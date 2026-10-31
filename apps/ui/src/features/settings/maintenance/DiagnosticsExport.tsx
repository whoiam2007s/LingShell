import { useState } from 'react'
import { tr } from '@lingshell/shared'
import { client } from '../../../client/index.js'
import { trx } from '../../../lib/trx.js'
import { Section, Row, BTN2 } from '../ui.js'

// 「[已脱敏]」是导出文件里的原样标记（英文界面也一样），作为参数传入
const tip = () => trx('遇到问题时导出发给开发者。{br}包含：应用 / 系统版本与环境探测、最近 3 次运行日志（每个末尾约 2MB）、脱敏后的设置 / 主机列表（地址、用户名、备注保留）/ 布局 / 巡检计划、会话与记录的数量统计。{br}不包含：API Key 与主机密码 / 私钥（已替换为「{mark}」）、会话对话内容、AI 执行过的命令、命令历史、本地 API token。{br}主机备注、本机备注、自定义规则按原文导出，分享前请自行检查。', { br: <br />, mark: '[已脱敏]' })   // i18n-ignore 导出文件里的脱敏标记

// 导出诊断包：包含 / 不包含什么放在问号说明里
export function DiagnosticsExport() {
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)

  const run = async () => {
    setBusy(true); setMsg(null)
    try {
      const p = await client.system.exportDiagnostics()
      if (p) setMsg({ ok: true, text: tr('已导出：{path}', { path: p }) })
    } catch (e) {
      setMsg({ ok: false, text: tr('导出失败：{error}', { error: e instanceof Error ? e.message : String(e) }) })
    } finally { setBusy(false) }
  }

  return (
    <Section title={tr('诊断包')}>
      <Row label={tr('日志与环境信息')} tip={tip()}
        hint={msg ? <span className={`block truncate ${msg.ok ? 'text-[var(--color-success)]' : 'text-[var(--color-danger)]'}`} title={msg.text}>{msg.text}</span> : tr('已脱敏，不含密钥、密码和对话内容')}>
        <button onClick={run} disabled={busy} className={BTN2}>{busy ? tr('导出中…') : tr('导出诊断包')}</button>
      </Row>
    </Section>
  )
}
