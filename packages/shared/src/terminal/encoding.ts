// 主机字符编码：老服务器 GBK/Big5 中文。解码用 TextDecoder（Electron/Node 带完整 ICU）；
// 编码 TextEncoder 只会 UTF-8 → 反查表：首次用到时把所有 1/2 字节序列解码一遍建「字符→字节」表（零依赖，与解码同源不会不一致）。
// ponytail: GB18030 的 4 字节序列（emoji/扩展区生僻字）不进表，输入时变 '?'；输出解码不受影响
export const TERM_ENCODINGS = ['utf8', 'gbk', 'gb18030', 'big5'] as const
export type TermEncoding = (typeof TERM_ENCODINGS)[number]
export const ENCODING_LABEL: Record<TermEncoding, string> = { utf8: 'UTF-8', gbk: 'GBK', gb18030: 'GB18030', big5: 'Big5' }

/** 非 UTF-8（需要转码）；未设/未知按 UTF-8 */
export function isLegacyEncoding(enc?: string): enc is Exclude<TermEncoding, 'utf8'> {
  return enc === 'gbk' || enc === 'gb18030' || enc === 'big5'
}

// ignoreBOM：保留 UTF-8 BOM 原样（同 Buffer.toString），带 BOM 的文件读写往返不丢字节
function newDecoder(enc?: string) {
  if (isLegacyEncoding(enc)) {
    try { return new TextDecoder(enc, { ignoreBOM: true }) } catch { /* 无 ICU：退回 UTF-8 */ }
  }
  return new TextDecoder('utf-8', { ignoreBOM: true })
}

/** 流式解码：多字节字符被切在两个 chunk 之间也能拼对（每条字节流各建一个） */
export function createDecoder(enc?: string): (chunk: Uint8Array) => string {
  const d = newDecoder(enc)
  return (chunk) => d.decode(chunk, { stream: true })
}

/** 一次性解码整段（文件内容） */
export function decodeText(buf: Uint8Array, enc?: string): string { return newDecoder(enc).decode(buf) }

const tables = new Map<string, Map<number, number[]>>()
function table(enc: string): Map<number, number[]> {
  let t = tables.get(enc)
  if (t) return t
  t = new Map()
  const d = newDecoder(enc)
  const put = (bytes: number[]) => {
    const s = d.decode(new Uint8Array(bytes))
    const cp = s.codePointAt(0) ?? 0xfffd
    // 只收「恰好一个字符、不是替换符」的；重复映射先到先得（单字节优先）
    if (cp !== 0xfffd && s.length === (cp > 0xffff ? 2 : 1) && !t!.has(cp)) t!.set(cp, bytes)
  }
  for (let b = 0x80; b <= 0xff; b++) put([b])
  for (let lead = 0x81; lead <= 0xfe; lead++) {
    for (let trail = 0x40; trail <= 0xfe; trail++) if (trail !== 0x7f) put([lead, trail])
  }
  tables.set(enc, t)
  return t
}

/** 文本 → 主机编码字节；表里没有的字符变 '?' */
export function encodeText(s: string, enc?: string): Uint8Array {
  if (!isLegacyEncoding(enc)) return new TextEncoder().encode(s)
  const t = table(enc)
  const out: number[] = []
  for (const ch of s) {
    const cp = ch.codePointAt(0)!
    if (cp < 0x80) out.push(cp)
    else out.push(...(t.get(cp) ?? [0x3f]))
  }
  return new Uint8Array(out)
}
