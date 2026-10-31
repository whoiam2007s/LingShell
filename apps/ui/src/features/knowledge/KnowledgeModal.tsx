// 「知识库」视图：左侧按归属（全部 / 全局 / 分组 / 主机）筛选，右侧卡片列表 + 分类筛选 + 全文搜索，手动新增 / 编辑 / 删除。
// 自挂载：App 里常驻 <KnowledgeModal />，任何地方 openKnowledge(filter) 打开。不能点遮罩关闭（按钮 / Esc）
import { useEffect, useMemo, useRef, useState } from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { X, Plus, Pencil, Trash2, BookMarked, Globe, Folder, Server, Library, Sparkles, Search } from 'lucide-react'
import {
  KNOWLEDGE_CATEGORIES, filterKnowledge, knowledgeCategoryLabel, knowledgeScopeText, tr,
  type HostSummary, type KnowledgeCard, type KnowledgeCategory, type KnowledgeFilter, type KnowledgeInput,
} from '@lingshell/shared'
import { client } from '../../client/index.js'
import { cn } from '../../lib/cn.js'
import { HelpTip, BTN2 } from '../../components/ui/form.js'
import { Input, Textarea } from '../../components/ui/Input.js'
import { Select } from '../../components/ui/Select.js'
import { ConfirmDialog } from '../common/index.js'
import { KNOWLEDGE_OPEN_EVENT, scopeValue, parseScopeValue } from './knowledgeBus.js'

const pad = (n: number) => String(n).padStart(2, '0')
const localTime = (iso: string) => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? iso : `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}` }
const errText = (e: unknown) => String((e as Error)?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

export function KnowledgeModal() {
  const [open, setOpen] = useState<{ filter: KnowledgeFilter; n: number } | null>(null)
  useEffect(() => {
    const f = (e: Event) => setOpen((o) => ({ filter: (e as CustomEvent<KnowledgeFilter>).detail ?? {}, n: (o?.n ?? 0) + 1 }))
    window.addEventListener(KNOWLEDGE_OPEN_EVENT, f)
    return () => window.removeEventListener(KNOWLEDGE_OPEN_EVENT, f)
  }, [])
  if (!open) return null
  return <KnowledgeBody key={open.n} initial={open.filter} onClose={() => setOpen(null)} />
}

type Draft = KnowledgeInput & { scopeKey: string }

function KnowledgeBody({ initial, onClose }: { initial: KnowledgeFilter; onClose: () => void }) {
  const [cards, setCards] = useState<KnowledgeCard[]>([])
  const [hosts, setHosts] = useState<HostSummary[]>([])
  const [where, setWhere] = useState(initial.scope ? scopeValue(initial.scope, initial.target ?? '') : 'all')
  const [category, setCategory] = useState<string>(initial.category ?? '')
  const [q, setQ] = useState(initial.q ?? '')
  const [edit, setEdit] = useState<Draft | null>(null)
  const [del, setDel] = useState<KnowledgeCard | null>(null)
  const [err, setErr] = useState('')
  const load = () => client.knowledge.list().then(setCards).catch((e) => setErr(errText(e)))
  useEffect(() => { void load(); client.hosts.list().then(setHosts).catch(() => {}) }, [])

  const hostLabel = (k: string) => (k === 'local' ? tr('host|本机') : hosts.find((h) => h.id === k)?.label)
  // 左侧导航：分组 = 主机的分组 ∪ 卡片引用过的分组；主机 = 本机 + 已保存主机 + 卡片引用了但已删除的主机
  const groups = useMemo(() => [...new Set([...hosts.flatMap((h) => (h.group ? [h.group] : [])), ...cards.filter((c) => c.scope === 'group').map((c) => c.target)])].sort(), [hosts, cards])
  const hostKeys = useMemo(() => [...new Set(['local', ...hosts.map((h) => h.id), ...cards.filter((c) => c.scope === 'host').map((c) => c.target)])], [hosts, cards])
  const count = (scope: string, target = '') => cards.filter((c) => c.scope === scope && (scope === 'global' || c.target === target)).length

  const filter: KnowledgeFilter = { ...(where === 'all' ? {} : parseScopeValue(where)), ...(category ? { category: category as KnowledgeCategory } : {}), q }
  const shown = filterKnowledge(cards, filter)

  // Esc：编辑中先退出编辑；上面还盖着别的弹层（确认框 / 下拉）时不关
  const rootRef = useRef<HTMLDivElement>(null)
  const editRef = useRef(edit); editRef.current = edit
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return
      if ([...document.querySelectorAll('.fixed.inset-0')].some((o) => o !== rootRef.current && !rootRef.current?.contains(o))) return
      if (editRef.current) { setEdit(null); return }
      onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const startNew = () => {
    const scopeKey = where === 'all' ? 'global' : where
    setErr('')
    setEdit({ scopeKey, ...parseScopeValue(scopeKey), title: '', content: '', category: (category || 'other') as KnowledgeCategory, source: 'manual' })
  }
  const save = async () => {
    if (!edit) return
    try {
      const { scopeKey, ...rest } = edit
      await client.knowledge.save({ ...rest, ...parseScopeValue(scopeKey), source: 'manual' })
      setEdit(null); setErr(''); void load()
    } catch (e) { setErr(errText(e)) }
  }
  const remove = async () => {
    if (!del) return
    await client.knowledge.remove(del.id).catch((e) => setErr(errText(e)))
    setDel(null); void load()
  }

  const scopeOptions = [
    { value: 'global', label: tr('全局（所有主机）') },
    ...(groups.length ? [{ group: tr('分组'), options: groups.map((g) => ({ value: `group:${g}`, label: g })) }] : []),
    { group: tr('主机'), options: hostKeys.map((k) => ({ value: `host:${k}`, label: hostLabel(k) ?? tr('{name}（已删除）', { name: k }) })) },
  ]
  const NavBtn = ({ value, icon: Icon, label, n }: { value: string; icon: typeof Globe; label: string; n?: number }) => (
    <button data-kb-nav={value} onClick={() => { setWhere(value); setEdit(null) }} title={label}
      className={cn('flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[12.5px] transition-colors',
        where === value ? 'bg-[var(--color-bg-raised)] text-[var(--color-text-primary)]' : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)]')}>
      <Icon className="h-3.5 w-3.5 shrink-0 text-[var(--color-accent)]" /><span className="min-w-0 flex-1 truncate">{label}</span>
      {n !== undefined && n > 0 && <span className="shrink-0 text-[11px] text-[var(--color-text-muted)]">{n}</span>}
    </button>
  )

  return (
    <div ref={rootRef} data-knowledge-modal className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm animate-fade-in">
      <div className="flex h-[min(760px,88vh)] w-[min(1080px,92vw)] overflow-hidden rounded-xl border border-[var(--color-border-default)] bg-[var(--color-bg-panel)] shadow-2xl">
        <nav className="flex w-[200px] shrink-0 flex-col gap-0.5 overflow-y-auto border-r border-[var(--color-border-subtle)] bg-[var(--color-bg-base)] p-2.5">
          <div className="px-2.5 pb-2 pt-1.5 text-[13px] font-semibold text-[var(--color-text-primary)]">{tr('知识库')}</div>
          <NavBtn value="all" icon={Library} label={tr('全部')} n={cards.length} />
          <NavBtn value="global" icon={Globe} label={tr('全局')} n={count('global')} />
          {groups.length > 0 && <div className="px-2.5 pb-0.5 pt-2.5 text-[10.5px] text-[var(--color-text-muted)]">{tr('分组')}</div>}
          {groups.map((g) => <NavBtn key={g} value={`group:${g}`} icon={Folder} label={g} n={count('group', g)} />)}
          <div className="px-2.5 pb-0.5 pt-2.5 text-[10.5px] text-[var(--color-text-muted)]">{tr('主机')}</div>
          {hostKeys.map((k) => <NavBtn key={k} value={`host:${k}`} icon={Server} label={hostLabel(k) ?? tr('{name}（已删除）', { name: k })} n={count('host', k)} />)}
        </nav>
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex h-11 shrink-0 items-center gap-2 border-b border-[var(--color-border-subtle)] px-4">
            <BookMarked className="h-4 w-4 text-[var(--color-accent)]" />
            <span className="text-[13px] font-semibold text-[var(--color-text-primary)]">{edit ? (edit.id ? tr('编辑知识卡') : tr('新建知识卡')) : tr('知识卡')}</span>
            <HelpTip>
              {tr('给主机、分组或全局记下部署方式、日志位置、启停方式、已知问题等长期知识。AI 用到某台主机后，会自动读到该主机、所属分组与全局的知识卡（按更新时间，总长约 4000 字）；')}
              {' '}{tr('排障中发现值得记住的事，AI 会在对话里提议保存，你点「保存」才写入。旧的「主机备注」已自动迁移成该主机的一张「主机备注」卡。')}
            </HelpTip>
            {!edit && <button onClick={startNew} className={cn('ml-auto flex items-center gap-1 py-1', BTN2)}><Plus className="h-3.5 w-3.5" />{tr('新建卡片')}</button>}
            <button onClick={onClose} title={tr('关闭（Esc）')} className={cn('flex h-6 w-6 items-center justify-center rounded-md text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)]', edit && 'ml-auto')}><X className="h-4 w-4" /></button>
          </div>
          {edit ? (
            <div className="min-h-0 flex-1 overflow-y-auto p-4">
              <div className="mx-auto max-w-[760px] space-y-3 text-[12px]">
                <div className="flex gap-3">
                  <label className="flex-1 space-y-1"><span className="text-[var(--color-text-secondary)]">{tr('归属')}</span>
                    <Select value={edit.scopeKey} onValueChange={(v) => setEdit({ ...edit, scopeKey: v })} options={scopeOptions} aria-label={tr('归属')} />
                  </label>
                  <label className="w-40 space-y-1"><span className="text-[var(--color-text-secondary)]">{tr('分类')}</span>
                    <Select value={edit.category} onValueChange={(v) => setEdit({ ...edit, category: v as KnowledgeCategory })} aria-label={tr('分类')}
                      options={KNOWLEDGE_CATEGORIES.map((c) => ({ value: c.id, label: tr(c.label) }))} />
                  </label>
                </div>
                <label className="block space-y-1"><span className="text-[var(--color-text-secondary)]">{tr('标题')}</span>
                  <Input value={edit.title} onChange={(e) => setEdit({ ...edit, title: e.target.value })} placeholder={tr('如：nginx 日志位置')} autoFocus />
                </label>
                <label className="block space-y-1"><span className="text-[var(--color-text-secondary)]">{tr('内容（Markdown）')}</span>
                  <Textarea value={edit.content} onChange={(e) => setEdit({ ...edit, content: e.target.value })} rows={14} className="resize-y font-mono"
                    placeholder={tr('如：\n- 访问日志：/var/log/nginx/access.log\n- 重载配置：nginx -t && systemctl reload nginx')} />
                </label>
                {err && <div className="text-[var(--color-danger)]">{err}</div>}
                <div className="flex justify-end gap-2">
                  <button onClick={() => { setEdit(null); setErr('') }} className={BTN2}>{tr('取消')}</button>
                  <button onClick={save} disabled={!edit.title.trim() || !edit.content.trim()}
                    className="rounded-md border border-transparent bg-[var(--color-accent)] px-4 py-1.5 text-[12px] font-medium text-[var(--color-bg-base)] transition-colors hover:bg-[var(--color-accent-dim)] disabled:opacity-40">{tr('保存')}</button>
                </div>
              </div>
            </div>
          ) : (
            <>
              <div className="flex shrink-0 items-center gap-2 border-b border-[var(--color-border-subtle)] px-4 py-2">
                <div className="relative flex-1">
                  <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[var(--color-text-muted)]" />
                  <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={tr('搜索标题 / 内容（空格分隔多个词）')} className="pl-8" aria-label={tr('搜索知识卡')} />
                </div>
                <Select value={category} onValueChange={setCategory} className="w-36" aria-label={tr('分类筛选')}
                  options={[{ value: '', label: tr('全部分类') }, ...KNOWLEDGE_CATEGORIES.map((c) => ({ value: c.id, label: tr(c.label) }))]} />
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto p-4">
                <div className="mx-auto max-w-[820px] space-y-2.5">
                  {err && <div className="text-[12px] text-[var(--color-danger)]">{err}</div>}
                  {!shown.length && (
                    <div className="py-10 text-center text-[12px] text-[var(--color-text-muted)]">
                      {cards.length ? tr('没有匹配的知识卡') : tr('还没有知识卡。点右上角「新建卡片」，或在排障对话里让 AI 提议保存。')}
                    </div>
                  )}
                  {shown.map((c) => (
                    <article key={c.id} data-kb-card={c.id} className="group rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-bg-base)] px-3.5 py-2.5">
                      <div className="flex items-center gap-2">
                        <span className="min-w-0 truncate text-[13px] font-semibold text-[var(--color-text-primary)]">{tr(c.title)}</span>
                        <span className="shrink-0 rounded bg-[color:color-mix(in_srgb,var(--color-accent)_14%,transparent)] px-1.5 py-0.5 text-[10.5px] text-[var(--color-accent)]">{tr(knowledgeCategoryLabel(c.category))}</span>
                        <span className="shrink-0 truncate text-[11px] text-[var(--color-text-muted)]">{knowledgeScopeText(c, hostLabel)}</span>
                        <span className="ml-auto flex shrink-0 items-center gap-1 text-[11px] text-[var(--color-text-muted)]" title={c.source === 'ai' ? tr('AI 提议、你确认保存的') : tr('手动添加 / 编辑的')}>
                          {c.source === 'ai' && <Sparkles className="h-3 w-3" />}{c.source === 'ai' ? tr('AI 提议') : tr('手动')} · {localTime(c.updatedAt)}
                        </span>
                        <button onClick={() => { setErr(''); setEdit({ ...c, scopeKey: scopeValue(c.scope, c.target) }) }} title={tr('编辑')}
                          className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text-primary)]"><Pencil className="h-3.5 w-3.5" /></button>
                        <button onClick={() => setDel(c)} title={tr('删除')}
                          className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-danger)]"><Trash2 className="h-3.5 w-3.5" /></button>
                      </div>
                      <div className="markdown-body mt-1.5 max-h-60 overflow-y-auto break-words text-[12px]">
                        <Markdown remarkPlugins={[remarkGfm]}>{c.content}</Markdown>
                      </div>
                    </article>
                  ))}
                </div>
              </div>
            </>
          )}
        </div>
      </div>
      <ConfirmDialog open={!!del} title={tr('删除知识卡')} message={tr('确定删除「{title}」？删除后 AI 不再读到这条知识。', { title: tr(del?.title ?? '') })} onConfirm={remove} onCancel={() => setDel(null)} />
    </div>
  )
}
