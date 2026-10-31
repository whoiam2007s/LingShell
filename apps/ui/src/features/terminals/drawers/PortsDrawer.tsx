import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { EthernetPort, ExternalLink, Loader2, RefreshCw, X } from 'lucide-react'
import {
  filterPorts, forwardTarget, localForwardUrl, portsSupported, tr,
  type ListenPort, type PortForwardInfo, type PortList, type TerminalInfo,
} from '@lingshell/shared'
import { client } from '../../../client/index.js'
import { ConfirmDialog } from '../../common/index.js'

const errText = (e: unknown) => String((e as { message?: string })?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
const IB = 'flex h-6 w-6 shrink-0 items-center justify-center rounded text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-accent)] disabled:opacity-40'
const BTN = 'flex shrink-0 items-center gap-1 rounded border border-[var(--color-border-default)] px-1.5 py-0.5 text-[11px] hover:bg-[var(--color-bg-hover)] disabled:opacity-40'
const W = { proto: 'w-[34px]', port: 'w-[44px]', proc: 'w-[80px]', act: 'w-[172px]' }
const keyOf = (host: string, port: number) => `${host}|${port}`
type LocalFwd = PortForwardInfo & { kind?: 'local'; remoteHost: string; remotePort: number }

// 监听端口：当前 SSH 终端所在主机（Linux）的 TCP 监听端口（独立 exec channel 跑 ss / netstat，不进交互 shell）。
// 每行「转发到本机」建一条临时本地转发（本地端口默认同号、被占用 +1），成功后可在浏览器打开；终端关闭时自动停。切终端时由外层 key 重挂载
export function PortsDrawer({ term, onClose }: { term?: TerminalInfo; onClose: () => void }) {
  const local = term?.type === 'local'   // 本机视图：本机监听端口，没有「转发」，改成「结束进程」
  const ok = !!term && (local || portsSupported(term.type, term.os))
  const w = local ? { ...W, proc: 'w-[150px]', act: 'w-[64px]' } : W   // 本机没有转发列，进程名多给点宽度
  const tid = term?.id ?? ''
  const [list, setList] = useState<PortList>()
  const [fwds, setFwds] = useState<LocalFwd[]>([])
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState('')
  const [q, setQ] = useState('')
  const [busy, setBusy] = useState<string>()   // 正在转发 / 停止的行
  const [kill, setKill] = useState<ListenPort>()   // 本机：待确认结束的进程

  const inflight = useRef(false)
  const loadFwds = useCallback(() => {
    if (ok && !local) client.ports.forwards(tid).then((f) => setFwds(f.filter((x): x is LocalFwd => x.kind !== 'dynamic' && x.kind !== 'remote'))).catch(() => {})
  }, [ok, local, tid])
  const refresh = useCallback(() => {
    if (!ok || inflight.current) return
    inflight.current = true; setLoading(true)
    client.ports.list(tid).then((r) => { setList(r); setErr('') }).catch((e) => setErr(errText(e)))
      .finally(() => { inflight.current = false; setLoading(false) })
    loadFwds()
  }, [ok, tid, loadFwds])
  useEffect(() => { refresh() }, [refresh])
  // 转发状态被动变化（断线重连 / 在设置里被停掉）
  useEffect(() => client.on((ev) => { if (ev.type === 'portForward:changed') loadFwds() }), [loadFwds])

  const shown = useMemo(() => filterPorts(list?.rows ?? [], q), [list, q])
  const fwdOf = (r: ListenPort) => fwds.find((f) => keyOf(f.remoteHost, f.remotePort) === keyOf(forwardTarget(r.addr), r.port))
  const forward = (r: ListenPort) => {
    const k = keyOf(r.addr, r.port)
    setBusy(k); setErr('')
    client.ports.forward(tid, r.addr, r.port).then(loadFwds, (e) => setErr(tr('转发 {port} 失败：{msg}', { port: r.port, msg: errText(e) }))).finally(() => setBusy(undefined))
  }
  const stop = (r: ListenPort, f: LocalFwd) => {
    setBusy(keyOf(r.addr, r.port))
    client.ports.stop(tid, f.id).catch((e) => setErr(errText(e))).finally(() => { setBusy(undefined); loadFwds() })
  }
  // 本机结束进程：Windows 直接 taskkill /F（控制台程序不接受普通结束），其它系统 kill -TERM；记执行记录
  const doKill = () => {
    const r = kill
    setKill(undefined)
    if (!r?.pid) return
    setBusy(keyOf(r.addr, r.port)); setErr('')
    client.processes.signal(tid, r.pid, list?.local === 'windows' ? 'KILL' : 'TERM', `${r.process ?? ''}（监听 ${r.port}）`)   // i18n-ignore 写进执行记录的描述
      .catch((e) => setErr(tr('结束进程 {pid} 失败：{msg}', { pid: r.pid ?? '', msg: errText(e) })))
      .finally(() => { setBusy(undefined); setTimeout(refresh, 500) })
  }

  const header = (
    <div className="flex h-10 shrink-0 items-center gap-1.5 border-b border-[var(--color-border-subtle)] px-3">
      <EthernetPort className="h-3.5 w-3.5 shrink-0 text-[var(--color-accent)]" />
      <span className="shrink-0 text-[12px] font-semibold text-[var(--color-text-primary)]">{local ? tr('监听端口 · 本机') : tr('监听端口')}</span>
      {list && <span className="shrink-0 text-[10.5px] text-[var(--color-text-muted)]">{list.rows.length} · {list.tool}</span>}
      <span className="ml-auto" />
      {ok && <button title={tr('刷新')} disabled={loading} onClick={refresh} className={IB}><RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} /></button>}
      <button title={tr('关闭')} onClick={onClose} className={IB}><X className="h-3.5 w-3.5" /></button>
    </div>
  )

  if (!ok) return (
    <div className="flex h-full flex-col">{header}
      <div className="px-3 py-3 text-[12px] text-[var(--color-text-muted)]">{tr('监听端口支持本地终端（本机）和 Linux 的 SSH 终端：先切到一个终端再打开。')}</div>
    </div>
  )

  return (
    <div className="flex h-full flex-col" data-ports-drawer>
      {header}
      <div className="shrink-0 border-b border-[var(--color-border-subtle)] px-3 py-1.5">
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={tr('按端口 / 地址 / 进程过滤')}
          className="w-full rounded border border-[var(--color-border-default)] bg-[var(--color-bg-raised)] px-2 py-1 text-[12px] text-[var(--color-text-primary)] outline-none focus:border-[var(--color-accent)]" />
      </div>
      {err && <div className="shrink-0 whitespace-pre-wrap break-all border-b border-[var(--color-border-subtle)] px-3 py-1.5 text-[11px] text-[var(--color-danger)]">{err}</div>}
      <div className="flex shrink-0 items-center gap-1.5 border-b border-[var(--color-border-subtle)] px-3 py-1 text-[10.5px] font-medium text-[var(--color-text-muted)]">
        <span className={`${w.proto} shrink-0`}>{tr('协议')}</span>
        <span className="min-w-0 flex-1">{tr('地址')}</span>
        <span className={`${w.port} shrink-0 text-right`}>{tr('端口')}</span>
        <span className={`${w.proc} shrink-0`}>{tr('进程 / PID')}</span>
        <span className={`${w.act} shrink-0 text-right`}>{local ? tr('操作') : tr('转发')}</span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto font-mono text-[11px]">
        {!list && <div className="px-3 py-3 font-sans text-[12px] text-[var(--color-text-muted)]">{loading ? tr('读取中…') : ''}</div>}
        {list && shown.length === 0 && <div className="px-3 py-3 font-sans text-[12px] text-[var(--color-text-muted)]">{tr('（没有匹配的监听端口）')}</div>}
        {shown.map((r) => {
          const f = fwdOf(r), k = keyOf(r.addr, r.port), st = f?.status
          return (
            <div key={k} data-port={r.port} className="flex items-center gap-1.5 px-3 py-[3px] text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)]">
              <span className={`${w.proto} shrink-0 text-[var(--color-text-muted)]`}>{r.proto}</span>
              <span className="min-w-0 flex-1 truncate" title={r.addr}>{r.addr}</span>
              <span className={`${w.port} shrink-0 text-right text-[var(--color-text-primary)]`}>{r.port}</span>
              <span className={`${w.proc} shrink-0 truncate`} title={r.process ? tr('{name}（PID {pid}）', { name: r.process, pid: r.pid ?? '' }) : tr('看不到进程（需要 root 或不是你的进程）')}>
                {r.process ? <>{r.process}<span className="text-[var(--color-text-muted)]">/{r.pid}</span></> : <span className="text-[var(--color-text-muted)]">—</span>}
              </span>
              <span className={`${w.act} flex shrink-0 items-center justify-end gap-1 font-sans`}>
                {busy === k ? <Loader2 className="h-3.5 w-3.5 animate-spin text-[var(--color-accent)]" />
                  : local ? (r.pid && r.pid > 4 ? <button data-port-kill onClick={() => setKill(r)} title={tr('结束占用 {port} 端口的进程（PID {pid}）', { port: r.port, pid: r.pid })} className={`${BTN} text-[var(--color-danger)]`}>{tr('结束进程')}</button> : null)
                  : f ? <>
                    {st?.state === 'running'
                      ? <button title={tr('在浏览器打开 {url}', { url: localForwardUrl(f.localPort, f.remotePort) })} onClick={() => window.open(localForwardUrl(f.localPort, f.remotePort), '_blank')}
                          className="flex shrink-0 items-center gap-0.5 whitespace-nowrap text-[11px] text-[var(--color-accent)] hover:underline">
                          <ExternalLink className="h-3 w-3 shrink-0" />127.0.0.1:{f.localPort}</button>
                      : <span className="truncate text-[11px] text-[var(--color-warn)]" title={st?.state === 'stopped' ? st.reason : ''}>{st?.state === 'stopped' ? tr('已断开') : tr('重连中…')}</span>}
                    <button onClick={() => stop(r, f)} className={`${BTN} text-[var(--color-danger)]`}>{tr('停止转发')}</button>
                  </>
                  : <button onClick={() => forward(r)} title={tr('在本机开一个端口转到远端 {target}（默认同号，被占用自动 +1）', { target: `${forwardTarget(r.addr)}:${r.port}` })} className={`${BTN} text-[var(--color-accent)]`}>{tr('转发到本机')}</button>}
              </span>
            </div>
          )
        })}
      </div>
      <div className="shrink-0 border-t border-[var(--color-border-subtle)] px-3 py-1.5 text-[10.5px] text-[var(--color-text-muted)]">
        {local ? tr('本机正在监听的 TCP 端口；系统进程（PID 0 / 4）不能结束，别的用户 / 管理员的进程需要以管理员身份运行灵壳才能结束。')
          : tr('临时转发只在本机 127.0.0.1 上监听，不写进主机配置，关闭这个终端时自动停止。')}
      </div>
      <ConfirmDialog open={!!kill} title={tr('结束进程 {pid}', { pid: kill?.pid ?? '' })} confirmText={tr('结束进程')}
        message={kill ? tr('{name}（PID {pid}）正在监听 {addr}。确定在本机结束它？{how}操作会记入执行记录。', {
          name: kill.process ?? tr('该进程'), pid: kill.pid ?? '', addr: `${kill.addr}:${kill.port}`,
          how: list?.local === 'windows' ? tr('将执行 taskkill /F（强制结束，未保存的数据会丢失）。') : tr('将发送 TERM 信号。'),
        }) : ''}
        onConfirm={doKill} onCancel={() => setKill(undefined)} />
    </div>
  )
}
