import { useEffect, useState } from 'react'
import { X, Trash2, Filter, Sparkles, Download } from 'lucide-react'
import { tr, dateLocale, exportTable, historyTable, formatExt, type CommandHistoryEntry, type ExportFormat } from '@lingshell/shared'
import { client } from '../../../client/index.js'
import { ConfirmDialog } from '../../common/index.js'
import { askAiChip } from '../../../lib/askAi.js'
import { historyBatchChip, historyEntryChip } from './historyQuote.js'

// hostKey：当前活动终端所属主机（'local' | hostId | 'host:port'）。hostLabel：可读主机名（清空提示用）。activeTerminalId：用于"只显示当前终端"过滤 + 双击填入目标。
export function CommandHistoryDrawer({ hostKey, hostLabel, activeTerminalId, onClose }: {
  hostKey: string
  hostLabel: string
  activeTerminalId: string
  onClose: () => void
}) {
  const [entries, setEntries] = useState<CommandHistoryEntry[]>([])
  const [onlyCurrent, setOnlyCurrent] = useState(false)
  // 来源筛选：默认只看用户手敲的（AI 执行的命令太杂，会把列表刷满）
  const [src, setSrc] = useState<'user' | 'ai' | 'all'>('user')
  const [confirmClear, setConfirmClear] = useState(false)
  const [exportOpen, setExportOpen] = useState(false)

  const reload = () => { client.history.list(hostKey).then(setEntries).catch(() => setEntries([])) }
  useEffect(reload, [hostKey])

  const shown = entries
    .filter((e) => (src === 'all' ? true : e.source === src))
    .filter((e) => (onlyCurrent ? e.terminalId === activeTerminalId : true))

  // hover 看完整命令：最多 10 行，超出就截断并说明总行数（命令经常很长，列表里是省略号）
  const TIP_MAX_LINES = 10
  const cmdTip = (cmd: string) => {
    const lines = cmd.split(/\r?\n/)
    if (lines.length <= TIP_MAX_LINES) return cmd
    return lines.slice(0, TIP_MAX_LINES).join('\n') + '\n' + tr('…（共 {n} 行，只显示前 {max} 行）', { n: lines.length, max: TIP_MAX_LINES })
  }

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
  // 「问 AI」：单条问「这条干什么 / 失败怎么查」，批量问「这段操作在干什么、有没有危险步骤」
  const askEntry = (e: CommandHistoryEntry) => {
    void askAiChip({ ctx: 'history', ...historyEntryChip({ host: hostLabel, entry: e }), question: tr('这条命令是做什么的？如果失败了该怎么查') })
    onClose()
  }
  const askBatch = () => {
    void askAiChip({ ctx: 'history', ...historyBatchChip({ host: hostLabel, entries: shown }), question: tr('归纳这段操作在干什么，哪些是危险或不可逆的') })
    onClose()
  }
  // 导出：只导出当前筛选出来的（来源 / 当前终端）结果，列 = 时间、主机、终端、来源、命令。
  // 命令历史本身不记退出码（那是执行记录的字段），要退出码请去执行记录导出。
  const exportNow = (format: ExportFormat) => {
    setExportOpen(false)
    if (!shown.length) return
    const day = new Date().toISOString().slice(0, 10)
    const text = exportTable(format, tr('命令历史：{host}', { host: hostLabel }), historyTable(shown, {
      hostLabel: (k) => (k === hostKey ? hostLabel : k === 'local' ? tr('本地') : k),
      timeLabel: (iso) => new Date(iso).toLocaleString(dateLocale(), { hour12: false }),
    }))
    const safe = `${tr('命令历史')}-${hostLabel}-${day}`.replace(/[\\/:*?"<>|]/g, '_')
    void client.system.saveTextFile(`${safe}.${formatExt(format)}`, text).catch(() => {})
  }
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
      <div className="flex h-10 shrink-0 items-center gap-2 whitespace-nowrap border-b border-[var(--color-border-subtle)] px-3">
        <span className="shrink-0 whitespace-nowrap text-[12px] font-semibold text-[var(--color-text-primary)]">{tr('命令历史')}</span>
        {/* 来源筛选：用户 / AI / 全部。默认用户 —— AI 执行的命令太多，列表会被刷满 */}
        {([['user', tr('用户')], ['ai', tr('AI')], ['all', tr('全部')]] as const).map(([k, label]) => (
          <button key={k} data-hist-src={k} title={k === 'user' ? tr('只显示你在终端里手敲的命令') : k === 'ai' ? tr('只显示 AI 执行的命令') : tr('全部命令')} onClick={() => setSrc(k)}
            className={`flex h-6 shrink-0 items-center whitespace-nowrap rounded px-1.5 text-[11px] ${src === k ? 'bg-[color:color-mix(in_srgb,var(--color-accent)_15%,transparent)] text-[var(--color-accent)]' : 'text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)]'}`}>
            {label}
          </button>
        ))}
        {shown.length > 0 && (
          <button title={tr('问 AI：归纳这段操作（最多 10 条）')} onClick={askBatch}
            className="ml-auto flex h-6 w-6 shrink-0 items-center justify-center rounded text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-accent)]"><Sparkles className="h-3.5 w-3.5" /></button>
        )}
        {/* 导出：Markdown / CSV（CSV 带 BOM，Excel 打开不乱码） */}
        <span className={`relative flex shrink-0 ${shown.length > 0 ? '' : 'ml-auto'}`}>
          <button data-hist-export title={tr('导出当前列表（Markdown / CSV）')} onClick={() => setExportOpen((v) => !v)} disabled={!shown.length}
            className="flex h-6 w-6 items-center justify-center rounded text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-accent)] disabled:opacity-40"><Download className="h-3.5 w-3.5" /></button>
          {exportOpen && (
            <>
              <div className="fixed inset-0 z-40" onClick={() => setExportOpen(false)} />
              <div className="absolute right-0 top-full z-50 mt-1 w-28 overflow-hidden rounded-md border border-[var(--color-border-default)] bg-[var(--color-bg-panel)] py-0.5 shadow-xl">
                <button onClick={() => exportNow('markdown')} className="block w-full px-2.5 py-1 text-left text-[11.5px] text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-accent)]">Markdown</button>
                <button onClick={() => exportNow('csv')} className="block w-full px-2.5 py-1 text-left text-[11.5px] text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-accent)]">CSV</button>
              </div>
            </>
          )}
        </span>
        <button title={tr('只显示当前终端')} onClick={() => setOnlyCurrent((v) => !v)}
          className={`flex h-6 shrink-0 items-center gap-1 whitespace-nowrap rounded px-1.5 text-[11px] ${onlyCurrent ? 'bg-[color:color-mix(in_srgb,var(--color-accent)_15%,transparent)] text-[var(--color-accent)]' : 'text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)]'}`}>
          <Filter className="h-3 w-3" />{tr('当前')}
        </button>
        <button title={tr('清空该主机历史')} onClick={() => setConfirmClear(true)} className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-danger)]"><Trash2 className="h-3.5 w-3.5" /></button>
        <button onClick={onClose} className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)]"><X className="h-3.5 w-3.5" /></button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
        {shown.length === 0 && <div className="px-2 py-3 text-[11px] text-[var(--color-text-muted)]">{tr('（无历史命令）')}</div>}
        {shown.map((e) => (
          <div key={`${e.at}-${e.terminalId}`} onDoubleClick={() => fill(e.command)} title={`${cmdTip(e.command)}\n\n${tr('双击填入终端（不执行）')}`}
            className="group flex items-center gap-2 rounded px-2 py-1 text-[12px] hover:bg-[var(--color-bg-hover)]">
            <span className="min-w-0 flex-1 truncate font-mono text-[var(--color-text-primary)]">{e.command}</span>
            <span className="shrink-0 rounded bg-[var(--color-bg-raised)] px-1.5 py-0.5 text-[10px] text-[var(--color-text-muted)]">{e.terminalTitle}</span>
            {/* hidden→group-hover:flex：平时完全不占位，hover 整行才显示删除按钮 */}
            {/* hidden→group-hover:flex：平时完全不占位，hover 整行才显示「问 AI」与删除 */}
            <button onClick={() => askEntry(e)} title={tr('问 AI：这条命令干什么、失败怎么查')} className="hidden shrink-0 text-[var(--color-text-muted)] hover:text-[var(--color-accent)] group-hover:flex"><Sparkles className="h-3 w-3" /></button>
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
