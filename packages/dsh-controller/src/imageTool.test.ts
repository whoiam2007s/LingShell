import { describe, it, expect, vi } from 'vitest'
import { imageToolDef, normalizePaths, DEFAULT_QUESTION, type ImageToolDeps } from './imageTool.js'
import type { LoadedImage } from './imageInput.js'

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a])

function makeDeps(over: Partial<ImageToolDeps> = {}): ImageToolDeps & { seen: LoadedImage[] } {
  const seen: LoadedImage[] = []
  const deps: ImageToolDeps = {
    sessionIdOf: () => 's1',
    supportsImages: () => true,
    readLocalFile: async () => PNG,
    readImageId: async () => ({ bytes: PNG, mediaType: 'image/png' }),
    chatWithImages: async (_s, _q, imgs) => { seen.push(...imgs); return '图里是一张报错弹窗' },
    ...over,
  }
  return Object.assign(deps, { seen })
}

const exec = {} as never
const run = (deps: ImageToolDeps, args: Record<string, unknown>) =>
  (imageToolDef(deps) as any).execute(args, exec)

describe('read_image 工具', () => {
  it('paths 支持数组、也支持逗号/换行分隔的字符串', () => {
    expect(normalizePaths([' a.png ', 'b.png'])).toEqual(['a.png', 'b.png'])
    expect(normalizePaths('a.png, b.png\nc.png')).toEqual(['a.png', 'b.png', 'c.png'])
    expect(normalizePaths('')).toEqual([])
  })

  it('多张图片一次送进同一次识别，返回模型文本', async () => {
    const deps = makeDeps()
    const out = await run(deps, { paths: ['a.png', 'b.png'] })
    expect(out).toBe('图里是一张报错弹窗')
    expect(deps.seen.map((i) => i.name)).toEqual(['a.png', 'b.png'])
    expect(deps.seen[0].mediaType).toBe('image/png')   // 用文件头嗅探
  })

  it('没给 question 时用默认问题（描述内容/抄报错原文）', async () => {
    const chat = vi.fn(async (_s: string, _q: string) => 'ok')
    await run(makeDeps({ chatWithImages: chat }), { paths: ['a.png'] })
    expect(chat.mock.calls[0][1]).toBe(DEFAULT_QUESTION)
  })

  it('模型不支持图片时直接拒绝，不去读文件', async () => {
    const readLocalFile = vi.fn()
    await expect(run(makeDeps({ supportsImages: () => false, readLocalFile }), { paths: ['a.png'] }))
      .rejects.toThrow(/当前模型不支持图片/)
    expect(readLocalFile).not.toHaveBeenCalled()
  })

  it('不支持的扩展名给中文原因', async () => {
    await expect(run(makeDeps(), { paths: ['a.bmp'] })).rejects.toThrow(/不支持的图片格式/)
  })

  it('超过 8 张直接拒', async () => {
    const paths = Array.from({ length: 9 }, (_, i) => `p${i}.png`)
    await expect(run(makeDeps(), { paths })).rejects.toThrow(/一次最多读取 8 张/)
  })

  it('一个都不给时给原因', async () => {
    await expect(run(makeDeps(), { paths: [] })).rejects.toThrow(/没有给图片路径/)
  })

  it('图片存档 id 走附件库，不走文件系统', async () => {
    const readLocalFile = vi.fn()
    const deps = makeDeps({ readLocalFile })
    await run(deps, { paths: ['img_abc123'] })
    expect(readLocalFile).not.toHaveBeenCalled()
    expect(deps.seen[0].name).toBe('img_abc123')
  })

  it('存档不存在时说明是存档问题', async () => {
    await expect(run(makeDeps({ readImageId: async () => undefined }), { paths: ['img_gone'] }))
      .rejects.toThrow(/图片存档不存在或已损坏/)
  })

  it('成功时写一条审计（读权限）', async () => {
    const audit = vi.fn()
    await run(makeDeps({ audit }), { paths: ['a.png'], terminal_id: 'term_1' })
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ decision: 'read_allowed', terminalId: 'term_1' }))
  })
})
