import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseAttachments, registerAttachments, parseFileNameW } from './attachIpc.js'

describe('parseAttachments', () => {
  const abs = process.platform === 'win32' ? 'C:\\x\\a.log' : '/x/a.log'
  it('合法的原样收下；缺省为空', () => {
    expect(parseAttachments(undefined)).toEqual([])
    expect(parseAttachments([{ kind: 'file', path: abs }, { kind: 'image', name: 'a.png', mediaType: 'image/png', data: 'AAAA', extra: 1 }]))
      .toEqual([{ kind: 'file', path: abs }, { kind: 'image', name: 'a.png', mediaType: 'image/png', data: 'AAAA' }])
  })
  it('相对路径 / 不支持的格式 / 超过张数一律拒', () => {
    expect(() => parseAttachments([{ kind: 'file', path: 'a.log' }])).toThrow()
    expect(() => parseAttachments([{ kind: 'image', mediaType: 'image/svg+xml', data: 'AA' }])).toThrow()
    expect(() => parseAttachments(Array.from({ length: 9 }, () => ({ kind: 'image', mediaType: 'image/png', data: 'AA' })))).toThrow(/最多 8 张/)
  })
  it('上下文标签：认可的类型收下并限长，其它拒', () => {
    expect(parseAttachments([{ kind: 'context', ctx: 'shell', name: 'ls', text: 'x'.repeat(20000), extra: 1 }]))
      .toEqual([{ kind: 'context', ctx: 'shell', name: 'ls', text: 'x'.repeat(12000) }])
    expect(() => parseAttachments([{ kind: 'context', ctx: 'evil', name: 'a', text: 'b' }])).toThrow()
    expect(() => parseAttachments([{ kind: 'context', ctx: 'host', name: 'a' }])).toThrow()
    expect(() => parseAttachments(Array.from({ length: 21 }, () => ({ kind: 'context', ctx: 'host', name: 'a', text: 'b' })))).toThrow(/最多 20 个上下文/)
  })
})

describe('registerAttachments', () => {
  it('kinds 区分文件 / 目录 / 不存在；open 不存在时返回原因、存在时交给系统打开', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'att-'))
    mkdirSync(join(dir, 'sub')); writeFileSync(join(dir, 'f.txt'), 'x')
    const h = new Map<string, (e: unknown, ...a: unknown[]) => unknown>()
    const opened: string[] = []
    registerAttachments({ handle: (c, f) => h.set(c, f), pick: async () => [], send: async () => {}, readImage: async () => null, openPath: async (p) => { opened.push(p); return '' } })
    expect(await h.get('attach:kinds')!(null, [join(dir, 'f.txt'), join(dir, 'sub'), join(dir, 'none'), 'rel'])).toEqual(['file', 'dir', null, null])
    expect(await h.get('attach:open')!(null, join(dir, 'none'))).toMatch(/已不存在/)
    expect(await h.get('attach:open')!(null, join(dir, 'f.txt'))).toBeNull()
    expect(opened).toEqual([join(dir, 'f.txt')])
    rmSync(dir, { recursive: true, force: true })
  })

  it('图片文件：kinds 认出（扩展名 + 文件头），imageFile 给 data URL（svg 为 image/svg+xml），冒名的不算', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'att-'))
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')
    writeFileSync(join(dir, 'a.png'), png); writeFileSync(join(dir, 'noext'), png)
    writeFileSync(join(dir, 'b.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>')
    writeFileSync(join(dir, 'fake.png'), 'not a png')
    const h = new Map<string, (e: unknown, ...a: unknown[]) => unknown>()
    registerAttachments({ handle: (c, f) => h.set(c, f), pick: async () => [], send: async () => {}, readImage: async () => null, openPath: async () => '', clipboardFiles: () => ['C:\\a.txt', 'rel'] })
    const ps = ['a.png', 'noext', 'b.svg', 'fake.png'].map((n) => join(dir, n))
    expect(await h.get('attach:kinds')!(null, ps)).toEqual(['image', 'image', 'image', 'file'])
    expect(await h.get('attach:imageFile')!(null, ps[0])).toBe(`data:image/png;base64,${png.toString('base64')}`)
    expect(String(await h.get('attach:imageFile')!(null, ps[2]))).toMatch(/^data:image\/svg\+xml;base64,/)
    expect(await h.get('attach:imageFile')!(null, ps[3])).toBeNull()
    expect(await h.get('attach:imageFile')!(null, 'rel.png')).toBeNull()
    if (process.platform === 'win32') expect(await h.get('attach:clipboardPaths')!(null)).toEqual(['C:\\a.txt'])
    rmSync(dir, { recursive: true, force: true })
  })
})

describe('parseFileNameW', () => {
  it('UTF-16 路径去掉结尾 NUL；空的返回 []', () => {
    expect(parseFileNameW(Buffer.from('C:\\x\\中文.txt\0', 'utf16le'))).toEqual(['C:\\x\\中文.txt'])
    expect(parseFileNameW(Buffer.alloc(0))).toEqual([])
  })
})
