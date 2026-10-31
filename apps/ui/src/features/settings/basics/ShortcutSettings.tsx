// 「设置 → 快捷键」：按分组列出注册表里的全部快捷键；点键帽录制新按键，立即生效并保存（只存改过的）
import { useEffect, useState } from 'react'
import { Search } from 'lucide-react'
import { KEY_ACTIONS, KEY_ACTION_BY_ID, KEY_GROUPS, KEY_SCOPE_LABEL, findConflicts, formatKey, keyOfEvent, keyParts, shellKeyConflict, tr, validateKey, type KeyAction } from '@lingshell/shared'
import { trx } from '../../../lib/trx.js'
import { saveKeybindingOverrides, setRecordingKeys, useKeybindings } from '../../../lib/keybindings.js'
import { cn } from '../../../lib/cn.js'
import { BTN2, INPUT, Page, Row, Section } from '../ui.js'

const LINK = 'shrink-0 rounded px-1.5 py-0.5 text-[11px] transition-colors hover:bg-[var(--color-bg-hover)]'

/** 键帽：Ctrl + Shift + T 分块显示 */
export function Keycaps({ k, muted }: { k: string; muted?: boolean }) {
  return (
    <span className="inline-flex items-center gap-1">
      {keyParts(k).map((p, i) => (
        <span key={i} className="inline-flex items-center gap-1">
          {i > 0 && <span className="text-[10px] text-[var(--color-text-muted)]">+</span>}
          <kbd className={cn('min-w-[22px] rounded border border-b-2 border-[var(--color-border-default)] bg-[var(--color-bg-raised)] px-1.5 py-px text-center font-mono text-[11px]',
            muted ? 'text-[var(--color-text-muted)]' : 'text-[var(--color-text-primary)]')}>{p}</kbd>
        </span>
      ))}
    </span>
  )
}

export function ShortcutSettings() {
  const { overrides, bindings } = useKeybindings()
  const [q, setQ] = useState('')
  const [rec, setRec] = useState<string | null>(null)                                       // 正在录制的动作
  const [err, setErr] = useState<{ id: string; text: string } | null>(null)                 // 录到的键不合法
  const [pending, setPending] = useState<{ id: string; key: string; others: string[] } | null>(null)   // 冲突待确认（同一个键可能和多个动作冲突）
  const [saveErr, setSaveErr] = useState('')

  const save = (o: Record<string, string | null>) => { setSaveErr(''); saveKeybindingOverrides(o).catch((e) => setSaveErr(tr('保存失败：{error}', { error: String(e instanceof Error ? e.message : e) }))) }
  const assign = (id: string, key: string | null, extra?: Record<string, string | null>) => save({ ...overrides, ...extra, [id]: key })
  const reset = (id: string) => { const o = { ...overrides }; delete o[id]; save(o) }

  // 录制：捕获阶段截下所有按键（其它快捷键处理同时暂停），不让它们触发任何动作
  useEffect(() => {
    if (!rec) return
    setRecordingKeys(true)
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault(); e.stopPropagation()
      if (e.isComposing) return
      const plain = !e.ctrlKey && !e.altKey && !e.shiftKey && !e.metaKey
      if (plain && e.key === 'Escape') { setRec(null); return }
      if (plain && e.key === 'Backspace') { assign(rec, null); setRec(null); return }
      const k = keyOfEvent(e)
      if (!k) return   // 只按了修饰键，等主键
      const bad = validateKey(k)
      if (bad) { setErr({ id: rec, text: tr('{key}：{error}', { key: formatKey(k), error: bad }) }); return }
      setErr(null); setRec(null)
      const others = findConflicts(rec, k, bindings)
      if (others.length) setPending({ id: rec, key: k, others })
      else assign(rec, k)
    }
    window.addEventListener('keydown', onKey, true)
    return () => { window.removeEventListener('keydown', onKey, true); setRecordingKeys(false) }
  }, [rec, bindings, overrides])

  const startRec = (id: string) => { setPending(null); setErr(null); setRec(id) }
  const needle = q.trim().toLowerCase().replace(/\s+/g, '')
  const match = (a: KeyAction) => {
    if (!needle) return true
    const k = a.editable ? bindings[a.id] : a.keys
    // 中文原名和译名都能搜到（英文界面也能用中文搜）
    return [a.name, tr(a.name), k ?? '', k ? formatKey(k) : '未设置', k ? tr(k) : tr('未设置')].some((s) => s.toLowerCase().replace(/\s+/g, '').includes(needle))   // i18n-ignore 搜索同时匹配中文原文
  }
  const changed = Object.keys(overrides).length > 0

  const rowOf = (a: KeyAction) => {
    const cur = a.editable ? bindings[a.id] : a.keys
    const isChanged = a.editable && Object.prototype.hasOwnProperty.call(overrides, a.id)
    const recording = rec === a.id
    const shell = isChanged && cur && a.scope !== 'outside' ? shellKeyConflict(cur) : null
    const scope = tr(KEY_SCOPE_LABEL[a.scope])
    const tip = <>{tr(a.desc)}<br /><span className="text-[var(--color-text-muted)]">{a.editable ? tr('作用范围：{scope}', { scope }) : tr('作用范围：{scope}（不可修改）', { scope })}</span></>
    const hint = pending?.id === a.id ? (
      <span className="flex flex-wrap items-center gap-1.5 text-[var(--color-danger)]">
        {trx('{keys}与『{names}』冲突', { keys: <Keycaps k={pending.key} />, names: pending.others.map((id) => { const n = KEY_ACTION_BY_ID[id]?.name; return n ? tr(n) : id }).join(tr('、')) })}
        <button className={cn(LINK, 'text-[var(--color-danger)]')} onClick={() => { assign(pending.id, pending.key, Object.fromEntries(pending.others.map((id) => [id, null]))); setPending(null) }}>{tr('仍然替换（对方变为未设置）')}</button>
        <button className={cn(LINK, 'text-[var(--color-text-secondary)]')} onClick={() => setPending(null)}>{tr('取消')}</button>
      </span>
    ) : recording ? <span className="text-[var(--color-accent)]">{tr('按下新的组合键… Esc 取消，Backspace 清除')}{err?.id === a.id && <span className="ml-2 text-[var(--color-danger)]">{err.text}</span>}</span>
      : shell ? <span className="text-[var(--color-warn)]">{tr('会占用终端里的 {key}', { key: shell })}</span>
      : undefined
    return (
      <Row key={a.id} label={tr(a.name)} tip={tip} hint={hint}>
        {isChanged && !recording && <button className={cn(LINK, 'text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]')} onClick={() => reset(a.id)} title={tr('默认：{key}', { key: formatKey(a.keys) })}>{tr('恢复默认')}</button>}
        {a.editable ? (
          <button data-shortcut={a.id} onClick={() => (recording ? setRec(null) : startRec(a.id))} onBlur={() => { if (recording) setRec(null) }}
            aria-label={cur ? tr('{name} 的快捷键：{key}', { name: tr(a.name), key: formatKey(cur) }) : tr('{name} 的快捷键：未设置', { name: tr(a.name) })}
            title={recording ? tr('按下新的组合键，Esc 取消') : tr('点击修改')}
            className={cn('flex min-h-[28px] min-w-[120px] items-center justify-end rounded-md border px-2 py-1 transition-colors',
              recording ? 'border-[var(--color-accent)] bg-[var(--color-accent-bg)]' : 'border-transparent hover:border-[var(--color-border-default)] hover:bg-[var(--color-bg-hover)]')}>
            {recording ? <span className="text-[11.5px] text-[var(--color-accent)]">{tr('按下组合键…')}</span>
              : cur ? <Keycaps k={cur} /> : <span className="text-[11.5px] text-[var(--color-text-muted)]">{tr('未设置')}</span>}
          </button>
        ) : <span className="flex min-h-[28px] min-w-[120px] items-center justify-end px-2 text-[11.5px] text-[var(--color-text-muted)]">{tr(a.keys)}</span>}
      </Row>
    )
  }

  const groups = KEY_GROUPS.map((g) => ({ g, items: KEY_ACTIONS.filter((a) => a.group === g.id && match(a)) })).filter((x) => x.items.length)
  return (
    <Page>
      <div className="flex items-center gap-2">
        <div className="relative min-w-0 flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[var(--color-text-muted)]" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={tr('按动作名或按键搜索，如「终端」「Ctrl+Shift」')} aria-label={tr('搜索快捷键')} className={cn(INPUT, 'w-full pl-8')} />
        </div>
        <button className={BTN2} disabled={!changed} onClick={() => { setPending(null); setRec(null); save({}) }}>{tr('全部恢复默认')}</button>
      </div>
      {saveErr && <div className="text-[12px] text-[var(--color-danger)]">{saveErr}</div>}
      {groups.map(({ g, items }) => <Section key={g.id} title={tr(g.label)}>{items.map(rowOf)}</Section>)}
      {!groups.length && <div className="py-8 text-center text-[12px] text-[var(--color-text-muted)]">{tr('没有匹配的快捷键')}</div>}
    </Page>
  )
}
