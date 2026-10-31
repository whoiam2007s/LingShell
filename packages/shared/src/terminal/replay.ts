// 即时回放（同 iTerm2 Instant Replay）：每个终端在内存里留最近 N MB 的输出流（时间戳 + 数据块 + 当时的行列），
// 回放时从头重放到某个时刻就得到那时的屏幕（含被 clear / top / vim 刷掉的画面）。
// 环形：超出上限从最早的块丢起；最早一块之前的屏幕状态已丢，回放开头可能不完整（只影响最早那一段）。

export interface ReplayChunk { t: number; data: string; cols: number; rows: number }

export const REPLAY_DEFAULT_MB = 4
export const REPLAY_MAX_MB = 64
const MB = 1024 * 1024
// 相邻 50ms 内、尺寸不变的块合并：输出密集时块数少一个量级，时间轴精度 50ms 足够
const MERGE_MS = 50

/** 设置里的 MB 数 → 字节上限（非法值用默认，0 = 关） */
export const replayCapOf = (mb: number | undefined) =>
  Math.round(Math.min(REPLAY_MAX_MB, Math.max(0, typeof mb === 'number' && Number.isFinite(mb) ? mb : REPLAY_DEFAULT_MB)) * MB)

export class ReplayBuffer {
  private buf: ReplayChunk[] = []
  private head = 0
  private bytes = 0
  constructor(private cap: number) {}

  /** 已存字节数（按字符数计，ASCII 输出与字节数相当） */
  get size(): number { return this.bytes }
  get capacity(): number { return this.cap }

  setCap(cap: number): void { this.cap = Math.max(0, cap); if (!this.cap) this.clear(); else this.trim() }
  clear(): void { this.buf = []; this.head = 0; this.bytes = 0 }

  push(t: number, data: string, cols: number, rows: number): void {
    if (!this.cap || !data) return
    const last = this.head < this.buf.length ? this.buf[this.buf.length - 1] : undefined
    if (last && t - last.t <= MERGE_MS && last.cols === cols && last.rows === rows) last.data += data
    else this.buf.push({ t, data, cols, rows })
    this.bytes += data.length
    this.trim()
  }

  /** 按时间先后的全部块（快照：之后的追加 / 合并不影响它） */
  chunks(): ReplayChunk[] { return this.buf.slice(this.head).map((c) => ({ ...c })) }

  private trim(): void {
    // 至少留最后一块：单块超上限时截它的尾部（大块输出里只有最后的部分决定屏幕）
    while (this.bytes > this.cap && this.buf.length - this.head > 1) this.bytes -= this.buf[this.head++].data.length
    const only = this.buf[this.head]
    if (this.bytes > this.cap && only) { only.data = only.data.slice(-this.cap); this.bytes = only.data.length }
    if (this.head > 1024 && this.head * 2 > this.buf.length) { this.buf = this.buf.slice(this.head); this.head = 0 }
  }
}

/** 时间 t（含）之前一共有几块：回放到 t = 重放前这么多块（二分） */
export function chunksUpTo(chunks: ReplayChunk[], t: number): number {
  let lo = 0, hi = chunks.length
  while (lo < hi) { const mid = (lo + hi) >> 1; if (chunks[mid].t <= t) lo = mid + 1; else hi = mid }
  return lo
}
