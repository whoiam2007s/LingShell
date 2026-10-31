// AI 对话的附件：本地文件 / 目录（只把路径作为上下文发给模型，不上传内容）与图片（多模态内容块随消息发送）。
// 纯函数：路径块的拼装与解析（持久化的消息文本里带着它，回放时解析回附件 tag）、Git Bash 路径换算、图片限额。

export type ImageMediaType = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'
export const IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'webp', 'gif']
export const IMAGE_MAX_SOURCE_BYTES = 10 * 1024 * 1024   // 单张原图上限
export const IMAGE_MAX_PER_MESSAGE = 8                    // 每条消息最多几张

/** 发送方向：文件 / 目录只带路径；图片带（已在渲染层缩放压缩过的）base64 */
export type TurnAttachment =
  | { kind: 'file' | 'dir'; path: string }
  | { kind: 'image'; name: string; mediaType: ImageMediaType; data: string }
  | ContextAttachment

/** 展示方向（气泡下方 / 历史回放）：图片用 imageId 向主进程取存档副本，src 是本地乐观显示时的 data URL */
export interface MsgAttachment {
  kind: 'file' | 'dir' | 'image' | 'context'
  name: string
  path?: string
  imageId?: string
  src?: string
  ctx?: ContextKind   // kind=context：引用的是终端 / 主机 / 历史会话 / 终端块
  text?: string       // kind=context：随消息发给 AI 的上下文文字（悬停预览）
}

/** Windows 路径 → Git Bash 写法（C:\a\b → /c/a/b）；不是盘符路径的原样返回 */
export function gitBashPath(p: string): string {
  const m = /^([a-zA-Z]):[\\/]?(.*)$/.exec(p)
  if (!m) return p.replace(/\\/g, '/')
  return `/${m[1].toLowerCase()}/${m[2].replace(/\\/g, '/')}`.replace(/\/+$/, '') || '/'
}

// 路径块是给模型的上下文，也是持久化后反解析的格式：固定中文，不翻译（界面显示前会被 splitPathsBlock 去掉）
const HEAD = '[附带的本地路径]'   // i18n-ignore 发给模型 + 解析格式
const TAIL = '（以上是用户在本机选的文件 / 目录，内容没有上传；需要时请用本地终端读取。）'   // i18n-ignore 发给模型 + 解析格式
const LINE = /^- (文件|目录)：(.+?)(?:（Git Bash：.*）)?$/

/**
 * 在用户消息末尾追加路径块。Windows 上同时给出 Git Bash 写法（本地终端默认是 Git Bash，PowerShell / cmd 用原路径）。
 * 没有路径时原样返回。
 */
export function withPathsBlock(text: string, paths: { kind: 'file' | 'dir'; path: string }[], platform: string): string {
  if (!paths.length) return text
  const lines = paths.map((p) => {
    const alt = platform === 'win32' && /^[a-zA-Z]:/.test(p.path) ? `（Git Bash：${gitBashPath(p.path)}）` : ''   // i18n-ignore 解析格式
    return `- ${p.kind === 'dir' ? '目录' : '文件'}：${p.path}${alt}`   // i18n-ignore 解析格式
  })
  return `${text.trim() ? `${text.trimEnd()}\n\n` : ''}${HEAD}\n${lines.join('\n')}\n${TAIL}`
}

/** 反解：消息文本 → 用户原话 + 路径附件（没有路径块的原样返回） */
export function splitPathsBlock(text: string): { text: string; paths: { kind: 'file' | 'dir'; path: string }[] } {
  const at = text.lastIndexOf(HEAD)
  if (at < 0 || (at > 0 && text[at - 1] !== '\n')) return { text, paths: [] }
  const paths: { kind: 'file' | 'dir'; path: string }[] = []
  for (const line of text.slice(at + HEAD.length).split('\n')) {
    const m = LINE.exec(line.trim())
    if (m) paths.push({ kind: m[1] === '目录' ? 'dir' : 'file', path: m[2] })   // i18n-ignore 解析格式
  }
  if (!paths.length) return { text, paths: [] }
  return { text: text.slice(0, at).trimEnd(), paths }
}

/** 按文件名判断是不是支持的图片 */
export const isImageName = (name: string): boolean => IMAGE_EXTS.includes((/\.([^.\\/]+)$/.exec(name)?.[1] ?? '').toLowerCase())
export const mediaTypeOfName = (name: string): ImageMediaType | undefined => {
  const ext = (/\.([^.\\/]+)$/.exec(name)?.[1] ?? '').toLowerCase()
  return ext === 'png' ? 'image/png' : ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : ext === 'webp' ? 'image/webp' : ext === 'gif' ? 'image/gif' : undefined
}

// 图片文件（选择文件 / 拖入 / 粘贴进来的本机文件）：以图片 tag 显示（小缩略图 + 名称）。
// 模型支持图片时渲染层把它光栅化成 PNG / JPEG 作为图片发送（bmp / svg 模型多不接受，统一转）；不支持时只发路径。
export type ImageFileType = ImageMediaType | 'image/bmp' | 'image/svg+xml'
export const IMAGE_FILE_EXTS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg']
const extOf = (name: string) => (/\.([^.\\/]+)$/.exec(name)?.[1] ?? '').toLowerCase()
/** 按扩展名判断是不是可显示的图片文件（含 bmp / svg） */
export const isImageFileName = (name: string): boolean => IMAGE_FILE_EXTS.includes(extOf(name))

/** 按文件头认图片格式（PNG / JPEG / GIF / WebP / BMP / SVG），认不出返回 undefined。传前 1KB 左右即可 */
export function sniffImage(b: Uint8Array): ImageFileType | undefined {
  const at = (i: number, s: string) => [...s].every((c, k) => b[i + k] === c.charCodeAt(0))
  if (b.length >= 8 && b[0] === 0x89 && at(1, 'PNG\r\n')) return 'image/png'
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg'
  if (at(0, 'GIF87a') || at(0, 'GIF89a')) return 'image/gif'
  if (b.length >= 12 && at(0, 'RIFF') && at(8, 'WEBP')) return 'image/webp'
  if (b.length >= 26 && at(0, 'BM')) return 'image/bmp'
  // SVG：可选 BOM（TextDecoder 自动去掉）/ XML 声明 / 注释 / DOCTYPE 之后是 <svg
  const head = new TextDecoder().decode(b.subarray(0, 2048))
  if (/^\s*(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*|<!DOCTYPE[^>]*>\s*)*<svg[\s/>]/i.test(head)) return 'image/svg+xml'
  return undefined
}

/** 文件名 + 文件头 → 图片类型：扩展名是图片的要文件头对得上（防改名的非图片）；没有扩展名的认得出也算 */
export function imageTypeOf(name: string, head: Uint8Array): ImageFileType | undefined {
  const ext = extOf(name)
  if (ext && !IMAGE_FILE_EXTS.includes(ext)) return undefined
  return sniffImage(head)
}

/**
 * SVG 光栅化尺寸：取 <svg> 的 width / height（px 或无单位），缺了按 viewBox 比例补，都没有按 300×150（浏览器默认）。
 * 矢量图放大不失真：长边小于 1024 的放大到 1024，大于 maxEdge 的缩到 maxEdge。
 */
export function svgRasterSize(svg: string, maxEdge = 2048): { width: number; height: number } {
  const tag = /<svg\b[^>]*>/i.exec(svg)?.[0] ?? ''
  const attr = (n: string) => { const m = new RegExp(`\\s${n}\\s*=\\s*["']\\s*([\\d.]+)\\s*(px)?\\s*["']`, 'i').exec(tag); return m ? Number(m[1]) || 0 : 0 }
  const vb = /\sviewBox\s*=\s*["']\s*[-\d.]+[\s,]+[-\d.]+[\s,]+([\d.]+)[\s,]+([\d.]+)\s*["']/i.exec(tag)
  const vw = vb ? Number(vb[1]) : 0, vh = vb ? Number(vb[2]) : 0
  let w = attr('width'), h = attr('height')
  if (!w && !h) { w = vw || 300; h = vh || 150 } else if (!w) w = vw && vh ? (h * vw) / vh : h
  else if (!h) h = vw && vh ? (w * vh) / vw : w
  const long = Math.max(w, h)
  const k = Math.min(maxEdge, Math.max(1024, long)) / long
  return { width: Math.max(1, Math.round(w * k)), height: Math.max(1, Math.round(h * k)) }
}

// 已知支持视觉输入的模型（新建 / 换模型时「支持图片」的默认值；不准时用户自己开关）
const VISION_RE = /(vision|[-_.:]vl\b|[-_]vl[-_]|qvq|qwen[\d.]*-?vl|gpt-4o|gpt-4\.1|gpt-5|\bo[34]\b|claude|gemini|llava|minicpm-v|glm-4(\.\d)?v|pixtral|kimi-k2\.5|kimi-latest|moondream|internvl|step-1v|deepseek-flash)/i
export const multimodalDefault = (_provider: string, model: string): boolean => VISION_RE.test(model)

// ── 上下文标签（@ 引用终端 / 主机 / 历史会话、`!命令` 的终端块）────────────
// 发给模型时追加在用户原话之后、路径块之前，形如 <context type="terminal" name="本地 1">…</context>；回放时解析回标签
export type ContextKind = 'terminal' | 'host' | 'session' | 'shell'
export const CONTEXT_KINDS: ContextKind[] = ['terminal', 'host', 'session', 'shell']
export interface ContextAttachment { kind: 'context'; ctx: ContextKind; name: string; text: string }
export const CONTEXT_MAX_CHARS = 12000

const ctxName = (s: string) => s.replace(/["\r\n<>]/g, ' ').trim().slice(0, 120)
const ctxBody = (s: string) => s.replace(/<\/context>/g, '</ context>')
const CTX_TAIL = /\n*<context type="(terminal|host|session|shell)" name="([^"\n]*)">\n((?:(?!\n<\/context>)[\s\S])*)\n<\/context>\s*$/   // 正文不含 \n</context>（写入时已转义），只匹配最后一块

/** 在用户原话后追加上下文块（没有时原样返回） */
export function withContextBlocks(text: string, ctxs: ContextAttachment[]): string {
  if (!ctxs.length) return text
  const blocks = ctxs.map((c) => `<context type="${c.ctx}" name="${ctxName(c.name)}">\n${ctxBody(c.text.slice(0, CONTEXT_MAX_CHARS))}\n</context>`)
  return `${text.trim() ? `${text.trimEnd()}\n\n` : ''}${blocks.join('\n')}`
}

/** 反解：从文本末尾逐个剥出上下文块 */
export function splitContextBlocks(text: string): { text: string; ctxs: ContextAttachment[] } {
  const ctxs: ContextAttachment[] = []
  let rest = text
  for (let m = CTX_TAIL.exec(rest); m; m = CTX_TAIL.exec(rest)) {
    ctxs.unshift({ kind: 'context', ctx: m[1] as ContextKind, name: m[2], text: m[3] })
    rest = rest.slice(0, m.index)
  }
  return { text: ctxs.length ? rest.trimEnd() : text, ctxs }
}
