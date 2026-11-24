import { createContext, memo, useContext, useEffect, useMemo, useState } from 'react'
import Markdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Copy, Check, GitBranchPlus, RefreshCw } from 'lucide-react'
import { tr } from '@lingshell/shared'
import type { ConvItem } from '../useConversation.js'
import { cn } from '../../../lib/cn.js'
import { openPathPreview } from '../../../lib/chatBus.js'
import { UserMsgTime } from './TurnTime.js'
import { CodeBlock } from './CodeBlock.js'
import { MdTable } from './MdTable.js'
import { langOf } from '../codeBlock.js'
import { splitTermBlocks, termBlockName } from '../../../lib/termBlock.js'
import { BlockChip } from '../AttachmentChips.js'

// 消息上的操作（ChatPanel 提供）：从这里分叉 / 重新生成。busy = 本轮进行中（全部禁用）
// 「编辑后重发」已移除：它的语义（切在这条消息之前、把改后的内容重发）和「分叉」容易混淆，
// 用户实际想要的是「把当前对话完整带到新会话继续」，见 docs/0.1.20-规划.md F3。
export interface MsgActions {
  busy: boolean
  onFork(msgId: string, includeTurn?: boolean): void
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
export const MessageItem = memo(function MessageItem({ item, streaming, regenFrom, turnUserMsgId }: { item: ConvItem; streaming: boolean; regenFrom?: string; turnUserMsgId?: string }) {
  const isUser = item.kind === 'user_message'
  // 后台任务完成通知是宿主注入的（不是用户说的话）：用系统条目样式显示，别冒充用户发言
  if (isUser && item.text.startsWith('[后台任务完成]')) {   // i18n-ignore 识别宿主注入的通知前缀（不是界面文案）
    return (
      <div data-system-notice className="mx-4 my-2 flex items-start gap-2 rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-bg-base)] px-3 py-2 text-[12px] leading-relaxed text-[var(--color-text-secondary)]">
        <span className="mt-0.5 shrink-0 text-[var(--color-accent)]">⏱</span>
        <span className="min-w-0 whitespace-pre-wrap break-words">{item.text}</span>
      </div>
    )
  }
  return (
    <div className={cn('group/msg animate-fade-in flex gap-2.5 px-3 py-2', isUser && 'flex-row-reverse')}>
      {/* 头像只给用户消息：AI 的头像由所在回合（ChatPanel 的 TurnBlock）统一出一个，放在回合最前 */}
      {isUser && (
        <div className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-[color:color-mix(in_srgb,var(--color-user)_30%,transparent)] text-[10px] font-semibold text-[var(--color-user)]">
          {tr('我')}
        </div>
      )}
      {(
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
      {!streaming && item.text && item.status !== 'in_progress' && (
        <MsgToolbar item={item} isUser={isUser} regenFrom={regenFrom} turnUserMsgId={turnUserMsgId} />
      )}
      {/* 发送时间：行是 row-reverse，放在这里就落在气泡左侧、底部对齐 */}
      {isUser && item.at && <UserMsgTime at={item.at} />}
    </div>
  )
})

// Markdown 正文单独 memo：消息操作（context）变化时不重新解析。代码块换成带按钮的 CodeBlock
export const MarkdownBody = memo(function MarkdownBody({ text, streaming }: { text: string; streaming: boolean }) {
  const components = useMemo<Components>(() => ({
    pre({ node, children }) {
      const code = (node as unknown as HNode | undefined)?.children?.find((c) => c.type === 'element')
      return <CodeBlock lang={langOf(code?.properties?.className)} text={hastText(code)} live={streaming}>{children}</CodeBlock>
    },
    table({ node, children }) { return <MdTable node={node}>{children}</MdTable> },
    // 外链一律交给系统浏览器：绝不在应用内导航（否则会把整个页面冲掉）
    a({ href, children, title }) {
      // 只有真能打开的地址才渲染成链接：http(s) 走系统浏览器，mailto 交给系统邮件程序；
      // 其它（# 锚点、相对路径）在应用里点了本来也没反应，渲染成普通文字，别让人以为能点
      const web = !!href && /^https?:\/\//i.test(href)
      const mail = !!href && /^mailto:/i.test(href)
      if (!web && !mail) return <span title={title}>{children}</span>
      return (
        <a href={href} rel="noreferrer" title={title ?? (web ? tr('在系统浏览器中打开') : tr('用邮件程序打开'))}
          className="text-[var(--color-accent)] underline decoration-dotted underline-offset-2 hover:decoration-solid"
          onClick={(e) => { e.preventDefault(); window.open(href, '_blank', 'noopener') }}>
          {children}
        </a>
      )
    },
    // 行内代码里看着像文件路径的，点一下直接看文件（不支持的格式会提示用系统程序打开）
    code({ node, className, children }) {
      const text = hastText(node as HNode)
      if (className || !looksLikePath(text)) return <code className={className}>{children}</code>
      return (
        <code title={tr('打开文件预览')} onClick={() => openPathPreview(text)}
          className="cursor-pointer rounded bg-[var(--color-bg-raised)] px-1 font-mono text-[0.92em] text-[var(--color-accent)] hover:underline">
          {children}
        </code>
      )
    },
  }), [streaming])
  return (
    <div className={cn('markdown-body break-words', streaming && 'stream-cursor')}>
      <Markdown remarkPlugins={[remarkGfm]} components={components}>{text}</Markdown>
    </div>
  )
})

type HNode = { type: string; value?: string; children?: HNode[]; properties?: Record<string, unknown> }
/** 看着像文件路径才让点（排除 URL / 太长 / 没扩展名的）—— 只对行内代码用，避免误判普通文字 */
const looksLikePath = (s: string): boolean => {
  const t = s.trim()
  if (t.length < 4 || t.length > 260) return false
  if (/^[a-z]+:\/\//i.test(t)) return false          // http://、vscode:// 这类不是文件
  if (/[\r\n]/.test(t)) return false
  if (!/[\\/]/.test(t)) return false                  // 至少有个路径分隔符
  const head = t.split(/[?#]/)[0]
  return /\.\w{1,8}$/.test(head)                      // 结尾有扩展名
}
const hastText = (n?: HNode): string => (!n ? '' : n.type === 'text' ? n.value ?? '' : (n.children ?? []).map(hastText).join(''))

const TB = 'flex h-6 w-6 items-center justify-center rounded text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-accent)] disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-[var(--color-text-muted)]'

function MsgToolbar({ item, isUser, regenFrom, turnUserMsgId }: { item: ConvItem; isUser: boolean; regenFrom?: string; turnUserMsgId?: string }) {
  const act = useContext(MsgActionsContext)
  const [copied, setCopied] = useState(false)
  useEffect(() => { if (!copied) return; const t = setTimeout(() => setCopied(false), 1500); return () => clearTimeout(t) }, [copied])
  const copy = () => navigator.clipboard.writeText(item.text).then(() => setCopied(true), () => {})
  // 进行中 / 还没拿到服务端 id（刚发出、未回显）不能编辑 / 分叉
  const why = act?.busy ? tr('（本轮进行中，结束后再操作）') : ''
  const msgId = isUser ? item.msgId : regenFrom
  // AI 回复上的「从此分叉」用**该轮用户消息**的 id 作切点（主进程按它定位）
  const forkFrom = isUser ? item.msgId : turnUserMsgId
  const off = !act || act.busy || !msgId
  const tip = (t: string) => (act?.busy ? `${t}${why}` : !msgId ? `${t}${tr('（消息还在同步，稍后再试）')}` : t)
  return (
    <div data-msg-actions className="flex shrink-0 items-center gap-0.5 self-end opacity-0 transition-opacity focus-within:opacity-100 group-hover/msg:opacity-100">
      <button data-msg-copy onClick={copy} title={isUser ? tr('复制消息') : tr('复制回复（Markdown 原文）')} className={TB}>
        {copied ? <Check className="h-3.5 w-3.5 text-[var(--color-success)]" /> : <Copy className="h-3.5 w-3.5" />}
      </button>
      {isUser && act && (
        <button data-msg-fork onClick={() => msgId && act.onFork(msgId)} disabled={off} className={TB}
          title={tip(tr('从这里分叉：把当前对话完整带到新会话（含这一条），输入框留空'))}><GitBranchPlus className="h-3.5 w-3.5" /></button>
      )}
      {!isUser && forkFrom && act && (
        <button data-msg-fork-reply onClick={() => act.onFork(forkFrom, true)} disabled={!act || act.busy} className={TB}
          title={tip(tr('从这里分叉：把当前对话完整带到新会话（含这一条），输入框留空'))}><GitBranchPlus className="h-3.5 w-3.5" /></button>
      )}
      {!isUser && regenFrom && act && (
        <button data-msg-regen onClick={() => act.onRegenerate(regenFrom)} disabled={off} className={TB}
          title={tip(tr('重新生成：用同一条消息重跑这一轮（替换这一轮的回复，前面的对话不变）'))}><RefreshCw className="h-3.5 w-3.5" /></button>
      )}
    </div>
  )
}
