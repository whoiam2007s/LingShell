import { useEffect, useState } from 'react'
import { tr, type UpdateStatus } from '@lingshell/shared'
import { client } from '../../../client/index.js'
import { Section, Row, BTN2 } from '../ui.js'

const TEXT: Record<UpdateStatus['state'], (s: UpdateStatus) => string> = {
  disabled: () => tr('未配置更新源'),
  checking: () => tr('正在检查更新…'),
  none: () => tr('已是最新版本'),
  available: (s) => tr('发现新版本 {version}，准备下载…', { version: s.version ?? '' }),
  downloading: (s) => tr('正在下载 {version}（{percent}%）', { version: s.version ?? '', percent: s.percent ?? 0 }),
  downloaded: (s) => tr('新版本 {version} 已下载，重启后生效', { version: s.version ?? '' }),
  error: (s) => tr('检查更新失败：{error}', { error: s.error ?? tr('未知错误') }),
}

// 关于 / 更新：一行状态 + 「检查更新」；下载完成后给「重启以更新」，不强制重启（版本号在关于页顶部）
export function UpdateCheck() {
  const [st, setSt] = useState<UpdateStatus | null>(null)
  const [installErr, setInstallErr] = useState('')

  useEffect(() => {
    client.system.getUpdateStatus().then((r) => setSt(r.status)).catch(() => {})
    return client.on((ev) => {
      if (ev.type === 'update:status') setSt({ state: ev.state, version: ev.version, percent: ev.percent, error: ev.error })
    })
  }, [])

  const check = () => { client.system.checkUpdate().then(setSt).catch((e) => setSt({ state: 'error', error: e instanceof Error ? e.message : String(e) })) }
  const busy = st?.state === 'checking' || st?.state === 'downloading' || st?.state === 'available'
  const color = st?.state === 'error' ? 'text-[var(--color-danger)]' : st?.state === 'downloaded' ? 'text-[var(--color-success)]' : ''

  return (
    <Section title={tr('更新')}>
      <Row label={tr('软件更新')}
        hint={st ? <span className={`block truncate ${color}`} title={TEXT[st.state](st)}>{TEXT[st.state](st)}</span> : '…'}
        tip={st?.state === 'downloaded' ? tr('点「重启以更新」立即安装；不点的话会在下次退出应用时自动安装。') : tr('有新版本时自动下载，下载完成后由你决定何时重启安装。')}>
        {st?.state === 'downloaded' && (
          <button onClick={() => {
            setInstallErr('')
            client.system.installUpdate().catch((e) => setInstallErr(tr('启动安装失败：{error}', { error: String((e as Error)?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '') })))
          }}
            className="rounded-md bg-[var(--color-accent)] px-3 py-1.5 text-[12px] font-medium text-[var(--color-bg-base)] transition-colors hover:bg-[var(--color-accent-dim)]">
            {tr('重启以更新')}
          </button>
        )}
        {st && st.state !== 'disabled' && st.state !== 'downloaded' && (
          <button onClick={check} disabled={busy} className={BTN2}>{tr('检查更新')}</button>
        )}
      </Row>
      {installErr && <div className="px-3.5 pb-2 text-[11.5px] text-[var(--color-danger)]">{installErr}</div>}
    </Section>
  )
}
