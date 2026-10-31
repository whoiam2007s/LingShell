import { useCallback, useEffect, useRef, useState } from 'react'
import { Activity, ArrowLeft, Container, Layers, LogIn, Play, RefreshCw, RotateCcw, ScrollText, Square, SquareTerminal, X } from 'lucide-react'
import {
  COMPOSE_ACTION_LABEL, DOCKER_ACTION_LABEL, DOCKER_LOCAL_PROBLEM_TEXT, DOCKER_PROBLEM_TEXT, dockerLocalSupported, dockerSupported, statFor, tr,
  type ComposeAction, type ComposeProject, type DockerAction, type DockerContainer, type DockerListResult, type DockerMode, type DockerStat, type TerminalInfo,
} from '@lingshell/shared'
import { client } from '../../../client/index.js'
import { ConfirmDialog } from '../../common/index.js'
import { cn } from '../../../lib/cn.js'

const errText = (e: unknown) => String((e as { message?: string })?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
const IB = 'flex h-6 w-6 shrink-0 items-center justify-center rounded text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-accent)] disabled:opacity-40'
const DOT: Record<string, string> = { running: 'bg-[var(--color-success)]', paused: 'bg-[var(--color-warn)]', restarting: 'bg-[var(--color-warn)]' }
const TAB = 'rounded px-2 py-0.5 text-[11px]'
// 日志页：容器（c）或 Compose 项目（p）
type Logs = { kind: 'c' | 'p'; id: string; name: string; text?: string; err?: string }

// 容器视图：当前终端所在主机的容器列表 / 日志 / 进入 / 启停，以及「Compose 项目」页签（docker compose ls，up / down / 重启 / 日志）。
// SSH 终端走独立 exec channel，本地终端是本机 docker（本机视图）；都不进交互 shell。
// 无权限时若免密 sudo 可用，由用户点「改用 sudo -n」（绝不提示密码；本机不走 sudo）。切终端时由外层 key 重挂载
export function DockerDrawer({ term, onClose }: { term?: TerminalInfo; onClose: () => void }) {
  const local = !!term && dockerLocalSupported(term.type)
  const ok = !!term && (local || dockerSupported(term.type, term.os))
  const [tab, setTab] = useState<'containers' | 'compose'>('containers')
  const [mode, setMode] = useState<DockerMode>('docker')
  const [res, setRes] = useState<DockerListResult>()
  const [projects, setProjects] = useState<ComposeProject[]>()
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState('')
  const [stats, setStats] = useState<Map<string, DockerStat>>()
  const [statsBusy, setStatsBusy] = useState(false)
  const [logs, setLogs] = useState<Logs>()
  const [confirm, setConfirm] = useState<{ c: DockerContainer; action: DockerAction } | { p: ComposeProject; action: ComposeAction }>()
  const [busy, setBusy] = useState<string>()   // 正在启停的容器 id / 项目名

  const tid = term?.id ?? ''
  const loadStats = useCallback(() => {
    setStatsBusy(true)
    client.docker.stats(tid, mode).then((s) => setStats(new Map(Object.entries(s)))).catch((e) => setErr(tr('CPU / 内存取不到：{msg}', { msg: errText(e) }))).finally(() => setStatsBusy(false))
  }, [tid, mode])
  // 点过 CPU / 内存后，刷新列表时一并刷新（ref：开关本身不触发重列）
  const statsOn = useRef(false)
  statsOn.current = !!stats
  // 请求序号：切页签 / 快速换容器时迟到的旧响应不能覆盖新结果
  const listSeq = useRef(0), logSeq = useRef(0)
  const refresh = useCallback(() => {
    if (!ok) return
    const my = ++listSeq.current
    setLoading(true); setErr('')
    const p = tab === 'compose'
      ? client.docker.composeList(tid, mode).then((v) => { if (my === listSeq.current) setProjects(v) })
      : client.docker.list(tid, mode).then((r) => { if (my === listSeq.current) { setRes(r); if (statsOn.current && r.containers) loadStats() } })
    p.catch((e) => { if (my === listSeq.current) setErr(errText(e)) }).finally(() => { if (my === listSeq.current) setLoading(false) })
  }, [ok, tid, mode, tab, loadStats])
  useEffect(() => { refresh() }, [refresh])

  const loadLogs = (l: Logs) => {
    const my = ++logSeq.current
    setLogs({ ...l, text: undefined, err: undefined })
    const p = l.kind === 'c' ? client.docker.logs(tid, mode, l.id) : client.docker.composeLogs(tid, mode, l.id)
    p.then((text) => { if (my === logSeq.current) setLogs({ ...l, text }) }).catch((e) => { if (my === logSeq.current) setLogs({ ...l, err: errText(e) }) })
  }
  const openTerm = (kind: 'follow' | 'exec' | 'composeLogs', ref: string) => {
    client.docker.openTerminal(tid, mode, kind, ref).then(onClose).catch((e) => setErr(errText(e)))
  }
  const doAction = () => {
    const x = confirm
    setConfirm(undefined)
    if (!x) return
    setErr('')
    if ('c' in x) {
      setBusy(x.c.id)
      client.docker.action(tid, mode, x.action, x.c.id, x.c.name).catch((e) => setErr(tr('{action}「{name}」失败：{msg}', { action: tr(DOCKER_ACTION_LABEL[x.action]), name: x.c.name, msg: errText(e) })))
        .finally(() => { setBusy(undefined); refresh() })
    } else {
      setBusy(x.p.name)
      client.docker.composeAction(tid, mode, x.action, x.p).catch((e) => setErr(tr('{action}「{name}」失败：{msg}', { action: tr(COMPOSE_ACTION_LABEL[x.action]), name: x.p.name, msg: errText(e) })))
        .finally(() => { setBusy(undefined); refresh() })
    }
  }

  const prod = term?.env === 'prod'
  const header = (
    <div className="flex h-10 shrink-0 items-center gap-2 border-b border-[var(--color-border-subtle)] px-3">
      {logs
        ? <button title={tr('返回列表')} onClick={() => { logSeq.current++; setLogs(undefined) }} className={IB}><ArrowLeft className="h-3.5 w-3.5" /></button>
        : <Container className="h-3.5 w-3.5 shrink-0 text-[var(--color-accent)]" />}
      <span className="truncate text-[12px] font-semibold text-[var(--color-text-primary)]">{logs ? tr('日志 · {name}', { name: logs.name }) : local ? tr('容器 · 本机') : tr('容器')}</span>
      {ok && !local && <span title={tr('当前使用的命令')} className="shrink-0 rounded bg-[var(--color-bg-raised)] px-1.5 py-0.5 font-mono text-[10px] text-[var(--color-text-muted)]">{mode === 'sudo' ? 'sudo -n docker' : 'docker'}</span>}
      <span className="ml-auto" />
      {ok && !logs && <>
        {tab === 'containers' && <button title={tr('CPU / 内存（docker stats，约需 2 秒）')} disabled={statsBusy || !res?.containers} onClick={loadStats}
          className={`${IB} ${stats ? 'text-[var(--color-accent)]' : ''}`}><Activity className={`h-3.5 w-3.5 ${statsBusy ? 'animate-pulse' : ''}`} /></button>}
        <button title={tr('刷新')} disabled={loading} onClick={refresh} className={IB}><RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} /></button>
      </>}
      {logs && <>
        <button title={tr('刷新日志（最后 200 行）')} onClick={() => loadLogs(logs)} className={IB}><RefreshCw className="h-3.5 w-3.5" /></button>
        <button title={logs.kind === 'c' ? tr('在终端里跟踪（docker logs -f）') : tr('在终端里跟踪（docker compose logs -f）')} onClick={() => openTerm(logs.kind === 'c' ? 'follow' : 'composeLogs', logs.id)} className={IB}><SquareTerminal className="h-3.5 w-3.5" /></button>
      </>}
      <button onClick={onClose} className={IB}><X className="h-3.5 w-3.5" /></button>
    </div>
  )

  const note = (text: string, tone: 'muted' | 'bad' = 'muted') => (
    <div className={`px-3 py-3 text-[12px] leading-relaxed ${tone === 'bad' ? 'text-[var(--color-danger)]' : 'text-[var(--color-text-muted)]'}`}>{text}</div>
  )
  const actBtn = (title: string, icon: typeof Play, onClick: () => void) => {
    const I = icon
    return <button title={title} disabled={!!busy} onClick={onClick} className={IB}><I className="h-3 w-3" /></button>
  }
  let body
  if (!ok) body = note(tr('容器视图支持本地终端（本机 Docker）和 Linux / macOS 的 SSH 终端：先切到一个终端再打开。'))
  else if (logs) body = logs.err ? note(logs.err, 'bad') : logs.text === undefined ? note(tr('读取中…'))
    : <pre className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-all p-2.5 font-mono text-[11px] leading-snug text-[var(--color-text-secondary)]">{logs.text || tr('（无日志）')}</pre>
  else if (tab === 'compose') body = !projects ? note(loading ? tr('读取中…') : '') : (
    <div className="min-h-0 flex-1 overflow-y-auto p-1.5" data-compose-list>
      {projects.length === 0 && note(tr('（没有 Compose 项目：docker compose ls 为空）'))}
      {projects.map((p) => {
        const up = /running/i.test(p.status)
        return (
          <div key={p.name} data-compose={p.name} className={`rounded px-2 py-1.5 hover:bg-[var(--color-bg-hover)] ${busy === p.name ? 'animate-pulse' : ''}`}>
            <div className="flex items-center gap-1.5">
              <span title={p.status} className={`h-2 w-2 shrink-0 rounded-full ${up ? 'bg-[var(--color-success)]' : 'bg-[var(--color-text-muted)]'}`} />
              <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-[var(--color-text-primary)]">{p.name}</span>
              <button title={tr('日志（最后 200 行）')} onClick={() => loadLogs({ kind: 'p', id: p.name, name: p.name })} className={IB}><ScrollText className="h-3 w-3" /></button>
              {actBtn(tr(COMPOSE_ACTION_LABEL.up), Play, () => setConfirm({ p, action: 'up' }))}
              {up && actBtn(tr(COMPOSE_ACTION_LABEL.down), Square, () => setConfirm({ p, action: 'down' }))}
              {up && actBtn(tr(COMPOSE_ACTION_LABEL.restart), RotateCcw, () => setConfirm({ p, action: 'restart' }))}
            </div>
            <div className="pl-3.5 text-[10.5px] text-[var(--color-text-muted)]">{p.status}</div>
            {p.configFiles.map((f) => <div key={f} className="truncate pl-3.5 font-mono text-[10.5px] text-[var(--color-text-muted)]" title={f}>{f}</div>)}
          </div>
        )
      })}
    </div>
  )
  else if (!res) body = note(loading ? tr('读取中…') : '')
  else if (res.problem) body = (
    <div className="space-y-2 px-3 py-3 text-[12px] leading-relaxed" data-docker-problem={res.problem}>
      <div className="font-medium text-[var(--color-danger)]">{tr((local ? DOCKER_LOCAL_PROBLEM_TEXT : DOCKER_PROBLEM_TEXT)[res.problem])}</div>
      {!local && res.problem === 'permission' && (res.sudoOk
        ? <button onClick={() => setMode('sudo')} className="rounded border border-[var(--color-border-default)] px-2.5 py-1 text-[12px] text-[var(--color-accent)] hover:bg-[var(--color-bg-hover)]">{tr('该用户有免密 sudo：改用 sudo -n docker 重试')}</button>
        : <div className="text-[var(--color-text-muted)]">{tr('该用户也没有免密 sudo，不会尝试提示输入密码。')}</div>)}
      {mode === 'sudo' && <button onClick={() => setMode('docker')} className="text-[11px] text-[var(--color-text-muted)] underline">{tr('改回 docker')}</button>}
      {res.message && <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-all rounded bg-[var(--color-bg-raised)] p-2 font-mono text-[10.5px] text-[var(--color-text-muted)]">{res.message}</pre>}
    </div>
  )
  else body = (
    <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
      {res.containers?.length === 0 && note(tr('（没有容器）'))}
      {res.containers?.map((c) => {
        const s = stats && statFor(stats, c)
        const running = c.state === 'running' || c.state === 'restarting'
        return (
          <div key={c.id} className={`rounded px-2 py-1.5 hover:bg-[var(--color-bg-hover)] ${busy === c.id ? 'animate-pulse' : ''}`}>
            <div className="flex items-center gap-1.5">
              <span title={c.state} className={`h-2 w-2 shrink-0 rounded-full ${DOT[c.state] ?? 'bg-[var(--color-text-muted)]'}`} />
              <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-[var(--color-text-primary)]" title={`${c.name}\n${c.id}`}>{c.name}</span>
              <button title={tr('日志（最后 200 行）')} onClick={() => loadLogs({ kind: 'c', id: c.id, name: c.name })} className={IB}><ScrollText className="h-3 w-3" /></button>
              {running && <button title={tr('进入容器（新终端标签）')} onClick={() => openTerm('exec', c.id)} className={IB}><LogIn className="h-3 w-3" /></button>}
              {running ? actBtn(tr(DOCKER_ACTION_LABEL.stop), Square, () => setConfirm({ c, action: 'stop' })) : actBtn(tr(DOCKER_ACTION_LABEL.start), Play, () => setConfirm({ c, action: 'start' }))}
              {actBtn(tr(DOCKER_ACTION_LABEL.restart), RotateCcw, () => setConfirm({ c, action: 'restart' }))}
            </div>
            <div className="truncate pl-3.5 text-[11px] text-[var(--color-text-muted)]" title={c.image}>{c.image}</div>
            <div className="flex flex-wrap gap-x-2 pl-3.5 text-[10.5px] text-[var(--color-text-muted)]">
              <span>{c.status}</span>
              {s && <span className="font-mono text-[var(--color-text-secondary)]">CPU {s.cpu} · MEM {s.mem}</span>}
              {c.ports && <span className="w-full truncate font-mono" title={c.ports}>{c.ports}</span>}
              {c.created && <span className="w-full truncate">{tr('创建：{time}', { time: c.created })}</span>}
            </div>
          </div>
        )
      })}
    </div>
  )

  const where = local ? tr('where|本机') : tr('「{title}」上', { title: term?.title ?? '' })
  const cLabel = confirm ? tr('c' in confirm ? DOCKER_ACTION_LABEL[confirm.action] : COMPOSE_ACTION_LABEL[confirm.action]) : ''
  const cTitle = confirm ? ('c' in confirm ? tr('{action}容器', { action: cLabel }) : `Compose ${cLabel}`) : ''
  const cTarget = confirm ? ('c' in confirm ? tr('容器「{name}」', { name: confirm.c.name }) : tr('Compose 项目「{name}」', { name: confirm.p.name })) : ''
  return (
    <div className="flex h-full flex-col">
      {header}
      {ok && !logs && (
        <div className="flex shrink-0 items-center gap-1 border-b border-[var(--color-border-subtle)] px-3 py-1">
          <button data-docker-tab="containers" onClick={() => setTab('containers')} className={cn(TAB, tab === 'containers' ? 'bg-[var(--color-bg-raised)] text-[var(--color-accent)]' : 'text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]')}>
            <Container className="mr-1 inline h-3 w-3" />{tr('容器')}</button>
          <button data-docker-tab="compose" onClick={() => setTab('compose')} className={cn(TAB, tab === 'compose' ? 'bg-[var(--color-bg-raised)] text-[var(--color-accent)]' : 'text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]')}>
            <Layers className="mr-1 inline h-3 w-3" />{tr('Compose 项目')}</button>
        </div>
      )}
      {err && <div className="shrink-0 whitespace-pre-wrap break-all border-b border-[var(--color-border-subtle)] px-3 py-1.5 text-[11px] text-[var(--color-danger)]">{err}</div>}
      {body}
      <ConfirmDialog open={!!confirm}
        title={prod ? tr('生产主机：{title}', { title: cTitle }) : cTitle}
        message={tr('{prod}确定在{where}{action}{target}？操作会记入执行记录。', { prod: prod ? tr('这是生产主机！') : '', where, action: cLabel, target: cTarget })}
        confirmText={prod ? tr('生产主机 · {label}', { label: cLabel }) : cLabel}
        onConfirm={doAction} onCancel={() => setConfirm(undefined)} />
    </div>
  )
}
