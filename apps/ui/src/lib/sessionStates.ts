// 会话运行状态（历史会话列表的状态点用）：纯前端维护，来源是主进程推来的事件。
//   running  = 有一轮正在跑
//   awaiting = 正在等用户处理授权 / 计划 / 提问卡片
//   failed   = 上一轮以失败告终
// 正常结束的会话不留状态（列表里不显示点）。
import { useEffect, useState } from 'react'

export type RunState = 'running' | 'awaiting' | 'failed'

const states = new Map<string, RunState>()
const subs = new Set<() => void>()
const notify = () => { for (const f of subs) f() }

/** 喂一条主进程事件；不是会话相关的就忽略 */
export function noteSessionEvent(ev: { type?: string; sessionId?: string; [k: string]: unknown }): void {
  const sid = ev.sessionId
  if (!sid || !ev.type) return
  const set = (s: RunState | undefined) => {
    const prev = states.get(sid)
    if (prev === s) return
    if (s) states.set(sid, s)
    else states.delete(sid)
    notify()
  }
  switch (ev.type) {
    case 'agent:turnStarted':
      set('running')
      break
    // 等用户动手的三种卡片
    case 'auth:request':
    case 'plan:request':
    case 'ask:request':
      set('awaiting')
      break
    case 'agent:turnCompleted':
      set(undefined)
      break
    // 格式错误后引擎会自动补一轮：状态回到「进行中」，不要因为这次失败亮红点
    case 'agent:turnRetrying':
      set('running')
      break
    case 'agent:turnFailed':
      set('failed')
      break
    // 用户点了「停止」：不算失败，正常收起
    case 'agent:interrupted':
      set(undefined)
      break
  }
}

/** 某个会话当前的状态（没有 = 正常/空闲） */
export const runStateOf = (sessionId: string): RunState | undefined => states.get(sessionId)

/**
 * 打开某个会话（切过去）就当他看过了：把状态点收起来。
 * 以前只有「下一轮正常结束」才清，失败后再没跑过的会话会一直亮红点（历史异常一直提醒）。
 */
export function clearRunState(sessionId: string): void {
  if (!states.delete(sessionId)) return
  notify()
}

/** 订阅状态变化，返回最新快照（历史会话抽屉用） */
export function useRunStates(): (sessionId: string) => RunState | undefined {
  const [, bump] = useState(0)
  useEffect(() => {
    const f = () => bump((n) => n + 1)
    subs.add(f)
    return () => { subs.delete(f) }
  }, [])
  return runStateOf
}
