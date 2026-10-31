import { useEffect, useState } from 'react'
import { tr, type AppInfo } from '@lingshell/shared'
import { client } from '../../../client/index.js'
import { Logo } from '../../../components/Logo.js'
import { UpdateCheck } from './UpdateCheck.js'
import { Page, Section, Row, BTN2 } from '../ui.js'

const BRAND = '灵壳 LingShell'   // i18n-ignore 品牌名不翻译
const OS: Record<string, string> = { win32: 'Windows', darwin: 'macOS', linux: 'Linux' }

// 「关于」：只放应用本身的信息——名称版本 → 更新 → 运行环境 → 版权。备份、诊断在「备份与诊断」页
// onOpenHelp：由设置弹窗接到 App 的帮助状态上（不再伪造 F1：设置弹窗是遮罩，App 的 F1 处理器会因已有弹层而不开）
export function AboutPanel({ onOpenHelp }: { onOpenHelp?: () => void }) {
  const [info, setInfo] = useState<AppInfo | null>(null)
  useEffect(() => { client.system.appInfo().then(setInfo).catch(() => {}) }, [])
  const v = (s?: string) => <span className="font-mono text-[12px] text-[var(--color-text-secondary)]">{s || '…'}</span>

  return (
    <Page>
      <div className="flex items-center gap-4 px-1 py-2">
        <Logo className="h-12 w-12 shrink-0" />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <span className="text-[16px] font-semibold text-[var(--color-text-primary)]">灵壳 LingShell</span>{/* i18n-ignore 品牌名不翻译 */}
            <span className="font-mono text-[12px] tabular-nums text-[var(--color-text-secondary)]" data-app-version>{info?.version ?? '…'}</span>
          </div>
          <div className="mt-0.5 text-[12px] text-[var(--color-text-muted)]">{tr('会思考的终端 · AI 排查和执行，你掌控每一步')}</div>
        </div>
        <button onClick={onOpenHelp} disabled={!onOpenHelp} className={BTN2}>{tr('使用帮助')}</button>
      </div>
      <UpdateCheck />
      <Section title={tr('运行环境')}>
        <Row label="Electron">{v(info?.electron)}</Row>
        <Row label="Chrome">{v(info?.chrome)}</Row>
        <Row label="Node.js">{v(info?.node)}</Row>
        <Row label={tr('系统')}>{v(info ? `${OS[info.platform] ?? info.platform} · ${info.arch}` : undefined)}</Row>
      </Section>
      <div className="px-1 text-center text-[11px] text-[var(--color-text-muted)]">
        <button
          className="underline decoration-dotted underline-offset-2 hover:text-[var(--color-text-secondary)]"
          onClick={() => window.open('https://github.com/whoiam2007s/LingShell/blob/master/THIRD_PARTY_NOTICES.md', '_blank')}
        >{tr('第三方组件许可（THIRD_PARTY_NOTICES）')}</button>
      </div>
      <div className="px-1 text-center text-[11px] text-[var(--color-text-muted)]">{tr('© {year} {brand} · 基于 Electron、xterm.js 等开源组件，各组件遵循其开源许可', { year: new Date().getFullYear(), brand: BRAND })}</div>
    </Page>
  )
}
