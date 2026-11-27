import { useMemo, useState, type ReactNode, type RefObject } from 'react'
import { Bot, Loader2, Sparkles, Terminal, X } from 'lucide-react'
import { INPUT_MAX, insertCapped, tr } from '@lingshell/shared'
import { client } from '../../client/index.js'
import { AttachmentChips } from './AttachmentChips.js'
import { PreviewBanner } from './PreviewMode.js'
import { AtMenuPopup, useAtMenu } from './AtMenu.js'
import { useAttachments } from './useAttachments.js'
import { ComposerFooter } from './ComposerFooter.js'

export interface ComposerProps {
  input: string
  onInput: (v: string) => void
  taRef: RefObject<HTMLTextAreaElement | null>
  onCaret: (n: number) => void
  canChat: boolean
  busy: boolean
  bang: string | null
  skill: string | null
  onPickSkill: (name: string) => void
  onClearSkill: () => void
  /** 本会话绑定的 Agent（角色）名；有值时输入区上方显示一个标签 */
  agentName?: string
  onClearAgent?: () => void
  att: ReturnType<typeof useAttachments>
  atMenu: ReturnType<typeof useAtMenu>
  preview: { on: boolean; set: (v: boolean) => void }
  noImage: boolean
  compactHint?: ReactNode
  shellBusy?: string
  inputH: number | undefined
  onResizeDown: (e: React.PointerEvent<HTMLDivElement>) => void
  resetInputH: () => void
  submit: (o?: { queue?: boolean }) => void
  interrupt: () => void
  showSend: boolean
  /** 左下角：「+」菜单与模板 / 手册 picker（由 ChatPanel 构造） */
  menus: ReactNode
  model: ReactNode
  usage?: ReactNode
  mode?: ReactNode
}

/**
 * 输入区：上方是草稿框，底部一条工具栏（+ 菜单 / 模型 / 性能指标 / 执行模式 / 发送）。
 * `/` 唤起 Skill 列表的逻辑也在这里（只认「/ + 还没空格」），避免在 ChatPanel 里再摊一遍 state。
 */
export function Composer({
  input, onInput, taRef, onCaret, canChat, busy, bang, skill, onPickSkill, onClearSkill,
  agentName, onClearAgent,
  att, atMenu, preview, noImage, compactHint, shellBusy, inputH, onResizeDown, resetInputH,
  submit, interrupt, showSend, menus, model, usage, mode,
}: ComposerProps) {
  const [sks, setSks] = useState<{ name: string; description?: string }[] | null>(null)
  const [slashQ, setSlashQ] = useState<string | null>(null)
  const [slashIdx, setSlashIdx] = useState(0)
  const slashItems = useMemo(() => {
    if (slashQ === null) return []
    const q = slashQ.trim().toLowerCase()
    return (sks ?? []).filter((s) => !q || s.name.toLowerCase().includes(q)).slice(0, 8)
  }, [sks, slashQ])
  const loadSkills = () => {
    if (sks) return
    client.skills.list()
      .then((l) => setSks(l.filter((s) => s.enabled && s.userInvocable && !s.error).map((s) => ({ name: s.name, description: s.description }))))
      .catch(() => setSks([]))
  }
  const pickSkill = (name: string) => { onPickSkill(name); setSlashQ(null) }

  return (
    <div className="border-t border-[var(--color-border-subtle)] bg-[var(--color-bg-panel)] p-2.5">
      {(skill || agentName) && (
        <div className="mb-1.5 flex flex-wrap gap-1.5">
          {agentName && (
            <span data-agent-tag={agentName} title={tr('本会话绑定的 Agent（角色）：正文进系统提示、工具按它的白名单收窄')}
              className="flex items-center gap-1 rounded-md border border-[color:color-mix(in_srgb,var(--color-accent)_40%,transparent)] bg-[color:color-mix(in_srgb,var(--color-accent)_8%,transparent)] py-0.5 pl-1.5 pr-0.5 text-[11.5px] text-[var(--color-text-secondary)]">
              <Bot className="h-3 w-3 text-[var(--color-accent)]" /><span className="font-mono">{agentName}</span>
              <button onClick={onClearAgent} title={tr('解除 Agent 绑定')} className="flex h-4 w-4 items-center justify-center rounded hover:bg-[var(--color-bg-hover)]"><X className="h-3 w-3" /></button>
            </span>
          )}
          {skill && (
            <span data-skill-tag={skill} title={tr('本条消息会让 AI 先加载这个 Skill 的完整指令')}
              className="flex items-center gap-1 rounded-md border border-[color:color-mix(in_srgb,var(--color-accent)_40%,transparent)] bg-[color:color-mix(in_srgb,var(--color-accent)_10%,transparent)] py-0.5 pl-1.5 pr-0.5 text-[11.5px] text-[var(--color-accent)]">
              <Sparkles className="h-3 w-3" /><span className="font-mono">{skill}</span>
              <button onClick={onClearSkill} title={tr('移除 Skill')} className="flex h-4 w-4 items-center justify-center rounded hover:bg-[var(--color-bg-hover)]"><X className="h-3 w-3" /></button>
            </span>
          )}
        </div>
      )}
      {preview.on && <PreviewBanner onOff={() => preview.set(false)} />}
      {/* `!` 开头的终端模式标记：放在附件 chip 同一行之前，别挤进输入框里 */}
      {bang !== null && (
        <div className="mb-1.5 flex">
          <span data-bang-badge title={tr('! 开头的内容会在当前终端执行（不发给 AI），结果作为「终端块」标签放进输入框')}
            className="flex h-[22px] items-center gap-1 rounded border border-[color:color-mix(in_srgb,var(--color-warn)_50%,transparent)] bg-[color:color-mix(in_srgb,var(--color-warn)_12%,transparent)] px-1.5 text-[11px] font-medium text-[var(--color-warn)]">
            <Terminal className="h-3 w-3" />{tr('终端')}
          </span>
        </div>
      )}
      <AttachmentChips items={att.items} onRemove={att.remove} onError={att.setHint} noImage={noImage} className="mb-1.5 pt-1.5" />
      {att.hint && <div data-attach-hint className="mb-1.5 text-[11.5px] text-[var(--color-warn)]">{att.hint}</div>}
      {compactHint}
      {shellBusy && (
        <div data-shell-busy className="mb-1.5 flex items-center gap-1.5 text-[11.5px] text-[var(--color-text-muted)]">
          <Loader2 className="h-3 w-3 animate-spin-slow text-[var(--color-accent)]" />
          {tr('正在终端「{title}」执行…', { title: shellBusy })}
        </div>
      )}

      {/* 输入框高度：往上拖变高（双击恢复默认一行）；拖过的高度记在 localStorage */}
      <div data-chat-resize
        title={tr('拖动调整输入框高度（双击恢复默认）')}
        onPointerDown={onResizeDown} onDoubleClick={resetInputH}
        className="group/resize relative -mt-0.5 flex h-2 shrink-0 cursor-row-resize items-center justify-center">
        <span className="h-[4px] w-12 rounded-full bg-[var(--color-border-default)] transition-all group-hover/resize:h-[5px] group-hover/resize:bg-[var(--color-ask)]" />
      </div>

      <div {...att.dropProps} data-compose-box style={inputH ? { height: inputH } : undefined}
        className={`relative flex min-h-[104px] flex-col rounded-lg border bg-[var(--color-bg-base)] px-2.5 pb-1 pt-1.5 transition-colors ${bang !== null ? 'border-[color:color-mix(in_srgb,var(--color-warn)_60%,transparent)]' : 'border-[var(--color-border-default)] focus-within:border-[color:color-mix(in_srgb,var(--color-accent)_60%,transparent)]'}`}>
        <AtMenuPopup m={atMenu} />
        {/* `/` 唤起 Skill：键盘上下选、回车确认、Esc 关；选中后变成输入框上方的 skill tag */}
        {slashQ !== null && (
          <div data-slash-menu className="absolute bottom-full left-0 z-20 mb-1 w-[320px] rounded-lg border border-[var(--color-border-default)] bg-[var(--color-bg-panel)] p-1.5 shadow-2xl animate-fade-in">
            {slashItems.length === 0
              ? <div className="px-2.5 py-2 text-[12px] text-[var(--color-text-muted)]">{tr('没有匹配的 Skill')}</div>
              : slashItems.map((s, i) => (
                <button key={s.name} onMouseEnter={() => setSlashIdx(i)} onClick={() => { pickSkill(s.name); onInput(''); onCaret(0); setSlashQ(null) }} title={s.description}
                  className={`flex w-full flex-col gap-0.5 rounded-md px-2.5 py-1.5 text-left transition-colors ${i === slashIdx ? 'bg-[var(--color-bg-hover)]' : ''}`}>
                  <span className="font-mono text-[12.5px] text-[var(--color-text-primary)]">/{s.name}</span>
                  {s.description && <span className="truncate text-[11px] text-[var(--color-text-muted)]">{s.description}</span>}
                </button>
              ))}
          </div>
        )}
        <textarea
          ref={taRef} data-chat-input
          value={input}
          maxLength={INPUT_MAX}
          onChange={(e) => {
            const v = e.target.value
            onInput(v); onCaret(e.target.selectionStart)
            // `/` 开头且还没打空格 → 唤起 Skill 列表（打了空格就当正文了）
            const m = /^\/([^\s]*)$/.exec(v)
            if (m) { loadSkills(); setSlashQ(m[1]); setSlashIdx(0) }
            else if (slashQ !== null) setSlashQ(null)
          }}
          onSelect={(e) => onCaret(e.currentTarget.selectionStart)}
          onKeyDown={(e) => {
            // `/` 浮层开着时先吃掉上下键 / 回车 / Esc，别让它落到发送逻辑上
            if (slashQ !== null) {
              if (e.key === 'ArrowDown') { e.preventDefault(); setSlashIdx((i) => Math.min(i + 1, Math.max(0, slashItems.length - 1))); return }
              if (e.key === 'ArrowUp') { e.preventDefault(); setSlashIdx((i) => Math.max(0, i - 1)); return }
              if (e.key === 'Escape') { e.preventDefault(); setSlashQ(null); return }
              if (e.key === 'Enter' && !e.nativeEvent.isComposing && slashItems.length) {
                e.preventDefault()
                pickSkill(slashItems[Math.min(slashIdx, slashItems.length - 1)].name)
                onInput(''); onCaret(0); setSlashQ(null)
                return
              }
            }
            if (atMenu.onKey(e)) return
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); submit(e.altKey ? { queue: true } : undefined) }
          }}
          onPaste={(e) => {
            // 纯文本：超过剩余额度就必须自己截断再插入。浏览器是"先插入再按 maxLength 裁剪"，
            // 6MB 那一下已经能把界面卡死（受控 textarea 每字符重渲染 + 自动增高重算布局）。
            const text = e.clipboardData.getData('text/plain')
            if (!text) { att.onPaste(e); return }   // 文件 / 图片交给附件逻辑
            const start = taRef.current?.selectionStart ?? input.length
            const end = taRef.current?.selectionEnd ?? input.length
            if (text.length <= INPUT_MAX - (input.length - (end - start))) { att.onPaste(e); return }   // 不超限：保留原生粘贴
            e.preventDefault()
            const r = insertCapped(input, text, start, end)
            onInput(r.value)
            onCaret(r.caret)
            requestAnimationFrame(() => { const el = taRef.current; if (el) el.selectionStart = el.selectionEnd = r.caret })
            att.setHint(tr('已粘贴 {kept} 字，超过上限 {max} 字的部分已截掉（{cut} 字）', { kept: r.kept, max: INPUT_MAX, cut: r.cut }))
          }}
          disabled={!canChat}
          rows={1}
          placeholder={canChat ? (busy ? tr('追问…（Enter 在下一步前插入，Alt+Enter 本轮结束后再发）') : tr('跟 AI 对话…（Enter 发送，@ 引用，! 开头跑命令）')) : tr('等待引擎就绪…')}
          className="min-h-[28px] flex-1 resize-none overflow-y-auto bg-transparent py-[3px] text-[13px] leading-[22px] text-[var(--color-text-primary)] outline-none placeholder:text-[var(--color-text-muted)] disabled:opacity-50"
        />
        <ComposerFooter
          left={<>{menus}{model}</>}
          usage={usage} mode={mode}
          busy={busy} showSend={showSend} bang={bang} disabled={!canChat}
          onSend={() => submit()} onStop={interrupt} />
      </div>
    </div>
  )
}
