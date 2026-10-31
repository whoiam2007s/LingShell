import { useState } from 'react'
import { AlertTriangle, Download, FileSearch, RotateCw, TerminalSquare } from 'lucide-react'
import { tr } from '@lingshell/shared'
import { client } from '../../client/index.js'

// Windows 上没检测到 Git Bash 时终端区的引导卡片（代替自动建本地终端）。
// 找到 / 指定好之后 onReady 建 Git Bash 终端；也可以先开 PowerShell（仅手动，AI 不能在里面执行命令）。
export const GIT_DOWNLOAD_URL = 'https://git-scm.com/download/win'
const errText = (e: unknown) => String((e as { message?: string })?.message ?? e).replace(/^Error invoking remote method '[^']+': Error:\s*/, '').replace(/^invalid_bash:\s*/, '')
const BTN = 'flex w-full items-center gap-2.5 rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-bg-base)] px-3.5 py-2.5 text-left text-[13px] text-[var(--color-text-primary)] transition-colors hover:border-[color:color-mix(in_srgb,var(--color-accent)_50%,transparent)] hover:bg-[var(--color-bg-hover)] disabled:opacity-50'

export function GitBashMissing({ onReady, onPowerShell }: { onReady: () => void; onPowerShell: () => void }) {
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const run = async (fn: () => Promise<{ path?: string } | null>) => {
    setBusy(true); setMsg(null)
    try {
      const st = await fn()
      if (st?.path) onReady()
      else if (st) setMsg(tr('还是没有检测到 Git Bash。装好后可能要重开本应用，或用「手动指定 bash.exe…」'))
    } catch (e) { setMsg(errText(e)) } finally { setBusy(false) }
  }
  return (
    <div data-testid="git-bash-missing" className="flex h-full flex-col items-center justify-center px-6">
      <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-[color:color-mix(in_srgb,var(--color-warn)_15%,transparent)] ring-1 ring-[color:color-mix(in_srgb,var(--color-warn)_30%,transparent)]">
        <AlertTriangle className="h-7 w-7 text-[var(--color-warn)]" />
      </div>
      <div className="mt-4 text-[15px] font-semibold text-[var(--color-text-primary)]">{tr('未检测到 Git Bash')}</div>
      <div className="mt-1.5 max-w-[380px] text-center text-[12px] leading-relaxed text-[var(--color-text-muted)]">
        {tr('本地终端和 AI 操作本地终端需要 Git for Windows 里的 Git Bash。SSH 远程终端不受影响，可以照常使用。')}
      </div>
      <div className="mt-6 w-full max-w-[360px] space-y-2">
        <button className={BTN} onClick={() => window.open(GIT_DOWNLOAD_URL, '_blank')}>
          <Download className="h-4 w-4 shrink-0 text-[var(--color-accent)]" />{tr('下载 Git for Windows')}
        </button>
        <button className={BTN} disabled={busy} onClick={() => run(() => client.gitBash.redetect())}>
          <RotateCw className="h-4 w-4 shrink-0 text-[var(--color-accent)]" />{tr('我已安装，重新检测')}
        </button>
        <button className={BTN} disabled={busy} onClick={() => run(() => client.gitBash.pick())}>
          <FileSearch className="h-4 w-4 shrink-0 text-[var(--color-accent)]" />{tr('手动指定 bash.exe…')}
        </button>
        <button className={BTN} disabled={busy} onClick={onPowerShell}>
          <TerminalSquare className="h-4 w-4 shrink-0 text-[var(--color-text-muted)]" />{tr('先用 PowerShell（仅手动）')}
        </button>
        {msg && <div role="alert" className="pt-1 text-center text-[12px] text-[var(--color-danger)]">{msg}</div>}
      </div>
    </div>
  )
}
