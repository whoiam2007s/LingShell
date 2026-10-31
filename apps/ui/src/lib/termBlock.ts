// 「终端块」附件：终端里一条命令（命令 / 退出码 / 目录 / 输出）或一段选中的输出，作为附件 tag 放进对话输入框，可附多块。
// 发送时拼成文本块追加在消息后面（模型看到的就是这段文字；不经主进程附件通道）。纯函数 + 窗口事件通道，不依赖 client。
import { tr } from '@lingshell/shared'

export interface TermBlock { terminalTitle: string; command?: string; exitCode?: number; cwd?: string; output: string }

export const TERM_BLOCK_MAX = 8 * 1024
/** 终端选中文字拖进对话输入框用的 dataTransfer 类型 */
export const TERM_BLOCK_MIME = 'application/x-lingshell-termblock'

/** 输出超长只留末尾 8KB（报错通常在最后） */
export function clipBlock(b: TermBlock, max = TERM_BLOCK_MAX): TermBlock {
  const out = b.output.replace(/\s+$/, '')
  return { ...b, output: out.length > max ? `…（前面省略 ${out.length - max} 字）\n${out.slice(-max)}` : out }   // i18n-ignore 发给模型的正文
}

/** tag 上显示的名字：命令首行，没有命令（选中的文字）显示「输出片段」 */
export function termBlockName(b: TermBlock): string {
  const c = b.command?.split('\n')[0].trim()
  return `${b.terminalTitle} · ${c ? (c.length > 28 ? `${c.slice(0, 28)}…` : c) : tr('输出片段')}`
}

/** 发给模型的文本（格式固定中文：存进会话记录，splitTermBlocks 按中文反解，不翻译） */
export function termBlockText(b: TermBlock): string {
  const fence = '```'
  const meta = [b.exitCode !== undefined ? `退出码 ${b.exitCode}` : '', b.cwd ? `目录 ${b.cwd}` : ''].filter(Boolean).join('，')   // i18n-ignore 固定格式（发给模型 / 反解）
  const head = b.command !== undefined ? `[终端块] 终端「${b.terminalTitle}」里的命令${meta ? `（${meta}）` : ''}：` : `[终端块] 终端「${b.terminalTitle}」的输出片段：`   // i18n-ignore 固定格式（发给模型 / 反解）
  const body = b.command !== undefined ? `$ ${b.command || '（未取到命令行）'}\n${b.output || '（无输出）'}` : b.output   // i18n-ignore 固定格式（发给模型 / 反解）
  return `${head}\n${fence}\n${body}\n${fence}`
}

/** 用户的话后面接上各块（没有块原样返回） */
export function withTermBlocks(text: string, blocks: TermBlock[]): string {
  if (!blocks.length) return text
  return [text.trim() ? text.trimEnd() : '', ...blocks.map(termBlockText)].filter(Boolean).join('\n\n')
}

/** 反解（用户气泡显示用）：消息文本 → 用户原话 + 各块；不是 termBlockText 的格式就原样返回 */
export function splitTermBlocks(text: string): { text: string; blocks: TermBlock[] } {
  const parts = text.split(/\n\n(?=\[终端块\] 终端「)/)   // i18n-ignore 固定格式（发给模型 / 反解）
  const head = parts[0].startsWith('[终端块] 终端「') ? '' : parts.shift()!   // i18n-ignore 固定格式（发给模型 / 反解）
  const blocks: TermBlock[] = []
  for (const p of parts) {
    const m = /^\[终端块\] 终端「(.*?)」(?:里的命令(?:（(.*?)）)?|的输出片段)：\n```\n([\s\S]*)\n```$/.exec(p)   // i18n-ignore 固定格式（发给模型 / 反解）
    if (!m) return { text, blocks: [] }
    const meta = m[2] ?? '', isCmd = p.includes('」里的命令')   // i18n-ignore 固定格式（发给模型 / 反解）
    const exit = /退出码 (-?\d+)/.exec(meta)?.[1], cwd = /目录 (.+)$/.exec(meta)?.[1]   // i18n-ignore 固定格式（发给模型 / 反解）
    const body = m[3]
    const nl = body.indexOf('\n')
    blocks.push(isCmd
      ? { terminalTitle: m[1], command: (nl < 0 ? body : body.slice(0, nl)).replace(/^\$ /, ''), output: nl < 0 ? '' : body.slice(nl + 1), ...(exit !== undefined ? { exitCode: Number(exit) } : {}), ...(cwd ? { cwd } : {}) }
      : { terminalTitle: m[1], output: body })
  }
  return { text: head, blocks }
}

/** 拖拽数据 → 块（来路不明的内容一律当输出片段，字段做类型检查） */
export function parseBlockDrag(s: string): TermBlock | undefined {
  try {
    const j = JSON.parse(s) as Partial<TermBlock>
    if (typeof j?.output !== 'string' || typeof j.terminalTitle !== 'string') return undefined
    return clipBlock({
      terminalTitle: j.terminalTitle.slice(0, 80), output: j.output,
      ...(typeof j.command === 'string' ? { command: j.command } : {}), ...(typeof j.exitCode === 'number' ? { exitCode: j.exitCode } : {}), ...(typeof j.cwd === 'string' ? { cwd: j.cwd } : {}),
    })
  } catch { return undefined }
}

// 终端 → 对话输入框（红点菜单「附加到对话」）：同 quoteToChat，用窗口事件直连
const EVT = 'lingshell:attach-term-block'
export function attachTermBlock(b: TermBlock): void { window.dispatchEvent(new CustomEvent<TermBlock>(EVT, { detail: b })) }
export function onAttachTermBlock(h: (b: TermBlock) => void): () => void {
  const f = (e: Event) => h((e as CustomEvent<TermBlock>).detail)
  window.addEventListener(EVT, f)
  return () => window.removeEventListener(EVT, f)
}
