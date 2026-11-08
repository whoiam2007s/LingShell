// 输入框附件（草稿）：文件 / 目录只记路径；图片在这里光栅化成 PNG / JPEG（长边 ≤ 2048），再随消息发给主进程存档。
// 图片有两种来源：粘贴 / 拖入的位图（没有路径，只能作为图片发送）；本机图片文件（有路径，模型支持图片时作为图片发送，不支持时只发路径）。
import { IMAGE_MAX_SOURCE_BYTES, IMAGE_MAX_SENT_BYTES, base64Bytes, baseName, tr, tk, isImageFileName, svgRasterSize, type ImageMediaType, type MsgAttachment, type TurnAttachment, type ContextKind } from '@lingshell/shared'
import { client } from '../../client/index.js'
import { clipBlock, termBlockName, type TermBlock } from '../../lib/termBlock.js'
import { naturalSize } from '../../lib/imageSrc.js'

type Raster = { mediaType: ImageMediaType; data: string }
export type DraftAtt =
  | { key: string; kind: 'file' | 'dir'; path: string; name: string }
  // src：显示用（图片文件是原图 data URL，svg 也能显示）；mediaType + data：发送用的光栅化结果（转换失败时缺省，只能按路径发）
  | ({ key: string; kind: 'image'; name: string; src: string; path?: string } & (Raster | { mediaType?: undefined; data?: undefined }))
  // 上下文标签：@ 引用终端 / 主机 / 历史会话、`!命令` 的终端块（只是一段文字，随消息发给 AI）
  | { key: string; kind: 'context'; ctx: ContextKind; name: string; text: string; path?: undefined }
  // 终端块（见 termBlock.ts）：发送时拼成文本接在消息后面，不走附件通道
  | { key: string; kind: 'termBlock'; name: string; block: TermBlock; path?: undefined }

export { type TermBlock, termBlockText, withTermBlocks, clipBlock, TERM_BLOCK_MIME } from '../../lib/termBlock.js'
export const termBlockAtt = (b: TermBlock): DraftAtt => ({ key: key(), kind: 'termBlock', name: termBlockName(b), block: clipBlock(b) })
/** 输入框 tag 的展示数据：MsgAttachment（文件 / 目录 / 图片）或终端块 */
export type ChipView = MsgAttachment | { kind: 'termBlock'; name: string; block: TermBlock; path?: undefined; src?: undefined; imageId?: undefined }

// 显示时 tr()
export const NO_IMAGE_HINT = tk('当前模型不支持图片，可在模型设置里开启或切换模型')
export const PATH_ONLY_HINT = tk('当前模型不支持图片，将只发送路径')
const MAX_EDGE = 2048
const PNG_MAX_CHARS = 3_000_000   // PNG 的 data URL 超过约 2.2MB 改用 JPEG（截图类图片 PNG 通常更小更清晰）

/** 压缩台阶：逐级降级直到体积压进 IMAGE_MAX_SENT_BYTES（长边 2048 → 1536 → 1024，质量同步降） */
export const ENCODE_LADDER: { edge: number; quality: number }[] = [
  { edge: 2048, quality: 0.888 },
  { edge: 2048, quality: 0.75 },
  { edge: 1536, quality: 0.75 },
  { edge: 1024, quality: 0.7 },
]

const key = () => `att_${Math.random().toString(36).slice(2, 10)}`
export const pathAtt = (kind: 'file' | 'dir', path: string): DraftAtt => ({ key: key(), kind, path, name: baseName(path) || path })
export const contextAtt = (ctx: ContextKind, name: string, text: string): DraftAtt => ({ key: key(), kind: 'context', ctx, name, text })

/**
 * 画到画布再编码：长边先压到 2048，然后按 ENCODE_LADDER 逐级降级（降质量 → 再降尺寸），
 * 直到单张压进 IMAGE_MAX_SENT_BYTES；原图是 JPEG 的直接走 JPEG（垫白底）。
 *
 * 以前只做「PNG 太大就转一次 JPEG」，JPEG 那档不再看体积 —— 噪点图能到 3MB 一张。
 * 现在最多四档必然收敛（2048/0.888 → 2048/0.75 → 1536/0.75 → 1024/0.7）。
 */
function encode(img: CanvasImageSource, w: number, h: number, jpeg: boolean): Raster {
  const c = document.createElement('canvas')
  const g = c.getContext('2d')!
  const render = (edge: number, bg: boolean, quality: number, type: 'image/png' | 'image/jpeg'): Raster => {
    const k = Math.min(1, edge / Math.max(w, h))
    c.width = Math.max(1, Math.round(w * k)); c.height = Math.max(1, Math.round(h * k))
    g.clearRect(0, 0, c.width, c.height)
    if (bg) { g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height) }
    g.drawImage(img, 0, 0, c.width, c.height)
    const src = type === 'image/png' ? c.toDataURL('image/png') : c.toDataURL('image/jpeg', quality)
    return { mediaType: type, data: src.slice(src.indexOf(',') + 1) }
  }
  // 截图类先试 PNG（无损、字更清楚）；本身太大或原图是 JPEG 就进降级台阶
  if (!jpeg) {
    const png = render(MAX_EDGE, false, 1, 'image/png')
    if (png.data.length <= PNG_MAX_CHARS && base64Bytes(png.data) <= IMAGE_MAX_SENT_BYTES) return png
  }
  let out: Raster | undefined
  for (const step of ENCODE_LADDER) {
    out = render(step.edge, true, step.quality, 'image/jpeg')
    if (base64Bytes(out.data) <= IMAGE_MAX_SENT_BYTES) return out
  }
  return out!   // 最后一档（1024 长边 / q0.7）远低于上限，直接兜底
}

/** 粘贴 / 拖入的位图（没有路径）→ 图片附件 */
export async function normalizeImage(blob: Blob, name: string): Promise<DraftAtt> {
  if (blob.size > IMAGE_MAX_SOURCE_BYTES) throw new Error(tr('图片超过 10MB：{name}', { name }))
  let bmp: ImageBitmap
  try { bmp = await createImageBitmap(blob) } catch { throw new Error(tr('无法读取图片：{name}', { name })) }
  const r = encode(bmp, bmp.width, bmp.height, blob.type === 'image/jpeg')
  bmp.close()
  return { key: key(), kind: 'image', name, ...r, src: `data:${r.mediaType};base64,${r.data}` }
}

/** data URL 里的 svg 文本（只用来读尺寸属性，按 latin1 解即可） */
const svgText = (src: string) => { try { return atob(src.slice(src.indexOf(',') + 1)) } catch { return '' } }
const isSvg = (src: string) => src.startsWith('data:image/svg+xml')

/** <img> 加载 data URL；svg 在 <img> 里不执行脚本、不加载外部资源 */
async function loadImg(src: string): Promise<HTMLImageElement> {
  const img = new Image()
  img.src = src
  await img.decode()
  return img
}


/**
 * 本机图片文件（路径已经过主进程 kinds 判断）→ 图片附件：主进程读成 data URL（svg 为 image/svg+xml）作显示用，
 * 再光栅化成 PNG / JPEG 备发送——bmp / svg 模型多不接受，统一转；svg 按 svgRasterSize 放大到长边 ≥ 1024 再画。
 * 光栅化失败（如 svg 引用外部内容导致画布受污染）时只留显示用的 src，发送时退回按路径发。
 */
export async function imageFileAtt(path: string): Promise<DraftAtt> {
  const name = baseName(path) || path
  const src = await client.attachments.imageFile(path)
  if (!src) throw new Error(tr('无法读取图片：{name}', { name }))
  const base = { key: key(), kind: 'image' as const, name, path, src }
  // 原图过大（>10MB）：不读进内存光栅化，只留路径（模型支持图片时也按路径发），由调用方提示
  if (base64Bytes(src.slice(src.indexOf(',') + 1)) > IMAGE_MAX_SOURCE_BYTES) return base
  let r: Raster | undefined
  try {
    const img = await loadImg(src)
    if (isSvg(src)) { const s = svgRasterSize(svgText(src), MAX_EDGE); r = encode(img, s.width, s.height, false) }
    else { const n = naturalSize(img, src); r = encode(img, n.w, n.h, src.startsWith('data:image/jpeg')) }
  } catch { r = undefined }
  return r ? { ...base, ...r } : base
}

/** 这条附件会不会作为图片发送：模型支持图片且已光栅化；否则有路径的按路径发 */
const asImage = (a: Extract<DraftAtt, { kind: 'image' }>, multimodal: boolean): a is Extract<DraftAtt, { kind: 'image' }> & Raster =>
  !!a.data && (multimodal || !a.path)

// 终端块不走这里（发送前已拆出去拼进文本）
export const toTurn = (a: Exclude<DraftAtt, { kind: 'termBlock' }>, multimodal: boolean): TurnAttachment => {
  if (a.kind === 'context') return { kind: 'context', ctx: a.ctx, name: a.name, text: a.text }
  if (a.kind !== 'image') return { kind: a.kind, path: a.path }
  if (asImage(a, multimodal)) return { kind: 'image', name: a.name, mediaType: a.mediaType, data: a.data }
  return { kind: 'file', path: a.path! }
}
export const toView = (a: Exclude<DraftAtt, { kind: 'termBlock' }>): MsgAttachment =>
  a.kind === 'context' ? { kind: 'context', ctx: a.ctx, name: a.name, text: a.text }
    : a.kind === 'image' ? { kind: 'image', name: a.name, src: a.src, ...(a.path ? { path: a.path } : {}) } : { kind: a.kind, name: a.name, path: a.path }
export const toChip = (a: DraftAtt): ChipView => (a.kind === 'termBlock' ? { kind: 'termBlock', name: a.name, block: a.block } : toView(a))
/** 草稿里要作为图片发出的张数（限额用） */
export const imageCount = (items: DraftAtt[], multimodal: boolean) => items.filter((a) => a.kind === 'image' && asImage(a, multimodal)).length

/** 以图片 tag 显示：图片附件，或文件名是图片的文件（历史回放里按路径发出的图片文件） */
export const isImageAtt = (a: ChipView): boolean => a.kind === 'image' || (a.kind === 'file' && isImageFileName(a.name))

export { imageSrc, naturalSize } from '../../lib/imageSrc.js'

// IPC 报错前缀（Error invoking remote method 'x': Error: ...）去掉，只留原因
export const errMsg = (e: unknown): string => String((e as Error)?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
