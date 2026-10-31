// Git 面板的 AI 功能：更新日志（两个版本之间的提交整理成发布说明）、审查已暂存的改动。都是一次性模型调用，发给模型前脱敏
import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Check, Copy, Download, FileText, Loader2, ShieldCheck, Sparkles, X } from 'lucide-react'
import { tk, tr, type GitRef, type GitReviewResult, type ReviewIssueLevel } from '@lingshell/shared'
import { client } from '../../client/index.js'
import { Select } from '../../components/ui/Select.js'
import { IB, errText, type GitCtx } from './gitUi.js'

function Frame({ title, icon, sub, onClose, children, actions }: { title: string; icon: React.ReactNode; sub?: React.ReactNode; onClose: () => void; children: React.ReactNode; actions?: React.ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose() } }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])
  return createPortal((
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/55 backdrop-blur-sm animate-fade-in">
      <div data-git-ai className="flex h-[82vh] w-[min(900px,92vw)] flex-col overflow-hidden rounded-lg border border-[var(--color-border-default)] bg-[var(--color-bg-panel)] shadow-2xl">
        <div className="flex h-10 shrink-0 items-center gap-2 border-b border-[var(--color-border-subtle)] px-3">
          {icon}<span className="text-[13px] font-semibold text-[var(--color-text-primary)]">{title}</span>{sub}
          <span className="ml-auto" />{actions}
          <button onClick={onClose} title={tr('关闭（Esc）')} className={IB}><X className="h-4 w-4" /></button>
        </div>
        {children}
      </div>
    </div>
  ), document.body)
}

function Result({ md, loading, err, hint }: { md?: string; loading: boolean; err: string; hint: string }) {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-5 py-3" data-git-ai-result>
      {err && <div className="text-[12px] text-[var(--color-danger)]">{err}</div>}
      {loading && <div className="flex items-center gap-1.5 text-[12px] text-[var(--color-text-muted)]"><Loader2 className="h-3.5 w-3.5 animate-spin" />{hint}</div>}
      {md && !loading && <div className="markdown-body break-words text-[12.5px]"><Markdown remarkPlugins={[remarkGfm]}>{md}</Markdown></div>}
    </div>
  )
}

function useCopy() {
  const [done, setDone] = useState(false)
  return { done, copy: (s: string) => navigator.clipboard?.writeText(s).then(() => { setDone(true); setTimeout(() => setDone(false), 1500) }) }
}

export function GitChangelog({ ctx, from: from0, onClose }: { ctx: GitCtx; from?: string; onClose: () => void }) {
  const [refs, setRefs] = useState<GitRef[]>([])
  const [from, setFrom] = useState(from0 ?? '')
  const [to, setTo] = useState('HEAD')
  const [audience, setAudience] = useState<'ops' | 'user' | 'dev'>('ops')
  const [res, setRes] = useState<{ markdown: string; commits: number; truncated: boolean }>()
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState('')
  const { done, copy } = useCopy()
  useEffect(() => {
    client.git.refs(ctx.tid, ctx.root).then((rs) => {
      setRefs(rs)
      if (from0 === undefined) { const tag = rs.find((r) => r.kind === 'tag'); if (tag) setFrom(tag.name) }   // 默认从最近的标签开始
    }).catch(() => {})
  }, [ctx.tid, ctx.root])
  const opts = useMemo(() => [
    ...refs.filter((r) => r.kind === 'tag').map((r) => ({ value: r.name, label: `🏷 ${r.name}` })),
    ...refs.filter((r) => r.kind !== 'tag').map((r) => ({ value: r.name, label: r.name })),
  ], [refs])
  const gen = () => {
    setLoading(true); setErr(''); setRes(undefined)
    client.git.changelog(ctx.tid, ctx.root, from || undefined, to, audience).then(setRes).catch((e) => setErr(errText(e))).finally(() => setLoading(false))
  }
  const save = () => res && client.system.saveTextFile(tr('更新日志-{from}-{to}.md', { from: (from || 'start').replace(/[\\/:*?"<>|]/g, '_'), to: to.replace(/[\\/:*?"<>|]/g, '_') }), res.markdown).catch((e) => setErr(errText(e)))
  return (
    <Frame title={tr('生成更新日志')} icon={<FileText className="h-4 w-4 text-[var(--color-accent)]" />} onClose={onClose}
      sub={res && <span className="text-[11px] text-[var(--color-text-muted)]">{res.truncated ? tr('{n} 个提交（只取了最近的部分）', { n: res.commits }) : tr('{n} 个提交', { n: res.commits })}</span>}
      actions={res && <>
        <button onClick={() => copy(res.markdown)} title={tr('复制 Markdown')} className={IB}>{done ? <Check className="h-3.5 w-3.5 text-[var(--color-success)]" /> : <Copy className="h-3.5 w-3.5" />}</button>
        <button onClick={save} title={tr('保存为 .md 文件')} className={IB}><Download className="h-3.5 w-3.5" /></button>
      </>}>
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-[var(--color-border-subtle)] px-3 py-2 text-[12px] text-[var(--color-text-secondary)]">
        <span>{tr('range|从')}</span>
        <Select size="sm" className="w-44" aria-label={tr('起始版本')} value={from || '__start'} onValueChange={(v) => setFrom(v === '__start' ? '' : v)} options={[{ value: '__start', label: tr('（从第一个提交）') }, ...opts]} />
        <span>{tr('range|到')}</span>
        <Select size="sm" className="w-44" aria-label={tr('结束版本')} value={to} onValueChange={setTo} options={[{ value: 'HEAD', label: tr('当前（{branch}）', { branch: ctx.st.branch || 'HEAD' }) }, ...opts]} />
        <span className="ml-2">{tr('写给')}</span>
        <Select size="sm" className="w-36" aria-label={tr('读者')} value={audience} onValueChange={(v) => setAudience(v as typeof audience)}
          options={[{ value: 'ops', label: tr('运维 / 部署') }, { value: 'user', label: tr('产品 / 用户') }, { value: 'dev', label: tr('开发团队') }]} />
        <button data-git-changelog-gen onClick={gen} disabled={loading} title={tr('生成\n把这个范围里的提交（不含合并提交，发给模型前脱敏）整理成发布说明')}
          className="ml-auto flex items-center gap-1 rounded border border-transparent bg-[var(--color-accent)] px-2.5 py-0.5 text-[11.5px] font-medium text-[var(--color-bg-base)] hover:opacity-90 disabled:opacity-40">
          {loading ? <Loader2 className="h-3 w-3 animate-spin" /> : <Sparkles className="h-3 w-3" />}{tr('生成')}
        </button>
      </div>
      <Result md={res?.markdown} loading={loading} err={err} hint={tr('正在整理提交记录…')} />
      {!res && !loading && !err && <div className="px-5 pb-4 text-[12px] text-[var(--color-text-muted)]">{tr('选好范围和读者后点「生成」。写给运维时会把配置、数据库、依赖、停机等「升级注意」放在最前面，可以直接附到部署评审里。')}</div>}
    </Frame>
  )
}

const LEVEL: Record<ReviewIssueLevel, { text: string; color: string }> = {
  high: { text: tk('高'), color: 'var(--color-danger)' }, medium: { text: tk('中'), color: 'var(--color-warn)' }, low: { text: tk('低'), color: 'var(--color-text-muted)' },
}
const reviewText = (r: GitReviewResult) => [r.summary, ...r.issues.map((x) => tr('【{level}】{loc} {title}', { level: tr(LEVEL[x.level].text), loc: `${x.file}${x.line ? `:${x.line}` : ''}`, title: x.title }) + (x.suggestion ? '\n    ' + tr('建议：{s}', { s: x.suggestion }) : ''))].join('\n')

export function GitReview({ ctx, paths, onClose }: { ctx: GitCtx; paths?: string[]; onClose: () => void }) {
  const [res, setRes] = useState<{ result?: GitReviewResult; markdown: string }>()
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState('')
  const { done, copy } = useCopy()
  useEffect(() => { client.git.review(ctx.tid, ctx.root, paths).then(setRes).catch((e) => setErr(errText(e))).finally(() => setLoading(false)) }, [ctx.tid, ctx.root])
  const r = res?.result
  const ok = r ? r.verdict === 'ok' : !!res && /^[#\s*]*可以提交/.test(res.markdown)   // i18n-ignore 匹配模型输出
  const count = (l: ReviewIssueLevel) => r?.issues.filter((x) => x.level === l).length ?? 0
  return (
    <Frame title={paths ? tr('AI 审查勾选的 {n} 个文件', { n: paths.length }) : tr('AI 审查已暂存的改动')} icon={<ShieldCheck className="h-4 w-4 text-[var(--color-accent)]" />} onClose={onClose}
      sub={res && <span className="flex items-center gap-2 text-[11px]">
        <span className={ok ? 'text-[var(--color-success)]' : 'text-[var(--color-warn)]'}>{ok ? tr('可以提交') : tr('建议修改后再提交')}</span>
        {r && (['high', 'medium', 'low'] as const).map((l) => count(l) ? <span key={l} style={{ color: LEVEL[l].color }}>{tr(LEVEL[l].text)} {count(l)}</span> : null)}
      </span>}
      actions={res && <button onClick={() => copy(r ? reviewText(r) : res.markdown)} title={tr('复制')} className={IB}>{done ? <Check className="h-3.5 w-3.5 text-[var(--color-success)]" /> : <Copy className="h-3.5 w-3.5" />}</button>}>
      {!r ? <Result md={res?.markdown} loading={loading} err={err} hint={tr('正在审查（找 bug、误提交的密钥、调试代码、不该提交的文件）…')} /> : (
        <div className="min-h-0 flex-1 space-y-2 overflow-y-auto px-4 py-3" data-git-ai-result>
          {r.issues.length > 0 && <div className="text-[12.5px] text-[var(--color-text-primary)]">{r.summary}</div>}
          {!r.issues.length && (
            <div data-git-review-empty className="flex h-full flex-col items-center justify-center gap-3 pb-10 text-center">
              <div className="flex h-14 w-14 items-center justify-center rounded-full" style={{ background: 'color-mix(in srgb, var(--color-success) 14%, transparent)' }}>
                <ShieldCheck className="h-7 w-7 text-[var(--color-success)]" />
              </div>
              <div className="text-[14px] font-semibold text-[var(--color-text-primary)]">{tr('没有发现问题，可以提交')}</div>
              <div className="max-w-md text-[12px] leading-relaxed text-[var(--color-text-secondary)]">{r.summary}</div>
              <div className="text-[11px] text-[var(--color-text-muted)]">{tr('已检查：bug 与边界条件、误提交的密码 / 密钥、调试代码、不该提交的文件、安全问题 · 范围：{scope}', { scope: paths ? tr('勾选的 {n} 个文件', { n: paths.length }) : tr('全部已暂存的文件') })}</div>
            </div>
          )}
          {r.issues.map((x, i) => (
            <div key={i} data-review-level={x.level} className="rounded-md border border-[var(--color-border-subtle)] px-3 py-2" style={{ borderLeft: `3px solid ${LEVEL[x.level].color}` }}>
              <div className="flex items-start gap-2">
                <span className="mt-px shrink-0 rounded px-1.5 text-[10.5px] font-medium" style={{ color: LEVEL[x.level].color, background: `color-mix(in srgb, ${LEVEL[x.level].color} 15%, transparent)` }}>{tr(LEVEL[x.level].text)}</span>
                <div className="min-w-0 flex-1">
                  <div className="text-[12.5px] font-medium text-[var(--color-text-primary)]">{x.title}</div>
                  {x.file && <div className="mt-0.5 font-mono text-[11px] text-[var(--color-text-muted)]">{x.file}{x.line ? `:${x.line}` : ''}</div>}
                  {x.suggestion && <div className="mt-1 text-[12px] text-[var(--color-text-secondary)]"><span className="mr-1 text-[var(--color-text-muted)]">{tr('review|建议')}</span>{x.suggestion}</div>}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </Frame>
  )
}
