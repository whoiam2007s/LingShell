import { useEffect, useState } from 'react'
import { tr, type UpdateStatus } from '@lingshell/shared'
import { client } from '../../../client/index.js'
import { Section, Row, BTN2 } from '../ui.js'
import { saveSystemPatch } from '../../../lib/systemSave.js'

// 手动下载地址：发布页（更新源是自建 mirror 时这里仍指向官方发布页，作为最后的兜底）
const RELEASE_PAGE = 'https://github.com/whoiam2007s/LingShell/releases/latest'

const TEXT: Record<UpdateStatus['state'], (s: UpdateStatus) => string> = {
  disabled: () => tr('未配置更新源'),
  checking: () => tr('正在检查更新…'),
  none: () => tr('已是最新版本'),
  available: (s) => tr('发现新版本 {version}，准备下载…', { version: s.version ?? '' }),
  downloading: (s) => tr('正在下载 {version}（{percent}%）', { version: s.version ?? '', percent: s.percent ?? 0 }),
  downloaded: (s) => tr('新版本 {version} 已下载，重启后生效', { version: s.version ?? '' }),
  error: (s) => tr('检查更新失败：{error}', { error: s.error ?? tr('未知错误') }),
}

// 失败归类与主进程 updateLogic.classifyUpdateError 同规则（UI 不跨包 import 主进程模块）
const errorKind = (msg?: string): 'network' | 'signature' | 'disk' | 'other' => {
  const s = (msg ?? '').toLowerCase()
  if (!s) return 'other'
  if (/enotfound|econnreset|econnrefused|etimedout|getaddrinfo|socket hang up|network|proxy|timed? ?out|certificate|x509|err_/.test(s)) return 'network'
  if (/sha512|sha256|checksum|signature|integrity|verif/.test(s)) return 'signature'
  if (/enospc|no space|disk full|quota/.test(s)) return 'disk'
  return 'other'
}
const ERROR_HINT: Record<ReturnType<typeof errorKind>, () => string> = {
  network: () => tr('像是网络或代理问题：检查代理设置后点「重试」。'),
  signature: () => tr('安装包校验失败（签名或哈希不符）：用「手动下载」重新安装。'),
  disk: () => tr('磁盘空间不足：清理系统盘后点「重试」。'),
  other: () => tr('可以先点「重试」；仍然失败就用「手动下载」。'),
}

// 关于 / 更新：一行状态 + 「检查更新」；下载完成后给「重启以更新」，不强制重启（版本号在关于页顶部）
// 进度条 / 跳过版本 / 失败原因建议也在这里（顶栏 UpdateBadge 只负责提醒）。
export function UpdateCheck() {
  const [st, setSt] = useState<UpdateStatus | null>(null)
  const [installErr, setInstallErr] = useState('')
  const [skip, setSkip] = useState('')   // 已跳过的版本（'' = 不跳过）

  const readSkip = () => client.settings.get().then((s) => setSkip(s.system?.updateSkipVersion ?? '')).catch(() => {})

  useEffect(() => {
    client.system.getUpdateStatus().then((r) => setSt(r.status)).catch(() => {})
    void readSkip()
    return client.on((ev) => {
      if (ev.type === 'update:status') setSt({ state: ev.state, version: ev.version, percent: ev.percent, error: ev.error })
    })
  }, [])

  // 手点「检查更新」= 想要升级：发现新版本直接开始下载（autoDownload=true），不必再去顶栏点更新图标。
  // 后台定时检查仍只检查、不下载（见 updater.ts）。
  const check = () => { client.system.checkUpdate(true).then(setSt).catch((e) => setSt({ state: 'error', error: e instanceof Error ? e.message : String(e) })) }
  const setSkipVersion = (v: string) => {
    void saveSystemPatch({ updateSkipVersion: v }).then(() => {
      setSkip(v)
      // 顶栏 UpdateBadge 监听这个事件：跳过后立刻不再提醒，不用等下一次状态推送
      window.dispatchEvent(new CustomEvent('lingshell:settings-changed'))
    })
  }
  const busy = st?.state === 'checking' || st?.state === 'downloading' || st?.state === 'available'
  const color = st?.state === 'error' ? 'text-[var(--color-danger)]' : st?.state === 'downloaded' ? 'text-[var(--color-success)]' : ''
  const pct = Math.max(0, Math.min(100, Math.round(st?.percent ?? 0)))

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
          <button onClick={check} disabled={busy} className={BTN2}>{st.state === 'error' ? tr('重试') : tr('检查更新')}</button>
        )}
        {/* 有新版本但这次不想升：跳过后顶栏不再提醒，设置页仍可手动检查 */}
        {st?.state === 'available' && st.version && st.version !== skip && (
          <button data-update-skip onClick={() => setSkipVersion(st.version ?? '')}
            title={tr('不再提醒这个版本；有新版本时仍会提醒')} className={BTN2}>{tr('跳过此版本')}</button>
        )}
        {/* 下载失败（网络/代理/签名校验）时不能只让人卡在这里：给一条自己下载安装的路 */}
        {st?.state === 'error' && (
          <button data-update-manual onClick={() => {
            // 渲染层 window.open 会被主进程拦下、交给系统浏览器打开（见 desktop/index.ts 的 setWindowOpenHandler）
            window.open(RELEASE_PAGE, '_blank', 'noopener')
          }} title={tr('打开发布页，自己下载安装包手动安装')} className={BTN2}>{tr('手动下载')}</button>
        )}
      </Row>
      {st?.state === 'downloading' && (
        <div className="px-3.5 pb-2" data-update-bar>
          <div className="h-1 w-full overflow-hidden rounded bg-[var(--color-bg-raised)]">
            <div className="h-full bg-[var(--color-danger)] transition-[width] duration-300" style={{ width: `${pct}%` }} />
          </div>
        </div>
      )}
      {skip && (
        <div className="px-3.5 pb-2 text-[11px] text-[var(--color-text-muted)]">
          {tr('已跳过 {version}，顶栏不再提示；有新版本时仍会提醒', { version: skip })}
          <button onClick={() => setSkipVersion('')} className="ml-2 text-[var(--color-accent)] hover:underline">{tr('恢复更新提示')}</button>
        </div>
      )}
      {st?.state === 'error' && <div className="px-3.5 pb-2 text-[11px] text-[var(--color-text-muted)]">{ERROR_HINT[errorKind(st.error)]()}</div>}
      {installErr && <div className="px-3.5 pb-2 text-[11.5px] text-[var(--color-danger)]">{installErr}</div>}
    </Section>
  )
}
