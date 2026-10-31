import { useState } from 'react'
import { FileDiff, Download, Loader2 } from 'lucide-react'
import { dateLocale, tr, type ProfileDiff, type FileChange, type ListenPort } from '@lingshell/shared'
import { client } from '../../client/index.js'
import { cn } from '../../lib/cn.js'
import { DiffView } from '../../components/DiffView.js'

// 两份主机档案的差异明细：体检「和上次比」与对话里「本轮主机变化」共用。
// 配置文件可「查看差异」（两次都缓存了内容才行）；缓存不全时给「拉取当前内容」和上次缓存比（需要该主机在线终端）

export const errText = (e: unknown) => String((e as { message?: string })?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
export const fmtTime = (iso: string) => new Date(iso).toLocaleString(dateLocale(), { hour12: false })
export const BTN = 'flex shrink-0 items-center gap-1 rounded border border-[var(--color-border-default)] px-1.5 py-0.5 text-[10.5px] text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-bg-hover)] disabled:opacity-40'

const tone = {
  add: 'text-[var(--color-success)] bg-[color:color-mix(in_srgb,var(--color-success)_10%,transparent)]',
  del: 'text-[var(--color-danger)] bg-[color:color-mix(in_srgb,var(--color-danger)_10%,transparent)]',
  mod: 'text-[var(--color-warn)] bg-[color:color-mix(in_srgb,var(--color-warn)_10%,transparent)]',
}
const Tag = ({ t, children }: { t: keyof typeof tone; children: React.ReactNode }) => <span className={cn('shrink-0 rounded px-1 text-[10px]', tone[t])}>{children}</span>
const portText = (p: ListenPort) => `${p.addr}:${p.port}${p.process ? tr('（{s}）', { s: p.process }) : ''}`

function Line({ t, tag, children }: { t: keyof typeof tone; tag: string; children: React.ReactNode }) {
  return <div className="flex items-baseline gap-1.5 py-[1px] text-[11px]"><Tag t={t}>{tag}</Tag><span className="min-w-0 break-all text-[var(--color-text-secondary)]">{children}</span></div>
}

function FileRow({ f, hostKey, terminalId, legend }: { f: FileChange; hostKey: string; terminalId?: string; legend: string }) {
  const [st, setSt] = useState<{ diff?: string; error?: string; legend?: string; loading?: boolean }>()
  const show = () => {
    if (st) { setSt(undefined); return }
    setSt({ loading: true })
    client.hostCheck.fileDiff(hostKey, f.path, f.from, f.to).then((r) => setSt({ diff: r.diff, legend }), (e) => setSt({ error: errText(e) }))
  }
  const fetchNow = () => {
    if (!terminalId) return
    setSt({ loading: true })
    client.hostCheck.fetchFile(terminalId, f.path, f.from).then(
      (r) => setSt({ diff: r.diff, legend: r.noBase ? tr('没有上次的缓存，显示远端当前全文') : tr('上次缓存 → 远端当前') }),
      (e) => setSt({ error: errText(e) }))
  }
  const name = f.path.split('/').pop()
  return (
    <div data-drift-file={f.path} className="py-[1px]">
      <div className="flex items-center gap-1.5 text-[11px]">
        <Tag t={f.kind === 'modified' ? 'mod' : f.kind === 'added' ? 'add' : 'del'}>{f.kind === 'modified' ? tr('tag|已修改') : f.kind === 'added' ? tr('tag|新出现') : tr('tag|已消失')}</Tag>
        <span className="flex min-w-0 flex-1 items-baseline gap-1.5 font-mono" title={f.path}>
          <span className="shrink-0 text-[var(--color-text-primary)]">{name}</span>
          <span className="min-w-0 truncate text-[10.5px] text-[var(--color-text-muted)]">{f.path.replace(/\/[^/]*$/, '')}</span>
        </span>
        <button onClick={show} className={BTN}><FileDiff className="h-3 w-3" />{st && !st.loading ? tr('收起') : f.kind === 'modified' ? tr('查看差异') : tr('查看内容')}</button>
      </div>
      {st?.loading && <div className="mt-0.5 flex items-center gap-1 text-[10.5px] text-[var(--color-text-muted)]"><Loader2 className="h-3 w-3 animate-spin" />{tr('读取中…')}</div>}
      {st?.error && (
        <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[10.5px] text-[var(--color-warn)]">
          <span>{st.error}</span>
          {terminalId && f.kind !== 'removed' && <button data-fetch-current onClick={fetchNow} className={BTN}><Download className="h-3 w-3" />{tr('拉取当前内容')}</button>}
        </div>
      )}
      {st?.diff !== undefined && <DiffView diff={st.diff} legend={st.legend} />}
    </div>
  )
}

/** 差异明细；没有任何变化时显示 empty（默认「没有变化」，legend 默认「上次 → 本次」） */
export function ProfileDiffView({ diff: d, hostKey, terminalId, empty: emptyProp, legend: legendProp }: { diff?: ProfileDiff; hostKey: string; terminalId?: string; empty?: string; legend?: string }) {
  const empty = emptyProp ?? tr('没有变化')
  const legend = legendProp ?? tr('上次 → 本次')
  if (!d) return <div className="text-[11px] text-[var(--color-text-muted)]">{empty}</div>
  const rows = [
    ...d.portsAdded.map((p) => <Line key={`pa${portText(p)}`} t="add" tag={tr('新端口')}>{portText(p)}</Line>),
    ...d.portsRemoved.map((p) => <Line key={`pr${portText(p)}`} t="del" tag={tr('端口消失')}>{portText(p)}</Line>),
    ...d.servicesFailed.map((u) => <Line key={`sf${u}`} t="del" tag={tr('新失败服务')}>{u}</Line>),
    ...d.servicesRecovered.map((u) => <Line key={`sr${u}`} t="add" tag={tr('服务恢复')}>{u}</Line>),
    ...d.containersAdded.map((c) => <Line key={`ca${c.name}`} t="add" tag={tr('新容器')}>{tr('{name}（{image}，{state}）', { name: c.name, image: c.image, state: c.state })}</Line>),
    ...d.containersRemoved.map((c) => <Line key={`cr${c.name}`} t="del" tag={tr('容器消失')}>{tr('{name}（{image}）', { name: c.name, image: c.image })}</Line>),
    ...d.containersChanged.map((c) => <Line key={`cc${c.name}`} t="mod" tag={tr('容器变化')}>{c.name}{tr('：')}{c.from.image === c.to.image ? '' : `${c.from.image} → ${c.to.image} `}{c.from.state === c.to.state ? '' : `${c.from.state} → ${c.to.state}`}</Line>),
    ...d.uid0Added.map((u) => <Line key={`u${u}`} t="del" tag={tr('新增 UID0')}>{u}</Line>),
    ...d.newLoginIps.map((ip) => <Line key={`ip${ip}`} t="mod" tag={tr('新登录来源')}>{ip}</Line>),
    ...d.disks.map((x) => <Line key={`d${x.mount}`} t="mod" tag={tr('磁盘')}>{tr('{mount}：{from}% → {to}%', { mount: x.mount, from: x.from, to: x.to })}</Line>),
  ]
  if (!rows.length && !d.files.length) return <div className="text-[11px] text-[var(--color-text-muted)]">{empty}</div>
  return (
    <div data-profile-diff>
      {rows}
      {d.files.map((f) => <FileRow key={f.path} f={f} hostKey={hostKey} terminalId={terminalId} legend={legend} />)}
    </div>
  )
}
