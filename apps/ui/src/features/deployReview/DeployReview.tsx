// 「部署评审」：研发给的部署文档 + 产物 → AI 解读成部署清单 → 规则 / AI 找风险 → 目标主机只读预检 → 评审结论 → 导出报告 / 转运维手册。
// 自挂载：App 里常驻 <DeployReviewModal />，openDeployReview(id?) 打开。不能点遮罩关闭（按钮 / Esc）。转运维手册后先关掉自己：手册视图是侧边面板，层级在下面
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  X, ClipboardCheck, Plus, Trash2, Loader2, Sparkles, FileUp, ClipboardPaste, Package, Play, Download, BookOpenText, GitCompare, ChevronRight, ChevronDown, Search, AlertTriangle,
} from 'lucide-react'
import {
  CONCLUSION_LABEL, DEPLOY_PROBE_LABEL, DOC_MAX_CHARS, REVIEW_LEVEL_LABEL, RISK_DECISION_LABEL, dateLocale, docDiff, fmtDateTime, getLocale, groupHosts, reviewMarkdown, suggestConclusion, tk, tr,
  type DeployProbeStatus, type DeployReview, type DeployReviewPatch, type DeployReviewSummary, type HostSummary, type ReviewConclusion, type ReviewLevel, type ReviewRisk, type RiskDecision,
} from '@lingshell/shared'
import { client } from '../../client/index.js'
import { cn } from '../../lib/cn.js'
import { trx } from '../../lib/trx.js'
import { Checkbox } from '../../components/ui/Checkbox.js'
import { Input } from '../../components/ui/Input.js'
import { Select } from '../../components/ui/Select.js'
import { uiLayerOpen } from '../../components/ui/layer.js'
import { ConfirmDialog } from '../common/index.js'
import { HelpTip, INPUT } from '../../components/ui/form.js'
import { BTN, PRIMARY, errText } from '../../components/ui/drawer.js'
import { openRunbookView } from '../runbooks/index.js'
import { DEPLOY_REVIEW_EVENT } from './deployReviewBus.js'

export function DeployReviewModal() {
  const [open, setOpen] = useState<{ id?: string; n: number } | null>(null)
  useEffect(() => {
    const f = (e: Event) => setOpen((o) => ({ id: (e as CustomEvent<string | undefined>).detail, n: (o?.n ?? 0) + 1 }))
    window.addEventListener(DEPLOY_REVIEW_EVENT, f)
    return () => window.removeEventListener(DEPLOY_REVIEW_EVENT, f)
  }, [])
  useEffect(() => client.on((ev) => { if (ev.type === 'app:lock' && ev.locked) setOpen(null) }), [])
  if (!open) return null
  return <Body key={open.n} initial={open.id} onClose={() => setOpen(null)} />
}

const LEVEL_COLOR: Record<ReviewLevel, string> = { high: 'var(--color-danger)', medium: 'var(--color-warn)', low: 'var(--color-text-muted)' }
const PROBE_COLOR: Record<DeployProbeStatus, string> = { pass: 'var(--color-success)', warn: 'var(--color-warn)', fail: 'var(--color-danger)', error: 'var(--color-danger)', skipped: 'var(--color-text-muted)' }
const CONCLUSION_COLOR: Record<ReviewConclusion, string> = { pass: 'var(--color-success)', conditional: 'var(--color-warn)', fail: 'var(--color-danger)' }
const SOURCE_LABEL = { rule: tk('规则'), ai: 'AI', probe: tk('预检') } as const
type Tab = 'doc' | 'plan' | 'risks' | 'probe' | 'report'
const fmtTime = (iso?: string) => (iso ? new Date(iso).toLocaleString(dateLocale(), { hour12: false }) : '')
// 列表里的短时间（月-日 时:分）：中文沿用 fmtTime 截取，英文另按格式输出（en-US 的日期格式截不出来）
const fmtShort = (iso: string) => (getLocale() === 'en' ? new Date(iso).toLocaleString(dateLocale(), { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }) : fmtTime(iso).slice(5, 16))
const fmtSize = (n: number) => (n >= 1 << 30 ? `${(n / (1 << 30)).toFixed(1)} GB` : n >= 1 << 20 ? `${(n / (1 << 20)).toFixed(1)} MB` : n >= 1024 ? `${(n / 1024).toFixed(1)} KB` : `${n} B`)
const tint = (c: string, p = 14) => `color-mix(in srgb, ${c} ${p}%, transparent)`

function Body({ initial, onClose }: { initial?: string; onClose: () => void }) {
  const [list, setList] = useState<DeployReviewSummary[]>([])
  const [cur, setCur] = useState<DeployReview | null>(null)
  const [hosts, setHosts] = useState<HostSummary[]>([])
  const [tab, setTab] = useState<Tab>('doc')
  const [busy, setBusy] = useState<'' | 'analyze' | 'probe' | 'import' | 'artifacts' | 'export'>('')
  const [err, setErr] = useState('')
  const [flash, setFlash] = useState('')
  const [delTarget, setDelTarget] = useState<DeployReviewSummary | null>(null)
  const [prodProbe, setProdProbe] = useState(false)
  const refresh = useCallback(() => client.deployReview.list().then(setList).catch((e) => setErr(errText(e))), [])
  const pick = useCallback((id: string) => { setErr(''); client.deployReview.get(id).then((r) => { setCur(r); setTab(r.plan ? 'risks' : 'doc') }).catch((e) => setErr(errText(e))) }, [])
  useEffect(() => {
    client.hosts.list().then(setHosts).catch(() => {})
    client.deployReview.list().then((l) => { setList(l); const id = initial ?? l[0]?.id; if (id) pick(id) }).catch((e) => setErr(errText(e)))
  }, [initial, pick])
  const rootRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented || uiLayerOpen()) return
      if ([...document.querySelectorAll('.fixed.inset-0')].some((o) => o !== rootRef.current && !rootRef.current?.contains(o))) return
      onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  const note = (s: string) => { setFlash(s); setTimeout(() => setFlash(''), 3000) }

  // 所有改动都回到这里：拿到最新的评审、刷新左侧列表
  const apply = (p: Promise<DeployReview | undefined>, k: typeof busy = '') => {
    setErr(''); if (k) setBusy(k)
    return p.then((r) => { if (r) { setCur(r); void refresh() } return r }).catch((e) => { setErr(errText(e)); return undefined }).finally(() => k && setBusy(''))
  }
  const update = (patch: DeployReviewPatch) => cur && apply(client.deployReview.update(cur.id, patch))
  const create = () => apply(client.deployReview.create()).then((r) => r && setTab('doc'))
  const doDelete = () => {
    const s = delTarget
    setDelTarget(null)
    if (s) client.deployReview.delete(s.id).then(() => { if (cur?.id === s.id) setCur(null); void refresh() }).catch((e) => setErr(errText(e)))
  }
  const analyze = () => cur && apply(client.deployReview.analyze(cur.id), 'analyze').then((r) => { if (r) { setTab('risks'); note(tr('解读完成：{steps} 个步骤，{risks} 条风险', { steps: r.plan?.steps.length ?? 0, risks: r.risks.length })) } })
  const probe = () => { setProdProbe(false); if (cur) void apply(client.deployReview.probe(cur.id), 'probe').then((r) => r && setTab('probe')) }
  const hostLabels = useMemo(() => Object.fromEntries(hosts.map((h) => [h.id, h.label])), [hosts])
  const prodTargets = useMemo(() => (cur ? hosts.filter((h) => h.env === 'prod' && cur.hostIds.includes(h.id)).length : 0), [hosts, cur])
  const probeNeedsConfirm = cur?.env === 'prod' || prodTargets > 0
  const stale = !!cur?.analyzedAt && !!cur.docAt && cur.docAt > cur.analyzedAt
  const openRisks = cur?.risks.filter((x) => x.decision === 'open').length ?? 0

  return (
    <div ref={rootRef} data-deploy-review className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm animate-fade-in">
      <div className="flex h-[92vh] w-[min(1280px,96vw)] flex-col overflow-hidden rounded-xl border border-[var(--color-border-default)] bg-[var(--color-bg-panel)] shadow-2xl">
        <div className="flex shrink-0 items-center gap-2 border-b border-[var(--color-border-subtle)] px-4 py-2">
          <ClipboardCheck className="h-4 w-4 text-[var(--color-accent)]" />
          <span className="text-[13px] font-semibold text-[var(--color-text-primary)]">{tr('部署评审')}</span>
          <HelpTip>{tr('导入研发给的部署文档（Markdown / Word / PDF / 文本，或直接粘贴）和产物，「AI 解读」把文档整理成部署清单（前置条件、步骤、配置与数据库变更、验证、回滚）， 同时用规则和 AI 找风险；「环境预检」在目标主机上只跑只读检查命令，核对环境是否满足要求。逐条给出处理意见、评审结论后导出报告，通过后可一键转成运维手册照着执行。 文档和预检输出发给模型前会按「发给 AI 前脱敏」设置处理。')}</HelpTip>
          {flash && <span className="ml-3 text-[11.5px] text-[var(--color-success)]">{flash}</span>}
          <button onClick={onClose} title={tr('关闭（Esc）')} className="ml-auto flex h-6 w-6 items-center justify-center rounded-md text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)]"><X className="h-4 w-4" /></button>
        </div>
        <div className="flex min-h-0 flex-1">
          {/* 左：评审列表 */}
          <div className="flex w-60 shrink-0 flex-col border-r border-[var(--color-border-subtle)]">
            <div className="p-2"><button data-dr-new onClick={create} className={cn(PRIMARY, 'w-full justify-center')}><Plus className="h-3.5 w-3.5" />{tr('新建评审')}</button></div>
            <div className="min-h-0 flex-1 space-y-0.5 overflow-y-auto px-2 pb-2">
              {!list.length && <div className="px-1 py-3 text-[11.5px] text-[var(--color-text-muted)]">{tr('还没有评审。点「新建评审」，导入部署文档开始')}</div>}
              {list.map((s) => (
                <div key={s.id} data-dr-item={s.title} onClick={() => pick(s.id)}
                  className={cn('group relative cursor-pointer rounded-md px-2 py-1.5', cur?.id === s.id ? 'bg-[var(--color-bg-raised)]' : 'hover:bg-[var(--color-bg-hover)]')}>
                  <div className="flex items-center gap-1">
                    {/* 删除按钮绝对定位、只改透明度：悬停时不占布局，列表项高度和标题宽度都不跳 */}
                    <span className="min-w-0 flex-1 truncate pr-5 text-[12px] text-[var(--color-text-primary)]">{s.title}</span>
                    <button onClick={(e) => { e.stopPropagation(); setDelTarget(s) }} title={tr('删除')}
                      className="absolute right-1 top-1.5 flex h-5 w-5 items-center justify-center rounded text-[var(--color-text-muted)] opacity-0 hover:text-[var(--color-danger)] focus-visible:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100"><Trash2 className="h-3 w-3" /></button>
                  </div>
                  {/* 一行：标签不折行，放不下时状态先截断，时间始终完整 */}
                  <div className="mt-0.5 flex items-center gap-1.5 whitespace-nowrap text-[10.5px] text-[var(--color-text-muted)]">
                    {s.env === 'prod' && <span className="shrink-0 text-[var(--color-danger)]">{tr('生产')}</span>}
                    {s.conclusion ? <span className="min-w-0 truncate" style={{ color: CONCLUSION_COLOR[s.conclusion] }}>{tr(CONCLUSION_LABEL[s.conclusion])}</span> : <span className="min-w-0 truncate">{tr('未评审')}</span>}
                    {s.openHigh > 0 && <span className="shrink-0 text-[var(--color-danger)]">{tr('高风险 {n}', { n: s.openHigh })}</span>}
                    <span className="ml-auto shrink-0">{fmtShort(s.updatedAt)}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
          {/* 右：当前评审 */}
          {!cur ? <div className="flex flex-1 items-center justify-center text-[12px] text-[var(--color-text-muted)]">{err || tr('选择或新建一个评审')}</div> : (
            <div className="flex min-w-0 flex-1 flex-col">
              <div className="flex shrink-0 items-center gap-2 border-b border-[var(--color-border-subtle)] px-3 py-2">
                <TitleInput key={`${cur.id}:${cur.title}`} value={cur.title} onSave={(title) => update({ title })} />
                <Select size="sm" className="w-28" aria-label={tr('目标环境')} value={cur.env} onValueChange={(v) => update({ env: v as 'test' | 'prod' })} options={[{ value: 'test', label: tr('测试环境') }, { value: 'prod', label: tr('生产环境') }]} />
                <button data-dr-analyze onClick={analyze} disabled={!!busy || !cur.docText.trim()} title={cur.docText.trim() ? tr('把文档整理成部署清单并找风险（一次模型调用，长文档约 1–2 分钟）') : tr('先导入部署文档')} className={PRIMARY}>
                  {busy === 'analyze' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}{busy === 'analyze' ? tr('解读中…') : cur.plan ? tr('重新解读') : tr('AI 解读')}
                </button>
                <button data-dr-probe onClick={() => (probeNeedsConfirm ? setProdProbe(true) : probe())} disabled={!!busy || !cur.plan || !cur.hostIds.length}
                  title={!cur.plan ? tr('先 AI 解读，得到检查命令') : !cur.hostIds.length ? tr('先在「文档与产物」里选目标主机') : tr('在目标主机上跑前置条件的只读检查命令')} className={BTN}>
                  {busy === 'probe' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}{busy === 'probe' ? tr('预检中…') : tr('环境预检')}
                </button>
              </div>
              <div className="flex shrink-0 items-center gap-0.5 border-b border-[var(--color-border-subtle)] px-3">
                {([['doc', tr('文档与产物')], ['plan', tr('部署清单')], ['risks', `${tr('风险')}${cur.risks.length ? ` ${cur.risks.length}` : ''}`], ['probe', `${tr('环境预检')}${cur.probes.length ? ` ${cur.probes.length}` : ''}`], ['report', tr('结论与报告')]] as [Tab, string][]).map(([k, label]) => (
                  <button key={k} data-dr-tab={k} onClick={() => setTab(k)} className={cn('-mb-px border-b-2 px-3 py-1.5 text-[12px]', tab === k ? 'border-[var(--color-accent)] text-[var(--color-text-primary)]' : 'border-transparent text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]')}>{label}</button>
                ))}
                {stale && <span className="ml-auto flex items-center gap-1 text-[11px] text-[var(--color-warn)]"><AlertTriangle className="h-3 w-3" />{tr('文档已更新，建议重新解读')}</span>}
              </div>
              {err && <div className="shrink-0 border-b border-[var(--color-border-subtle)] px-3 py-1.5 text-[11.5px] text-[var(--color-danger)]">{err}</div>}
              {busy === 'analyze' && <div className="shrink-0 border-b border-[var(--color-border-subtle)] px-3 py-1.5 text-[11.5px] text-[var(--color-text-muted)]">{tr('正在让模型读文档、整理部署清单、找风险，长文档要 1–2 分钟…')}</div>}
              <div className="min-h-0 flex-1 overflow-y-auto p-3 text-[12px]">
                {tab === 'doc' && <DocTab r={cur} hosts={hosts} busy={busy} apply={apply} update={update} />}
                {tab === 'plan' && <PlanTab r={cur} />}
                {tab === 'risks' && <RisksTab r={cur} update={update} />}
                {tab === 'probe' && <ProbeTab r={cur} />}
                {tab === 'report' && <ReportTab r={cur} hostLabels={hostLabels} openRisks={openRisks} update={update} setErr={setErr} note={note} onClose={onClose} />}
              </div>
            </div>
          )}
        </div>
      </div>
      <ConfirmDialog open={!!delTarget} title={tr('删除评审')} message={tr('确定删除评审「{title}」？文档、清单、风险和评审意见都会删除，不可恢复。', { title: delTarget?.title ?? '' })} onConfirm={doDelete} onCancel={() => setDelTarget(null)} />
      <ConfirmDialog open={prodProbe} title={prodTargets ? tr('在生产主机上预检') : tr('在生产环境预检')} confirmText={tr('开始预检')}
        message={prodTargets
          ? tr('将在 {n} 台目标主机（其中 {prod} 台标记为生产）上执行前置条件检查命令。只执行只读命令（不改任何东西、不用 sudo），其余的会跳过、标为「未执行」。确定开始？', { n: cur?.hostIds.length ?? 0, prod: prodTargets })
          : tr('将在 {n} 台目标主机上执行前置条件检查命令。只执行只读命令（不改任何东西、不用 sudo），其余的会跳过、标为「未执行」。确定开始？', { n: cur?.hostIds.length ?? 0 })}
        onConfirm={probe} onCancel={() => setProdProbe(false)} />
    </div>
  )
}

function TitleInput({ value, onSave }: { value: string; onSave: (v: string) => void }) {
  const [v, setV] = useState(value)
  return <Input size="sm" className="min-w-0 flex-1 font-medium" aria-label={tr('评审标题')} placeholder={tr('评审标题，如 订单服务 v2.1 上线')} value={v} onChange={(e) => setV(e.target.value)}
    onBlur={() => v.trim() !== value && onSave(v.trim())} onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()} />
}

function Section({ title, tip, actions, children }: { title: string; tip?: string; actions?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="mb-4">
      <div className="mb-1.5 flex items-center gap-2">
        <span className="text-[12.5px] font-semibold text-[var(--color-text-primary)]">{title}</span>
        {tip && <HelpTip>{tip}</HelpTip>}
        <div className="ml-auto flex items-center gap-1.5">{actions}</div>
      </div>
      {children}
    </div>
  )
}
const Empty = ({ children }: { children: React.ReactNode }) => <div className="rounded-md border border-dashed border-[var(--color-border-subtle)] px-3 py-5 text-center text-[11.5px] text-[var(--color-text-muted)]">{children}</div>
const TruncNote = () => (
  <div data-dr-truncated className="mb-2 rounded-md px-2.5 py-1.5 text-[11.5px]" style={{ color: 'var(--color-warn)', background: tint('var(--color-warn)', 10) }}>
    {/* 中文按「万字」计，英文直接写字符数 */}
    {tr('文档超过 {n} 万字，AI 只解读了前面一部分：后面的步骤没有进入清单和 AI 风险检查，请人工核对（规则检查覆盖全文）。', { n: getLocale() === 'en' ? DOC_MAX_CHARS.toLocaleString(dateLocale()) : DOC_MAX_CHARS / 10_000 })}
  </div>
)
const Pre = ({ children, max = 'max-h-60' }: { children: string; max?: string }) => <pre className={cn('overflow-auto whitespace-pre-wrap break-all rounded-md bg-[var(--color-bg-base)] px-2.5 py-1.5 font-mono text-[11px] text-[var(--color-text-secondary)]', max)}>{children}</pre>

// ── 文档与产物 ──
function DocTab({ r, hosts, busy, apply, update }: { r: DeployReview; hosts: HostSummary[]; busy: string; apply: (p: Promise<DeployReview | undefined>, k?: '' | 'import' | 'artifacts') => Promise<DeployReview | undefined>; update: (p: DeployReviewPatch) => unknown }) {
  const [paste, setPaste] = useState<{ name: string; text: string } | null>(null)
  const [showDiff, setShowDiff] = useState(false)
  const [openArt, setOpenArt] = useState<string | null>(null)
  const prev = r.history.at(-1)
  const diff = useMemo(() => (showDiff && prev ? docDiff(prev.text, r.docText) : null), [showDiff, prev, r.docText])
  return (
    <>
      <Section title={tr('部署文档')} tip={tr('支持 Markdown、Word（.docx）、PDF、纯文本 / HTML，也可以直接粘贴。重新导入会保留旧版本，可以和上一版对比改了什么')}
        actions={<>
          {prev && <button onClick={() => setShowDiff(!showDiff)} className={BTN}><GitCompare className="h-3.5 w-3.5" />{showDiff ? tr('看全文') : tr('与上一版对比')}</button>}
          <button onClick={() => setPaste(paste ? null : { name: '', text: '' })} className={BTN}><ClipboardPaste className="h-3.5 w-3.5" />{tr('粘贴文本')}</button>
          <button data-dr-import onClick={() => apply(client.deployReview.importDoc(r.id), 'import')} disabled={!!busy} className={PRIMARY}>{busy === 'import' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <FileUp className="h-3.5 w-3.5" />}{tr('导入文件')}</button>
        </>}>
        {paste && (
          <div className="mb-2 space-y-1.5 rounded-md border border-[var(--color-border-default)] p-2.5">
            <Input size="sm" placeholder={tr('文档名称（可空）')} value={paste.name} onChange={(e) => setPaste({ ...paste, name: e.target.value })} />
            <textarea data-dr-paste className={cn(INPUT, 'h-48 w-full resize-y font-mono text-[11.5px]')} placeholder={tr('把部署文档内容粘贴到这里')} value={paste.text} onChange={(e) => setPaste({ ...paste, text: e.target.value })} />
            <div className="flex justify-end gap-1.5">
              <button onClick={() => setPaste(null)} className={BTN}>{tr('取消')}</button>
              <button disabled={!paste.text.trim()} onClick={() => apply(client.deployReview.pasteDoc(r.id, paste.name, paste.text)).then((x) => x && setPaste(null))} className={PRIMARY}>{tr('保存')}</button>
            </div>
          </div>
        )}
        {!r.docText ? <Empty>{tr('还没有文档。点「导入文件」或「粘贴文本」')}</Empty> : (
          <>
            <div className="mb-1 text-[11px] text-[var(--color-text-muted)]">{r.docName} · {tr('{n} 字', { n: r.docText.length.toLocaleString(dateLocale()) })}{r.history.length ? ` · ${tr('第 {n} 版', { n: r.history.length + 1 })}` : ''}{r.docAt ? ` · ${tr('导入于 {at}', { at: fmtTime(r.docAt) })}` : ''}</div>
            {diff ? (
              <div data-dr-diff>
                <div className="mb-1 text-[11px] text-[var(--color-text-muted)]">{trx('和上一版《{name}》相比：{added} 行 / {removed} 行', { name: prev!.name, added: <span className="text-[var(--color-success)]">+{diff.added}</span>, removed: <span className="text-[var(--color-danger)]">−{diff.removed}</span> })}</div>
                <pre className="max-h-[50vh] overflow-auto rounded-md bg-[var(--color-bg-base)] py-1.5 font-mono text-[11px]">
                  {diff.lines.map((l, i) => <div key={i} className="whitespace-pre-wrap break-all px-2.5" style={l.t === ' ' ? { color: 'var(--color-text-muted)' } : { color: l.t === '+' ? 'var(--color-success)' : 'var(--color-danger)', background: tint(l.t === '+' ? 'var(--color-success)' : 'var(--color-danger)', 10) }}>{l.t} {l.s}</div>)}
                </pre>
              </div>
            ) : <Pre max="max-h-[40vh]">{r.docText}</Pre>}
          </>
        )}
      </Section>
      <Section title={tr('部署产物')} tip={tr('选研发给的安装包 / 镜像包 / 脚本等：算 sha256、列出压缩包里的文件（300MB 以内），和文档里写的版本号、校验值对照。文件本身不会上传')}
        actions={<button data-dr-artifacts onClick={() => apply(client.deployReview.addArtifacts(r.id), 'artifacts')} disabled={!!busy} className={BTN}>{busy === 'artifacts' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Package className="h-3.5 w-3.5" />}{busy === 'artifacts' ? tr('计算校验值…') : tr('添加产物')}</button>}>
        {!r.artifacts.length ? <Empty>{tr('没有产物（可选）')}</Empty> : (
          <div className="space-y-1">
            {r.artifacts.map((a) => (
              <div key={a.name} className="rounded-md border border-[var(--color-border-subtle)] px-2.5 py-1.5">
                <div className="flex items-center gap-2">
                  {a.entries?.length ? <button onClick={() => setOpenArt(openArt === a.name ? null : a.name)} className="text-[var(--color-text-muted)]">{openArt === a.name ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}</button> : <Package className="h-3.5 w-3.5 text-[var(--color-text-muted)]" />}
                  <span className="truncate font-mono text-[var(--color-text-primary)]">{a.name}</span>
                  <span className="shrink-0 text-[11px] text-[var(--color-text-muted)]">{fmtSize(a.size)}{a.entries ? ` · ${tr('{n} 个文件', { n: a.entries.length })}` : ''}</span>
                  <button onClick={() => apply(client.deployReview.removeArtifact(r.id, a.name))} title={tr('移除')} className="ml-auto text-[var(--color-text-muted)] hover:text-[var(--color-danger)]"><Trash2 className="h-3 w-3" /></button>
                </div>
                <div className="mt-0.5 select-text break-all font-mono text-[10.5px] text-[var(--color-text-muted)]">sha256 {a.sha256}</div>
                {openArt === a.name && a.entries && <Pre max="max-h-40">{a.entries.join('\n')}</Pre>}
              </div>
            ))}
          </div>
        )}
      </Section>
      <Section title={tr('目标主机')} tip={tr('「环境预检」在这些主机上跑检查命令；也会写进评审报告')}>
        <HostPicker hosts={hosts} picked={r.hostIds} onChange={(hostIds) => update({ hostIds })} />
      </Section>
    </>
  )
}

function HostPicker({ hosts, picked, onChange }: { hosts: HostSummary[]; picked: string[]; onChange: (ids: string[]) => void }) {
  const [q, setQ] = useState('')
  const ql = q.trim().toLowerCase()
  const groups = useMemo(() => groupHosts(hosts.filter((h) => !ql || [h.label, h.host, h.group].some((x) => x?.toLowerCase().includes(ql)))), [hosts, ql])
  const toggle = (ids: string[], on: boolean) => onChange(on ? [...new Set([...picked, ...ids])] : picked.filter((x) => !ids.includes(x)))
  if (!hosts.length) return <Empty>{tr('还没有已保存的主机')}</Empty>
  return (
    <div className="rounded-md border border-[var(--color-border-subtle)]">
      <div className="relative border-b border-[var(--color-border-subtle)] p-1.5">
        <Search className="pointer-events-none absolute left-3.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[var(--color-text-muted)]" />
        <Input size="sm" className="pl-7" value={q} placeholder={tr('搜索主机 / 分组')} aria-label={tr('搜索主机')} onChange={(e) => setQ(e.target.value)} />
      </div>
      <div className="grid max-h-48 grid-cols-2 gap-x-4 overflow-y-auto p-2">
        {groups.map((g) => {
          const ids = g.hosts.map((h) => h.id)
          const sel = ids.filter((x) => picked.includes(x)).length
          return (
            <div key={g.group} className="mb-1">
              <label className="flex cursor-pointer items-center gap-1.5 rounded px-1 py-0.5 font-medium text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)]">
                <Checkbox checked={sel === ids.length ? true : sel ? 'indeterminate' : false} onCheckedChange={(v) => toggle(ids, v)} aria-label={tr('整组 {group}', { group: g.group || tr('未分组') })} />{g.group || tr('未分组')}
              </label>
              {g.hosts.map((h) => (
                <label key={h.id} data-dr-host={h.label} className="ml-4 flex cursor-pointer items-center gap-1.5 rounded px-1 py-0.5 text-[var(--color-text-primary)] hover:bg-[var(--color-bg-hover)]">
                  <Checkbox checked={picked.includes(h.id)} onCheckedChange={(v) => toggle([h.id], v)} aria-label={h.label} /><span className="truncate">{h.label}</span>
                  {h.env === 'prod' && <span className="shrink-0 text-[10px] text-[var(--color-danger)]">{tr('生产')}</span>}
                </label>
              ))}
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ── 部署清单 ──
function PlanTab({ r }: { r: DeployReview }) {
  const p = r.plan
  if (!p) return <Empty>{tr('还没有部署清单。导入文档后点「AI 解读」')}</Empty>
  const list = (xs: string[]) => (xs.length ? <ul className="list-disc space-y-0.5 pl-5 text-[var(--color-text-secondary)]">{xs.map((x, i) => <li key={i}>{x}</li>)}</ul> : <div className="text-[var(--color-text-muted)]">{tr('文档没写')}</div>)
  return (
    <div data-dr-plan>
      <div className="mb-3 text-[11px] text-[var(--color-text-muted)]">{tr('解读于 {at}', { at: fmtTime(r.analyzedAt) })}</div>
      {r.planTruncated && <TruncNote />}
      {p.summary && <Section title={tr('概述')}><div className="text-[var(--color-text-secondary)]">{p.summary}</div></Section>}
      <Section title={tr('前置条件')} tip={tr('「检查命令」由 AI 生成；环境预检只执行其中的只读命令')}>
        {!p.prerequisites.length ? <div className="text-[var(--color-text-muted)]">{tr('文档没写')}</div> : (
          <table className="w-full border-collapse text-[11.5px]">
            <thead><tr className="text-left text-[var(--color-text-muted)]"><th className="py-1 pr-2 font-medium">{tr('检查项')}</th><th className="py-1 pr-2 font-medium">{tr('要求')}</th><th className="py-1 font-medium">{tr('检查命令')}</th></tr></thead>
            <tbody>{p.prerequisites.map((x, i) => (
              <tr key={i} className="border-t border-[var(--color-border-subtle)] align-top">
                <td className="py-1 pr-2 text-[var(--color-text-primary)]">{x.item}</td><td className="py-1 pr-2 text-[var(--color-text-secondary)]">{x.requirement}</td>
                <td className="break-all py-1 font-mono text-[11px] text-[var(--color-text-secondary)]">{x.check || '—'}</td>
              </tr>
            ))}</tbody>
          </table>
        )}
      </Section>
      <Section title={tr('部署步骤')}>
        {!p.steps.length ? <div className="text-[var(--color-text-muted)]">{tr('文档没写')}</div> : (
          <ol className="space-y-2">
            {p.steps.map((s, i) => (
              <li key={i} className="flex gap-2">
                <span className="mt-px flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-[var(--color-bg-raised)] text-[10.5px] text-[var(--color-text-muted)]">{i + 1}</span>
                <div className="min-w-0 flex-1 space-y-1">
                  <div className="text-[var(--color-text-primary)]">{s.title}{s.downtime && <span className="ml-1.5 rounded px-1 text-[10px]" style={{ color: 'var(--color-warn)', background: tint('var(--color-warn)') }}>{tr('中断服务')}</span>}</div>
                  {s.command && <Pre max="max-h-40">{s.command}</Pre>}
                  {s.rollback && <div className="text-[11px] text-[var(--color-text-muted)]">{tr('回滚：{text}', { text: s.rollback })}</div>}
                </div>
              </li>
            ))}
          </ol>
        )}
      </Section>
      <div className="grid grid-cols-2 gap-x-6">
        <Section title={tr('配置变更')}>{list(p.configChanges)}</Section>
        <Section title={tr('数据库变更')}>{list(p.dbChanges)}</Section>
        <Section title={tr('验证方法')}>{list(p.verify)}</Section>
        <Section title={tr('回滚方案')}>{list(p.rollback)}</Section>
      </div>
    </div>
  )
}

// ── 风险 ──
const DECISIONS: RiskDecision[] = ['open', 'accept', 'ignore', 'rework']
function RisksTab({ r, update }: { r: DeployReview; update: (p: DeployReviewPatch) => unknown }) {
  const [lv, setLv] = useState<ReviewLevel | 'all'>('all')
  if (!r.risks.length) return <Empty>{r.plan ? tr('没有发现风险') : tr('还没有分析。导入文档后点「AI 解读」')}</Empty>
  const shown = r.risks.filter((x) => lv === 'all' || x.level === lv)
  const n = (l: ReviewLevel) => r.risks.filter((x) => x.level === l).length
  return (
    <div data-dr-risks>
      <div className="mb-2 flex items-center gap-1">
        {(['all', 'high', 'medium', 'low'] as const).map((k) => (
          <button key={k} onClick={() => setLv(k)} className={cn('rounded-md px-2 py-0.5 text-[11.5px]', lv === k ? 'bg-[var(--color-bg-raised)] text-[var(--color-text-primary)]' : 'text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]')}>
            {k === 'all' ? tr('全部 {n}', { n: r.risks.length }) : `${tr(REVIEW_LEVEL_LABEL[k])} ${n(k)}`}
          </button>
        ))}
        <span className="ml-auto text-[11px] text-[var(--color-text-muted)]">{tr('待处理 {n}', { n: r.risks.filter((x) => x.decision === 'open').length })}</span>
      </div>
      {r.planTruncated && <TruncNote />}
      <div className="space-y-2">{shown.map((x) => <RiskCard key={x.id} x={x} onDecide={(decision, note) => update({ decisions: { [x.id]: { decision, ...(note !== undefined ? { note } : {}) } } })} />)}</div>
    </div>
  )
}

function RiskCard({ x, onDecide }: { x: ReviewRisk; onDecide: (d: RiskDecision, note?: string) => void }) {
  const [noteV, setNoteV] = useState(x.note ?? '')
  const c = LEVEL_COLOR[x.level]
  return (
    <div data-dr-risk={x.title} className="rounded-md border border-[var(--color-border-subtle)] px-3 py-2" style={{ borderLeft: `3px solid ${c}` }}>
      <div className="flex items-start gap-2">
        <span className="mt-px shrink-0 rounded px-1 text-[10.5px] font-medium" style={{ color: c, background: tint(c) }}>{tr(REVIEW_LEVEL_LABEL[x.level])}</span>
        <div className="min-w-0 flex-1">
          <div className="font-medium text-[var(--color-text-primary)]">{tr(x.title)}</div>
          <div className="mt-0.5 text-[11.5px] text-[var(--color-text-secondary)]">{tr(x.detail)}</div>
        </div>
        <span className="shrink-0 text-[10.5px] text-[var(--color-text-muted)]">{tr(x.category)} · {tr(SOURCE_LABEL[x.source])}</span>
      </div>
      {x.evidence && <div className="mt-1.5"><Pre max="max-h-32">{x.evidence}</Pre></div>}
      {x.suggestion && <div className="mt-1.5 text-[11.5px] text-[var(--color-text-secondary)]"><span className="mr-1 text-[var(--color-text-muted)]">{tr('dr|建议')}</span>{tr(x.suggestion)}</div>}
      <div className="mt-2 flex items-center gap-1">
        {DECISIONS.map((d) => (
          <button key={d} data-dr-decide={d} onClick={() => onDecide(d, noteV.trim())} className={cn('rounded px-2 py-0.5 text-[11px]', x.decision === d ? 'bg-[var(--color-accent)] text-[var(--color-bg-base)]' : 'border border-[var(--color-border-default)] text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)]')}>{tr(RISK_DECISION_LABEL[d])}</button>
        ))}
        <Input size="sm" className="ml-2 h-6 min-w-0 flex-1 text-[11px]" placeholder={x.decision === 'ignore' ? tr('忽略的理由（会写进报告）') : tr('备注（可空，会写进报告）')} value={noteV}
          onChange={(e) => setNoteV(e.target.value)} onBlur={() => noteV.trim() !== (x.note ?? '') && onDecide(x.decision, noteV.trim())} />
      </div>
    </div>
  )
}

// ── 环境预检 ──
function ProbeTab({ r }: { r: DeployReview }) {
  const [open, setOpen] = useState<number | null>(null)
  if (!r.probes.length) return <Empty>{!r.plan ? tr('先「AI 解读」得到前置条件和检查命令') : !r.hostIds.length ? tr('先在「文档与产物」里选目标主机，再点「环境预检」') : tr('点上方「环境预检」，在目标主机上跑只读检查')}</Empty>
  const count = (s: DeployProbeStatus) => r.probes.filter((x) => x.status === s).length
  return (
    <div data-dr-probes>
      <div className="mb-2 flex items-center gap-3 text-[11px] text-[var(--color-text-muted)]">
        <span>{tr('检查于 {at}', { at: fmtTime(r.probedAt) })}</span>
        {(['pass', 'warn', 'fail', 'error', 'skipped'] as const).map((s) => count(s) ? <span key={s} style={{ color: PROBE_COLOR[s] }}>{tr(DEPLOY_PROBE_LABEL[s])} {count(s)}</span> : null)}
      </div>
      <table className="w-full border-collapse text-[11.5px]">
        <thead><tr className="text-left text-[var(--color-text-muted)]"><th className="py-1 pr-2 font-medium">{tr('主机')}</th><th className="py-1 pr-2 font-medium">{tr('检查项')}</th><th className="py-1 pr-2 font-medium">{tr('要求')}</th><th className="py-1 pr-2 font-medium">{tr('结果')}</th><th className="py-1 font-medium">{tr('说明')}</th></tr></thead>
        <tbody>
          {r.probes.map((x, i) => (
            <FragmentRow key={i} open={open === i} onToggle={() => setOpen(open === i ? null : i)} x={x} />
          ))}
        </tbody>
      </table>
    </div>
  )
}
function FragmentRow({ x, open, onToggle }: { x: DeployReview['probes'][number]; open: boolean; onToggle: () => void }) {
  return (
    <>
      <tr data-dr-probe-row={`${x.hostLabel}:${x.item}`} data-status={x.status} onClick={onToggle} className="cursor-pointer border-t border-[var(--color-border-subtle)] align-top hover:bg-[var(--color-bg-hover)]">
        <td className="py-1 pr-2 text-[var(--color-text-primary)]">{x.hostLabel}</td>
        <td className="py-1 pr-2 text-[var(--color-text-primary)]">{x.item}</td>
        <td className="py-1 pr-2 text-[var(--color-text-secondary)]">{x.requirement}</td>
        <td className="py-1 pr-2 font-medium" style={{ color: PROBE_COLOR[x.status] }}>{tr(DEPLOY_PROBE_LABEL[x.status])}</td>
        <td className="py-1 text-[var(--color-text-secondary)]">{x.note ? tr(x.note) : x.output.split('\n')[0]}</td>
      </tr>
      {open && <tr><td colSpan={5} className="pb-2"><Pre max="max-h-48">{`$ ${x.command}${x.code !== undefined ? `   ${tr('（退出码 {code}）', { code: x.code })}` : ''}\n${x.output || tr('（无输出）')}`}</Pre></td></tr>}
    </>
  )
}

// ── 结论与报告 ──
function ReportTab({ r, hostLabels, openRisks, update, setErr, note, onClose }: { r: DeployReview; hostLabels: Record<string, string>; openRisks: number; update: (p: DeployReviewPatch) => unknown; setErr: (s: string) => void; note: (s: string) => void; onClose: () => void }) {
  const [reviewer, setReviewer] = useState(r.reviewer)
  const [opinion, setOpinion] = useState(r.opinion)
  const [exporting, setExporting] = useState(false)
  const sug = suggestConclusion(r)
  // 文件名用本地日期：早上 8 点前 UTC 还是前一天，导出文件会标错日期
  const name = tr('部署评审-{title}-{date}', { title: (r.title || r.docName || tr('未命名')).replace(/[\\/:*?"<>|]/g, '_'), date: fmtDateTime(Date.now()).slice(0, 10) })
  const md = () => reviewMarkdown(r, hostLabels)
  const html = async () => (await import('../chat/reportHtml.js')).markdownToHtml(tr('部署评审报告：{title}', { title: r.title || r.docName }), md())
  const save = (p: Promise<string | undefined>) => { setExporting(true); p.then((f) => f && note(tr('已导出：{f}', { f }))).catch((e) => setErr(errText(e))).finally(() => setExporting(false)) }
  return (
    <div data-dr-report className="max-w-3xl">
      <Section title={tr('评审结论')} tip={tr('系统按待处理 / 退回的风险给出建议：还有高风险或退回研发的 → 不通过；还有其他待处理的 → 有条件通过；都处理了 → 通过。最终以你选的为准')}>
        <div className="flex items-center gap-1.5">
          {(['pass', 'conditional', 'fail'] as const).map((c) => (
            <button key={c} data-dr-conclusion={c} onClick={() => update({ conclusion: r.conclusion === c ? null : c })}
              className={cn('rounded-md border px-3 py-1 text-[12px]', r.conclusion === c ? 'font-medium' : 'border-[var(--color-border-default)] text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)]')}
              style={r.conclusion === c ? { color: CONCLUSION_COLOR[c], borderColor: CONCLUSION_COLOR[c], background: tint(CONCLUSION_COLOR[c], 12) } : undefined}>{tr(CONCLUSION_LABEL[c])}</button>
          ))}
          <span className="ml-2 text-[11px] text-[var(--color-text-muted)]">{trx('建议：{c}', { c: <span style={{ color: CONCLUSION_COLOR[sug] }}>{tr(CONCLUSION_LABEL[sug])}</span> })}{openRisks ? tr('（还有 {n} 条风险待处理）', { n: openRisks }) : ''}</span>
        </div>
      </Section>
      <Section title={tr('评审人')}>
        <Input size="sm" className="w-60" placeholder={tr('姓名')} value={reviewer} onChange={(e) => setReviewer(e.target.value)} onBlur={() => reviewer.trim() !== r.reviewer && update({ reviewer: reviewer.trim() })} />
      </Section>
      <Section title={tr('评审意见')} tip={tr('写进报告的总体意见，如上线前必须完成的整改项、上线时间窗口要求等')}>
        <textarea data-dr-opinion className={cn(INPUT, 'h-28 w-full resize-y')} placeholder={tr('总体意见（可空）')} value={opinion} onChange={(e) => setOpinion(e.target.value)} onBlur={() => opinion !== r.opinion && update({ opinion })} />
      </Section>
      <Section title={tr('导出报告')} tip={tr('报告包括结论与意见、风险清单及处理意见、环境预检结果、部署清单和产物')}>
        <div className="flex items-center gap-1.5">
          <button data-dr-export="md" disabled={exporting} onClick={() => save(client.system.saveTextFile(`${name}.md`, md()))} className={BTN}><Download className="h-3.5 w-3.5" />Markdown</button>
          <button data-dr-export="html" disabled={exporting} onClick={() => save(html().then((h) => client.system.saveTextFile(`${name}.html`, h)))} className={BTN}><Download className="h-3.5 w-3.5" />HTML</button>
          <button data-dr-export="pdf" disabled={exporting} onClick={() => save(html().then((h) => client.deployReview.exportPdf(h, `${name}.pdf`)))} className={BTN}>{exporting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}PDF</button>
        </div>
      </Section>
      <Section title={tr('上线执行')} tip={tr('把前置检查、部署步骤、验证方法转成运维手册：在手册视图里逐条执行到终端，记录每步结果。生成后可在「设置 → 运维手册」里修改')}>
        <button data-dr-runbook disabled={!r.plan?.steps.length} onClick={() => client.deployReview.toRunbook(r.id).then((id) => { onClose(); openRunbookView(id) }).catch((e) => setErr(errText(e)))} className={BTN}>
          <BookOpenText className="h-3.5 w-3.5" />{tr('转成运维手册')}
        </button>
        {r.conclusion === 'fail' && <span className="ml-2 text-[11px] text-[var(--color-danger)]">{tr('评审结论是不通过，建议整改后重新评审再上线')}</span>}
      </Section>
    </div>
  )
}
