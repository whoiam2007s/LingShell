// 图片地址与自然尺寸：草稿 / 乐观显示自带 src；历史回放按存档 id 或文件路径向主进程取（同一张只取一次）。
// 放在 lib：对话附件列表和图片查看器（components/ImageViewer）都要用
import { svgRasterSize, type MsgAttachment } from '@lingshell/shared'
import { client } from '../client/index.js'

const svgText = (src: string) => { try { return atob(src.slice(src.indexOf(',') + 1)) } catch { return '' } }
const cache = new Map<string, Promise<string | null>>()
const cached = (k: string, f: () => Promise<string | null>) => {
  let p = cache.get(k)
  if (!p) { p = f().catch(() => null); cache.set(k, p) }
  return p
}
export const storedImage = (id: string) => cached(`id:${id}`, () => client.attachments.image(id))
export const imageSrc = (a: MsgAttachment): Promise<string | null> =>
  a.src ? Promise.resolve(a.src) : a.imageId ? storedImage(a.imageId) : a.path ? cached(`path:${a.path}`, () => client.attachments.imageFile(a.path!)) : Promise.resolve(null)

/** svg 没写 width / height 时 naturalWidth 可能是 0：按 viewBox 补 */
export function naturalSize(img: HTMLImageElement, src: string): { w: number; h: number } {
  if (img.naturalWidth && img.naturalHeight) return { w: img.naturalWidth, h: img.naturalHeight }
  const s = svgRasterSize(svgText(src), 1024)
  return { w: s.width, h: s.height }
}
