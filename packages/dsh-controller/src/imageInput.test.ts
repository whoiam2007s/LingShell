import { describe, it, expect } from 'vitest'
import {
  MAX_IMAGES, MAX_IMAGE_BYTES, MAX_TOTAL_BYTES,
  mimeOfPath, nameOfPath, parseRef, sniffMime, validateBatch, type LoadedImage,
} from './imageInput.js'

const img = (name: string, bytes: number, mediaType = 'image/png'): LoadedImage =>
  ({ name, bytes: new Uint8Array(bytes), mediaType })

describe('图片输入解析', () => {
  it('绝对路径原样保留', () => {
    const r = parseRef(process.platform === 'win32' ? 'C:/pics/a.png' : '/pics/a.png')
    expect(r).toEqual({ kind: 'path', path: process.platform === 'win32' ? 'C:/pics/a.png' : '/pics/a.png' })
  })

  it('相对路径按给定 cwd 拼成绝对路径；没有 cwd 就原样留着（交给远端分支）', () => {
    const cwd = process.platform === 'win32' ? 'D:/work' : '/work'
    const r = parseRef('shot.png', cwd) as { kind: 'path'; path: string }
    expect(r.kind).toBe('path')
    expect(r.path.endsWith('shot.png')).toBe(true)
    expect(r.path.startsWith(cwd.slice(0, 3)) || r.path.includes('work')).toBe(true)
    expect(parseRef('shot.png')).toEqual({ kind: 'path', path: 'shot.png' })
  })

  it('图片存档 id 认得出（img_ 前缀与十六进制哈希两种）', () => {
    expect(parseRef('img_abc123')).toEqual({ kind: 'imageId', id: 'img_abc123' })
    const hash = 'a'.repeat(64)
    expect(parseRef(hash)).toEqual({ kind: 'imageId', id: hash })
  })

  it('空字符串给中文原因', () => {
    expect(() => parseRef('   ')).toThrow(/图片路径为空/)
  })

  it('扩展名映射：jpg 与 jpeg 都是 image/jpeg，未知返回 undefined', () => {
    expect(mimeOfPath('a.PNG')).toBe('image/png')
    expect(mimeOfPath('a.jpeg')).toBe('image/jpeg')
    expect(mimeOfPath('a.jpg')).toBe('image/jpeg')
    expect(mimeOfPath('a.webp')).toBe('image/webp')
    expect(mimeOfPath('a.bmp')).toBeUndefined()
    expect(mimeOfPath('noext')).toBeUndefined()
  })

  it('展示名只取文件名（不把远端整条路径塞进上下文）', () => {
    expect(nameOfPath('/var/log/shot.png')).toBe('shot.png')
    expect(nameOfPath('C:\\tmp\\shot.png')).toBe('shot.png')
  })
})

describe('批量校验', () => {
  it('正常两通过', () => {
    expect(() => validateBatch([img('a.png', 100), img('b.jpg', 200, 'image/jpeg')])).not.toThrow()
  })

  it('空列表给原因', () => {
    expect(() => validateBatch([])).toThrow(/没有可读取的图片/)
  })

  it('超过张数上限', () => {
    const many = Array.from({ length: MAX_IMAGES + 1 }, (_, i) => img(`p${i}.png`, 10))
    expect(() => validateBatch(many)).toThrow(new RegExp(`一次最多读取 ${MAX_IMAGES} 张`))
  })

  it('单张超限', () => {
    expect(() => validateBatch([img('big.png', MAX_IMAGE_BYTES + 1)])).toThrow(/单张上限/)
  })

  it('总量超限', () => {
    const each = Math.floor(MAX_IMAGE_BYTES * 0.9)   // 每张没超单图上限，但 5 张合计超总量
    expect(() => validateBatch(Array.from({ length: 5 }, (_, i) => img(`p${i}.png`, each)))).toThrow(/图片总量太大/)
    expect(each * 5).toBeGreaterThan(MAX_TOTAL_BYTES)
  })

  it('不是图片的 MIME 直接拒（不让文本文件混进来）', () => {
    expect(() => validateBatch([img('a.txt', 10, 'text/plain')])).toThrow(/不支持的图片格式/)
  })
})

describe('文件头嗅探', () => {
  it('能认出 png / jpeg / gif / webp，认不出时回退到扩展名给的 MIME', () => {
    expect(sniffMime(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), 'image/gif')).toBe('image/png')
    expect(sniffMime(new Uint8Array([0xff, 0xd8, 0x00]), 'image/png')).toBe('image/jpeg')
    expect(sniffMime(new Uint8Array([0x47, 0x49, 0x46, 0x38]), 'image/png')).toBe('image/gif')
    const webp = new Uint8Array(12); webp.set([0x52, 0x49, 0x46, 0x46]); webp.set([0x57, 0x45, 0x42, 0x50], 8)
    expect(sniffMime(webp, 'image/png')).toBe('image/webp')
    expect(sniffMime(new Uint8Array([1, 2, 3]), 'image/webp')).toBe('image/webp')
  })
})
