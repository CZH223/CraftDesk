import { randomBytes } from 'node:crypto'
import { connect, type Socket } from 'node:net'
import { parsePropertiesFile } from './properties'
import type { PropertiesEntry } from '../shared/types'

/**
 * 最小 RCON 客户端。
 *
 * 外部启动的服务端没有 stdin 可写，但只要 server.properties 里开了 RCON，
 * 就能用同一个控制台协议读玩家坐标。协议很简单：
 *   [长度 int32LE][请求 id][类型][正文][两个 0 字节]
 * 类型 3 = 登录，2 = 执行指令，0 = 响应。
 */

export interface RconConfig {
  host: string
  port: number
  password: string
}

export async function readRconConfig(propertiesPath: string): Promise<RconConfig | null> {
  let props
  try {
    props = await parsePropertiesFile(propertiesPath)
  } catch {
    return null
  }
  const get = (key: string): string => props.find((p) => p.key === key)?.value ?? ''
  if (get('enable-rcon') !== 'true') return null
  const password = get('rcon.password')
  if (!password) return null
  const port = Number(get('rcon.port') || 25575)
  if (!Number.isFinite(port) || port <= 0 || port > 65535) return null
  const ip = get('server-ip')
  // RCON 只连本机；server-ip 是 0.0.0.0 时用回环地址
  const host = ip && ip !== '0.0.0.0' && ip !== '::' ? ip : '127.0.0.1'
  return { host, port, password }
}

export function encodeRconPacket(id: number, type: number, body: string): Buffer {
  const payload = Buffer.from(body, 'utf-8')
  const buf = Buffer.alloc(14 + payload.length)
  buf.writeInt32LE(payload.length + 10, 0)
  buf.writeInt32LE(id, 4)
  buf.writeInt32LE(type, 8)
  payload.copy(buf, 12)
  buf.writeUInt16LE(0, 12 + payload.length)
  return buf
}

interface RconPacket {
  id: number
  type: number
  body: string
}

/** 从缓冲区里尽量多地取出完整包 */
export function decodeRconPackets(buf: Buffer): { packets: RconPacket[]; rest: Buffer } {
  const packets: RconPacket[] = []
  let off = 0
  while (buf.length - off >= 4) {
    const len = buf.readInt32LE(off)
    if (len < 10 || len > 1024 * 1024) break
    if (buf.length - off < 4 + len) break
    const id = buf.readInt32LE(off + 4)
    const type = buf.readInt32LE(off + 8)
    const body = buf.toString('utf-8', off + 12, off + 4 + len - 2)
    packets.push({ id, type, body })
    off += 4 + len
  }
  return { packets, rest: buf.subarray(off) }
}

export class RconClient {
  private socket: Socket
  private buf = Buffer.alloc(0)
  private queue: RconPacket[] = []
  private waiters: ((p: RconPacket) => void)[] = []
  private nextId = 2
  private closed = false

  private constructor(socket: Socket) {
    this.socket = socket
    socket.on('data', (chunk) => {
      this.buf = Buffer.concat([this.buf, chunk])
      const { packets, rest } = decodeRconPackets(this.buf)
      this.buf = Buffer.from(rest)
      for (const p of packets) {
        const waiter = this.waiters.shift()
        if (waiter) waiter(p)
        else this.queue.push(p)
      }
    })
    socket.on('close', () => {
      this.closed = true
      // 让等待中的请求尽快失败
      for (const w of this.waiters.splice(0)) {
        w({ id: -1, type: -1, body: '' })
      }
    })
    socket.on('error', () => {
      this.closed = true
    })
  }

  static open(cfg: RconConfig, timeout = 3000): Promise<RconClient> {
    return new Promise((resolve, reject) => {
      const socket = connect({ host: cfg.host, port: cfg.port })
      const timer = setTimeout(() => {
        socket.destroy()
        reject(new Error(`连接 RCON 超时（${cfg.host}:${cfg.port}）`))
      }, timeout)
      socket.once('error', (err) => {
        clearTimeout(timer)
        reject(err)
      })
      socket.once('connect', () => {
        clearTimeout(timer)
        const client = new RconClient(socket)
        client
          .commandWithType(1, 3, cfg.password)
          .then((res) => {
            if (res.id === -1) throw new Error('RCON 密码错误')
            resolve(client)
          })
          .catch((err) => {
            client.close()
            reject(err)
          })
      })
    })
  }

  private next(): Promise<RconPacket> {
    if (this.queue.length) return Promise.resolve(this.queue.shift()!)
    if (this.closed) return Promise.reject(new Error('RCON 连接已关闭'))
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('RCON 响应超时')), 3000)
      this.waiters.push((p) => {
        clearTimeout(timer)
        resolve(p)
      })
    })
  }

  private async commandWithType(id: number, type: number, body: string): Promise<RconPacket> {
    this.socket.write(encodeRconPacket(id, type, body))
    return this.next()
  }

  async command(cmd: string): Promise<string> {
    const id = this.nextId++
    const res = await this.commandWithType(id, 2, cmd)
    let body = res.body
    // 大响应（比如在线玩家很多时的 list）会被拆成多个包，稍等一下把后续包收齐
    await new Promise((resolve) => setTimeout(resolve, 20))
    while (this.queue.length) body += this.queue.shift()!.body
    return body.replace(/[\0\s]+$/g, '').trim()
  }

  close(): void {
    this.closed = true
    this.socket.destroy()
  }
}

/** 一次连接里按顺序执行多条指令，返回各自的输出 */
export async function runRconCommands(cfg: RconConfig, commands: string[]): Promise<string[]> {
  const client = await RconClient.open(cfg)
  try {
    const out: string[] = []
    for (const cmd of commands) out.push(await client.command(cmd))
    return out
  } finally {
    client.close()
  }
}


/**
 * 把 server.properties 的条目改成「开启 RCON」。
 *
 * 保留原有注释与顺序；密码为空时生成一个 16 位随机密码（不回传给界面，
 * 只写进文件，RCON 客户端之后自己读）。rcon.port 没填或和游戏端口相同
 * 时用 25575，避免绑定冲突。
 */
export function withRconEnabled(entries: PropertiesEntry[]): {
  entries: PropertiesEntry[]
  port: number
  generatedPassword: boolean
} {
  const out = entries.map((e) => ({ ...e }))
  const find = (key: string): PropertiesEntry | undefined => out.find((e) => e.key === key)
  const set = (key: string, value: string): void => {
    const hit = find(key)
    if (hit) hit.value = value
    else out.push({ key, value })
  }

  const oldPassword = find('rcon.password')?.value ?? ''
  const generatedPassword = !oldPassword
  set('enable-rcon', 'true')
  if (generatedPassword) set('rcon.password', randomBytes(8).toString('hex'))

  const serverPort = Number(find('server-port')?.value ?? 0)
  let port = Number(find('rcon.port')?.value ?? 0)
  if (!Number.isFinite(port) || port <= 0 || port === serverPort) {
    port = 25575
    set('rcon.port', String(port))
  }
  set('broadcast-rcon-to-ops', 'false')
  return { entries: out, port, generatedPassword }
}
