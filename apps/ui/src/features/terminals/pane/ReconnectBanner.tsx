import { useEffect, useRef, useState } from 'react'
import { Loader2, RotateCw, Unplug, X } from 'lucide-react'
import { RECONNECT_DELAYS_SEC, reconnectStep, tr, type ReconnectEvent, type ReconnectState, type TerminalInfo } from '@lingshell/shared'
import { client } from '../../../client/index.js'
import { getTermPrefs } from '../../../lib/termPrefs.js'

const offText = (why: 'disabled' | 'exited' | 'cancelled' | 'gaveUp' | 'local'): string => ({
  disabled: () => tr('连接已断开'),
  exited: () => tr('远端会话已退出'),
  cancelled: () => tr('连接已断开，已取消自动重连'),
  gaveUp: () => tr('连接已断开，自动重连 {n} 次均失败', { n: RECONNECT_DELAYS_SEC.length }),
  local: () => tr('终端进程已退出'),
})[why]()
const BTN = 'flex shrink-0 items-center gap-1 rounded px-2 py-0.5 hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-accent)]'

// 终端顶部的断线横幅 + SSH 自动重连（状态机见 shared/terminal/tabs.ts）。随 TerminalPane 挂载：关标签即卸载，定时器一并清掉。
// 重连走 TerminalManager.reconnect（重建连接 + 提示符设置），成功由 terminal:status running 收起横幅。
export function ReconnectBanner({ info }: { info: TerminalInfo }) {
  const [s, setS] = useState<ReconnectState>(info.status === 'disconnected' ? { phase: 'off', why: info.type === 'ssh' ? 'disabled' : 'local' } : { phase: 'idle' })
  const [now, setNow] = useState(() => Date.now())
  const [err, setErr] = useState('')   // 重连失败原因（以前静默失败，点了像没反应）
  const gen = useRef(0)   // 取消 / 切换状态后，晚到的重连结果不再改状态机
  const errText = (e: unknown) => String((e as { message?: string })?.message ?? e).replace(/^Error invoking remote method '[^']+': Error:\s*/, '')
  const dispatch = (ev: ReconnectEvent) => setS((x) => reconnectStep(x, ev))

  useEffect(() => client.on((ev) => {
    if (ev.type !== 'terminal:status' || ev.terminalId !== info.id) return
    if (ev.status === 'running') dispatch({ type: 'connected' })
    else dispatch({ type: 'disconnected', ssh: info.type === 'ssh', enabled: !!getTermPrefs().autoReconnect, reason: ev.reason, now: Date.now() })
  }), [info.id])

  // 等待中：刷新倒计时，到点发起
  useEffect(() => {
    if (s.phase !== 'waiting') return
    const tick = () => { const t = Date.now(); setNow(t); if (t >= s.at) dispatch({ type: 'fire' }) }
    tick()
    const h = setInterval(tick, 250)
    return () => clearInterval(h)
  }, [s])

  // 连接中：发起一次（后端对同一终端的并发重连去重）。取消后这次连接的晚到结果不再翻状态
  useEffect(() => {
    if (s.phase !== 'connecting') return
    const g = ++gen.current
    setErr('')
    client.terminal.reconnect(info.id).then(
      () => { if (gen.current === g) dispatch({ type: 'connected' }) },
      (e) => { if (gen.current !== g) return; setErr(tr('重连失败：{msg}', { msg: errText(e) })); dispatch({ type: 'failed', now: Date.now() }) })
    return () => { gen.current++ }
  }, [s])

  if (s.phase === 'idle') return null
  return (
    <div className="flex items-center gap-1.5 border-b border-[var(--color-border-subtle)] bg-[var(--color-bg-raised)] px-3 py-1 text-[12px] text-[var(--color-text-muted)]">
      {s.phase === 'connecting' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Unplug className="h-3.5 w-3.5" />}
      <span className="min-w-0 flex-1 truncate">
        {s.phase === 'waiting' && tr('连接已断开，{sec} 秒后重连（第 {n} 次）', { sec: Math.max(0, Math.ceil((s.at - now) / 1000)), n: s.attempt })}
        {s.phase === 'connecting' && tr('正在重连（第 {n} 次）…', { n: s.attempt })}
        {s.phase === 'off' && offText(s.why)}
        {err && <span className="ml-2 text-[var(--color-danger)]">{err}</span>}
      </span>
      {s.phase === 'waiting' && <button onClick={() => dispatch({ type: 'fire' })} className={BTN}><RotateCw className="h-3 w-3" />{tr('立即重连')}</button>}
      {(s.phase === 'waiting' || s.phase === 'connecting') && <button onClick={() => dispatch({ type: 'cancel' })} className={BTN}><X className="h-3 w-3" />{tr('取消')}</button>}
      {s.phase === 'off' && info.type === 'ssh' && (
        <button onClick={() => {
          setErr('')
          client.terminal.reconnect(info.id).then(() => dispatch({ type: 'connected' }), (e) => setErr(tr('重连失败：{msg}', { msg: errText(e) })))
        }} className={BTN}><RotateCw className="h-3 w-3" />{tr('重连')}</button>
      )}
    </div>
  )
}
