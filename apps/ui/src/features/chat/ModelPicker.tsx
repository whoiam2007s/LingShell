import { useEffect, useRef, useState } from 'react'
import { Aperture, Asterisk, Boxes, Check, ChevronDown, ChevronRight, Cpu, Settings2, Sparkles } from 'lucide-react'
import { providerMeta, thinkingLevelsOfModel, THINKING_LEVELS, tr, type ModelProfile, type ThinkingLevel } from '@lingshell/shared'
import { ThinkingBar, thinkingLabel } from './ThinkingBar.js'

// 各家 provider 的图标；没登记过的用 Cpu 兜底，别让列表看着像纯文字
const PROVIDER_ICON: Record<string, typeof Cpu> = {
  deepseek: Sparkles,
  anthropic: Asterisk,
  openai: Aperture,
}
const iconOf = (provider: string) => PROVIDER_ICON[provider] ?? (provider === 'openai-compatible' ? Boxes : Cpu)

/** 本会话用量快照（模型面板最底「查看用量」用，数据由 ChatPanel 传下来） */
export interface PickerUsage { requests: number; total: number; cacheRate: number; cost?: number; currency?: string }

export function ModelPicker({ profiles, current, defaultId, thinking, onPick, onPickThinking, onManage, onViewUsage }: {
  profiles: ModelProfile[]
  current?: ModelProfile
  defaultId?: string
  thinking?: ThinkingLevel
  onPick: (id: string) => void
  onPickThinking?: (lv: ThinkingLevel | undefined) => void
  onManage?: () => void
  onViewUsage?: () => void
}) {
  const ROW = 'flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors'

  const levels = current ? thinkingLevelsOfModel(current.provider, current.model) : THINKING_LEVELS
  // 显示的是本会话实际生效值：本会话设过就用本会话的，否则跟随这套模型配置
  const effective: ThinkingLevel = thinking ?? current?.thinking ?? (levels.includes('off') ? 'off' : levels[0] ?? 'off')
  const supportsThinking = levels.length > 1

  return (
    <div className="flex w-[300px] flex-col" data-model-picker>
      <div className="max-h-[292px] overflow-y-auto p-1.5">
        {profiles.map((p) => {
          const meta = providerMeta(p.provider)
          const noKey = meta.needsApiKey && !p.hasApiKey
          const active = p.id === current?.id
          const Icon = iconOf(p.provider)
          const lv = p.thinking
          return (
            <button key={p.id} data-model-pick={p.id} disabled={noKey}
              onClick={() => onPick(p.id)}
              title={noKey ? tr('这套配置还没填 API Key') : `${tr(meta.label)} · ${p.model}`}
              className={`${ROW} disabled:cursor-not-allowed disabled:opacity-45 ${active ? 'bg-[color:color-mix(in_srgb,var(--color-accent)_10%,transparent)]' : 'hover:bg-[var(--color-bg-hover)]'}`}>
              <Icon className={`h-[18px] w-[18px] shrink-0 ${active ? 'text-[var(--color-accent)]' : 'text-[var(--color-text-secondary)]'}`} />
              <span className={`min-w-0 flex-1 truncate text-[13px] ${active ? 'font-medium text-[var(--color-text-primary)]' : 'text-[var(--color-text-primary)]'}`}>
                {tr(p.name)}
              </span>
              {lv && supportsThinking && (
                <span className="shrink-0 text-[11px] text-[var(--color-text-muted)]">{thinkingLabel(lv)}</span>
              )}
              {p.id === defaultId && (
                <span className="shrink-0 rounded-full bg-[var(--color-bg-hover)] px-1.5 py-0.5 text-[10.5px] text-[var(--color-text-muted)]">{tr('默认')}</span>
              )}
              {noKey && (
                <span className="shrink-0 rounded-full bg-[var(--color-bg-hover)] px-1.5 py-0.5 text-[10.5px] text-[var(--color-text-muted)]">{tr('未配置')}</span>
              )}
              <Check className={`h-3.5 w-3.5 shrink-0 ${active ? 'text-[var(--color-accent)]' : 'invisible'}`} />
            </button>
          )
        })}
        {profiles.length === 0 && (
          <div className="px-3 py-6 text-center text-[12px] text-[var(--color-text-muted)]">{tr('还没有模型配置')}</div>
        )}
      </div>

      {current && supportsThinking && onPickThinking && (
        <div className="border-t border-[var(--color-border-subtle)]">
          <ThinkingBar value={effective} levels={levels} onChange={(lv) => onPickThinking(lv)} />
        </div>
      )}

      {supportsThinking && !onPickThinking && (
        <div className="border-t border-[var(--color-border-subtle)] px-3 py-2 text-[11.5px] text-[var(--color-text-muted)]">
          {tr('这个模型不支持推理档位')}
        </div>
      )}

      <div className="border-t border-[var(--color-border-subtle)] p-1.5">
        <button data-usage-entry onClick={() => onViewUsage?.()}
          className={`${ROW} justify-between text-[12px] text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)]`}>
          <span className="flex items-center gap-2">
            <Cpu className="h-[15px] w-[15px]" />{tr('查看用量')}
          </span>
          <ChevronRight className="h-3.5 w-3.5" />
        </button>
        {onManage && (
          <button onClick={onManage}
            className={`${ROW} text-[12px] text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)]`}>
            <Settings2 className="h-[15px] w-[15px]" />{tr('管理模型配置…')}
          </button>
        )}
      </div>
    </div>
  )
}

/** 底部工具栏的模型短标签：点开即上面这个面板（pending = 回合进行中切的，下一回合生效） */
export function ModelChip({ profile, pending, profiles, defaultId, thinking, note, onPick, onPickThinking, onManage, onViewUsage }: {
  profile?: ModelProfile; pending: boolean; profiles: ModelProfile[]; defaultId?: string
  thinking?: ThinkingLevel; note?: { ok: boolean; text: string }
  onPick: (id: string) => void; onPickThinking?: (lv: ThinkingLevel | undefined) => void
  onManage?: () => void; onViewUsage?: () => void
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLSpanElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false) }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey, true)
    }
  }, [open])

  if (!profile) return null
  const meta = providerMeta(profile.provider)
  const Icon = iconOf(profile.provider)
  const lv = thinking ?? profile.thinking
  const tip = `${tr('当前模型：{name}（{provider} · {model}）', { name: tr(profile.name), provider: tr(meta.label), model: profile.model })}${pending ? `\n${tr('本回合结束后生效')}` : ''}\n${tr('点击切换模型 / 推理等级')}`
  return (
    <span ref={ref} className="relative shrink-0">
      <button data-model-chip onClick={() => setOpen((o) => !o)} title={tip} aria-expanded={open}
        className={`flex h-7 max-w-[210px] items-center gap-1.5 rounded-full border border-[var(--color-border-subtle)] px-2 text-[11.5px] transition-colors hover:bg-[var(--color-bg-hover)] ${pending ? 'text-[var(--color-warn)]' : 'text-[var(--color-text-secondary)]'}`}>
        <Icon className="h-[15px] w-[15px] shrink-0 text-[var(--color-accent)]" />
        <span className="truncate">{tr(profile.name)}</span>
        {lv && <span className="shrink-0 text-[11px] text-[var(--color-text-muted)]">{thinkingLabel(lv)}</span>}
        <ChevronDown className="h-3 w-3 shrink-0" />
      </button>
      {note && (
        <span data-model-note title={note.text}
          className={`ml-1 max-w-[140px] shrink-0 truncate text-[11px] ${note.ok ? 'text-[var(--color-text-secondary)]' : 'text-[var(--color-danger)]'}`}>
          {note.text}
        </span>
      )}
      {open && (
        <div className="absolute bottom-full left-0 z-50 mb-2 rounded-xl border border-[var(--color-border-default)] bg-[var(--color-bg-panel)] shadow-2xl animate-fade-in">
          <ModelPicker profiles={profiles} current={profile} defaultId={defaultId}
            thinking={thinking}
            onPick={(id) => { setOpen(false); onPick(id) }}
            onPickThinking={onPickThinking}
            onManage={onManage && (() => { setOpen(false); onManage() })}
            onViewUsage={onViewUsage && (() => { setOpen(false); onViewUsage() })} />
        </div>
      )}
    </span>
  )
}
