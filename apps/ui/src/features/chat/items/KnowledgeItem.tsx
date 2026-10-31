import { useState } from 'react'
import { BookMarked, Check, X, ExternalLink } from 'lucide-react'
import { KNOWLEDGE_CATEGORIES, tr, type KnowledgeCategory } from '@lingshell/shared'
import type { ConvItem } from '../useConversation.js'
import { client } from '../../../client/index.js'
import { Input, Textarea } from '../../../components/ui/Input.js'
import { Select } from '../../../components/ui/Select.js'
import { openKnowledge } from '../../knowledge/index.js'

// 卡片结果按 proposalId 记在模块里：切会话会卸载卡片，回来不该又变成待处理
const done = new Map<string, 'saved' | 'ignored'>()

// AI 提议的知识卡（propose_host_knowledge）：标题 / 分类 / 内容可改，「保存」写入知识库（带 id = 更新那张），「忽略」不写。
export function KnowledgeItem({ item }: { item: ConvItem }) {
  const p = item.knowledge
  const [title, setTitle] = useState(p?.draft.title ?? '')
  const [content, setContent] = useState(p?.draft.content ?? '')
  const [category, setCategory] = useState<KnowledgeCategory>(p?.draft.category ?? 'other')
  const [state, setState] = useState(p ? done.get(p.proposalId) : undefined)
  const [error, setError] = useState('')
  if (!p) return null
  const finish = (s: 'saved' | 'ignored') => { done.set(p.proposalId, s); setState(s) }
  const save = async () => {
    setError('')
    try { await client.knowledge.save({ ...p.draft, title, content, category, source: 'ai' }); finish('saved') }
    catch (e) { setError(String((e as Error)?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')) }
  }
  const catLabel0 = KNOWLEDGE_CATEGORIES.find((c) => c.id === category)?.label
  const catLabel = catLabel0 && tr(catLabel0)

  return (
    <div className="animate-fade-in px-3 py-1" data-knowledge-proposal>
      <div className="overflow-hidden rounded-md border border-[var(--color-border-default)] bg-[var(--color-bg-raised)]">
        <div className="flex items-center gap-2 px-2.5 py-1.5">
          <BookMarked className="h-3.5 w-3.5 shrink-0 text-[var(--color-accent)]" />
          <span className="text-[12px] font-semibold text-[var(--color-text-primary)]">{p.previous ? tr('AI 建议更新知识卡') : tr('AI 建议记入知识库')}</span>
          <code className="ml-auto truncate rounded bg-[var(--color-bg-base)] px-1.5 py-0.5 text-[11px] text-[var(--color-text-muted)]">{p.targetLabel}</code>
        </div>
        <div className="border-t border-[var(--color-border-subtle)] bg-[var(--color-bg-base)] px-3 py-2">
          {state ? (
            <>
              <div className="text-[12px] font-medium text-[var(--color-text-primary)]">{title}<span className="ml-2 text-[11px] font-normal text-[var(--color-text-muted)]">{catLabel}</span></div>
              <pre className="mt-1 whitespace-pre-wrap rounded bg-[var(--color-bg-raised)] px-2 py-1.5 text-[11px] leading-relaxed text-[var(--color-text-secondary)]">{content}</pre>
              <div className="mt-2 flex items-center gap-1 text-[12px] text-[var(--color-text-muted)]">
                {state === 'saved'
                  ? <><Check className="h-3.5 w-3.5 text-[var(--color-success)]" />{tr('已保存到知识库')}
                    <button onClick={() => openKnowledge({ q: title })} className="ml-2 flex items-center gap-0.5 text-[var(--color-accent)] hover:underline"><ExternalLink className="h-3 w-3" />{tr('在知识库中查看')}</button></>
                  : <><X className="h-3.5 w-3.5" />{tr('已忽略')}</>}
              </div>
            </>
          ) : (
            <>
              <div className="flex items-center gap-2">
                <Input value={title} onChange={(e) => setTitle(e.target.value)} size="sm" aria-label={tr('标题')} placeholder={tr('标题')} className="flex-1" />
                <Select value={category} onValueChange={(v) => setCategory(v as KnowledgeCategory)} size="sm" aria-label={tr('分类')} className="w-28"
                  options={KNOWLEDGE_CATEGORIES.map((c) => ({ value: c.id, label: tr(c.label) }))} />
              </div>
              <Textarea value={content} onChange={(e) => setContent(e.target.value)} rows={Math.min(8, content.split('\n').length + 1)} aria-label={tr('内容')}
                className="mt-1.5 resize-y font-mono text-[11.5px]" />
              {p.previous && (
                <details className="mt-1 text-[11px] text-[var(--color-text-muted)]">
                  <summary className="cursor-pointer select-none">{tr('原卡片：{title}', { title: p.previous.title })}</summary>
                  <pre className="mt-1 whitespace-pre-wrap rounded bg-[var(--color-bg-raised)] px-2 py-1.5 leading-relaxed">{p.previous.content}</pre>
                </details>
              )}
              {error && <div className="mt-1 text-[11px] text-[var(--color-danger)]">{tr('保存失败：{error}', { error })}</div>}
              <div className="mt-2 flex items-center gap-2">
                <button onClick={save} disabled={!title.trim() || !content.trim()}
                  className="flex items-center gap-1 rounded-md border border-transparent bg-[var(--color-accent)] px-3 py-1 text-[12px] font-medium text-[var(--color-bg-base)] transition-colors hover:bg-[var(--color-accent-dim)] disabled:opacity-40">
                  <Check className="h-3.5 w-3.5" />{tr('保存')}
                </button>
                <button onClick={() => finish('ignored')}
                  className="flex items-center gap-1 rounded-md border border-[var(--color-border-default)] px-3 py-1 text-[12px] text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-bg-hover)]">
                  <X className="h-3.5 w-3.5" />{tr('忽略')}
                </button>
                <span className="ml-auto text-[11px] text-[var(--color-text-muted)]">{tr('可先修改再保存')}</span>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
