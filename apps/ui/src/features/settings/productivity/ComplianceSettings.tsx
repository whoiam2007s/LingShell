import { useEffect, useState } from 'react'
import { Layers } from 'lucide-react'
import { COMPLIANCE_SEVERITY_LABEL, LINUX_BASELINE, tr } from '@lingshell/shared'
import { client } from '../../../client/index.js'
import { Switch } from '../../../components/ui/Switch.js'
import { openComplianceBatch } from '../../hostcheck/index.js'
import { Page, Section, HelpTip, BTN1, LIST, ITEM, Toolbar, errText } from '../ui.js'

// 设置 →「合规基线」：内置 Linux 基线各条目的开关（关掉的不检查，如跑容器的主机要开 ip_forward）。改了立即保存
export function ComplianceSettings() {
  const [disabled, setDisabled] = useState<string[] | null>(null)
  const [err, setErr] = useState('')
  useEffect(() => { client.compliance.config().then((c) => setDisabled(c.disabled)).catch((e) => setErr(errText(e))) }, [])
  const toggle = (id: string, on: boolean) => {
    if (!disabled) return
    const next = on ? disabled.filter((x) => x !== id) : [...disabled, id]
    setDisabled(next)
    client.compliance.setDisabled(next).then((c) => setDisabled(c.disabled)).catch((e) => setErr(errText(e)))
  }
  return (
    <Page>
      <Toolbar hint={tr('在主机体检抽屉「合规」页检查单台，或批量检查多台')} tip={tr('只读检查：不用 sudo、不改任何东西；修复建议只给命令，需要你确认后自己执行。关掉的条目在单台与批量检查里都不跑、不进导出的 CSV。')}>
        <button onClick={() => openComplianceBatch()} className={BTN1}><Layers className="h-3.5 w-3.5" />{tr('批量合规检查')}</button>
      </Toolbar>
      {err && <div className="text-[12px] text-[var(--color-danger)]">{err}</div>}
      <Section title={tr('Linux 基线（{n} 条）', { n: LINUX_BASELINE.length })}>
        <div className={LIST} data-compliance-settings>
          {LINUX_BASELINE.map((i) => (
            <div key={i.id} className={ITEM}>
              <Switch checked={!!disabled && !disabled.includes(i.id)} disabled={!disabled} onCheckedChange={(v) => toggle(i.id, v)} aria-label={tr(i.title)} />
              <span className="min-w-0 flex-1 truncate text-[var(--color-text-primary)]">{tr(i.title)}</span>
              <span className="shrink-0 text-[11px] text-[var(--color-text-muted)]">{tr('严重度 {level}', { level: tr(COMPLIANCE_SEVERITY_LABEL[i.severity]) })}{i.advisory ? tr(' · 建议级') : ''}</span>
              <HelpTip>{tr('修复建议：{fix}', { fix: tr(i.fix) })}</HelpTip>
            </div>
          ))}
        </div>
      </Section>
    </Page>
  )
}
