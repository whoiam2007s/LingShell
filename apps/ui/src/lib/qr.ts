// 二维码编码（手机访问的配对链接用）：字节模式、纠错等级 M、版本 1–9（最多 180 字节，链接只有几十字节；版本 10 起长度字段要 16 位，没做）。
// ponytail: 只做这一种组合，够配对链接用；要更长的内容再补版本表和 16 位长度字段，或换成 qrcode 库（当时 npm 源连不上）。
// 算法照 ISO/IEC 18004：数据码字 → Reed-Solomon 纠错码字 → 分块交错 → 放置（避开功能图形）→ 8 种掩码取罚分最低 → 写格式 / 版本信息
import { tr } from '@lingshell/shared'

const ECC = [0, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26]   // 每块纠错码字数（M）
const BLOCKS = [0, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5]          // 块数（M）
const M_BITS = 0                                           // 格式信息里 M 的编码

const rawModules = (v: number) => {
  let r = (16 * v + 128) * v + 64
  if (v >= 2) { const n = Math.floor(v / 7) + 2; r -= (25 * n - 10) * n - 55; if (v >= 7) r -= 36 }
  return r
}
export const dataCodewords = (v: number) => Math.floor(rawModules(v) / 8) - ECC[v] * BLOCKS[v]

const gfMul = (x: number, y: number) => {
  let z = 0
  for (let i = 7; i >= 0; i--) { z = (z << 1) ^ ((z >>> 7) * 0x11d); z ^= ((y >>> i) & 1) * x }
  return z & 0xff
}
function rsDivisor(deg: number): number[] {
  const r = new Array<number>(deg).fill(0); r[deg - 1] = 1
  let root = 1
  for (let i = 0; i < deg; i++) {
    for (let j = 0; j < deg; j++) { r[j] = gfMul(r[j], root); if (j + 1 < deg) r[j] ^= r[j + 1] }
    root = gfMul(root, 2)
  }
  return r
}
function rsRemainder(data: number[], div: number[]): number[] {
  const r = div.map(() => 0)
  for (const b of data) {
    const f = b ^ (r.shift() as number)
    r.push(0)
    div.forEach((d, i) => { r[i] ^= gfMul(d, f) })
  }
  return r
}

export function alignPositions(v: number): number[] {
  if (v === 1) return []
  const n = Math.floor(v / 7) + 2, size = v * 4 + 17
  const step = Math.ceil((v * 4 + 4) / (n * 2 - 2)) * 2
  const r = [6]
  for (let p = size - 7; r.length < n; p -= step) r.splice(1, 0, p)
  return r
}
export const MASKS: ((x: number, y: number) => boolean)[] = [
  (x, y) => (x + y) % 2 === 0, (_x, y) => y % 2 === 0, (x) => x % 3 === 0, (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0, (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0, (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
]
export const formatBits = (mask: number) => {
  const d = (M_BITS << 3) | mask
  let r = d
  for (let i = 0; i < 10; i++) r = (r << 1) ^ ((r >>> 9) * 0x537)
  return ((d << 10) | r) ^ 0x5412
}

/** 功能图形（定位、分隔、时序、校正、格式 / 版本区）：返回模块初值和「是不是功能模块」 */
export function functionPatterns(v: number) {
  const size = v * 4 + 17
  const m = Array.from({ length: size }, () => new Array<boolean>(size).fill(false))
  const fn = Array.from({ length: size }, () => new Array<boolean>(size).fill(false))
  const set = (x: number, y: number, dark: boolean) => { m[y][x] = dark; fn[y][x] = true }
  for (let i = 0; i < size; i++) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0) }
  for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]]) {
    for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
      const d = Math.max(Math.abs(dx), Math.abs(dy)), x = cx + dx, y = cy + dy
      if (x >= 0 && x < size && y >= 0 && y < size) set(x, y, d !== 2 && d !== 4)
    }
  }
  const al = alignPositions(v)
  al.forEach((ax, i) => al.forEach((ay, j) => {
    if ((i === 0 && j === 0) || (i === 0 && j === al.length - 1) || (i === al.length - 1 && j === 0)) return
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) set(ax + dx, ay + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1)
  }))
  drawFormat(set, size, 0)   // 先占位，选好掩码再写真值
  if (v >= 7) {
    let r = v
    for (let i = 0; i < 12; i++) r = (r << 1) ^ ((r >>> 11) * 0x1f25)
    const bits = (v << 12) | r
    for (let i = 0; i < 18; i++) { const b = ((bits >>> i) & 1) === 1, a = size - 11 + (i % 3), c = Math.floor(i / 3); set(a, c, b); set(c, a, b) }
  }
  return { size, m, fn }
}
function drawFormat(set: (x: number, y: number, d: boolean) => void, size: number, mask: number) {
  const bits = formatBits(mask), bit = (i: number) => ((bits >>> i) & 1) === 1
  for (let i = 0; i <= 5; i++) set(8, i, bit(i))
  set(8, 7, bit(6)); set(8, 8, bit(7)); set(7, 8, bit(8))
  for (let i = 9; i < 15; i++) set(14 - i, 8, bit(i))
  for (let i = 0; i < 8; i++) set(size - 1 - i, 8, bit(i))
  for (let i = 8; i < 15; i++) set(8, size - 15 + i, bit(i))
  set(8, size - 8, true)
}
/** 数据区按「两列一组、蛇形上下」的顺序遍历（跳过第 6 列和功能模块） */
export function* zigzag(size: number, fn: boolean[][]): Generator<[number, number]> {
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5
    for (let vert = 0; vert < size; vert++) for (let j = 0; j < 2; j++) {
      const x = right - j, y = ((right + 1) & 2) === 0 ? size - 1 - vert : vert
      if (!fn[y][x]) yield [x, y]
    }
  }
}

function penalty(m: boolean[][]): number {
  const size = m.length
  let p = 0
  const lines = [...m.map((r) => r.map((b) => (b ? '1' : '0')).join('')), ...m.map((_r, x) => m.map((r) => (r[x] ? '1' : '0')).join(''))]
  for (const l of lines) {
    for (const run of l.match(/0{5,}|1{5,}/g) ?? []) p += run.length - 2
    p += 40 * ((`0000${l}0000`.match(/(?=00001011101|10111010000)/g) ?? []).length)
  }
  let dark = 0
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    if (m[y][x]) dark++
    if (x < size - 1 && y < size - 1 && m[y][x] === m[y][x + 1] && m[y][x] === m[y + 1][x] && m[y][x] === m[y + 1][x + 1]) p += 3
  }
  return p + 10 * Math.floor(Math.abs(dark * 20 - size * size * 10) / (size * size))
}

/** 文本 → 二维码模块矩阵（true = 深色），不含四周留白 */
export function qrMatrix(text: string): boolean[][] {
  const bytes = [...new TextEncoder().encode(text)]
  let v = 1
  while (v <= 9 && 4 + 8 + bytes.length * 8 > dataCodewords(v) * 8) v++
  if (v > 9) throw new Error(tr('内容太长，二维码放不下'))
  const cap = dataCodewords(v)
  // 数据码字：模式 0100 + 8 位长度 + 字节 + 终止符 + 补齐到字节 + 交替填充 0xEC 0x11
  const bits: number[] = []
  const put = (val: number, n: number) => { for (let i = n - 1; i >= 0; i--) bits.push((val >>> i) & 1) }
  put(4, 4); put(bytes.length, 8); bytes.forEach((b) => put(b, 8))
  put(0, Math.min(4, cap * 8 - bits.length))
  put(0, (8 - (bits.length % 8)) % 8)
  const data: number[] = []
  for (let i = 0; i < bits.length; i += 8) data.push(bits.slice(i, i + 8).reduce((a, b) => (a << 1) | b, 0))
  for (let pad = 0xec; data.length < cap; pad ^= 0xec ^ 0x11) data.push(pad)
  // 分块（前面的短块少一个数据码字）+ 纠错，再按列交错
  const nb = BLOCKS[v], ec = ECC[v], raw = Math.floor(rawModules(v) / 8)
  const short = nb - (raw % nb), shortLen = Math.floor(raw / nb) - ec
  const div = rsDivisor(ec)
  const blocks: { d: number[]; e: number[] }[] = []
  for (let i = 0, k = 0; i < nb; i++) { const len = shortLen + (i < short ? 0 : 1); const d = data.slice(k, k + len); k += len; blocks.push({ d, e: rsRemainder(d, div) }) }
  const out: number[] = []
  for (let i = 0; i <= shortLen; i++) for (const b of blocks) if (i < b.d.length) out.push(b.d[i])
  for (let i = 0; i < ec; i++) for (const b of blocks) out.push(b.e[i])
  // 放置 + 选掩码
  const { size, m, fn } = functionPatterns(v)
  let k = 0
  for (const [x, y] of zigzag(size, fn)) { m[y][x] = k < out.length * 8 && ((out[k >>> 3] >>> (7 - (k & 7))) & 1) === 1; k++ }
  let best: boolean[][] = m, bestP = Infinity
  MASKS.forEach((f, mask) => {
    const t = m.map((r, y) => r.map((b, x) => (fn[y][x] ? b : b !== f(x, y))))
    drawFormat((x, y, d) => { t[y][x] = d }, size, mask)
    const p = penalty(t)
    if (p < bestP) { bestP = p; best = t }
  })
  return best
}
