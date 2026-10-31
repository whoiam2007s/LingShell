import { describe, expect, it } from 'vitest'
import { MASKS, dataCodewords, functionPatterns, qrMatrix, zigzag } from './qr.js'

// 测试用的解码器：从矩阵读格式信息（BCH 校验、两份一致）→ 去掩码 → 读码字 → 拆块 → 校验 RS 伴随式全为 0 → 解析字节模式。
// RS 校验和格式校验是独立于编码实现的数学检查
const BLOCKS = [0, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5], ECC = [0, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26]
const gfMul = (x: number, y: number) => { let z = 0; for (let i = 7; i >= 0; i--) { z = (z << 1) ^ ((z >>> 7) * 0x11d); z ^= ((y >>> i) & 1) * x } return z & 0xff }
const gfPow = (e: number) => { let r = 1; for (let i = 0; i < e; i++) r = gfMul(r, 2); return r }

function decode(q: boolean[][]): { text: string; mask: number; version: number } {
  const size = q.length, v = (size - 17) / 4
  const b = (x: number, y: number) => (q[y][x] ? 1 : 0)
  let f1 = 0
  for (let i = 0; i <= 5; i++) f1 |= b(8, i) << i
  f1 |= (b(8, 7) << 6) | (b(8, 8) << 7) | (b(7, 8) << 8)
  for (let i = 9; i < 15; i++) f1 |= b(14 - i, 8) << i
  let f2 = 0
  for (let i = 0; i < 8; i++) f2 |= b(size - 1 - i, 8) << i
  for (let i = 8; i < 15; i++) f2 |= b(8, size - 15 + i) << i
  expect(f1).toBe(f2)
  const raw = f1 ^ 0x5412
  let rem = raw   // BCH(15,5)：整除生成多项式 0x537
  for (let i = 14; i >= 10; i--) if ((rem >>> i) & 1) rem ^= 0x537 << (i - 10)
  expect(rem).toBe(0)
  expect(raw >>> 13).toBe(0)   // 纠错等级 M = 00
  const mask = (raw >>> 10) & 7
  expect(b(8, size - 8)).toBe(1)   // 固定深色模块
  const { fn } = functionPatterns(v)
  const bits: number[] = []
  for (const [x, y] of zigzag(size, fn)) bits.push(b(x, y) ^ (MASKS[mask](x, y) ? 1 : 0))
  const cw: number[] = []
  for (let i = 0; i + 8 <= bits.length; i += 8) cw.push(bits.slice(i, i + 8).reduce((a, c) => (a << 1) | c, 0))
  const nb = BLOCKS[v], ec = ECC[v], total = cw.length, short = nb - (total % nb), shortLen = Math.floor(total / nb) - ec
  const blocks = Array.from({ length: nb }, (_x, i) => ({ d: [] as number[], e: [] as number[], len: shortLen + (i < short ? 0 : 1) }))
  let k = 0
  for (let i = 0; i <= shortLen; i++) for (const bl of blocks) if (i < bl.len) bl.d.push(cw[k++])
  for (let i = 0; i < ec; i++) for (const bl of blocks) bl.e.push(cw[k++])
  for (const bl of blocks) {
    const poly = [...bl.d, ...bl.e]
    for (let i = 0; i < ec; i++) { const a = gfPow(i); expect(poly.reduce((s, c) => gfMul(s, a) ^ c, 0)).toBe(0) }
  }
  const data = blocks.flatMap((bl) => bl.d)
  expect(data.length).toBe(dataCodewords(v))
  const bs = data.flatMap((c) => [7, 6, 5, 4, 3, 2, 1, 0].map((i) => (c >>> i) & 1))
  const num = (o: number, n: number) => bs.slice(o, o + n).reduce((a, c) => (a << 1) | c, 0)
  expect(num(0, 4)).toBe(4)
  const len = num(4, 8)
  return { text: new TextDecoder().decode(new Uint8Array(Array.from({ length: len }, (_x, i) => num(12 + i * 8, 8)))), mask, version: v }
}
const finderOk = (q: boolean[][], cx: number, cy: number) => {
  for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) {
    const d = Math.max(Math.abs(dx), Math.abs(dy))
    if (q[cy + dy][cx + dx] !== (d !== 2)) return false
  }
  return true
}

describe('二维码编码', () => {
  it.each([
    'http://192.168.1.23:52817/#c=483920',
    'http://10.0.0.5:4000/',
    'A',
    '手机访问 灵壳 LingShell http://172.16.30.200:65535/#c=000000',
    'x'.repeat(150),   // 版本 7 以上：带版本信息
    'y'.repeat(180),   // 最大容量（版本 9）
  ])('%s → 能解回原文，格式 / RS 校验通过', (s) => {
    const q = qrMatrix(s)
    const size = q.length
    expect(finderOk(q, 3, 3) && finderOk(q, size - 4, 3) && finderOk(q, 3, size - 4)).toBe(true)
    expect(decode(q).text).toBe(s)
  })
  it('配对链接用版本 3（29×29），太长时报错', () => {
    expect(qrMatrix('http://192.168.1.23:52817/#c=483920').length).toBe(29)
    expect(() => qrMatrix('x'.repeat(181))).toThrow(/太长/)
  })
  it('掩码按罚分挑选（不是总用同一个）', () => {
    const masks = new Set(['a', 'http://192.168.1.2:1/', 'http://10.1.2.3:44444/#c=111111', 'hello world', 'x'.repeat(40), '0123456789'].map((s) => decode(qrMatrix(s)).mask))
    expect(masks.size).toBeGreaterThan(1)
  })
})
