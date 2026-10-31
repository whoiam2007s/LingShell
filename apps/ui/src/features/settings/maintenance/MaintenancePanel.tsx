import { useEffect, useState } from 'react'
import { tr, type AppInfo } from '@lingshell/shared'
import { client } from '../../../client/index.js'
import { ConfigBackup } from './ConfigBackup.js'
import { DiagnosticsExport } from './DiagnosticsExport.js'
import { Page, Section, Row, BTN2 } from '../ui.js'

const dataTip = () => tr('配置、主机、会话与对话、执行记录、命令历史、终端录像、运行日志都存在这里。设了环境变量 LINGSHELL_DATA_DIR 时使用该目录。备份可直接复制整个目录（含加密凭据，换电脑后凭据无法解密，换电脑请用「配置导出」）。')
const logTip = () => tr('每次启动一个子目录，只保留最近 20 次运行。反馈问题时更推荐导出诊断包（会自动脱敏）。')

// 「备份与诊断」：配置导出 → 配置导入 → 诊断包 → 数据目录
export function MaintenancePanel() {
  const [info, setInfo] = useState<AppInfo | null>(null)
  const [err, setErr] = useState('')
  useEffect(() => { client.system.appInfo().then(setInfo).catch(() => {}) }, [])
  const open = (which: 'data' | 'logs') => { setErr(''); client.system.openDir(which).catch((e) => setErr(tr('打开失败：{error}', { error: e instanceof Error ? e.message : String(e) }))) }
  const path = (p?: string) => <span className="block truncate font-mono" title={p}>{p ?? '…'}</span>

  return (
    <Page>
      <ConfigBackup />
      <DiagnosticsExport />
      <Section title={tr('数据目录')}>
        <Row label={tr('数据目录')} tip={dataTip()} hint={path(info?.dataDir)}>
          <button onClick={() => open('data')} className={BTN2}>{tr('打开数据目录')}</button>
        </Row>
        <Row label={tr('运行日志')} tip={logTip()} hint={path(info?.logsDir)}>
          <button onClick={() => open('logs')} className={BTN2}>{tr('打开日志目录')}</button>
        </Row>
        {err && <div className="px-3.5 py-2 text-[11.5px] text-[var(--color-danger)]">{err}</div>}
      </Section>
    </Page>
  )
}
