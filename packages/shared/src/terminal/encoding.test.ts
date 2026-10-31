import { describe, it, expect } from 'vitest'
import { createDecoder, decodeText, encodeText, isLegacyEncoding } from './encoding.js'

const GBK_NIHAO = [0xc4, 0xe3, 0xba, 0xc3]   // 你好

describe('createDecoder 流式解码', () => {
  it('GBK 双字节被切在两个 chunk 之间也能拼对', () => {
    const dec = createDecoder('gbk')
    const bytes = [0x61, ...GBK_NIHAO, 0x0a]
    let out = ''
    for (const b of bytes) out += dec(new Uint8Array([b]))   // 逐字节喂
    expect(out).toBe('a你好\n')
  })
  it('UTF-8 三字节切开也不乱码', () => {
    const dec = createDecoder('utf8')
    const u = new TextEncoder().encode('中文')
    expect(dec(u.subarray(0, 2)) + dec(u.subarray(2, 4)) + dec(u.subarray(4))).toBe('中文')
  })
  it('未设编码按 UTF-8；big5 / gb18030 可解', () => {
    expect(decodeText(new TextEncoder().encode('你好'))).toBe('你好')
    expect(decodeText(new Uint8Array([0xa7, 0x41]), 'big5')).toBe('你')
    expect(decodeText(new Uint8Array(GBK_NIHAO), 'gb18030')).toBe('你好')
  })
})

describe('encodeText', () => {
  it('GBK 往返；ASCII 原样；表外字符变 ?', () => {
    expect([...encodeText('你好', 'gbk')]).toEqual(GBK_NIHAO)
    expect([...encodeText('ls -l\r', 'gbk')]).toEqual([...new TextEncoder().encode('ls -l\r')])
    const s = 'echo 中文测试，€ ok'
    expect(decodeText(encodeText(s, 'gbk'), 'gbk')).toBe(s)
    expect(decodeText(encodeText('a😀b', 'gbk'), 'gbk')).toBe('a?b')
  })
  it('Big5 往返繁体；简体专有字变 ?', () => {
    expect(decodeText(encodeText('繁體中文', 'big5'), 'big5')).toBe('繁體中文')
    expect(decodeText(encodeText('简', 'big5'), 'big5')).toBe('?')
  })
  it('UTF-8 走 TextEncoder', () => {
    expect([...encodeText('中', 'utf8')]).toEqual([0xe4, 0xb8, 0xad])
    expect(isLegacyEncoding('utf8')).toBe(false)
    expect(isLegacyEncoding(undefined)).toBe(false)
    expect(isLegacyEncoding('gbk')).toBe(true)
  })
})
