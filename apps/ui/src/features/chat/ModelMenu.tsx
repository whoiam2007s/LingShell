import { useEffect, useRef, useState } from 'react'
import { Check, ChevronDown, Cpu, Settings2 } from 'lucide-react'
import { providerMeta, tr, type ModelProfile } from '@lingshell/shared'

// 会话所用模型 + 切换回调（会话头部模型标签用）
export interface ModelMenuProps { profiles: ModelProfile[]; current?: ModelProfile; defaultId?: string; onPick: (id: string) => void; onManage?: () => void }

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
export function ModelChip({ profile, pending, profiles, defaultId, onPick, onManage }: {
  profile?: ModelProfile; pending: boolean; profiles: ModelProfile[]; defaultId?: string
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
        </div>
      )}
    </span>
  )
}
