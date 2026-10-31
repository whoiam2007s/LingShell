// 部署评审用：文档转纯文本（md / txt / docx / pdf…）、产物信息（大小、sha256、压缩包里的文件列表）
// docx 是 zip 包里的 word/document.xml，用 zlib 自己读，不引依赖；pdf 用 unpdf（pdf.js）
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { basename, extname } from 'node:path'
import { gunzipSync, inflateRawSync } from 'node:zlib'
import { decodeText, tr, type ReviewArtifact } from '@lingshell/shared'

export const DOC_EXTS = ['md', 'markdown', 'txt', 'text', 'log', 'docx', 'pdf', 'html', 'htm', 'yaml', 'yml', 'sh', 'json', 'conf', 'ini']
const DOC_MAX_BYTES = 50 * 1024 * 1024
/** 文档纯文字上限：界面会把全文渲染进 <pre>，几十兆会卡死；部署文档远小于这个量 */
export const DOC_TEXT_MAX_CHARS = 1_000_000
const LIST_MAX_BYTES = 300 * 1024 * 1024   // 压缩包超过这个大小就不列文件（要整个读进内存）
const XML_MAX_BYTES = 64 * 1024 * 1024     // docx 解压上限（防 zip 炸弹）
const TAR_MAX_BYTES = 512 * 1024 * 1024    // tar.gz 解压上限（防 zip 炸弹；超了只是不列文件）

// ── zip（只读中央目录，够 docx / zip 产物用）──
interface ZipEntry { name: string; method: number; csize: number; offset: number }
export function zipEntries(buf: Buffer): ZipEntry[] {
  let eocd = -1
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65_535); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break }
  if (eocd < 0) throw new Error(tr('不是有效的 zip / docx 文件'))
  const n = buf.readUInt16LE(eocd + 10)
  let p = buf.readUInt32LE(eocd + 16)
  const out: ZipEntry[] = []
  for (let k = 0; k < n && p + 46 <= buf.length && buf.readUInt32LE(p) === 0x02014b50; k++) {
    const nameLen = buf.readUInt16LE(p + 28), extraLen = buf.readUInt16LE(p + 30), commentLen = buf.readUInt16LE(p + 32)
    out.push({ name: buf.subarray(p + 46, p + 46 + nameLen).toString('utf8'), method: buf.readUInt16LE(p + 10), csize: buf.readUInt32LE(p + 20), offset: buf.readUInt32LE(p + 42) })
    p += 46 + nameLen + extraLen + commentLen
  }
  return out
}
export function zipRead(buf: Buffer, e: ZipEntry, maxOutputLength = XML_MAX_BYTES): Buffer {
  const start = e.offset + 30 + buf.readUInt16LE(e.offset + 26) + buf.readUInt16LE(e.offset + 28)
  const data = buf.subarray(start, start + e.csize)
  if (e.method === 0) return data
  if (e.method === 8) return inflateRawSync(data, { maxOutputLength })
  throw new Error(tr('不支持的 zip 压缩方式 {method}', { method: e.method }))
}

const ENT: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }
const codepoint = (s: string): string | undefined => {
  const n = s[0] === '#' ? (s[1] === 'x' || s[1] === 'X' ? parseInt(s.slice(2), 16) : Number(s.slice(1))) : NaN
  return Number.isFinite(n) && n >= 0 && n <= 0x10ffff ? String.fromCodePoint(n) : undefined
}
const unescapeXml = (s: string) => s.replace(/&(#x?[0-9a-f]+|\w+);/gi, (m, k: string) => (k[0] === '#' ? codepoint(k) ?? m : ENT[k.toLowerCase()] ?? m))

/** word/document.xml → 文本：段落换行，表格单元格用 | 分隔，编号段落前加 - */
export function docxXmlToText(xml: string): string {
  return unescapeXml(xml
    .replace(/<w:instrText[\s\S]*?<\/w:instrText>/g, '')
    .replace(/<w:tab\/>/g, '\t').replace(/<w:br\/>|<w:cr\/>/g, '\n')
    .replace(/<w:tc[ >][\s\S]*?<\/w:tc>/g, (tc) => tc.replace(/<\/w:p>/g, ' ').replace(/<[^>]+>/g, '').trim() + ' | ')   // 单元格里的段落不换行
    .replace(/<\/w:tr>/g, '\n')
    .replace(/<w:p[ >][\s\S]*?<\/w:p>/g, (p) => (/<w:numPr[\s/>]/.test(p) ? '- ' : '') + p + '\n')
    .replace(/<[^>]+>/g, ''))
    .replace(/ \| \n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
}

export const htmlToText = (html: string) => unescapeXml(html.replace(/<(script|style)[\s\S]*?<\/\1>/gi, '').replace(/<br\s*\/?>|<\/(p|div|li|tr|h\d)>/gi, '\n').replace(/<\/t[dh]>/gi, ' | ').replace(/<[^>]+>/g, '')).replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()

export function decodeAuto(buf: Buffer): string {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buf) } catch { return decodeText(buf, 'gbk') }
}

export async function docToText(path: string): Promise<{ name: string; text: string }> {
  const s = await stat(path)
  if (s.size > DOC_MAX_BYTES) throw new Error(tr('文档超过 50MB'))
  const buf = await readFile(path), ext = extname(path).slice(1).toLowerCase()
  let text: string
  if (ext === 'docx') {
    const es = zipEntries(buf), main = es.find((e) => e.name === 'word/document.xml')
    if (!main) throw new Error(tr('不是有效的 Word 文档（.docx）'))
    try { text = docxXmlToText(zipRead(buf, main).toString('utf8')) } catch (e) {
      throw new Error(tr('读取 Word 文档失败：{err}', { err: e instanceof Error ? e.message : String(e) }))
    }
  } else if (ext === 'doc') {
    throw new Error(tr('不支持旧版 .doc，请在 Word 里另存为 .docx'))
  } else if (ext === 'pdf') {
    const { extractText, getDocumentProxy } = await import('unpdf')
    const pdf = await getDocumentProxy(new Uint8Array(buf))
    text = (await extractText(pdf, { mergePages: false })).text.map((t, i) => `【第 ${i + 1} 页】\n${t.trim()}`).join('\n\n')   // i18n-ignore 文档正文里的分页标记（发给模型评审）
  } else if (ext === 'html' || ext === 'htm') text = htmlToText(decodeAuto(buf))
  else text = decodeAuto(buf)
  if (!text.trim()) throw new Error(ext === 'pdf' ? tr('没从 PDF 里读出文字（可能是扫描件 / 图片）') : tr('文档是空的'))
  if (text.length > DOC_TEXT_MAX_CHARS) throw new Error(tr('文档文字过长（超过 {n} 万字），请拆分，或只保留与部署相关的内容', { n: DOC_TEXT_MAX_CHARS / 10_000 }))
  return { name: basename(path), text: text.replace(/\r\n/g, '\n') }
}

// ── 产物 ──
function tarNames(tar: Buffer): string[] {
  const out: string[] = []
  let p = 0, long = ''
  while (p + 512 <= tar.length && out.length < 2000) {
    const h = tar.subarray(p, p + 512)
    if (h.every((b) => b === 0)) break
    const size = parseInt(h.subarray(124, 136).toString('latin1').replace(/\0.*$/, '').trim() || '0', 8) || 0
    const type = String.fromCharCode(h[156])
    const body = tar.subarray(p + 512, p + 512 + size)
    if (type === 'L') long = body.toString('utf8').replace(/\0.*$/s, '')
    else if (type !== 'x' && type !== 'g') {
      const prefix = h.subarray(345, 500).toString('utf8').replace(/\0.*$/s, '')
      const name = long || (prefix ? `${prefix}/` : '') + h.subarray(0, 100).toString('utf8').replace(/\0.*$/s, '')
      long = ''
      if (type !== '5' && name) out.push(name)
    }
    p += 512 + Math.ceil(size / 512) * 512
  }
  return out
}

function sha256File(path: string): Promise<string> {
  return new Promise((res, rej) => {
    const h = createHash('sha256')
    createReadStream(path).on('data', (c) => h.update(c)).on('error', rej).on('end', () => res(h.digest('hex')))
  })
}

export async function artifactInfo(path: string): Promise<ReviewArtifact> {
  const s = await stat(path)
  if (!s.isFile()) throw new Error(tr('{name} 不是文件', { name: basename(path) }))
  const name = basename(path), lower = name.toLowerCase()
  let entries: string[] | undefined
  if (s.size <= LIST_MAX_BYTES && /\.(zip|jar|war|ear|whl|tar|tgz|tar\.gz)$/.test(lower)) {
    try {
      const buf = await readFile(path)
      entries = /\.(tgz|tar\.gz)$/.test(lower) ? tarNames(gunzipSync(buf, { maxOutputLength: TAR_MAX_BYTES })) : lower.endsWith('.tar') ? tarNames(buf) : zipEntries(buf).map((e) => e.name).filter((n) => !n.endsWith('/'))
    } catch { /* 读不了就不列 */ }
  }
  return { name, size: s.size, sha256: await sha256File(path), ...(entries ? { entries: entries.slice(0, 500) } : {}) }
}
