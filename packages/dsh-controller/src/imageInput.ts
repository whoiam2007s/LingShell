// 图片输入的纯逻辑：路径/存档引用 → 校验过的图片数据。不碰 IO 之外的东西，方便单测。
//
// 三种来源：
//   - 绝对路径（本机文件）
//   - 相对路径（按会话/终端的工作目录解析，由调用方传 cwd 进来）
//   - imageId（已经在附件库里的图片，直接按 id 取）
//
// 限制（超了给中文原因，不许静默截断）：
//   - 张数 1–8
//   - 单张 ≤ 5MB
//   - 合计 ≤ 20MB
//   - 只认 png / jpg / jpeg / webp / gif（gif 只取首帧，由图片解码侧处理）
import { isAbsolute, resolve, basename } from 'node:path'
import { tr } from '@lingshell/shared'

/** 支持的扩展名 → MIME。别名（jpg/jpeg）都收敛到 image/jpeg */
export const IMAGE_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
}

export const MAX_IMAGES = 8
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024
export const MAX_TOTAL_BYTES = 20 * 1024 * 1024

/** 一个待读取的图片引用 */
export type ImageRef =
  | { kind: 'path'; path: string }        // 已按 cwd 解析成绝对路径（或原样保留，由调用方判断是否远端）
  | { kind: 'imageId'; id: string }

/** 读出来的一张图（交给 saveImages 的形状 + 展示用名字） */
export interface LoadedImage {
  name: string
  bytes: Uint8Array
  mediaType: string
}

const extOf = (p: string): string => {
  const i = p.lastIndexOf('.')
  return i < 0 ? '' : p.slice(i + 1).toLowerCase()
}

/** 扩展名 → MIME；不认识的返回 undefined（调用方给「不支持的格式」错误） */
export const mimeOfPath = (p: string): string | undefined => IMAGE_MIME[extOf(p)]

/**
 * 把工具入参里的一条字符串解析成引用：
 *   - `img_...` / 32 位以上十六进制串 → imageId（附件库存的 id 就是内容哈希）
 *   - 其它 → 路径；相对路径按 cwd 拼绝对路径（cwd 为空则原样留下，由远端分支处理）
 */
export function parseRef(raw: string, cwd?: string): ImageRef {
  const s = raw.trim()
  if (!s) throw new Error(tr('图片路径为空'))
  if (/^img_[a-z0-9]+$/i.test(s) || /^[a-f0-9]{32,}$/i.test(s)) return { kind: 'imageId', id: s }
  if (isAbsolute(s)) return { kind: 'path', path: s }
  return { kind: 'path', path: cwd ? resolve(cwd, s) : s }
}

/**
 * 校验整批图片。任何一条不合格就整体失败 —— 半截成功比失败更难查。
 * @param images 已读出的字节
 */
export function validateBatch(images: LoadedImage[]): void {
  if (!images.length) throw new Error(tr('没有可读取的图片'))
  if (images.length > MAX_IMAGES) throw new Error(tr('一次最多读取 {n} 张图片，这次给了 {got} 张', { n: MAX_IMAGES, got: images.length }))
  let total = 0
  for (const img of images) {
    if (!img.mediaType.startsWith('image/')) throw new Error(tr('不支持的图片格式：{name}（支持 png / jpg / webp / gif）', { name: img.name }))
    if (img.bytes.byteLength > MAX_IMAGE_BYTES)
      throw new Error(tr('图片太大：{name} 约 {mb}MB，单张上限 {limit}MB', { name: img.name, mb: mb(img.bytes.byteLength), limit: MB(MAX_IMAGE_BYTES) }))
    total += img.bytes.byteLength
  }
  if (total > MAX_TOTAL_BYTES)
    throw new Error(tr('图片总量太大：合计约 {mb}MB，上限 {limit}MB', { mb: mb(total), limit: MB(MAX_TOTAL_BYTES) }))
}

const MB = (n: number): number => Math.round(n / 1024 / 1024)
const mb = (n: number): number => Math.max(1, Math.round(n / 1024 / 1024))

/** 路径 → 展示用名字（只取文件名，避免把整条远端路径写进模型上下文） */
export const nameOfPath = (p: string): string => basename(p.replace(/\\/g, '/')) || p

/** 文件头嗅探：扩展名可以骗人，这里再看一眼魔数（认不出就按扩展名走） */
export function sniffMime(bytes: Uint8Array, fallback: string): string {
  const b = bytes
  const at = (i: number) => b[i] ?? 0
  if (at(0) === 0x89 && at(1) === 0x50 && at(2) === 0x4e && at(3) === 0x47) return 'image/png'
  if (at(0) === 0xff && at(1) === 0xd8) return 'image/jpeg'
  if (at(0) === 0x47 && at(1) === 0x49 && at(2) === 0x46) return 'image/gif'
  if (at(0) === 0x52 && at(1) === 0x49 && at(2) === 0x46 && at(3) === 0x46 && at(8) === 0x57 && at(9) === 0x45) return 'image/webp'
  return fallback
}
