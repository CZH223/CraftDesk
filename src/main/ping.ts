import { createConnection } from 'node:net'

/**
 * Server List Ping：直接问服务端「几个人在线」。
 *
 * 为什么不再只靠日志数人头：日志解析是「从我开始看之后」的变化量，
 * 中途接管、重启、某人以插件方式进服、崩溃前没刷出来的离开行，
 * 都会让这个数字慢慢偏掉。客户端服务器列表里显示的 1/99999 也是从这个
 * 协议拿的，所以用它来数，界面上的数字和客户端看到的必然一致。
 *
 * 协议很短：握手（状态 = 1）→ 请求状态 → 服务端回一个 JSON。
 */

export interface PingResult {
  /** 服务端自己报的在线人数 */
  online: number
  /** 服务端自己报的上限。服务端不一定是 server.properties 里那个值：
   *  代理端会用 show-max-players，插件也可能改写 */
  max: number
  /** 服务器给的在线名单，可能被截断，也可能是插件塞的假条目 */
  sample: string[]
  version: string
  motd: string
}

/** Minecraft 协议的 VarInt */
function writeVarInt(value: number): Buffer {
  const bytes: number[] = []
  let v = value >>> 0
  do {
    let b = v & 0b0111_1111
    v >>>= 7
    if (v !== 0) b |= 0b1000_0000
    bytes.push(b)
  } while (v !== 0)
  return Buffer.from(bytes)
}

function readVarInt(buf: Buffer, offset: number): { value: number; size: number } | null {
  let value = 0
  let size = 0
  while (offset + size < buf.length) {
    const b = buf[offset + size]
    value |= (b & 0b0111_1111) << (7 * size)
    size++
    if (size > 5) return null
    if ((b & 0b1000_0000) === 0) return { value: value >>> 0, size }
  }
  return null
}

/** 一个包 = 长度前缀 + 包体 */
function frame(body: Buffer): Buffer {
  return Buffer.concat([writeVarInt(body.length), body])
}

function mcString(s: string): Buffer {
  const raw = Buffer.from(s, 'utf8')
  return Buffer.concat([writeVarInt(raw.length), raw])
}

/**
 * 从收到的字节流里解析状态响应。
 * TCP 不保证一次收完，所以要么返回结果，要么返回 null 等更多数据。
 */
function parseStatus(buf: Buffer): PingResult | null {
  const len = readVarInt(buf, 0)
  if (!len || buf.length < len.size + len.value) return null

  const body = buf.subarray(len.size, len.size + len.value)
  const packetId = readVarInt(body, 0)
  if (!packetId || packetId.value !== 0x00) return null

  const strLen = readVarInt(body, packetId.size)
  if (!strLen) return null
  const start = packetId.size + strLen.size
  const json = body.subarray(start, start + strLen.value).toString('utf8')

  try {
    const data = JSON.parse(json) as {
      version?: { name?: string }
      players?: { online?: number; max?: number; sample?: { name?: string }[] }
      description?: unknown
    }
    const players = data.players ?? {}
    return {
      online: Number.isFinite(players.online) ? Number(players.online) : 0,
      max: Number.isFinite(players.max) ? Number(players.max) : 0,
      sample: (players.sample ?? [])
        .map((s) => s?.name ?? '')
        .filter((n): n is string => Boolean(n)),
      version: data.version?.name ?? '',
      motd: flattenMotd(data.description)
    }
  } catch {
    return null
  }
}

/** description 可能是字符串，也可能是带颜色代码的富文本对象 */
function flattenMotd(desc: unknown): string {
  if (typeof desc === 'string') return desc
  if (desc && typeof desc === 'object') {
    const o = desc as { text?: string; extra?: unknown[] }
    const parts: string[] = []
    if (typeof o.text === 'string') parts.push(o.text)
    for (const e of o.extra ?? []) parts.push(flattenMotd(e))
    return parts.join('')
  }
  return ''
}

/**
 * 问一次。连不上、超时、不是 Minecraft 服务端都返回 null——
 * 调用方据此退回日志里数出来的值。
 */
export function pingServer(host: string, port: number, timeoutMs = 2500): Promise<PingResult | null> {
  return new Promise((resolve) => {
    let done = false
    const finish = (r: PingResult | null): void => {
      if (done) return
      done = true
      socket.destroy()
      resolve(r)
    }

    const socket = createConnection({ host, port })
    socket.setTimeout(timeoutMs, () => finish(null))
    socket.on('error', () => finish(null))
    socket.on('close', () => finish(null))

    let buf = Buffer.alloc(0)
    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk])
      // 正常的响应也就几百字节，超过 1 MB 说明对面不是 Minecraft
      if (buf.length > 1 << 20) return finish(null)
      const res = parseStatus(buf)
      if (res) finish(res)
    })

    socket.on('connect', () => {
      // protocolVersion 给 -1 表示「我不挑版本」，只想要状态。
      // 状态阶段服务端不看这个值，但填一个假版本号也容易被反作弊插件记一笔。
      const handshake = Buffer.concat([
        writeVarInt(0x00),
        writeVarInt(-1),
        mcString(host),
        Buffer.from([(port >> 8) & 0xff, port & 0xff]),
        writeVarInt(1)
      ])
      const request = writeVarInt(0x00)
      socket.write(Buffer.concat([frame(handshake), frame(request)]))
    })
  })
}

/** 服务器给的名单能不能当用户名用（插件常往 sample 里塞广告词） */
export function looksLikePlayerNames(names: string[]): boolean {
  if (!names.length) return false
  return names.every((n) => /^[A-Za-z0-9_]{1,16}$/.test(n))
}
