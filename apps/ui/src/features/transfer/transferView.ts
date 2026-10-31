// 传输面板 / 汇总浮层的纯展示逻辑
import { fmtBytes, tk, tr, type TransferProgressEvent, type TransferState } from '@lingshell/shared'

type Ev = TransferProgressEvent
export const FINISHED: TransferState[] = ['done', 'error', 'cancelled']
export const isActive = (t: Ev): boolean => !FINISHED.includes(t.state)

// 汇总：未结束的任务数与总体百分比（有字节数的按字节加权，否则取各任务百分比的平均）
export function summarize(list: Ev[]): { active: number; percent: number; failed: number } {
  const act = list.filter(isActive)
  const failed = list.filter((t) => t.state === 'error').length
  if (!act.length) return { active: 0, percent: 100, failed }
  // 排队中的不算进度：一个跑到一半 + 三个排队，平均会把百分比稀释成 13%。
  // 有正在跑的只看正在跑的；没有跑着的（全在排队）显示 0。
  const live = act.filter((t) => t.state === 'running')
  const pool = live.length ? live : act.filter((t) => t.state !== 'queued')
  if (!pool.length) return { active: act.length, percent: 0, failed }
  const sized = pool.filter((t) => t.bytesTotal)
  const percent = sized.length === pool.length
    ? (sized.reduce((s, t) => s + (t.bytesDone ?? 0), 0) / sized.reduce((s, t) => s + (t.bytesTotal ?? 0), 0)) * 100
    : pool.reduce((s, t) => s + t.overallPercent, 0) / pool.length
  return { active: act.length, percent: Math.max(0, Math.min(100, Math.round(percent))), failed }
}

export function fmtEta(sec: number | undefined): string {
  if (sec === undefined) return ''
  if (sec < 60) return tr('{n} 秒', { n: sec })
  if (sec < 3600) return tr('{m} 分 {s} 秒', { m: Math.floor(sec / 60), s: sec % 60 })
  return tr('{h} 小时 {m} 分', { h: Math.floor(sec / 3600), m: Math.floor((sec % 3600) / 60) })
}

const STAGE: Record<string, string> = { pack: tk('打包加密'), transfer: tk('传输中'), extract: tk('解密解压') }
// 一行状态文字：排队中 / 扫描目录 / 传输中 / 完成 / 失败 / 已取消
export function stateLabel(t: Ev): string {
  if (t.state === 'queued') return t.queuePos ? tr('排队中 · 第 {n} 个', { n: t.queuePos }) : tr('排队中')
  if (t.state === 'done') return tr('完成')
  if (t.state === 'cancelled') return t.paused ? tr('已暂停') : tr('已取消')
  if (t.state === 'error') return tr('失败')
  if ((t.kind === 'download' || t.resumable) && t.stage === 'pack') return tr('扫描目录')
  return STAGE[t.stage] ? tr(STAGE[t.stage]) : tr('进行中')
}

// 进度细节：12.3M / 40M · 3/10 个文件 · 2.1M/s · 剩余 13 秒
export function detailLine(t: Ev): string {
  const parts: string[] = []
  if (t.bytesTotal) parts.push(`${fmtBytes(t.bytesDone ?? 0)} / ${fmtBytes(t.bytesTotal)}`)
  if (t.fileTotal) parts.push(tr('{done}/{total} 个文件', { done: t.fileDone ?? 0, total: t.fileTotal }))
  if (t.state === 'running' && t.speed) parts.push(`${fmtBytes(t.speed)}/s`)
  if (t.state === 'running' && t.etaSec !== undefined) parts.push(tr('剩余 {eta}', { eta: fmtEta(t.etaSec) }))
  if (t.skipped) parts.push(tr('跳过 {n} 项（同名 / 符号链接）', { n: t.skipped }))
  return parts.join(' · ')
}

// 面板顺序：进行中（新的在上）→ 排队中（按队内位置，下一个开始的在上）→ 已结束（新的在上）
export function panelOrder(list: Ev[]): Ev[] {
  const rank = (t: Ev) => (t.state === 'running' ? 0 : t.state === 'queued' ? 1 : 2)
  const pos = (t: Ev) => t.queuePos ?? Number.MAX_SAFE_INTEGER
  return [...list].sort((a, b) => rank(a) - rank(b)
    || (a.state === 'queued' ? pos(a) - pos(b) || a.createdAt - b.createdAt : b.createdAt - a.createdAt))
}
