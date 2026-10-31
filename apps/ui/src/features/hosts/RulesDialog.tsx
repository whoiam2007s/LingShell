import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { ScrollText } from 'lucide-react'
import { RULE_TEXT_MAX, tr } from '@lingshell/shared'
import { client } from '../../client/index.js'
import { TEXTAREA } from '../../components/ui/form.js'

export type RulesTarget = { kind: 'group'; group: string } | { kind: 'host'; hostId: string; label: string }

// 分组 / 主机规则编辑（主机面板右键 →「分组规则…」/「规则…」）。只能按按钮或 Esc 关，点遮罩不关
export function RulesDialog({ target, onClose }: { target: RulesTarget; onClose: () => void }) {
  const [text, setText] = useState('')
  const [loaded, setLoaded] = useState(false)
  const [err, setErr] = useState('')
  useEffect(() => {
    client.safety.rules().then((r) => setText((target.kind === 'group' ? r.groups[target.group] : r.hosts[target.hostId]) ?? '')).catch(() => {}).finally(() => setLoaded(true))
  }, [target])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose() } }
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [onClose])
  const save = () => {
    const p = target.kind === 'group' ? client.safety.setGroupRules(target.group, text) : client.safety.setHostRules(target.hostId, text)
    p.then(onClose).catch((e) => setErr(String((e as Error)?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')))
  }
  const title = target.kind === 'group' ? tr('分组「{name}」的规则', { name: target.group }) : tr('主机「{name}」的规则', { name: target.label })
  return createPortal((
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/55 backdrop-blur-sm animate-fade-in" onMouseDown={(e) => e.stopPropagation()}>
      <div data-rules-dialog className="w-[520px] rounded-lg border border-[var(--color-border-default)] bg-[var(--color-bg-panel)] p-5 shadow-2xl">
        <div className="mb-1.5 flex items-center gap-2 text-[14px] font-semibold text-[var(--color-text-primary)]">
          <ScrollText className="h-4 w-4 text-[var(--color-accent)]" />{title}
        </div>
        <p className="mb-2.5 text-[12px] leading-relaxed text-[var(--color-text-secondary)]">
          {tr('AI 用到{target}后，这些规则会注入它的系统提示，必须遵守。', { target: target.kind === 'group' ? tr('这个分组里的主机') : tr('这台主机') })}
          {' '}{tr('叠加顺序：全局 → 分组 → 主机 → 工作目录，越具体的优先。不要写密码等机密。')}
        </p>
        <textarea autoFocus value={text} onChange={(e) => setText(e.target.value)} rows={7} maxLength={RULE_TEXT_MAX} disabled={!loaded}
          placeholder={target.kind === 'group' ? tr('例：禁止重启 mysqld；任何变更前先 mysqldump 备份') : tr('例：这台是主库，只读排查；改配置前先告诉我')}
          className={TEXTAREA} />
        <div className="mt-1 flex items-center text-[11px] text-[var(--color-text-muted)]">
          <span>{tr('清空后保存 = 删除规则')}</span><span className="ml-auto tabular-nums">{text.length} / {RULE_TEXT_MAX}</span>
        </div>
        {err && <div className="mt-2 text-[12px] text-[var(--color-danger)]">{err}</div>}
        <div className="mt-3.5 flex justify-end gap-2">
          <button onClick={onClose} className="rounded-md border border-[var(--color-border-default)] px-4 py-1.5 text-[12.5px] text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-bg-hover)]">{tr('取消')}</button>
          <button onClick={save} disabled={!loaded} className="rounded-md border border-transparent bg-[var(--color-accent)] px-4 py-1.5 text-[12.5px] font-medium text-[var(--color-bg-base)] transition-colors hover:bg-[var(--color-accent-dim)] disabled:opacity-40">{tr('保存')}</button>
        </div>
      </div>
    </div>
  ), document.body)
}
