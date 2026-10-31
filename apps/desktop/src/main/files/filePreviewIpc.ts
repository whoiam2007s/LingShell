import { mkdir, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { decodeText, previewKind, previewMaxBytes, tr, type FsScope, type PreviewData } from '@lingshell/shared'
import { isFsError, type FileAccess } from './fileOps.js'

// 资源管理器预览（见 shared/files/filePreview.ts）：远程走该终端的 SFTP 会话，本地直接读；上限按类型（Markdown 2MB / CSV 5MB / 图片、PDF 20MB）。
// 「用系统程序打开」：远程先下到临时目录再交给系统（PDF 应用内显示不了时的降级）；本地直接打开。
// 临时下载要先整个读进主进程内存，上限只给 30MB（更大的文件请走「下载」：流式、有进度、可暂停）
export const PREVIEW_EXTERNAL_MAX_BYTES = 30 * 1024 * 1024

export interface FilePreviewDeps {
  handle(channel: string, fn: (e: unknown, ...args: unknown[]) => unknown): void
  access(scope: FsScope): Promise<FileAccess>
  tempDir: string
  openPath(p: string): Promise<string>   // 返回错误文本（空 = 成功），同 shell.openPath
  /** 测试用；默认 100MB */
  externalMaxBytes?: number
}

const nameOf = (p: string) => p.split(/[\\/]/).pop() || 'file'
// 按错误码判断（fileOps.tooBig 抛的 FsError），不按文案：文案随界面语言变
const tooBig = (e: unknown) => isFsError(e, 'too_big')

export function registerFilePreview(d: FilePreviewDeps): void {
  const read = async (scope: unknown, path: unknown, max: number, how: 'preview' | 'open' = 'preview') => {
    if (typeof path !== 'string' || !path) throw new Error(tr('非法的路径'))
    const fa = await d.access(scope as FsScope)
    let buf: Buffer | undefined
    try { buf = await fa.read(path, max) } catch (e) {
      if (tooBig(e)) throw new Error(how === 'open' ? tr('文件超过 {n}MB，请用「下载」保存到本地后再打开', { n: Math.round(max / 1024 / 1024) }) : tr('文件超过 {n}MB，不在应用内预览，请下载后查看', { n: Math.round(max / 1024 / 1024) }))
      throw e
    }
    if (buf === undefined) throw new Error(tr('文件不存在：{path}', { path }))
    return { fa, buf }
  }
  d.handle('preview:read', async (_e, scope, path): Promise<PreviewData> => {
    const kind = typeof path === 'string' ? previewKind(path) : undefined
    if (!kind) throw new Error(tr('这种文件不支持预览'))
    const { fa, buf } = await read(scope, path, previewMaxBytes(kind))
    const base = { kind, name: nameOf(path as string), size: buf.length }
    return kind === 'image' || kind === 'pdf' ? { ...base, base64: buf.toString('base64') } : { ...base, text: decodeText(buf, fa.encoding) }
  })
  d.handle('preview:openExternal', async (_e, scope, path) => {
    // 本地也先走 access 解析（展开 ~、转本地路径），避免把渲染层给的原始字符串直接交给系统
    if (scope === 'local' && typeof path === 'string') {
      const fa = await d.access(scope as FsScope)
      const err = await d.openPath(await fa.resolve(path))
      if (err) throw new Error(err)
      return
    }
    const { buf } = await read(scope, path, d.externalMaxBytes ?? PREVIEW_EXTERNAL_MAX_BYTES, 'open')
    await mkdir(d.tempDir, { recursive: true, mode: 0o700 })
    const name = nameOf(path as string).replace(/[<>:"|?*\\/]/g, '_')
    const local = join(d.tempDir, `${Date.now()}-${randomUUID().slice(0, 8)}-${name}`)
    await writeFile(local, buf, { mode: 0o600 })
    const err = await d.openPath(local)
    if (err) {
      await unlink(local).catch(() => {})
      throw new Error(err)
    }
  })
}
