import { useEffect, useMemo, useState } from 'react'
import Markdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Loader2 } from 'lucide-react'
import { parseDelimited, previewMime, tr, type FsScope, type PreviewData } from '@lingshell/shared'
import { client } from '../../client/index.js'
import { ImageViewer } from '../../components/ImageViewer.js'
import { Input } from '../../components/ui/Input.js'

const errMsg = (e: unknown) => (e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(e))
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
/** 预览正文（不带弹窗外壳）：统一弹窗的查看模式直接用它 */
export function PreviewBody({ scope, path, text }: { scope: FsScope; path: string; text?: string }) {
  const [data, setData] = useState<PreviewData>()
  const [err, setErr] = useState('')
  const [zoom, setZoom] = useState(false)   // 图片点开后用 ImageViewer（缩放 / 拖拽 / ← → 切换）
  // md / csv 的正文父组件已经读过（切编辑还要用），这里直接用，不再读一遍；图片 / PDF 没有正文，走 preview.read
  const textKind = text === undefined ? undefined
    : /\.(md|markdown)$/i.test(path) ? 'markdown' : /\.tsv$/i.test(path) ? 'tsv' : /\.csv$/i.test(path) ? 'csv' : undefined
  useEffect(() => {
    if (textKind) return
    client.preview.read(scope, path).then(setData).catch((e) => setErr(errMsg(e)))
  }, [scope, path, textKind])
  const mdBlock = (src: string) => (
    <div className="min-h-0 flex-1 overflow-auto px-8 py-5">
      <div className="markdown-body mx-auto max-w-[860px] break-words text-[13px] text-[var(--color-text-primary)]">
        <Markdown remarkPlugins={[remarkGfm]} components={{ img: ({ src, alt, title }) => <MarkdownImage src={src} alt={alt} title={title} scope={scope} basePath={path} /> } as Components}>{src}</Markdown>
      </div>
    </div>
  )
  if (textKind === 'markdown') return mdBlock(text ?? '')
  if (textKind) return <CsvView text={text ?? ''} sep={textKind === 'tsv' ? '\t' : ','} />
  if (err) return <div className="p-5 text-[12.5px] text-[var(--color-danger)]">{tr('无法预览：{err}', { err })}</div>
  if (!data) return <div className="flex items-center gap-1.5 p-5 text-[12px] text-[var(--color-text-muted)]"><Loader2 className="h-3.5 w-3.5 animate-spin" />{tr('读取中…')}</div>
  if (data.kind === 'image') {
    const src = `data:${previewMime(data.name)};base64,${data.base64}`
    return <>
      <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto bg-[var(--color-bg-base)] p-3">
        <img data-preview-image src={src} alt={data.name} title={tr('点击放大（可缩放 / 拖拽）')} onClick={() => setZoom(true)}
          className="max-h-full max-w-full cursor-zoom-in object-contain" />
      </div>
      {zoom && <ImageViewer items={[{ kind: 'image', name: data.name, path, src }]} index={0} onClose={() => setZoom(false)} />}
    </>
  }
  if (data.kind === 'markdown') return mdBlock(data.text ?? '')
  if (data.kind === 'pdf') return <PdfView data={data} />
  return <CsvView text={data.text ?? ''} sep={data.kind === 'tsv' ? '\t' : ','} />
}

// 资源管理器里双击文件 → 统一弹窗的查看模式（FileEditor 只读态）渲染本文件的 PreviewBody



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
