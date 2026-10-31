// 资源管理器文件预览：按扩展名认图片 / Markdown / CSV / TSV / PDF，应用内直接看（读取见 desktop/main/files/filePreviewIpc.ts）。
// 上限按类型分：Markdown 要整段交给 react-markdown 渲染，越大越慢；CSV 只显示前 5000 行，读太大没意义；
// 图片 / PDF 交给浏览器解码，20MB 已是能流畅打开的量级。超过就走「下载」或用系统程序打开。
import { tk } from '../i18n/i18n.js'
export type PreviewKind = 'image' | 'markdown' | 'csv' | 'tsv' | 'pdf'
export const PREVIEW_MAX_BYTES = 20 * 1024 * 1024          // 图片 / PDF
export const PREVIEW_TEXT_MAX_BYTES = 2 * 1024 * 1024      // Markdown
export const PREVIEW_TABLE_MAX_BYTES = 5 * 1024 * 1024     // CSV / TSV
export const PREVIEW_TABLE_MAX_ROWS = 5000
export const previewMaxBytes = (kind: PreviewKind): number =>
  kind === 'markdown' ? PREVIEW_TEXT_MAX_BYTES : kind === 'csv' || kind === 'tsv' ? PREVIEW_TABLE_MAX_BYTES : PREVIEW_MAX_BYTES

const EXT: Record<string, PreviewKind> = {
  png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', webp: 'image', svg: 'image', bmp: 'image', ico: 'image',
  md: 'markdown', markdown: 'markdown', csv: 'csv', tsv: 'tsv', pdf: 'pdf',
}
const MIME: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', bmp: 'image/bmp', ico: 'image/x-icon', pdf: 'application/pdf' }
const ext = (name: string) => /\.([^./\\]+)$/.exec(name)?.[1]?.toLowerCase() ?? ''

export const previewKind = (name: string): PreviewKind | undefined => EXT[ext(name)]
export const previewMime = (name: string): string => MIME[ext(name)] ?? 'application/octet-stream'
export const PREVIEW_KIND_LABEL: Record<PreviewKind, string> = { image: tk('图片'), markdown: 'Markdown', csv: tk('CSV 表格'), tsv: tk('TSV 表格'), pdf: 'PDF' }

export interface PreviewData {
  kind: PreviewKind
  name: string
  size: number
  base64?: string       // 图片 / PDF 原字节
  text?: string         // Markdown / CSV / TSV（按主机编码解码）
}

/** CSV / TSV → 行（RFC 4180：双引号包裹、"" 转义、引号里可换行）；去掉 UTF-8 BOM 与末尾空行 */
export function parseDelimited(text: string, sep: ',' | '\t', maxRows = PREVIEW_TABLE_MAX_ROWS): { rows: string[][]; truncated: boolean } {
  const s = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  const rows: string[][] = []
  let row: string[] = [], cell = '', q = false, i = 0
  const endRow = () => { row.push(cell); rows.push(row); row = []; cell = '' }
  while (i < s.length) {
    const c = s[i]
    if (q) {
      if (c === '"') { if (s[i + 1] === '"') { cell += '"'; i += 2; continue } q = false; i++; continue }
      cell += c; i++; continue
    }
    if (c === '"' && cell === '') { q = true; i++; continue }
    if (c === sep) { row.push(cell); cell = ''; i++; continue }
    if (c === '\r' || c === '\n') { endRow(); i += c === '\r' && s[i + 1] === '\n' ? 2 : 1; if (rows.length > maxRows) break; continue }
    cell += c; i++
  }
  if (cell !== '' || row.length) endRow()
  while (rows.length && rows.at(-1)!.every((x) => x === '')) rows.pop()
  const truncated = rows.length > maxRows
  return { rows: rows.slice(0, maxRows), truncated }
}
