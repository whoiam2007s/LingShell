import { useEffect } from 'react'
import { X, ArrowUp, ArrowDown, ArrowUpDown, RotateCw, FolderOpen, FolderSearch, ChevronsUp, ChevronUp, ChevronDown, Pause, Play, Trash2 } from 'lucide-react'
import { tr, type TransferMove, type TransferProgressEvent } from '@lingshell/shared'
import { client } from '../../client/index.js'
import { paletteSend } from '../../lib/paletteBus.js'
import { useTransfers, openTransferPanel, closeTransferPanel, clearFinished, discardTask } from './transferStore.js'
import { HelpTip } from '../../components/ui/form.js'
import { detailLine, isActive, panelOrder, stateLabel, summarize } from './transferView.js'

const ICON_BTN = 'flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-accent)]'
const LINK = 'flex shrink-0 items-center gap-1 text-[11px] text-[var(--color-text-muted)] hover:text-[var(--color-accent)]'

// 终端工具栏上的「传输」按钮：有进行中的任务时带个数角标
export function TransferButton() {
  const { tasks, open } = useTransfers()
  const n = tasks.filter(isActive).length
  return (
    <button title={tr('传输队列')} onClick={() => (open ? closeTransferPanel() : openTransferPanel())}
      className={`relative ${ICON_BTN} ${open ? 'bg-[var(--color-bg-hover)] text-[var(--color-accent)]' : ''}`}>
      <ArrowUpDown className="h-3.5 w-3.5" />
      {n > 0 && <span className="absolute -right-0.5 -top-0.5 min-w-[12px] rounded-full bg-[var(--color-accent)] px-0.5 text-center text-[9px] leading-[12px] text-[var(--color-bg-base)]">{n}</span>}
    </button>
  )
}

// 传输面板：终端区底部抽屉（不挡对话和终端上半部），列出全部上传 / 下载任务（排队中 / 进行中 / 完成 / 失败 / 已取消）
export function TransferPanel() {
  const { tasks, open } = useTransfers()
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') closeTransferPanel() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])
  if (!open) return null
  const s = summarize(tasks)
  const list = panelOrder(tasks)
  const queued = tasks.filter((t) => t.state === 'queued').length
  return (
    <div data-transfer-drawer className="absolute inset-x-0 bottom-0 z-[35] flex h-[45%] min-h-[220px] flex-col border-t border-[var(--color-border-default)] bg-[var(--color-bg-panel)] shadow-2xl animate-fade-in">
        <div className="flex h-9 shrink-0 items-center gap-3 border-b border-[var(--color-border-subtle)] px-4">
          <ArrowUpDown className="h-3.5 w-3.5 shrink-0 text-[var(--color-accent)]" />
          <span className="shrink-0 whitespace-nowrap text-[13px] font-semibold text-[var(--color-text-primary)]">{tr('传输')}</span>
          <HelpTip>{tr('同时进行的任务数、限速在「设置 → 通用 → 文件传输」里改。不加密的上传和资源管理器下载是逐个文件直传：可暂停，「继续」从断点接着传、保留修改时间；加密上传失败只能从头重传。排队中的可「优先传输」或上下移动。已结束的任务重启后还在（标「历史」）。')}</HelpTip>
          <span className="min-w-0 truncate text-[11px] text-[var(--color-text-muted)]">{s.active ? tr('{n} 个进行中 · {p}%', { n: s.active, p: s.percent }) : tr('没有进行中的传输')}</span>
          <button onClick={clearFinished} disabled={tasks.every((t) => isActive(t) || t.paused)}
            className="ml-auto shrink-0 whitespace-nowrap rounded-md border border-[var(--color-border-default)] px-2 py-0.5 text-[11px] text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)] disabled:opacity-40">{tr('清除已完成')}</button>
          <button onClick={closeTransferPanel} title={tr('关闭')} className="text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]"><X className="h-4 w-4" /></button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {list.length === 0 && <div className="p-6 text-center text-[12px] text-[var(--color-text-muted)]">{tr('还没有传输任务。上传、资源管理器下载、AI 上传下载都会排在这里。')}</div>}
          {list.map((t) => <TaskRow key={t.taskId} t={t} queued={queued} />)}
        </div>
    </div>
  )
}

// queued：排队中的总数（判断能否再上移/下移）
function TaskRow({ t, queued }: { t: TransferProgressEvent; queued: number }) {
  const active = isActive(t)
  const pos = t.state === 'queued' ? t.queuePos : undefined
  const move = (to: TransferMove) => client.transfer.reorder(t.taskId, to).catch(() => {})
  const color = t.state === 'error' ? 'text-[var(--color-danger)]' : t.state === 'done' ? 'text-[var(--color-success)]' : 'text-[var(--color-text-muted)]'
  const r = t.reveal
  const detail = detailLine(t)
  return (
    <div className="border-b border-[var(--color-border-subtle)] px-4 py-2">
      <div className="flex items-center gap-2 text-[12px]">
        {t.kind === 'upload' ? <ArrowUp className="h-3.5 w-3.5 shrink-0 text-[var(--color-accent)]" /> : <ArrowDown className="h-3.5 w-3.5 shrink-0 text-[var(--color-accent)]" />}
        <span className="min-w-0 truncate font-medium text-[var(--color-text-primary)]" title={t.files.join('\n')}>{t.files.join(', ')}</span>
        <span className={`shrink-0 text-[11px] ${color}`}>{stateLabel(t)}</span>
        <span className="ml-auto flex shrink-0 items-center gap-3">
          {/* 排队中：调整顺序（进行中的不受影响）。只有一个在排队时不显示 */}
          {pos !== undefined && queued > 1 && (
            <>
              <button onClick={() => move('top')} disabled={pos <= 1} title={tr('移到队首，下一个开始')} className={`${LINK} disabled:opacity-40`}><ChevronsUp className="h-3 w-3" />{tr('优先传输')}</button>
              <button onClick={() => move('up')} disabled={pos <= 1} title={tr('上移')} className={`${LINK} disabled:opacity-40`}><ChevronUp className="h-3 w-3" /></button>
              <button onClick={() => move('down')} disabled={pos >= queued} title={tr('下移')} className={`${LINK} disabled:opacity-40`}><ChevronDown className="h-3 w-3" /></button>
            </>
          )}
          {t.state === 'running' && t.resumable && <button data-tf-pause title={tr('暂停，之后可从断点继续')} onClick={() => client.transfer.pause(t.taskId).catch(() => {})} className={LINK}><Pause className="h-3 w-3" />{tr('暂停')}</button>}
          {active && t.cancellable !== false && <button data-tf-cancel title={t.resumable ? tr('取消并删掉已传的半截文件') : tr('取消')} onClick={() => client.transfer.cancel(t.taskId).catch(() => {})} className={LINK}>{tr('取消')}</button>}
          {t.paused && <button data-tf-resume title={tr('从断点接着传')} onClick={() => client.transfer.retry(t.taskId).catch(() => {})} className={LINK}><Play className="h-3 w-3" />{tr('transfer|继续')}</button>}
          {!t.paused && !t.restored && (t.state === 'error' || t.state === 'cancelled') && <button data-tf-retry title={t.resumable && t.state === 'error' ? tr('从断点接着传') : tr('从头重新传')} onClick={() => client.transfer.retry(t.taskId).catch(() => {})} className={LINK}><RotateCw className="h-3 w-3" />{t.resumable && t.state === 'error' ? tr('transfer|继续') : tr('重试')}</button>}
          {t.resumable && !t.restored && (t.paused || t.state === 'error') && <button data-tf-discard title={tr('删掉已传的半截文件并移出列表')} onClick={() => discardTask(t.taskId)} className={LINK}><Trash2 className="h-3 w-3" />{tr('放弃')}</button>}
          {t.restored && <span className="text-[10px] text-[var(--color-text-muted)]" title={tr('上次运行留下的记录')}>{tr('历史')}</span>}
          {t.state === 'done' && r && 'local' in r && <button onClick={() => client.transfer.revealLocal(t.taskId).catch(() => {})} className={LINK}><FolderOpen className="h-3 w-3" />{tr('打开所在文件夹')}</button>}
          {t.state === 'done' && r && 'hostId' in r && (
            <button onClick={() => { closeTransferPanel(); paletteSend({ type: 'explorerAt', hostId: r.hostId, path: r.path }) }} className={LINK}><FolderSearch className="h-3 w-3" />{tr('在资源管理器中定位')}</button>
          )}
        </span>
      </div>
      {t.target && <div className="mt-0.5 truncate text-[11px] text-[var(--color-text-muted)]" title={t.target}>{t.kind === 'upload' ? tr('到 {path}', { path: t.target }) : tr('存到 {path}', { path: t.target })}</div>}
      {active && (
        <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-[var(--color-bg-raised)]">
          <div className={`h-full rounded-full bg-[var(--color-accent)] transition-all ${t.state === 'running' && t.stagePercent < 0 ? 'animate-pulse-dim w-full opacity-60' : ''}`}
            style={t.state === 'running' && t.stagePercent < 0 ? undefined : { width: `${t.state === 'queued' ? 0 : t.overallPercent}%` }} />
        </div>
      )}
      {detail && <div className="mt-0.5 text-[11px] text-[var(--color-text-muted)]">{detail}</div>}
      {t.state === 'error' && t.error && <div className="mt-0.5 break-words text-[11px] text-[var(--color-danger)]">{t.error}</div>}
    </div>
  )
}
