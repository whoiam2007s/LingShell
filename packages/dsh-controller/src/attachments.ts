/* eslint-disable @typescript-eslint/no-explicit-any */
// 图片附件的本地存档：dsh 的 ctx.attachments 服务（AttachmentStore）的最小实现。
//
// dsh 0.2 的图片走「持久引用」：用户消息里只存 ImageBlock{attachment: 引用}，适配器发请求时再经 ctx.attachments
// 读字节（OpenAI 兼容 → image_url data URL；Anthropic Messages → image source base64 / Files API）。
// 官方实现 dsh-attachment-local 没进依赖（要原生图像库做归一化），这里自己实现：
//  - 按内容 sha256 存到 <数据目录>/attachments/<sha>.<ext>，不可变、多会话共享，删会话不删（同官方的保留策略）；
//  - 不做像素级归一化：渲染层发来前已缩放（长边 ≤ 2048）、重新编码成 PNG / JPEG，这里只校验格式与尺寸；
//  - readImageRequest 不按路由目标再缩放，原样返回存档字节（体积已在渲染层压到适合请求的大小）。
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises'
import { join } from 'node:path'
import { AttachmentStore, AttachmentError } from '@deepseek-ai/dsh-attachment'
import { IMAGE_MAX_SOURCE_BYTES, IMAGE_MAX_PER_MESSAGE, tr, type ImageMediaType } from '@lingshell/shared'

const EXT: Record<ImageMediaType, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' }
const ID_RE = /^[a-f0-9]{64}$/

/** 从文件头认出图片格式与尺寸（PNG / JPEG / GIF / WebP），认不出返回 undefined */
export function imageInfo(b: Uint8Array): { mediaType: ImageMediaType; width: number; height: number } | undefined {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength)
  const ascii = (at: number, n: number) => String.fromCharCode(...b.subarray(at, at + n))
  if (b.length >= 24 && v.getUint32(0) === 0x89504e47) return { mediaType: 'image/png', width: v.getUint32(16), height: v.getUint32(20) }
  if (b.length >= 10 && ascii(0, 4) === 'GIF8') return { mediaType: 'image/gif', width: v.getUint16(6, true), height: v.getUint16(8, true) }
  if (b.length >= 30 && ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP') {
    const kind = ascii(12, 4)
    if (kind === 'VP8 ') return { mediaType: 'image/webp', width: v.getUint16(26, true) & 0x3fff, height: v.getUint16(28, true) & 0x3fff }
    if (kind === 'VP8L') { const x = v.getUint32(21, true); return { mediaType: 'image/webp', width: (x & 0x3fff) + 1, height: ((x >> 14) & 0x3fff) + 1 } }
    if (kind === 'VP8X') return { mediaType: 'image/webp', width: 1 + (b[24] | (b[25] << 8) | (b[26] << 16)), height: 1 + (b[27] | (b[28] << 8) | (b[29] << 16)) }
    return undefined
  }
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
    // 逐段找 SOFn（C0–CF，除 C4 DHT / C8 / CC DAC）
    let i = 2
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) { i++; continue }
      const m = b[i + 1]
      if (m === 0xff) { i++; continue }
      if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { i += 2; continue }
      const len = v.getUint16(i + 2)
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { mediaType: 'image/jpeg', width: v.getUint16(i + 7), height: v.getUint16(i + 5) }
      i += 2 + len
    }
  }
  return undefined
}

export class LocalImageStore extends AttachmentStore {
  readonly imageLimits = {
    maxImageBytes: IMAGE_MAX_SOURCE_BYTES,
    maxImagesPerMessage: IMAGE_MAX_PER_MESSAGE,
    maxMessageImageBytes: IMAGE_MAX_SOURCE_BYTES * IMAGE_MAX_PER_MESSAGE,
    maxImagePixels: 40_000_000,
    maxImageDimension: 12_000,
    mediaTypes: Object.keys(EXT) as ImageMediaType[],
  }
  private root: string
  constructor(ctx: any, config: { root: string }) {
    super(ctx)
    this.root = config.root
  }

  async validateImage(input: { data: Uint8Array; mediaType: ImageMediaType }): Promise<void> { this.check(input) }

  private check(input: { data: Uint8Array; mediaType: ImageMediaType }) {
    const info = imageInfo(input.data)
    const L = this.imageLimits
    if (!info) throw new AttachmentError(tr('无法识别的图片格式'), 'INVALID_IMAGE')
    if (info.mediaType !== input.mediaType) throw new AttachmentError(tr('图片实际格式是 {actual}，与声明的 {declared} 不符', { actual: info.mediaType, declared: input.mediaType }), 'IMAGE_TYPE_MISMATCH')
    if (input.data.byteLength > L.maxImageBytes) throw new AttachmentError(tr('图片超过单张大小上限'), 'IMAGE_TOO_LARGE')
    if (!info.width || !info.height || info.width > L.maxImageDimension || info.height > L.maxImageDimension) throw new AttachmentError(tr('图片尺寸超出上限'), 'IMAGE_DIMENSION_TOO_LARGE')
    if (info.width * info.height > L.maxImagePixels) throw new AttachmentError(tr('图片像素超出上限'), 'IMAGE_TOO_MANY_PIXELS')
    return info
  }

  pathOf(id: string, mediaType: ImageMediaType): string { return join(this.root, `${id}.${EXT[mediaType]}`) }

  async saveImage(input: { data: Uint8Array; mediaType: ImageMediaType; name?: string }): Promise<any> {
    const info = this.check(input)
    const id = createHash('sha256').update(input.data).digest('hex')
    const file = this.pathOf(id, info.mediaType)
    if (!existsSync(file)) {
      await mkdir(this.root, { recursive: true })
      const tmp = `${file}.${process.pid}.tmp`
      await writeFile(tmp, input.data)
      await rename(tmp, file)
    }
    return { attachmentId: id, mediaType: info.mediaType, bytes: input.data.byteLength, width: info.width, height: info.height, ...(input.name ? { name: input.name.replace(/^.*[\\/]/, '').slice(0, 120) } : {}) }
  }

  async readImage(ref: any, signal?: AbortSignal): Promise<any> {
    signal?.throwIfAborted()
    if (!ID_RE.test(String(ref?.attachmentId)) || !EXT[ref?.mediaType as ImageMediaType]) throw new AttachmentError(tr('非法的图片引用'), 'INVALID_ATTACHMENT_REF')
    let data: Buffer
    try { data = await readFile(this.pathOf(ref.attachmentId, ref.mediaType)) }
    catch { throw new AttachmentError(tr('图片存档不见了'), 'ATTACHMENT_NOT_FOUND') }
    if (createHash('sha256').update(data).digest('hex') !== ref.attachmentId) throw new AttachmentError(tr('图片存档已损坏'), 'ATTACHMENT_CORRUPT')
    return { ref, data: new Uint8Array(data) }
  }

  imageHostPath(ref: any): string | undefined {
    return ID_RE.test(String(ref?.attachmentId)) && EXT[ref?.mediaType as ImageMediaType] ? this.pathOf(ref.attachmentId, ref.mediaType) : undefined
  }

  async readImageRequest(ref: any, _target: unknown, signal?: AbortSignal): Promise<any> {
    const { data } = await this.readImage(ref, signal)
    return {
      variantId: `${ref.attachmentId}:orig`, attachment: ref, data, mediaType: ref.mediaType, bytes: data.byteLength,
      width: ref.width, height: ref.height, depth: 'uchar', space: 'srgb', hasAlpha: ref.mediaType !== 'image/jpeg',
    }
  }
}

/** 按存档 id 读图片（界面回放缩略图 / 大图用）：返回 data URL，找不到为 null */
export async function readStoredImage(root: string, id: string): Promise<string | null> {
  if (!ID_RE.test(id)) return null
  for (const [mt, ext] of Object.entries(EXT)) {
    const file = join(root, `${id}.${ext}`)
    if (existsSync(file)) return `data:${mt};base64,${(await readFile(file)).toString('base64')}`
  }
  return null
}
