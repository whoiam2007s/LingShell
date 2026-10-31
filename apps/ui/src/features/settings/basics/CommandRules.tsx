import { useEffect, useState } from 'react'
import { Plus, Trash2, ArrowUp, ArrowDown } from 'lucide-react'
import { hostGroupNames, ruleError, type CommandRule, type HostSummary, tr } from '@lingshell/shared'
import { client } from '../../../client/index.js'
import { Select } from '../../../components/ui/Select.js'
import { Input } from '../../../components/ui/Input.js'
import { Checkbox } from '../../../components/ui/Checkbox.js'
import { BTN2 } from '../ui.js'

const ICON = 'flex h-6 w-6 shrink-0 items-center justify-center rounded text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text-primary)] disabled:opacity-30 disabled:hover:bg-transparent'

// 命令规则列表（设置 → AI 与安全 → 命令规则）：匹配方式 / 模式 / 动作 / 范围 / 备注，可上下移动（先匹配先生效）
export function CommandRules({ rules, onChange }: { rules: CommandRule[]; onChange: (r: CommandRule[]) => void }) {
  const [hosts, setHosts] = useState<HostSummary[]>([])
  useEffect(() => { client.hosts.list().then(setHosts).catch(() => {}) }, [])
  const groups = hostGroupNames(hosts)
  const set = (i: number, p: Partial<CommandRule>) => onChange(rules.map((r, j) => (j === i ? { ...r, ...p } : r)))
  const move = (i: number, d: -1 | 1) => {
    const next = [...rules]
    ;[next[i], next[i + d]] = [next[i + d], next[i]]
    onChange(next)
  }
  const toggle = (list: string[] | undefined, v: string, on: boolean) => (on ? [...new Set([...(list ?? []), v])] : (list ?? []).filter((x) => x !== v))
  const hostOpts = [{ key: 'local', label: tr('本地终端') }, ...hosts.map((h) => ({ key: h.id, label: h.label }))]

  return (
    <div className="space-y-2">
      {rules.map((r, i) => {
        const err = ruleError(r)
        return (
          <div key={r.id} data-command-rule className="space-y-1.5 rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-bg-panel)] p-2">
            <div className="flex items-center gap-1.5">
              <span className="w-5 shrink-0 text-center text-[11px] tabular-nums text-[var(--color-text-muted)]" title={tr('越靠前越先匹配')}>{i + 1}</span>
              <Select size="sm" className="w-[84px]" value={r.match} onValueChange={(v) => set(i, { match: v as CommandRule['match'] })}
                options={[{ value: 'prefix', label: tr('前缀') }, { value: 'regex', label: tr('正则') }]} />
              <Input size="sm" value={r.pattern} onChange={(e) => set(i, { pattern: e.target.value })} spellCheck={false}
                placeholder={r.match === 'prefix' ? tr('如 systemctl status （命令段开头）') : tr('如 ^rm\\s')} title={err && tr(err)}
                className={`flex-1 font-mono ${err && r.pattern ? 'border-[var(--color-danger)]' : ''}`} />
              <Select size="sm" className="w-[96px]" value={r.action} onValueChange={(v) => set(i, { action: v as CommandRule['action'] })}
                options={[{ value: 'allow', label: tr('总是放行') }, { value: 'ask', label: tr('总是询问') }, { value: 'deny', label: tr('总是禁止') }]} />
              <Select size="sm" className="w-[120px]" value={r.scope} onValueChange={(v) => set(i, { scope: v as CommandRule['scope'] })}
                options={[{ value: 'all', label: tr('全部主机') }, { value: 'groups', label: tr('指定分组') }, { value: 'hosts', label: tr('指定主机') }]} />
              <button title={tr('上移')} disabled={i === 0} onClick={() => move(i, -1)} className={ICON}><ArrowUp className="h-3.5 w-3.5" /></button>
              <button title={tr('下移')} disabled={i === rules.length - 1} onClick={() => move(i, 1)} className={ICON}><ArrowDown className="h-3.5 w-3.5" /></button>
              <button title={tr('删除')} onClick={() => onChange(rules.filter((_, j) => j !== i))} className={`${ICON} hover:!text-[var(--color-danger)]`}><Trash2 className="h-3.5 w-3.5" /></button>
            </div>
            {err && r.pattern && <div className="pl-6 text-[11px] text-[var(--color-danger)]">{tr(err)}</div>}
            <div className="pl-6">
              <Input size="sm" value={r.note ?? ''} onChange={(e) => set(i, { note: e.target.value })} placeholder={tr('备注（可选，如：只读查看，放心放行）')} />
            </div>
            {r.scope !== 'all' && (
              <div className="flex flex-wrap gap-x-3 gap-y-1 pl-6 text-[11.5px] text-[var(--color-text-secondary)]">
                {(r.scope === 'groups' ? groups.map((g) => ({ key: g, label: g })) : hostOpts).map((o) => {
                  const list = r.scope === 'groups' ? r.groups : r.hosts
                  return (
                    <label key={o.key} className="flex cursor-pointer items-center gap-1">
                      <Checkbox checked={!!list?.includes(o.key)}
                        onCheckedChange={(v) => set(i, r.scope === 'groups' ? { groups: toggle(r.groups, o.key, v) } : { hosts: toggle(r.hosts, o.key, v) })} />
                      {o.label}
                    </label>
                  )
                })}
                {r.scope === 'groups' && !groups.length && <span className="text-[var(--color-text-muted)]">{tr('还没有主机分组（在主机管理里给主机设分组）')}</span>}
                {!(r.scope === 'groups' ? r.groups : r.hosts)?.length && (r.scope === 'hosts' || groups.length > 0) && <span className="text-[var(--color-warn)]">{tr('未选择，此规则不生效')}</span>}
              </div>
            )}
          </div>
        )
      })}
      {rules.length === 0 && <div className="py-2 text-center text-[12px] text-[var(--color-text-muted)]">{tr('还没有规则：AI 执行命令全按会话信任档决定是否弹授权卡')}</div>}
      <button onClick={() => onChange([...rules, { id: `cr${Date.now().toString(36)}`, match: 'prefix', pattern: '', action: 'allow', scope: 'all' }])}
        className={`${BTN2} flex items-center gap-1`}><Plus className="h-3.5 w-3.5" />{tr('添加规则')}</button>
    </div>
  )
}
