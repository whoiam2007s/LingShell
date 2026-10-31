// 附件 tag：输入框上方（可删）与用户消息气泡下方（只看，含历史回放）共用。
// 统一一行高：图标或小缩略图（16px）+ 名称 + ×。图片 = 图片附件，或文件名是图片的文件（按路径发出的图片文件）。
// 点击打开：图片 → 应用内预览（可缩放、多张左右切换）；文件 → 系统默认程序打开；目录 → 系统资源管理器。
import { useEffect, useState } from 'react'
import { FileText, Folder, Image as ImageIcon, Info, X, TerminalSquare, Server, MessageSquare, SquareTerminal } from 'lucide-react'
import { tr, tk, type MsgAttachment, type ContextKind } from '@lingshell/shared'
import { client } from '../../client/index.js'
import { imageSrc, isImageAtt, errMsg, PATH_ONLY_HINT, NO_IMAGE_HINT, type ChipView } from './attachments.js'
import type { TermBlock } from '../../lib/termBlock.js'
import { ImageViewer } from '../../components/ImageViewer.js'
import { cn } from '../../lib/cn.js'

type Chip = ChipView & { key?: string }

export function AttachmentChips({ items, onRemove, onError, noImage, className }: {
  items: Chip[]
  onRemove?: (i: number) => void
  onError?: (msg: string) => void       // 打开失败（如文件已不存在）
  noImage?: boolean                     // 输入框草稿：当前模型不支持图片（图片 tag 上给提示）
  className?: string
}) {
  const [view, setView] = useState<number | null>(null)
  const images = items.filter((a): a is MsgAttachment & { key?: string } => a.kind !== 'termBlock' && isImageAtt(a))
  const openPath = (p: string) => client.attachments.open(p).then((r) => { if (r) onError?.(r) }).catch((e) => onError?.(errMsg(e)))
  const open = (a: MsgAttachment & { key?: string }, src?: string | null) => {
    if (isImageAtt(a) && src) { setView(images.indexOf(a)); return }
    if (a.path) void openPath(a.path)
    else onError?.(tr('图片存档不见了'))
  }
  if (!items.length) return null
  return (
    <div data-attachments className={cn('flex flex-wrap gap-1.5', className)}>
      {items.map((a, i) => a.kind === 'context' ? <CtxChip key={a.key ?? i} a={a} onRemove={onRemove && (() => onRemove(i))} />
        : a.kind === 'termBlock' ? <BlockChip key={a.key ?? i} name={a.name} b={a.block} onRemove={onRemove && (() => onRemove(i))} />
        : <AttChip key={a.key ?? i} a={a} onOpen={(src) => open(a, src)} onRemove={onRemove && (() => onRemove(i))}
          warn={noImage && isImageAtt(a) ? (a.path ? tr(PATH_ONLY_HINT) : tr('{hint}，发送前请移除', { hint: tr(NO_IMAGE_HINT) })) : undefined} />)}
      {view !== null && images[view] && <ImageViewer items={images} index={view} onClose={() => setView(null)} />}
    </div>
  )
}

// 上下文标签（@ 终端 / 主机 / 历史会话、`!命令` 终端块）：悬停看随消息发给 AI 的文字
const CTX_ICON: Record<ContextKind, typeof FileText> = { terminal: TerminalSquare, host: Server, session: MessageSquare, shell: SquareTerminal }
const CTX_LABEL: Record<ContextKind, string> = { terminal: tk('终端'), host: tk('主机'), session: tk('会话'), shell: tk('终端块') }
function CtxChip({ a, onRemove }: { a: MsgAttachment & { key?: string }; onRemove?: () => void }) {
  const ctx = a.ctx ?? 'terminal'
  const Icon = CTX_ICON[ctx]
  const tip = (a.text ?? '').length > 1500 ? `${a.text!.slice(0, 1500)}…` : a.text ?? ''
  return (
    <span data-att-kind="context" data-ctx={ctx} title={`${tr('{label}：{name}', { label: tr(CTX_LABEL[ctx]), name: a.name })}\n\n${tip}`}
      className="group flex h-6 max-w-[260px] items-center gap-1 rounded-md border border-[color:color-mix(in_srgb,var(--color-accent)_35%,transparent)] bg-[color:color-mix(in_srgb,var(--color-accent)_8%,transparent)] pl-1 pr-0.5 text-[11.5px] text-[var(--color-text-secondary)]">
      <Icon className="h-3.5 w-3.5 shrink-0 text-[var(--color-accent)]" />
      <span className="shrink-0 text-[10.5px] text-[var(--color-text-muted)]">{tr(CTX_LABEL[ctx])}</span>
      <span className={cn('truncate', ctx === 'shell' && 'font-mono')}>{a.name}</span>
      {onRemove ? <button onClick={onRemove} title={tr('移除')} className="flex h-4 w-4 shrink-0 items-center justify-center rounded hover:bg-[var(--color-bg-hover)]"><X className="h-3 w-3" /></button> : <span className="w-1" />}
    </span>
  )
}

// 终端块 tag：悬停看命令 / 退出码 / 目录 / 输出开头
export function BlockChip({ name, b, onRemove }: { name: string; b: TermBlock; onRemove?: () => void }) {
  const tip = [b.command !== undefined ? `$ ${b.command}` : tr('（选中的输出）'), b.exitCode !== undefined ? tr('退出码 {code}', { code: b.exitCode }) : '', b.cwd ? tr('目录 {cwd}', { cwd: b.cwd }) : '', '', b.output.slice(0, 600)].filter((x, i) => x || i === 3).join('\n')
  return (
    <span data-att-kind="termBlock" title={tip}
      className="group flex h-6 max-w-[260px] items-center gap-1 rounded-md border border-[color:color-mix(in_srgb,var(--color-accent)_40%,transparent)] bg-[var(--color-bg-raised)] pl-1 pr-0.5 text-[11.5px] text-[var(--color-text-secondary)]">
      <SquareTerminal className={`h-4 w-4 shrink-0 ${b.exitCode !== undefined && b.exitCode !== 0 ? 'text-[var(--color-danger)]' : 'text-[var(--color-accent)]'}`} />
      <span className="min-w-0 truncate font-mono">{name}</span>
      {onRemove ? <button onClick={onRemove} title={tr('移除')} className="flex h-4 w-4 shrink-0 items-center justify-center rounded hover:bg-[var(--color-bg-hover)]"><X className="h-3 w-3" /></button> : <span className="w-1" />}
    </span>
  )
}

function AttChip({ a, onOpen, onRemove, warn }: { a: MsgAttachment & { key?: string }; onOpen: (src: string | null) => void; onRemove?: () => void; warn?: string }) {
  const img = isImageAtt(a)
  const [src, setSrc] = useState<string | null | undefined>(a.src)
  useEffect(() => {
    if (!img) return
    if (a.src) { setSrc(a.src); return }
    let alive = true
    void imageSrc(a).then((s) => { if (alive) setSrc(s) })
    return () => { alive = false }
  }, [img, a.src, a.imageId, a.path])
  const icon = img
    ? (src ? <img src={src} alt="" draggable={false} className="h-4 w-4 shrink-0 rounded-[3px] object-cover" /> : <ImageIcon className="h-4 w-4 shrink-0 text-[var(--color-text-muted)]" />)
    : a.kind === 'dir' ? <Folder className="h-4 w-4 shrink-0 text-[var(--color-accent)]" /> : <FileText className="h-4 w-4 shrink-0 text-[var(--color-text-muted)]" />
  const how = img && src ? tr('点击预览') : a.kind === 'dir' ? tr('点击在资源管理器打开') : tr('点击用系统程序打开')
  return (
    <span data-att-kind={img ? 'image' : a.kind} title={warn}
      className="group flex h-6 max-w-[240px] items-center gap-1 rounded-md border border-[var(--color-border-default)] bg-[var(--color-bg-raised)] pl-1 pr-0.5 text-[11.5px] text-[var(--color-text-secondary)]">
      <button onClick={() => onOpen(src ?? null)} className="flex min-w-0 items-center gap-1.5 hover:text-[var(--color-accent)]" title={`${a.path ?? a.name}\n${how}`}>
        {icon}<span className="truncate">{a.name}</span>
      </button>
      {warn && <span data-att-warn title={warn} className="flex shrink-0 text-[var(--color-warn)]"><Info className="h-3 w-3" /></span>}
      {onRemove ? <button onClick={onRemove} title={tr('移除')} className="flex h-4 w-4 shrink-0 items-center justify-center rounded hover:bg-[var(--color-bg-hover)]"><X className="h-3 w-3" /></button> : <span className="w-1" />}
    </span>
  )
}
