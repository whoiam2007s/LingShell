import { useEffect, useState } from 'react'
import { X, Trash2, Filter } from 'lucide-react'
import { tr, type CommandHistoryEntry } from '@lingshell/shared'
import { client } from '../../../client/index.js'
import { ConfirmDialog } from '../../common/index.js'

// hostKey：当前活动终端所属主机（'local' | hostId | 'host:port'）。hostLabel：可读主机名（清空提示用）。activeTerminalId：用于"只显示当前终端"过滤 + 双击填入目标。
export function CommandHistoryDrawer({ hostKey, hostLabel, activeTerminalId, onClose }: {
  hostKey: string
  hostLabel: string
  activeTerminalId: string
  onClose: () => void
}) {
  const [entries, setEntries] = useState<CommandHistoryEntry[]>([])
  const [onlyCurrent, setOnlyCurrent] = useState(false)
  const [confirmClear, setConfirmClear] = useState(false)

  const reload = () => { client.history.list(hostKey).then(setEntries).catch(() => setEntries([])) }
  useEffect(reload, [hostKey])

  const shown = onlyCurrent ? entries.filter((e) => e.terminalId === activeTerminalId) : entries

  // 填入前先发 Ctrl-U 清掉终端里未回车的半行输入，避免历史命令拼接到已敲内容后面
  const fill = (cmd: string) => {
    client.terminal.write(activeTerminalId, '\x15').catch(() => {})
    client.terminal.write(activeTerminalId, cmd).catch(() => {})
  }
  // 按下标删除，但下标要从"最新"列表里现找：list 新在前，抽屉打开期间终端每执行一条命令，
  // 旧条目下标就整体 +1，拿渲染时的旧下标会删错条。删前重新拉列表，按 at + command + terminalId 定位。
  const deleteFresh = async (entry: CommandHistoryEntry) => {
    const fresh = await client.history.list(hostKey)
    const idx = fresh.findIndex((e) => e.at === entry.at && e.command === entry.command && e.terminalId === entry.terminalId)
    if (idx >= 0) await client.history.delete(hostKey, idx)
  }
  const del = (entry: CommandHistoryEntry) => { deleteFresh(entry).catch(() => {}).finally(reload) }
  // 清空：只显示当前终端时只清当前终端记录（逐条现找下标再删），否则清整台主机。
  const clearHistory = async () => {
    if (onlyCurrent) {
      const fresh = await client.history.list(hostKey).catch(() => [] as CommandHistoryEntry[])
      for (const e of fresh.filter((x) => x.terminalId === activeTerminalId)) await deleteFresh(e).catch(() => {})
      reload()
    } else {
      client.history.clear(hostKey).then(reload).catch(() => {})
    }
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-[var(--color-border-subtle)] px-3">
        <span className="text-[12px] font-semibold text-[var(--color-text-primary)]">{tr('命令历史')}</span>
        <button title={tr('只显示当前终端')} onClick={() => setOnlyCurrent((v) => !v)}
          className={`ml-auto flex h-6 items-center gap-1 rounded px-1.5 text-[11px] ${onlyCurrent ? 'bg-[color:color-mix(in_srgb,var(--color-accent)_15%,transparent)] text-[var(--color-accent)]' : 'text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)]'}`}>
          <Filter className="h-3 w-3" />{tr('当前')}
        </button>
        <button title={tr('清空该主机历史')} onClick={() => setConfirmClear(true)} className="flex h-6 w-6 items-center justify-center rounded text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-danger)]"><Trash2 className="h-3.5 w-3.5" /></button>
        <button onClick={onClose} className="flex h-6 w-6 items-center justify-center rounded text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)]"><X className="h-3.5 w-3.5" /></button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
        {shown.length === 0 && <div className="px-2 py-3 text-[11px] text-[var(--color-text-muted)]">{tr('（无历史命令）')}</div>}
        {shown.map((e) => (
          <div key={`${e.at}-${e.terminalId}`} onDoubleClick={() => fill(e.command)} title={tr('双击填入终端（不执行）')}
            className="group flex items-center gap-2 rounded px-2 py-1 text-[12px] hover:bg-[var(--color-bg-hover)]">
            <span className="min-w-0 flex-1 truncate font-mono text-[var(--color-text-primary)]">{e.command}</span>
            <span className="shrink-0 rounded bg-[var(--color-bg-raised)] px-1.5 py-0.5 text-[10px] text-[var(--color-text-muted)]">{e.terminalTitle}</span>
            {/* hidden→group-hover:flex：平时完全不占位，hover 整行才显示删除按钮 */}
            <button onClick={() => del(e)} className="hidden shrink-0 text-[var(--color-text-muted)] hover:text-[var(--color-danger)] group-hover:flex"><Trash2 className="h-3 w-3" /></button>
          </div>
        ))}
      </div>
      <ConfirmDialog open={confirmClear} title={onlyCurrent ? tr('清空当前终端历史') : tr('清空命令历史')}
        message={onlyCurrent
          ? tr('将清空「当前终端」在本应用内记录的命令历史（同一主机其它终端的记录保留）。不可恢复。')
          : tr('将清空【{host}】在本应用内记录的全部命令历史。不可恢复。', { host: hostLabel })}
        confirmText={tr('清空')}
        onConfirm={() => { clearHistory(); setConfirmClear(false) }}
        onCancel={() => setConfirmClear(false)} />
    </div>
  )
}
