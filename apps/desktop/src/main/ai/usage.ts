import { UsageStore } from '@lingshell/config'
import type { UsageRecord } from '@lingshell/shared'
import { log } from '../core/index.js'

// 用量统计：主进程唯一的写入口。ipc.ts 启动时 initUsage；DshController 的 recordUsage 接到这里。
let store: UsageStore | undefined

export function initUsage(dir: string): UsageStore {
  return (store = new UsageStore(dir))
}

/**
 * 记一次模型请求的用量（落 usage.jsonl）。会话外的一次性调用（如自然语言转命令）也调这个：
 *   recordUsage({ sessionId: '', source: 'nl-command', provider, model, input, cacheRead, output })
 * input = 未命中缓存的输入 tokens，cacheRead = 命中缓存的；拿不到缓存明细就全记在 input、cacheRead 填 0。
 * 写失败只记日志，绝不影响调用方。
 */
export function recordUsage(r: Omit<UsageRecord, 'at'> & { at?: string }): void {
  if (!store) return
  try { store.add({ ...r, at: r.at ?? new Date().toISOString() }) }
  catch (e) { log('warn', 'main', 'usage', 'record failed', { err: String(e).slice(0, 200) }) }
}
