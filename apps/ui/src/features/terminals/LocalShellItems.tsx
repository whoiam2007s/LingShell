import { useEffect, useState } from 'react'
import { MonitorDot } from 'lucide-react'
import { tr, type LocalShellOption } from '@lingshell/shared'
import { client } from '../../client/index.js'

// 「+」菜单里的本地终端入口：Windows 上可选 Git Bash（默认）/ PowerShell / cmd / WSL 发行版（见 shared/terminal/localShell.ts）。
// 先显示上次枚举的结果，每次打开菜单后台刷新（WSL 发行版可能新装 / 卸载）
let last: LocalShellOption[] = []
const ITEM = 'flex w-full items-center gap-2 rounded px-2.5 py-1.5 hover:bg-[var(--color-bg-hover)]'

export function LocalShellItems({ onPick }: { onPick: (shell?: string) => void }) {
  const [shells, setShells] = useState(last)
  useEffect(() => { client.localShells.list().then((s) => { last = s; setShells(s) }).catch(() => {}) }, [])
  const others = shells.filter((s) => s.id !== 'bash')
  const missing = shells.find((s) => s.id === 'bash')?.unavailable   // Windows 没检测到 Git Bash：置灰并说明原因
  return (
    <>
      <button onClick={() => onPick()} disabled={!!missing} className={`${ITEM} disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent`} title={missing ?? tr('AI 可以在本地终端里执行命令')}>
        <MonitorDot className="h-3.5 w-3.5 text-[var(--color-accent)]" />
        <span className="min-w-0 flex-1 truncate text-left">{others.length ? tr('本地终端（Git Bash）') : tr('本地终端')}</span>
        {missing && <span className="shrink-0 rounded border border-[var(--color-border-subtle)] px-1 text-[10px] text-[var(--color-text-muted)]">{tr('badge|未安装')}</span>}
      </button>
      {others.map((s) => (
        <button key={s.id} onClick={() => onPick(s.id)} className={ITEM}
          title={s.ai ? tr('WSL 发行版：默认 shell 是 bash / zsh 等时 AI 也能在里面执行命令（建好后自动检测）；首次启动可能要等几秒')
            : tr('{name}：仅手动终端，AI 不能在里面执行命令（AI 的命令捕获依赖 bash），可读屏幕', { name: tr(s.label) })}>
          <MonitorDot className="h-3.5 w-3.5 text-[var(--color-text-muted)]" />
          <span className="min-w-0 flex-1 truncate text-left">{tr(s.label)}</span>
          {!s.ai && <span className="shrink-0 rounded border border-[var(--color-border-subtle)] px-1 text-[10px] text-[var(--color-text-muted)]">{tr('仅手动')}</span>}
        </button>
      ))}
    </>
  )
}
