import { parentPort } from 'node:worker_threads'
import { promises as fs } from 'node:fs'
import { renderRegionAllSteps } from './worldmap'

/**
 * 地图渲染 worker。
 *
 * region 解析是纯 CPU 活（解压 + NBT + PNG 编码），放在主进程里会把 IPC 和
 * 窗口消息一起堵住。每个 worker 独立解析一个 region，主进程只负责写缓存。
 */

interface Job {
  id: number
  path: string
}

parentPort?.on('message', (job: Job) => {
  void (async () => {
    try {
      const res = renderRegionAllSteps(await fs.readFile(job.path))
      parentPort!.postMessage({
        id: job.id,
        ok: true,
        pngs: [...res.pngs.entries()],
        heights: res.heights,
        explored: res.explored
      })
    } catch (err) {
      parentPort!.postMessage({
        id: job.id,
        ok: false,
        error: (err as Error).message
      })
    }
  })()
})
