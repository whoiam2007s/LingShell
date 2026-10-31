import { createContext, memo, useContext, useEffect, useMemo, useRef, useState } from 'react'
import Markdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Copy, Check, Pencil, GitBranchPlus, RefreshCw } from 'lucide-react'
import { tr } from '@lingshell/shared'
import type { ConvItem } from '../useConversation.js'
import { cn } from '../../../lib/cn.js'
import { UserMsgTime } from './TurnTime.js'
import { CodeBlock } from './CodeBlock.js'
import { MdTable } from './MdTable.js'
import { langOf } from '../codeBlock.js'
import { splitTermBlocks, termBlockName } from '../../../lib/termBlock.js'
import { BlockChip } from '../AttachmentChips.js'

// 消息上的操作（ChatPanel 提供）：编辑后重发 / 从这里分叉 / 重新生成。busy = 本轮进行中（全部禁用）
export interface MsgActions {
  busy: boolean
  onEdit(msgId: string, text: string): void
  onFork(msgId: string): void
  onRegenerate(msgId: string): void
}
export const MsgActionsContext = createContext<MsgActions | null>(null)

// 用户消息正文：末尾的终端块（见 termBlock.ts）折成 tag 显示，悬停看内容
function UserText({ text }: { text: string }) {
  const p = useMemo(() => splitTermBlocks(text), [text])
  if (!p.blocks.length) return <>{text}</>
  return (
    <>
      {p.text}
      <span data-msg-blocks className={cn('flex flex-wrap gap-1.5 whitespace-normal', p.text && 'mt-1.5')}>
        {p.blocks.map((b, i) => <BlockChip key={i} name={termBlockName(b)} b={b} />)}
      </span>
    </>
  )
}

// 用户消息 / AI 回复消息
// memo：react-markdown+remark-gfm 每次渲染都重新解析整段(表格尤慢)。输入框每次击键会让整个
// ChatPanel 重渲染，若不 memo，所有历史消息都被重新解析→输入卡顿。text/streaming 不变则跳过。
// regenFrom：本轮用户消息的服务端 id，只给最后一轮的最后一条 AI 回复（出「重新生成」）
export const MessageItem = memo(function MessageItem({ item, streaming, regenFrom }: { item: ConvItem; streaming: boolean; regenFrom?: string }) {
  const isUser = item.kind === 'user_message'
  const [editing, setEditing] = useState(false)
  return (
    <div className={cn('group/msg animate-fade-in flex gap-2.5 px-3 py-2', isUser && 'flex-row-reverse')}>
      {/* 头像只给用户消息：AI 的头像由所在回合（ChatPanel 的 TurnBlock）统一出一个，放在回合最前 */}
      {isUser && (
        <div className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-[color:color-mix(in_srgb,var(--color-user)_30%,transparent)] text-[10px] font-semibold text-[var(--color-user)]">
          {tr('我')}
        </div>
      )}
      {editing ? <EditBox item={item} onClose={() => setEditing(false)} /> : (
        // 气泡：无边框，用户气泡与 AI 气泡用不同底色区分（用户偏蓝、AI 用 raised 灰）
        <div
          className={cn(
            'max-w-[85%] rounded-lg px-3 py-2 text-[13px] leading-relaxed',
            isUser
              ? 'bg-[color:color-mix(in_srgb,var(--color-user)_28%,transparent)] text-[var(--color-text-primary)]'
              : 'bg-[var(--color-bg-hover)] text-[var(--color-text-primary)]',
            item.status === 'failed' && 'bg-[color:color-mix(in_srgb,var(--color-danger)_20%,transparent)] text-[var(--color-danger)]'
          )}
        >
          {isUser ? (
            <span className="whitespace-pre-wrap break-words">
              <UserText text={item.text} />
              {/* 本轮还在跑时补发的消息：先排队，本轮结束自动发出 */}
              {item.status === 'in_progress' && (
                <span className="ml-1.5 align-middle text-[10.5px] text-[var(--color-text-muted)]">{tr('· 排队中')}</span>
              )}
            </span>
          ) : (
            <MarkdownBody text={item.text} streaming={streaming} />
          )}
        </div>
      )}
      {/* 悬停才显示的操作：用户消息在气泡左侧，AI 回复在气泡右侧，底部对齐 */}
      {!editing && !streaming && item.text && item.status !== 'in_progress' && (
        <MsgToolbar item={item} isUser={isUser} regenFrom={regenFrom} onEdit={() => setEditing(true)} />
      )}
      {/* 发送时间：行是 row-reverse，放在这里就落在气泡左侧、底部对齐 */}
      {isUser && item.at && <UserMsgTime at={item.at} />}
    </div>
  )
})

// Markdown 正文单独 memo：消息操作（context）变化时不重新解析。代码块换成带按钮的 CodeBlock
const MarkdownBody = memo(function MarkdownBody({ text, streaming }: { text: string; streaming: boolean }) {
  const components = useMemo<Components>(() => ({
    pre({ node, children }) {
      const code = (node as unknown as HNode | undefined)?.children?.find((c) => c.type === 'element')
      return <CodeBlock lang={langOf(code?.properties?.className)} text={hastText(code)} live={streaming}>{children}</CodeBlock>
    },
    table({ node, children }) { return <MdTable node={node}>{children}</MdTable> },
  }), [streaming])
  return (
    <div className={cn('markdown-body break-words', streaming && 'stream-cursor')}>
      <Markdown remarkPlugins={[remarkGfm]} components={components}>{text}</Markdown>
    </div>
  )
})

type HNode = { type: string; value?: string; children?: HNode[]; properties?: Record<string, unknown> }
const hastText = (n?: HNode): string => (!n ? '' : n.type === 'text' ? n.value ?? '' : (n.children ?? []).map(hastText).join(''))

const TB = 'flex h-6 w-6 items-center justify-center rounded text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-accent)] disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-[var(--color-text-muted)]'

function MsgToolbar({ item, isUser, regenFrom, onEdit }: { item: ConvItem; isUser: boolean; regenFrom?: string; onEdit: () => void }) {
  const act = useContext(MsgActionsContext)
  const [copied, setCopied] = useState(false)
  useEffect(() => { if (!copied) return; const t = setTimeout(() => setCopied(false), 1500); return () => clearTimeout(t) }, [copied])
  const copy = () => navigator.clipboard.writeText(item.text).then(() => setCopied(true), () => {})
  // 进行中 / 还没拿到服务端 id（刚发出、未回显）不能编辑 / 分叉
  const why = act?.busy ? tr('（本轮进行中，结束后再操作）') : ''
  const msgId = isUser ? item.msgId : regenFrom
  const off = !act || act.busy || !msgId
  const tip = (t: string) => (act?.busy ? `${t}${why}` : !msgId ? `${t}${tr('（消息还在同步，稍后再试）')}` : t)
  return (
    <div data-msg-actions className="flex shrink-0 items-center gap-0.5 self-end opacity-0 transition-opacity focus-within:opacity-100 group-hover/msg:opacity-100">
      <button data-msg-copy onClick={copy} title={isUser ? tr('复制消息') : tr('复制回复（Markdown 原文）')} className={TB}>
        {copied ? <Check className="h-3.5 w-3.5 text-[var(--color-success)]" /> : <Copy className="h-3.5 w-3.5" />}
      </button>
      {isUser && act && (
        <>
          <button data-msg-edit onClick={onEdit} disabled={off} className={TB}
            title={tip(tr('编辑后重发：从这条消息之前分叉出新会话，发送改后的内容（原会话保留在历史里）'))}><Pencil className="h-3.5 w-3.5" /></button>
          <button data-msg-fork onClick={() => msgId && act.onFork(msgId)} disabled={off} className={TB}
            title={tip(tr('从这里分叉：从这条消息之前分叉出新会话，并把这条消息填进输入框（不发送）'))}><GitBranchPlus className="h-3.5 w-3.5" /></button>
        </>
      )}
      {!isUser && regenFrom && act && (
        <button data-msg-regen onClick={() => act.onRegenerate(regenFrom)} disabled={off} className={TB}
          title={tip(tr('重新生成：用同一条消息重跑这一轮（替换这一轮的回复，前面的对话不变）'))}><RefreshCw className="h-3.5 w-3.5" /></button>
      )}
    </div>
  )
}

// 原地编辑用户消息：Enter 发送（分叉出新会话），Shift+Enter 换行，Esc 取消
function EditBox({ item, onClose }: { item: ConvItem; onClose: () => void }) {
  const act = useContext(MsgActionsContext)
  const [draft, setDraft] = useState(item.text)
  const ta = useRef<HTMLTextAreaElement>(null)
  useEffect(() => { const el = ta.current; if (el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length) } }, [])
  // 自适应高度（+2 = 上下边框，border-box 下 scrollHeight 不含边框），最高 240px 后滚动
  useEffect(() => { const el = ta.current; if (el) { el.style.height = 'auto'; el.style.height = `${Math.min(el.scrollHeight + 2, 240)}px` } }, [draft])
  const ok = !!draft.trim() && !!item.msgId && !act?.busy
  const submit = () => { if (!ok || !act || !item.msgId) return; act.onEdit(item.msgId, draft); onClose() }
  return (
    <div data-msg-editor className="flex w-[85%] flex-col gap-1.5">
      <textarea ref={ta} value={draft} rows={1} spellCheck={false} onChange={(e) => setDraft(e.target.value)} aria-label={tr('编辑消息')}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing) return
          if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit() }
          else if (e.key === 'Escape') { e.preventDefault(); onClose() }
        }}
        className="w-full resize-none rounded-lg border border-[color:color-mix(in_srgb,var(--color-accent)_60%,transparent)] bg-[var(--color-bg-base)] px-3 py-2 text-[13px] leading-relaxed text-[var(--color-text-primary)] outline-none" />
      <div className="flex items-center justify-end gap-1.5 text-[11.5px]">
        <span className="mr-auto text-[var(--color-text-muted)]">{tr('发送后在新会话里继续（原会话保留在历史里）')}</span>
        <button onClick={onClose} className="rounded-md border border-[var(--color-border-default)] px-2.5 py-0.5 text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)]">{tr('取消')}</button>
        <button data-msg-edit-send onClick={submit} disabled={!ok}
          className="rounded-md border border-transparent bg-[var(--color-accent)] px-2.5 py-0.5 font-medium text-[var(--color-bg-base)] hover:bg-[var(--color-accent-dim)] disabled:cursor-not-allowed disabled:opacity-40">{tr('发送')}</button>
      </div>
    </div>
  )
}
