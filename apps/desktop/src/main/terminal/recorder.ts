import { createWriteStream, mkdirSync, readdirSync, rmSync, statSync, openSync, readSync, closeSync, type WriteStream } from 'node:fs'
import { join } from 'node:path'
import { castHeaderLine, castEventLine, parseCast, type CastHeader, type CastEventCode, type RecordingInfo } from '@lingshell/shared'
import { makeStartedAtLabel } from '@lingshell/platform'

// 终端录像（审计合规）：每个终端一份 asciicast v2，~/.lingshell/recordings/<YYYY-MM-DD>/<HH-mm-ss>_<终端名>_<id>.cast。
// 录的是「UI 上看到的输出」（onData）+ 用户键入（terminal:write）+ 尺寸变化（terminal:resize）：
// AI execCapture 期间原始输出不走 onData，录到的是青色命令回显 + 清洗后的结果，哨兵包装噪音天然不进录像；
// 静默探测（资源管理器取 pwd）不回显，也不进录像。
// 输入原样记录 —— 包括 sudo/ssh 等提示下敲的密码（终端层分辨不出），所以开关默认关，设置里写明。

const DAY = /^\d{4}-\d{2}-\d{2}$/
const ID = /^\d{4}-\d{2}-\d{2}\/[^/\\]+\.cast$/

interface Rec { file: string; stream: WriteStream; start: number; header: CastHeader; started: boolean }

export class TerminalRecorder {
  private recs = new Map<string, Rec>()
  constructor(private root: string, private onError?: (msg: string, data?: unknown) => void, private now: () => number = Date.now) {}

  get active(): boolean { return this.recs.size > 0 }
  /** 正在写的文件 id（YYYY-MM-DD/x.cast） */
  activeIds(): Set<string> {
    return new Set([...this.recs.values()].map((r) => r.file.slice(this.root.length + 1).replace(/\\/g, '/')))
  }

  start(terminalId: string, title: string, type: string, cols = 80, rows = 30): string {
    this.stop(terminalId)
    const t = this.now()
    const [day, time] = makeStartedAtLabel(new Date(t)).split('_')
    const dir = join(this.root, day)
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    const safe = title.replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 60)
    const file = join(dir, `${time}_${safe}_${terminalId}.cast`)
    // 追加流：写入走 libuv 异步，不逐块同步落盘；0600 因为录像含用户键入（可能含 sudo / ssh 密码）
    const stream = createWriteStream(file, { flags: 'a', mode: 0o600 })
    stream.on('error', (e) => { this.onError?.('录像写入失败', { file, error: String(e) }); this.recs.delete(terminalId) })   // i18n-ignore 日志
    this.recs.set(terminalId, {
      file, stream, start: t, started: false,
      header: { version: 2, width: cols, height: rows, timestamp: Math.floor(t / 1000), title, env: { TERM: 'xterm-256color', SHELL: type } },
    })
    return file
  }

  output(id: string, data: string): void { this.event(id, 'o', data) }
  input(id: string, data: string): void { this.event(id, 'i', data) }
  // 首个事件前的尺寸变化（xterm 首次 fit）直接改 header，不记 r 事件
  resize(id: string, cols: number, rows: number): void {
    const r = this.recs.get(id)
    if (!r) return
    if (!r.started) { r.header.width = cols; r.header.height = rows; return }
    this.event(id, 'r', `${cols}x${rows}`)
  }

  private event(id: string, code: CastEventCode, data: string): void {
    const r = this.recs.get(id)
    if (!r || !data) return
    if (!r.started) { r.stream.write(castHeaderLine(r.header)); r.started = true }
    r.stream.write(castEventLine(Math.round(this.now() - r.start) / 1000, code, data))
  }

  /** 结束一个终端的录像；resolve 于数据落盘后 */
  stop(id: string): Promise<void> {
    const r = this.recs.get(id)
    if (!r) return Promise.resolve()
    this.recs.delete(id)
    if (!r.started) r.stream.write(castHeaderLine(r.header))   // 没有任何事件也留个合法文件
    return new Promise((resolve) => r.stream.end(() => resolve()))
  }
  stopAll(): Promise<void> { return Promise.all([...this.recs.keys()].map((id) => this.stop(id))).then(() => {}) }
}

/** 删掉早于 days 天的日期目录（目录名 YYYY-MM-DD，字典序即时间序）。days<=0 不清理。删除失败跳过 */
export function pruneRecordings(root: string, days: number, now: Date): string[] {
  if (days <= 0) return []
  const cutoff = makeStartedAtLabel(new Date(now.getTime() - days * 86_400_000)).split('_')[0]
  const removed: string[] = []
  let names: string[] = []
  try { names = readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory() && DAY.test(e.name)).map((e) => e.name) } catch { return [] }
  for (const n of names.sort()) {
    if (n >= cutoff) break
    try { rmSync(join(root, n), { recursive: true, force: true }); removed.push(n) } catch { /* 被占用 */ }
  }
  return removed
}

function readSlice(file: string, pos: number, len: number): string {
  const buf = Buffer.alloc(len)
  const fd = openSync(file, 'r')
  try { return buf.subarray(0, readSync(fd, buf, 0, len, pos)).toString('utf8') } finally { closeSync(fd) }
}

/** 列出录像（新在前）。只读首行 header 和末尾 8KB 取时长，不读整份 */
export function listRecordings(root: string, active: Set<string> = new Set()): RecordingInfo[] {
  const out: RecordingInfo[] = []
  let days: string[] = []
  try { days = readdirSync(root).filter((n) => DAY.test(n)) } catch { return [] }
  for (const day of days) {
    let files: string[] = []
    try { files = readdirSync(join(root, day)).filter((f) => f.endsWith('.cast')) } catch { continue }
    for (const f of files) {
      const file = join(root, day, f)
      try {
        const size = statSync(file).size
        const { header } = parseCast(readSlice(file, 0, 4096).split('\n')[0])
        // 末尾切片的首行要么是 header（小文件）要么是被截断的半行，parseCast 都当 header 吃掉
        const last = parseCast(readSlice(file, Math.max(0, size - 8192), 8192)).events.at(-1)
        const id = `${day}/${f}`
        out.push({
          id, date: day, title: header.title ?? f, size, durationSec: last?.[0] ?? 0, active: active.has(id),
          startedAt: new Date((header.timestamp || 0) * 1000).toISOString(),
        })
      } catch { /* 读不了的跳过 */ }
    }
  }
  return out.sort((a, b) => b.id.localeCompare(a.id))
}

/** 录像 id → 绝对路径；id 不合法（防目录穿越）抛错 */
export function recordingPath(root: string, id: string): string {
  if (!ID.test(id) || id.includes('..')) throw new Error('invalid_recording_id')
  return join(root, ...id.split('/'))
}
