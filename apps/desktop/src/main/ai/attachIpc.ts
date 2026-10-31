// AI 对话附件的 IPC（输入框「+」菜单的选择文件 / 目录 / 图片、带附件发送、历史回放取图、打开附件）。
// 渲染层参数一律当不可信：路径必须是绝对路径，图片限格式与大小，发送前逐项校验。
import { readFile, stat, open } from 'node:fs/promises'
import { isAbsolute, basename } from 'node:path'
import { IMAGE_FILE_EXTS, IMAGE_MAX_PER_MESSAGE, IMAGE_MAX_SOURCE_BYTES, imageTypeOf, tr, type ImageMediaType, type TurnAttachment } from '@lingshell/shared'
import { CONTEXT_KINDS, CONTEXT_MAX_CHARS, type ContextKind } from '@lingshell/shared'

export interface AttachIpcDeps {
  handle(channel: string, fn: (e: unknown, ...args: unknown[]) => unknown): void
  // 系统选择框：返回选中的绝对路径（取消 = []）
  pick(kind: 'files' | 'dirs' | 'images'): Promise<string[]>
  send(sessionId: string, prompt: string, attachments: TurnAttachment[]): Promise<void>
  readImage(id: string): Promise<string | null>
  openPath(p: string): Promise<string>   // electron shell.openPath：成功返回 ''，失败返回原因
  clipboardFiles?(): string[]            // 系统剪贴板里复制的文件路径（粘贴兜底）
}

const MEDIA = new Set<string>(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])
const MAX_PATHS = 50
const MAX_CONTEXTS = 20

/** 校验并规整渲染层传来的附件表（非法的直接报错，不悄悄丢） */
export function parseAttachments(v: unknown): TurnAttachment[] {
  if (v === undefined || v === null) return []
  if (!Array.isArray(v)) throw new Error(tr('非法的附件列表'))
  const out: TurnAttachment[] = []
  for (const a of v as Record<string, unknown>[]) {
    if ((a?.kind === 'file' || a?.kind === 'dir') && typeof a.path === 'string' && isAbsolute(a.path)) out.push({ kind: a.kind, path: a.path })
    else if (a?.kind === 'image' && typeof a.data === 'string' && MEDIA.has(String(a.mediaType))) {
      if (a.data.length > Math.ceil(IMAGE_MAX_SOURCE_BYTES / 3) * 4) throw new Error(tr('图片超过 10MB'))
      out.push({ kind: 'image', name: String(a.name ?? tr('图片')).slice(0, 120), mediaType: a.mediaType as ImageMediaType, data: a.data })
    } else if (a?.kind === 'context' && CONTEXT_KINDS.includes(a.ctx as ContextKind) && typeof a.text === 'string') {
      // @ 引用 / 终端块：只是一段文字，限长
      out.push({ kind: 'context', ctx: a.ctx as ContextKind, name: String(a.name ?? '').slice(0, 120), text: a.text.slice(0, CONTEXT_MAX_CHARS) })
    } else throw new Error(tr('非法的附件'))
  }
  if (out.filter((a) => a.kind === 'image').length > IMAGE_MAX_PER_MESSAGE) throw new Error(tr('每条消息最多 {n} 张图片', { n: IMAGE_MAX_PER_MESSAGE }))
  if (out.filter((a) => a.kind === 'file' || a.kind === 'dir').length > MAX_PATHS) throw new Error(tr('每条消息最多附 {n} 个文件 / 目录', { n: MAX_PATHS }))
  if (out.filter((a) => a.kind === 'context').length > MAX_CONTEXTS) throw new Error(tr('每条消息最多 {n} 个上下文标签', { n: MAX_CONTEXTS }))
  return out
}

// what：已翻译的参数名
const str = (v: unknown, what: string): string => { if (typeof v !== 'string' || !v) throw new Error(tr('非法的{what}', { what })); return v }

export function registerAttachments(d: AttachIpcDeps): void {
  d.handle('attach:pickFiles', () => d.pick('files'))
  d.handle('attach:pickDirs', () => d.pick('dirs'))
  // 只返回路径：之后和「选择文件」选中的图片一样走 kinds → imageFile（统一成图片 tag）
  d.handle('attach:pickImages', async () => (await d.pick('images')).slice(0, IMAGE_MAX_PER_MESSAGE))
  // 路径是文件 / 目录 / 图片文件（扩展名 + 文件头，见 imageTypeOf；不存在 = null）
  d.handle('attach:kinds', async (_e, ps) => {
    if (!Array.isArray(ps)) throw new Error(tr('非法的路径列表'))
    return Promise.all(ps.slice(0, MAX_PATHS).map(async (p) => {
      if (typeof p !== 'string' || !isAbsolute(p)) return null
      try {
        const s = await stat(p)
        if (s.isDirectory()) return 'dir'
        return s.size <= IMAGE_MAX_SOURCE_BYTES && (await readImageType(p)) ? 'image' : 'file'
      } catch { return null }
    }))
  })
  // 图片文件 → data URL（缩略图 / 大图 / 渲染层光栅化后发送）。只认文件头对得上的图片；svg 按 image/svg+xml 给，
  // 渲染层只放进 <img>（不执行脚本、不加载外部资源）。不是图片 / 超限 / 不存在 → null
  d.handle('attach:imageFile', async (_e, p) => {
    const path = str(p, tr('arg|路径'))
    if (!isAbsolute(path)) return null
    try {
      if ((await stat(path)).size > IMAGE_MAX_SOURCE_BYTES) return null
      const buf = await readFile(path)
      const type = imageTypeOf(basename(path), buf.subarray(0, 2048))
      return type ? `data:${type};base64,${buf.toString('base64')}` : null
    } catch { return null }
  })
  // 粘贴文件的兜底：渲染层 paste 事件拿不到路径时，从系统剪贴板读（见 ipc.ts 的 clipboardFiles）
  d.handle('attach:clipboardPaths', () => (d.clipboardFiles?.() ?? []).filter((p) => isAbsolute(p)).slice(0, MAX_PATHS))
  d.handle('attach:send', (_e, sid, prompt, atts) => d.send(str(sid, tr('arg|会话')), typeof prompt === 'string' ? prompt : '', parseAttachments(atts)))
  d.handle('attach:image', (_e, id) => d.readImage(str(id, tr('arg|图片 id'))))
  // 文件用系统默认程序打开、目录在资源管理器打开；路径已不存在时返回原因（界面提示），不抛错
  d.handle('attach:open', async (_e, p) => {
    const path = str(p, tr('arg|路径'))
    if (!isAbsolute(path)) return tr('非法的路径')
    try { await stat(path) } catch { return tr('已不存在：{path}', { path }) }
    return (await d.openPath(path)) || null
  })
}

// name 用 getter：模块加载时还没读语言设置，用到时再翻译
export const IMAGE_FILTER = { get name() { return tr('图片') }, extensions: IMAGE_FILE_EXTS }

// 读文件头判断图片类型（只读前 2KB）
async function readImageType(p: string) {
  const fh = await open(p, 'r')
  try {
    const b = Buffer.alloc(2048)
    const { bytesRead } = await fh.read(b, 0, b.length, 0)
    return imageTypeOf(basename(p), b.subarray(0, bytesRead))
  } finally { await fh.close() }
}

/**
 * Windows 剪贴板里复制的文件：Electron 读不到标准 CF_HDROP（readBuffer 只认注册格式），
 * 退而读资源管理器同时放的 FileNameW（UTF-16，只有第一个路径）。正常路径走渲染层 paste 事件的 files（文件和目录都有）。
 */
export function parseFileNameW(buf: Buffer): string[] {
  const s = buf.toString('utf16le').replace(/\0[\s\S]*$/, '')
  return s ? [s] : []
}
