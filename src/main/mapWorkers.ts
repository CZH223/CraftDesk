import { Worker } from 'node:worker_threads'
import { join } from 'node:path'
import { cpus } from 'node:os'
import { app } from 'electron'

/**
 * 地图渲染 worker 池。
 *
 * 每个 worker 单独解析 region；主进程只排队、写缓存和返回 data URL。
 * 打包后 worker 从 asar.unpacked 加载（见 package.json 的 asarUnpack）。
 * 如果 worker 起不来（例如某些受限环境），调用方会退回主进程同步渲染。
 */

export interface WorkerRegionRender {
  pngs: Map<number, Buffer>
  heights: Uint16Array
  explored: number
}

interface Job {
  id: number
  path: string
  resolve: (result: WorkerRegionRender) => void
  reject: (err: Error) => void
}

interface WorkerMessage {
  id: number
  ok: boolean
  pngs?: [number, Uint8Array][]
  heights?: Uint16Array
  explored?: number
  error?: string
}

const workers = new Set<Worker>()
const idle: Worker[] = []
const active = new Map<Worker, Job>()
const queue: Job[] = []
let nextId = 1
let disabled = false
let spawning = false
/** worker 启动就失败（路径不对 / asar 未解包）的次数；连续两次就不再尝试 */
let startupFailures = 0

function wantedWorkers(): number {
  return Math.max(1, Math.min(4, cpus().length - 1))
}

function workerPath(): string {
  if (app.isPackaged) {
    return join(process.resourcesPath, 'app.asar.unpacked', 'out', 'main', 'mapWorker.js')
  }
  return join(__dirname, 'mapWorker.js')
}

function fail(worker: Worker, err: Error): void {
  const job = active.get(worker)
  active.delete(worker)
  workers.delete(worker)
  const at = idle.indexOf(worker)
  if (at >= 0) idle.splice(at, 1)
  void worker.terminate()

  if (job) {
    job.reject(err)
  } else {
    // 还没接到任务就退出 = 启动失败；不要无限补进程
    startupFailures++
    if (startupFailures >= 2) disabled = true
  }

  // 一个 worker 都起不来时，后续请求直接走主进程兜底，不再反复尝试
  if (!workers.size) {
    disabled = true
    for (const pending of queue.splice(0)) pending.reject(err)
  } else {
    pump()
  }
}

function spawn(): void {
  if (disabled || spawning) return
  spawning = true
  try {
    while (workers.size < wantedWorkers()) {
      const worker = new Worker(workerPath())
      workers.add(worker)
      idle.push(worker)
      // worker 不阻止应用退出
      worker.unref()

      worker.on('message', (msg: WorkerMessage) => {
        const job = active.get(worker)
        if (!job || msg.id !== job.id) return
        active.delete(worker)
        if (msg.ok) {
          job.resolve({
            pngs: new Map(
              (msg.pngs ?? []).map(([step, png]) => [step, Buffer.from(png)])
            ),
            heights: msg.heights ?? new Uint16Array(0),
            explored: msg.explored ?? 0
          })
        } else {
          job.reject(new Error(msg.error || '地图渲染 worker 出错'))
        }
        idle.push(worker)
        pump()
      })
      worker.on('error', (err) => fail(worker, err))
      worker.on('exit', (code) => {
        // 非 terminate 的退出也要补一个 worker；否则 idle 队列里会留下死进程
        if (workers.has(worker)) fail(worker, new Error(`地图渲染 worker 退出（${code}）`))
      })
    }
  } catch {
    disabled = true
  } finally {
    spawning = false
  }
}

function pump(): void {
  // 只派发已有的 idle worker；补进程交给下一次 renderRegionInWorker，
  // 避免启动失败时 fail → pump → spawn 的无限循环
  while (queue.length && idle.length) {
    const worker = idle.pop()!
    const job = queue.shift()!
    active.set(worker, job)
    try {
      worker.postMessage({ id: job.id, path: job.path })
    } catch (err) {
      active.delete(worker)
      fail(worker, err as Error)
    }
  }
}

export function renderRegionInWorker(path: string): Promise<WorkerRegionRender> {
  spawn()
  if (disabled || !workers.size) {
    return Promise.reject(new Error('地图渲染 worker 不可用'))
  }
  return new Promise<WorkerRegionRender>((resolve, reject) => {
    queue.push({ id: nextId++, path, resolve, reject })
    pump()
  })
}

export function shutdownMapWorkers(): void {
  disabled = true
  for (const worker of workers) void worker.terminate()
  workers.clear()
  idle.length = 0
  active.clear()
  for (const job of queue.splice(0)) job.reject(new Error('地图渲染已停止'))
}
