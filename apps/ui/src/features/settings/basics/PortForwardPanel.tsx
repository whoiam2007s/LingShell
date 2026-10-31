import { useCallback, useEffect, useState } from 'react'
import { Loader2, CircleStop, ArrowRightLeft, Save, Trash2, RotateCw, Play } from 'lucide-react'
import { forwardSlot, tr, type HostSummary, type PortForwardInfo, type PortForwardInput, type SavedPortForward } from '@lingshell/shared'
import { client } from '../../../client/index.js'
import { Switch } from '../../../components/ui/Switch.js'
import { Select } from '../../../components/ui/Select.js'
import { HelpTip } from '../ui.js'

const BIND_OPTS = [{ value: '127.0.0.1', label: '127.0.0.1' }, { value: '0.0.0.0', label: '0.0.0.0' }]

// 某台主机的端口转发：本地转发 127.0.0.1:本地端口 → (经该主机) 远端地址:端口；动态转发 = 本地 SOCKS5 代理经该主机连出；
// 远程转发 = 服务器上监听端口 → (经 SSH 回到) 本机地址:端口。
// 已保存的转发（可启停/删除/启动时自动开启）+ 未保存的活动转发（可保存）+ 新建表单。
// 只挂在已存主机上，所以都能保存；临时连接没有凭据可存，后端会拒绝。
// 保存的与活动的按占用端口对应（forwardSlot：-L/-D 本地端口，-R 服务器端口）。
export function PortForwardPanel({ host }: { host: HostSummary }) {
  const [list, setList] = useState<PortForwardInfo[]>([])
  const [saved, setSaved] = useState<SavedPortForward[]>([])
  const [now, setNow] = useState(Date.now())
  const [localPort, setLocalPort] = useState('')
  const [remoteHost, setRemoteHost] = useState('127.0.0.1')
  const [remotePort, setRemotePort] = useState('')
  const [kind, setKind] = useState<'local' | 'dynamic' | 'remote'>('local')
  const dynamic = kind === 'dynamic', remote = kind === 'remote'
  const [lan, setLan] = useState(false)           // 动态转发监听 0.0.0.0 / 远程转发让服务器监听 0.0.0.0
  const [localHost, setLocalHost] = useState('127.0.0.1')   // 远程转发：本机目标地址
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const refresh = useCallback(() => {
    client.portForward.list().then((all) => setList(all.filter((f) => f.hostId === host.id))).catch(() => {})
    client.portForward.listSaved().then((all) => setSaved(all.filter((s) => s.hostId === host.id))).catch(() => {})
  }, [host.id])
  useEffect(() => {
    refresh()
    // 断线重连 / 恢复 / 停止 → 刷新
    return client.on((ev) => { if (ev.type === 'portForward:changed') refresh() })
  }, [refresh])
  // 有重连倒计时时每秒刷新显示
  const counting = list.some((f) => f.status.state === 'reconnecting')
  useEffect(() => {
    if (!counting) return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [counting])

  const lp = Number(localPort), rp = Number(remotePort)
  const okPort = (p: number) => Number.isInteger(p) && p > 0 && p < 65536
  const valid = okPort(lp) && (dynamic || (okPort(rp) && !!(remote ? localHost : remoteHost).trim()))
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true); setError('')
    try { await fn(); refresh() }
    catch (e) { setError(fwdErrorText(e instanceof Error ? e.message : String(e))) }
    finally { setBusy(false) }
  }
  const start = () => run(async () => {
    await client.portForward.start(dynamic
      ? { hostId: host.id, kind: 'dynamic', localPort: lp, bindHost: lan ? '0.0.0.0' : '127.0.0.1' }
      : remote
        ? { hostId: host.id, kind: 'remote', remotePort: rp, remoteBind: lan ? '0.0.0.0' : '127.0.0.1', localHost: localHost.trim(), localPort: lp }
        : { hostId: host.id, localPort: lp, remoteHost: remoteHost.trim(), remotePort: rp })
    setLocalPort('')
  })

  // 保存的在前（附上对应的活动转发），其后是未保存的活动转发；按占用端口对应（-R 是服务器端口）
  const rows: { input: PortForwardInput; fwd?: PortForwardInfo; saved?: SavedPortForward }[] = [
    ...saved.map((s) => ({ input: s.input, saved: s, fwd: list.find((f) => forwardSlot(f) === forwardSlot(s.input)) })),
    ...list.filter((f) => !saved.some((s) => forwardSlot(s.input) === forwardSlot(f))).map((f) => ({ input: f, fwd: f })),
  ]
  const btn = 'flex shrink-0 items-center gap-1 rounded border px-1.5 py-0.5 text-[11px] disabled:opacity-40'
  const neutral = `${btn} border-[var(--color-border-default)] text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)]`

  const inp = 'h-7 rounded-md border border-[var(--color-border-default)] bg-[var(--color-bg-panel)] px-2 text-[12px] text-[var(--color-text-primary)] outline-none focus:border-[color:color-mix(in_srgb,var(--color-accent)_60%,transparent)]'
  return (
    <div className="space-y-2 px-3.5 py-3 text-[12px]">
      {rows.length === 0 && <div className="text-[11px] text-[var(--color-text-muted)]">{tr('这台主机还没有转发，在下面新建')}</div>}
      {rows.map(({ input: f, fwd, saved: s }) => {
        const st = fwd?.status
        return (
          <div key={s?.id ?? fwd!.id} className="flex items-center gap-2 rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-bg-panel)] px-2.5 py-1.5">
            <ArrowRightLeft className={`h-3 w-3 shrink-0 ${st?.state === 'running' ? 'text-[var(--color-success)]' : st?.state === 'reconnecting' ? 'text-[var(--color-warn)]' : 'text-[var(--color-text-muted)]'}`} />
            <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-[var(--color-text-primary)]">
              {f.kind === 'dynamic' ? `SOCKS5 ${f.bindHost ?? '127.0.0.1'}:${f.localPort} → via ${host.label}`
                : f.kind === 'remote' ? tr('远程 {host} {bind}:{rport} → 本机 {lhost}:{lport}', { host: host.label, bind: f.remoteBind ?? '127.0.0.1', rport: f.remotePort, lhost: f.localHost, lport: f.localPort })
                : `127.0.0.1:${f.localPort} → ${f.remoteHost}:${f.remotePort}`}
            </span>
            <span className={`shrink-0 text-[11px] ${st?.state === 'running' ? 'text-[var(--color-success)]' : st?.state === 'reconnecting' ? 'text-[var(--color-warn)]' : st ? 'text-[var(--color-danger)]' : 'text-[var(--color-text-muted)]'}`}>
              {statusText(st, now)}
            </span>
            {s && <span className="flex shrink-0 items-center gap-1.5 text-[11px] text-[var(--color-text-secondary)]" title={tr('应用启动时自动开启')}>
              {tr('自启')}<Switch checked={s.autoStart} onCheckedChange={(v) => void run(() => client.portForward.setAutoStart(s.id, v))} aria-label={tr('应用启动时自动开启')} />
            </span>}
            {st && st.state !== 'running' && <button onClick={() => void run(() => client.portForward.retry(fwd!.id))} className={neutral}><RotateCw className="h-3 w-3" />{tr('立即重试')}</button>}
            {!fwd && s && <button disabled={busy} onClick={() => void run(() => client.portForward.start(s.input))} className={neutral}><Play className="h-3 w-3" />{tr('启动')}</button>}
            {!s && <button onClick={() => void run(() => client.portForward.save(f))} title={tr('保存此转发，之后可一键启动 / 启动时自动开启')} className={neutral}><Save className="h-3 w-3" />{tr('保存')}</button>}
            {fwd && <button onClick={() => void run(() => client.portForward.stop(fwd.id))} title={tr('停止转发（不再自动重连）')} className={`${btn} border-[color:color-mix(in_srgb,var(--color-danger)_40%,transparent)] text-[var(--color-danger)] hover:bg-[color:color-mix(in_srgb,var(--color-danger)_15%,transparent)]`}><CircleStop className="h-3 w-3" />{tr('停止')}</button>}
            {s && <button onClick={() => void run(() => client.portForward.deleteSaved(s.id))} title={tr('删除保存的转发（不影响正在运行的）')} className={neutral}><Trash2 className="h-3 w-3" /></button>}
          </div>
        )
      })}
      <div className="flex items-center gap-1.5">
        <Select size="sm" value={kind} onValueChange={(v) => { setKind(v as typeof kind); setLan(false) }} className="w-auto shrink-0">
          <option value="local">{tr('本地转发')}</option>
          <option value="remote">{tr('远程转发')}</option>
          <option value="dynamic">{tr('动态转发(SOCKS5)')}</option>
        </Select>
        {remote ? <>
          <span className="shrink-0 text-[11px] text-[var(--color-text-muted)]">{tr('服务器')}</span>
          <Select size="sm" value={lan ? '0.0.0.0' : '127.0.0.1'} onValueChange={(v) => setLan(v === '0.0.0.0')} title={tr('服务器上的监听地址')} className="w-auto shrink-0" options={BIND_OPTS} />
          <span className="text-[var(--color-text-muted)]">:</span>
          <input value={remotePort} onChange={(e) => setRemotePort(e.target.value)} placeholder="8080" title={tr('服务器上监听的端口')} className={`${inp} w-16`} />
          <span className="text-[var(--color-text-muted)]">{tr('→ 本机')}</span>
          <input value={localHost} onChange={(e) => setLocalHost(e.target.value)} placeholder="127.0.0.1" title={tr('从本机看到的目标地址')} className={`${inp} min-w-0 flex-1`} />
          <span className="text-[var(--color-text-muted)]">:</span>
          <input value={localPort} onChange={(e) => setLocalPort(e.target.value)} placeholder="3000" className={`${inp} w-16`} />
        </> : dynamic ? <>
          <Select size="sm" value={lan ? '0.0.0.0' : '127.0.0.1'} onValueChange={(v) => setLan(v === '0.0.0.0')} className="w-auto shrink-0" options={BIND_OPTS} />
          <span className="text-[var(--color-text-muted)]">:</span>
          <input value={localPort} onChange={(e) => setLocalPort(e.target.value)} placeholder="1080" className={`${inp} w-16`} />
          <span className="min-w-0 flex-1" />
        </> : <>
          <span className="shrink-0 text-[11px] text-[var(--color-text-muted)]">{tr('本地 127.0.0.1:')}</span>
          <input value={localPort} onChange={(e) => setLocalPort(e.target.value)} placeholder="13306" className={`${inp} w-16`} />
          <span className="text-[var(--color-text-muted)]">→</span>
          <input value={remoteHost} onChange={(e) => setRemoteHost(e.target.value)} placeholder={tr('远端地址')} title={tr('从 SSH 服务器看到的地址')} className={`${inp} min-w-0 flex-1`} />
          <span className="text-[var(--color-text-muted)]">:</span>
          <input value={remotePort} onChange={(e) => setRemotePort(e.target.value)} placeholder="3306" className={`${inp} w-16`} />
        </>}
        <HelpTip>{dynamic ? tr('用法：浏览器 / SwitchyOmega 设代理 socks5://127.0.0.1:{port}，或 curl --socks5-hostname 127.0.0.1:{port} http://内网地址', { port: localPort || '1080' })
          : remote ? tr('用法：在服务器上访问 127.0.0.1:{rport} 即连到本机 {lhost}:{lport}。服务器 sshd 需允许转发（AllowTcpForwarding）', { rport: remotePort || '8080', lhost: localHost || '127.0.0.1', lport: localPort || '3000' })
          : tr('本机 127.0.0.1:本地端口 → 经这台主机 → 远端地址:端口。远端地址是从 SSH 服务器看到的地址')}</HelpTip>
        <button onClick={start} disabled={busy || !valid}
          className="flex h-7 shrink-0 items-center gap-1 rounded-md border border-transparent bg-[var(--color-accent)] px-2.5 text-[11px] font-medium text-[var(--color-bg-base)] hover:bg-[var(--color-accent-dim)] disabled:opacity-40">
          {busy && <Loader2 className="h-3 w-3 animate-spin" />}{tr('启动')}
        </button>
      </div>
      {lan && (remote || dynamic) && <div className="flex items-center gap-1.5 rounded bg-[color:color-mix(in_srgb,var(--color-warn)_10%,transparent)] px-2 py-1 text-[11px] text-[var(--color-warn)]">
        {remote ? tr('监听 0.0.0.0：能访问这台服务器的人都能连到你本机的服务') : tr('监听 0.0.0.0：局域网内任何人都能把这台主机当代理用')}
        <HelpTip>{remote ? tr('能访问这台服务器的任何人都能连到你本机的这个服务；且需服务器 sshd_config 设 GatewayPorts yes 或 clientspecified，否则服务器仍只监听 127.0.0.1')
          : tr('局域网内任何人都能把你的 SSH 主机当代理用，仅在可信网络下使用')}</HelpTip>
      </div>}
      {error && <div className="rounded bg-[color:color-mix(in_srgb,var(--color-danger)_10%,transparent)] px-2 py-1 text-[11px] text-[var(--color-danger)]">{error}</div>}
    </div>
  )
}

function statusText(st: PortForwardInfo['status'] | undefined, now: number): string {
  if (!st) return tr('未启动')
  if (st.state === 'running') return tr('运行中')
  if (st.state === 'stopped') return tr('已停止（{reason}）', { reason: st.reason })
  const sec = Math.ceil((st.retryAt - now) / 1000)
  return sec > 0 ? tr('重连中（第 {n} 次，{sec} 秒后）', { n: st.attempt, sec }) : tr('重连中（第 {n} 次，连接中）', { n: st.attempt })
}

function fwdErrorText(msg: string): string {
  const m = /local_port_in_use: (.*)$/.exec(msg)
  if (m) return tr('{msg}，换一个端口', { msg: m[1] })
  const r = /remote_bind_failed: (.*)$/.exec(msg)
  if (r) return r[1]
  return tr('启动失败：{msg}', { msg: msg.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') })
}
