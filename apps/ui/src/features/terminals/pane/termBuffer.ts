// 导出终端缓冲区（含回滚）：把 xterm 主屏缓冲拼成纯文本。软换行（isWrapped）的续行接回上一行，末尾空行去掉。
import { stripEndMarks } from '@lingshell/shared'
// 结构化最小接口：@xterm/xterm 与测试里的 @xterm/headless 都满足
interface Line { isWrapped: boolean; translateToString(trimRight?: boolean): string }
export interface Buf { length: number; getLine(y: number): Line | undefined }

export function bufferText(buf: Buf): string {
  const out: string[] = []
  for (let y = 0; y < buf.length; y++) {
    const l = buf.getLine(y)
    if (!l) continue
    const s = stripEndMarks(l.translateToString(!buf.getLine(y + 1)?.isWrapped))   // 下一行是续行：本行行尾空格是内容，不能裁；AI 命令的隐藏结束标记去掉
    if (l.isWrapped && out.length) out[out.length - 1] += s
    else out.push(s)
  }
  while (out.length && !out[out.length - 1].trim()) out.pop()
  return out.join('\n') + (out.length ? '\n' : '')
}

// 各终端登记「读出缓冲文本」的函数，工具栏按钮按终端 id 取（缓冲在 TerminalPane 的 xterm 里）
const readers = new Map<string, () => string>()
export function registerBufferReader(id: string, f: () => string): () => void {
  readers.set(id, f)
  return () => { if (readers.get(id) === f) readers.delete(id) }
}
export const readTermBuffer = (id: string): string | undefined => readers.get(id)?.()

// 文件名：标题里不能进文件名的字符换成 _，带上时间
export function bufferFileName(title: string, now = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0')
  const ts = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`
  // eslint-disable-next-line no-control-regex
  const safe = title.replace(/[\\/:*?"<>|\x00-\x1f]+/g, '_').trim().slice(0, 60) || 'terminal'
  return `${safe}-${ts}.txt`
}
