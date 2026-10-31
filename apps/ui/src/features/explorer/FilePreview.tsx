import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import Markdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Download, ExternalLink, Eye, Loader2, Pencil, X } from 'lucide-react'
import { PREVIEW_KIND_LABEL, formatSize, parseDelimited, previewMime, tr, type FsScope, type PreviewData } from '@lingshell/shared'
import { client } from '../../client/index.js'
import { ImageViewer } from '../../components/ImageViewer.js'
import { Input } from '../../components/ui/Input.js'

const errMsg = (e: unknown) => (e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(e))
const BTN = 'flex h-7 shrink-0 items-center gap-1 rounded-md border border-[var(--color-border-default)] px-2 text-[11.5px] text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)]'
const MAX_SHOWN = 2000

/** 把 Markdown 里的相对图片路径解析成「相对 Markdown 文件所在目录」的路径；绝对路径 / URL 原样返回 */
function resolveRelative(baseFile: string, rel: string): string {
  let clean = rel.split(/[?#]/)[0] ?? ''
  try { clean = decodeURIComponent(clean) } catch { /* 保留原样：文件名里就有 % 时不要报错 */ }
  if (!clean) return clean
  if (/^(?:[a-zA-Z]:[\\/]|[\\/]{2})/.test(clean)) return clean   // Windows 盘符 / UNC
  if (clean.startsWith('/')) return clean                       // POSIX 绝对路径
  const sep = baseFile.includes('\\') ? '\\' : '/'
  const cut = Math.max(baseFile.lastIndexOf('/'), baseFile.lastIndexOf('\\'))
  const baseDir = cut >= 0 ? baseFile.slice(0, cut) : ''
  const parts = (baseDir + sep + clean).split(/[\\/]+/)
  const out: string[] = []
  for (const p of parts) {
    if (!p || p === '.') continue
    if (p === '..') { if (out.length) out.pop(); continue }
    out.push(p)
  }
  const joined = out.join(sep)
  return baseFile.startsWith('/') ? `/${joined}` : joined
}

/** Markdown 图片：相对路径按 md 文件目录经 preview.read 读字节，转 data URL；外链 / data URL 直接用 */
function MarkdownImage({ src, alt, title, scope, basePath }: { src?: string; alt?: string; title?: string; scope: FsScope; basePath: string }) {
  const [state, setState] = useState<{ url?: string; err?: string }>({})
  useEffect(() => {
    let alive = true
    if (!src) return
    if (/^(?:https?:|data:|blob:)/i.test(src)) { setState({ url: src }); return }
    const abs = resolveRelative(basePath, src)
    client.preview.read(scope, abs).then((d) => {
      if (!alive) return
      if (d.kind === 'image' && d.base64) setState({ url: `data:${previewMime(d.name)};base64,${d.base64}` })
      else setState({ err: tr('不是图片文件') })
    }).catch((e) => { if (alive) setState({ err: errMsg(e) }) })
    return () => { alive = false }
  }, [src, scope, basePath])
  if (!src) return null
  if (state.err) return <span title={state.err} className="text-[var(--color-text-muted)]">{alt || src}</span>
  if (!state.url) return <span className="text-[var(--color-text-muted)]">{alt || ''}</span>
  return <img src={state.url} alt={alt ?? ''} title={title} className="max-w-full rounded" />
}

// 资源管理器里的文件预览（双击 / 右键「预览」）：图片用 ImageViewer（缩放 / 拖拽）、Markdown 渲染、CSV / TSV 表格、PDF 用内置查看器（iframe），
// 超过 20MB 或读不了的提示下载 / 用系统程序打开。弹窗只能按 × / Esc 关
export function FilePreview({ scope, path, onDownload, onEdit, onClose }: { scope: FsScope; path: string; onDownload?: () => void; onEdit?: () => void; onClose: () => void }) {
  const [data, setData] = useState<PreviewData>()
  const [err, setErr] = useState('')
  const [note, setNote] = useState('')
  useEffect(() => { client.preview.read(scope, path).then(setData).catch((e) => setErr(errMsg(e))) }, [])
  const isImage = data?.kind === 'image'
  // 图片交给 ImageViewer 自己处理 Esc；其余在捕获阶段拦 Esc，免得先关掉底下的抽屉
  useEffect(() => {
    if (isImage) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose() } }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [isImage, onClose])
  const openExternal = () => { setNote(tr('正在用系统程序打开…')); client.preview.openExternal(scope, path).then(() => setNote('')).catch((e) => setNote(errMsg(e))) }

  if (data?.kind === 'image') return <ImageViewer items={[{ kind: 'image', name: data.name, path, src: `data:${previewMime(data.name)};base64,${data.base64}` }]} index={0} onClose={onClose} />
  const name = path.split(/[\\/]/).pop() ?? path
  return createPortal((
    <div className="fixed inset-0 z-[65] flex items-center justify-center bg-black/55 backdrop-blur-sm animate-fade-in">
      <div data-file-preview={data?.kind ?? (err ? 'error' : 'loading')} className="flex h-[85vh] w-[min(1100px,92vw)] flex-col overflow-hidden rounded-lg border border-[var(--color-border-default)] bg-[var(--color-bg-panel)] shadow-2xl">
        <div className="flex h-10 shrink-0 items-center gap-2 border-b border-[var(--color-border-subtle)] px-3">
          <Eye className="h-4 w-4 shrink-0 text-[var(--color-accent)]" />
          <span className="min-w-0 truncate font-mono text-[12px] text-[var(--color-text-primary)]" title={path}>{name}</span>
          {data && <span className="shrink-0 text-[11px] text-[var(--color-text-muted)]">{tr(PREVIEW_KIND_LABEL[data.kind])} · {formatSize(data.size)}</span>}
          {note && <span className="min-w-0 truncate text-[11px] text-[var(--color-text-muted)]">{note}</span>}
          <span className="ml-auto" />
          {onEdit && (data?.kind === 'markdown' || data?.kind === 'csv' || data?.kind === 'tsv') && <button onClick={onEdit} title={tr('在文本编辑器里查看 / 编辑原文')} className={BTN}><Pencil className="h-3.5 w-3.5" />{tr('编辑')}</button>}
          <button onClick={openExternal} title={tr('下载到临时目录后用系统默认程序打开')} className={BTN}><ExternalLink className="h-3.5 w-3.5" />{tr('用系统程序打开')}</button>
          {onDownload && <button onClick={onDownload} title={tr('下载到本地…')} className={BTN}><Download className="h-3.5 w-3.5" />{tr('下载')}</button>}
          <button onClick={onClose} title={tr('关闭（Esc）')} className="flex h-6 w-6 items-center justify-center rounded text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)]"><X className="h-4 w-4" /></button>
        </div>
        {err ? <div className="p-5 text-[12.5px] text-[var(--color-danger)]">{tr('无法预览：{err}', { err })}</div>
          : !data ? <div className="flex items-center gap-1.5 p-5 text-[12px] text-[var(--color-text-muted)]"><Loader2 className="h-3.5 w-3.5 animate-spin" />{tr('读取中…')}</div>
            : data.kind === 'markdown' ? <div className="min-h-0 flex-1 overflow-auto px-8 py-5"><div className="markdown-body mx-auto max-w-[860px] break-words text-[13px] text-[var(--color-text-primary)]"><Markdown remarkPlugins={[remarkGfm]} components={{ img: ({ src, alt, title }) => <MarkdownImage src={src} alt={alt} title={title} scope={scope} basePath={path} /> } as Components}>{data.text ?? ''}</Markdown></div></div>
              : data.kind === 'pdf' ? <PdfView data={data} />
                : <CsvView text={data.text ?? ''} sep={data.kind === 'tsv' ? '\t' : ','} />}
      </div>
    </div>
  ), document.body)
}

// PDF：base64 → Blob URL，交给 Chromium 内置的 PDF 查看器（iframe）；查看器不可用时用右上角「用系统程序打开」
function PdfView({ data }: { data: PreviewData }) {
  const url = useMemo(() => {
    const bin = atob(data.base64 ?? '')
    const u8 = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i)
    return URL.createObjectURL(new Blob([u8], { type: 'application/pdf' }))
  }, [data])
  useEffect(() => () => URL.revokeObjectURL(url), [url])
  return <iframe data-pdf-frame title={data.name} src={url} className="min-h-0 w-full flex-1 border-0 bg-[var(--color-bg-base)]" />
}

function CsvView({ text, sep }: { text: string; sep: ',' | '\t' }) {
  const { rows, truncated } = useMemo(() => parseDelimited(text, sep), [text, sep])
  const [q, setQ] = useState('')
  const [head, ...body] = rows
  const cols = Math.max(0, ...rows.map((r) => r.length))
  const shown = useMemo(() => { const s = q.trim().toLowerCase(); return s ? body.filter((r) => r.some((c) => c.toLowerCase().includes(s))) : body }, [body, q])
  return (
    <>
      <div className="flex shrink-0 items-center gap-2 border-b border-[var(--color-border-subtle)] px-3 py-1.5">
        <Input data-csv-search size="sm" value={q} onChange={(e) => setQ(e.target.value)} placeholder={tr('搜索全部列')} className="w-56" />
        <span className="ml-auto text-[11px] text-[var(--color-text-muted)]">{tr('{rows} 行 · {cols} 列', { rows: q.trim() ? `${shown.length} / ${body.length}` : body.length, cols })}{truncated ? tr(' · 只读了前 5000 行') : ''}</span>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        <table data-csv-table className="min-w-full border-collapse font-mono text-[11.5px]">
          <thead className="sticky top-0 z-[1] bg-[var(--color-bg-panel)]">
            <tr>
              <th className="border-b border-[var(--color-border-default)] px-2 py-1 text-right font-normal text-[var(--color-text-muted)]">#</th>
              {Array.from({ length: cols }, (_, i) => <th key={i} className="whitespace-nowrap border-b border-[var(--color-border-default)] px-2 py-1 text-left font-semibold text-[var(--color-text-secondary)]">{head?.[i] ?? ''}</th>)}
              <th className="w-full border-b border-[var(--color-border-default)]" />
            </tr>
          </thead>
          <tbody>
            {shown.slice(0, MAX_SHOWN).map((r, i) => (
              <tr key={i} className="hover:bg-[var(--color-bg-hover)]">
                <td className="border-b border-[var(--color-border-subtle)] px-2 py-[3px] text-right text-[var(--color-text-muted)]">{i + 1}</td>
                {Array.from({ length: cols }, (_, c) => <td key={c} title={(r[c] ?? '').length > 60 ? r[c] : undefined} className="max-w-[420px] truncate whitespace-pre border-b border-[var(--color-border-subtle)] px-2 py-[3px] text-[var(--color-text-primary)]">{r[c] ?? ''}</td>)}
                <td className="border-b border-[var(--color-border-subtle)]" />
              </tr>
            ))}
          </tbody>
        </table>
        {shown.length > MAX_SHOWN && <div className="px-3 py-2 text-[11.5px] text-[var(--color-text-muted)]">{tr('只显示前 {n} 行。', { n: MAX_SHOWN })}</div>}
      </div>
    </>
  )
}
