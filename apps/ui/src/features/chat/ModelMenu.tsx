import { useEffect, useRef, useState } from 'react'
import { Check, ChevronDown, Cpu, Settings2 } from 'lucide-react'
import { providerMeta, thinkingLevelsOfModel, thinkingSupportedModel, thinkingWireOfModel, THINKING_LEVELS, tr, type ModelProfile, type ThinkingLevel } from '@lingshell/shared'

// 会话所用模型 + 切换回调（会话头部模型标签用）
export interface ModelMenuProps { profiles: ModelProfile[]; current?: ModelProfile; defaultId?: string; onPick: (id: string) => void; onManage?: () => void }

/** 会话级思考深度：只影响当前会话，不动模型配置里的默认值。
 *  显示的是**实际生效值**：本会话设过就用本会话的，没设过就跟随这套模型配置里的默认值
 *  （以前只显示本会话的覆盖值，没设时三档都不高亮，跟设置页显示的不是一回事）。 */
export function ThinkingRow({ provider, model, level, fallback, onPick }: {
  provider: string; model?: string; level?: ThinkingLevel; fallback?: ThinkingLevel
  onPick: (lv: ThinkingLevel | undefined) => void
}) {
  // 按「厂商 + 模型」算：gpt-4o / deepseek-chat 这类非推理模型整行置灰，不再让人选了也没用
  const levels = thinkingLevelsOfModel(provider, model)
  const ok = thinkingSupportedModel(provider, model)
  const has = (lv: ThinkingLevel) => levels.includes(lv)
  // 本会话设过就用本会话的；没设过跟随模型配置；两者都没有就落在「中」（该厂商没有「中」就取第一个可用档）
  const effective = level ?? fallback ?? (has('medium') ? 'medium' : levels[0] ?? 'medium')
  const name = (lv: ThinkingLevel) => (lv === 'off' ? tr('关') : lv === 'low' ? tr('低') : lv === 'medium' ? tr('中') : tr('高'))
  const wire = thinkingWireOfModel(provider, model, effective)
  const sent = wire === null ? tr('不发思考参数（关闭思考）') : tr('实际发送：{wire}', { wire: wire ?? '' })
  return (
    <div className="border-t border-[var(--color-border-subtle)] px-2.5 py-2" data-thinking-row>
      <div className="mb-1 flex items-center justify-between text-[11px] text-[var(--color-text-muted)]">
        <span>{tr('思考深度')}</span>
        <span data-thinking-source={level ? 'session' : 'config'}>
          {ok ? sent : tr('这个模型不支持思考档位')}
          {ok && (level ? tr(' · 本会话') : tr(' · 跟随配置'))}
        </span>
      </div>
      <div className="flex items-center gap-1">
        {THINKING_LEVELS.map((lv) => (
          <button key={lv} data-thinking={lv} disabled={!has(lv)} onClick={() => onPick(lv)}
            title={has(lv) ? tr('本会话改为「{lv}」档，只影响当前会话', { lv: name(lv) }) : tr('这个模型没有这一档')}
            className={`h-6 flex-1 rounded border text-[11.5px] transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${effective === lv ? 'border-[color:color-mix(in_srgb,var(--color-accent)_60%,transparent)] bg-[color:color-mix(in_srgb,var(--color-accent)_12%,transparent)] text-[var(--color-accent)]' : 'border-[var(--color-border-default)] text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)]'}`}>
            {name(lv)}
          </button>
        ))}
        {ok && level !== undefined && (
          <button data-thinking="inherit" onClick={() => onPick(undefined)}
            title={tr('恢复为跟随模型配置（{lv}）', { lv: name(fallback ?? 'medium') })}
            className="h-6 shrink-0 rounded border border-[var(--color-border-default)] px-1.5 text-[11px] text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)]">
            {tr('跟随配置')}
          </button>
        )}
      </div>
    </div>
  )
}

// 会话级切换模型的列表：会话头部的模型标签点开即是
export function ModelList({ profiles, currentId, defaultId, onPick, onManage }: {
  profiles: ModelProfile[]; currentId?: string; defaultId?: string
  onPick: (id: string) => void; onManage?: () => void
}) {
  const ROW = 'flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[12.5px] transition-colors hover:bg-[var(--color-bg-hover)]'
  return (
    <>
      <div className="max-h-[260px] overflow-y-auto">
        {profiles.map((p) => {
          const meta = providerMeta(p.provider)
          const noKey = meta.needsApiKey && !p.hasApiKey
          return (
            <button key={p.id} onClick={() => onPick(p.id)} disabled={noKey} title={noKey ? tr('这套配置还没填 API Key') : `${tr(meta.label)} · ${p.model}`}
              className={`${ROW} disabled:cursor-not-allowed disabled:opacity-40`}>
              <Check className={`h-3.5 w-3.5 shrink-0 ${p.id === currentId ? 'text-[var(--color-accent)]' : 'invisible'}`} />
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="flex items-center gap-1.5 text-[var(--color-text-primary)]">
                  <span className="truncate">{tr(p.name)}</span>
                  {p.id === defaultId && <span className="shrink-0 text-[10.5px] text-[var(--color-text-muted)]">{tr('默认')}</span>}
                </span>
                <span className="truncate text-[11px] text-[var(--color-text-muted)]">{noKey ? tr('未配置 Key') : `${tr(meta.label)} · ${p.model}`}</span>
              </span>
            </button>
          )
        })}
      </div>
      {onManage && (
        <button onClick={onManage}
          className="mt-1 flex w-full items-center gap-1.5 border-t border-[var(--color-border-subtle)] px-2.5 pb-1 pt-2 text-[11.5px] text-[var(--color-text-secondary)] hover:text-[var(--color-accent)]">
          <Settings2 className="h-3.5 w-3.5" />{tr('管理模型配置…')}
        </button>
      )}
    </>
  )
}

// 会话头部的当前模型短标签：点开就是同一份列表。pending = 回合进行中切的，下一回合生效
export function ModelChip({ profile, pending, profiles, defaultId, onPick, onManage, thinking, onPickThinking }: {
  profile?: ModelProfile; pending: boolean; profiles: ModelProfile[]; defaultId?: string
  thinking?: ThinkingLevel; onPickThinking?: (lv: ThinkingLevel | undefined) => void
  onPick: (id: string) => void; onManage?: () => void
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])
  if (!profile) return null
  const tip = `${tr('当前模型：{name}（{provider} · {model}）', { name: tr(profile.name), provider: tr(providerMeta(profile.provider).label), model: profile.model })}${pending ? `\n${tr('本回合结束后生效')}` : ''}\n${tr('点击切换本会话的模型')}`
  return (
    <span ref={ref} className="relative shrink-0">
      <button onClick={() => setOpen((o) => !o)} title={tip} aria-label={tr('切换模型')}
        className={`flex max-w-[140px] items-center gap-1 rounded px-1.5 py-0.5 text-[11px] transition-colors hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-accent)] ${pending ? 'text-[var(--color-warn)]' : 'text-[var(--color-text-muted)]'}`}>
        <Cpu className="h-3 w-3 shrink-0" /><span className="truncate">{tr(profile.name)}{pending ? tr('（下一回合）') : ''}</span><ChevronDown className="h-3 w-3 shrink-0" />
      </button>
      {open && (
        <div className="absolute right-0 top-7 z-50 w-[260px] rounded-lg border border-[var(--color-border-default)] bg-[var(--color-bg-panel)] p-1.5 shadow-2xl">
          <ModelList profiles={profiles} currentId={profile.id} defaultId={defaultId}
            onPick={(id) => { setOpen(false); onPick(id) }} onManage={onManage && (() => { setOpen(false); onManage() })} />
          {onPickThinking && <ThinkingRow provider={profile.provider} model={profile.model} level={thinking} fallback={profile.thinking} onPick={onPickThinking} />}
        </div>
      )}
    </span>
  )
}
