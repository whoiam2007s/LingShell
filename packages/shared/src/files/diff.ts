// 行级 unified diff（write_file 授权卡预览、多主机文件比对用）。不引依赖：
// 先剥掉公共前后缀（改配置文件通常只动几行，剩下的中段很小），中段用 LCS 动态规划回溯。
// 中段过大（n*m 超上限）退化成「整段删 + 整段加」——仍是正确的 diff，只是不最小。

type Op = { t: ' ' | '-' | '+'; s: string }

import { tr } from '../i18n/i18n.js'
const MAX_CELLS = 4_000_000          // Uint32Array 16MB 封顶
const MAX_OUT_LINES = 2000           // 授权卡上的 diff 行数封顶

export function diffLines(a: string[], b: string[]): Op[] {
  let pre = 0
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++
  let suf = 0
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++
  const A = a.slice(pre, a.length - suf), B = b.slice(pre, b.length - suf)
  const n = A.length, m = B.length
  const mid: Op[] = []
  if (n * m > MAX_CELLS) {
    for (const s of A) mid.push({ t: '-', s })
    for (const s of B) mid.push({ t: '+', s })
  } else {
    // dp[i*w+j] = A[i..] 与 B[j..] 的 LCS 长度
    const w = m + 1
    const dp = new Uint32Array((n + 1) * w)
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        dp[i * w + j] = A[i] === B[j] ? dp[(i + 1) * w + j + 1] + 1 : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1])
      }
    }
    let i = 0, j = 0
    while (i < n && j < m) {
      if (A[i] === B[j]) { mid.push({ t: ' ', s: A[i] }); i++; j++ }
      else if (dp[(i + 1) * w + j] >= dp[i * w + j + 1]) mid.push({ t: '-', s: A[i++] })
      else mid.push({ t: '+', s: B[j++] })
    }
    while (i < n) mid.push({ t: '-', s: A[i++] })
    while (j < m) mid.push({ t: '+', s: B[j++] })
  }
  const same = (s: string): Op => ({ t: ' ', s })
  return [...a.slice(0, pre).map(same), ...mid, ...a.slice(a.length - suf).map(same)]
}

// 剥掉一个末尾换行再切（否则新建文件末尾多显示一行空的 +）；只差末尾换行时单独提示
const splitLines = (t: string) => (t === '' ? [] : t.replace(/\n$/, '').split('\n'))

/** 生成 unified diff（git 风格 ---/+++/@@ 头，ctx 行上下文）。内容相同返回 '' */
export function unifiedDiff(oldText: string, newText: string, path: string, ctx = 3): string {
  const ops = diffLines(splitLines(oldText), splitLines(newText))
  // 每个 op 在旧/新文件里的行号（0 起，指向该 op 之前已走过的行数）
  const oNo: number[] = [], nNo: number[] = []
  let o = 0, n = 0
  for (const op of ops) { oNo.push(o); nNo.push(n); if (op.t !== '+') o++; if (op.t !== '-') n++ }
  const changed = ops.flatMap((op, i) => (op.t === ' ' ? [] : [i]))
  const out = [`--- a/${path}`, `+++ b/${path}`]
  if (changed.length === 0) return oldText === newText ? '' : [...out, tr('（仅文件末尾换行不同）')].join('\n')
  let k = 0
  while (k < changed.length) {
    // 相邻改动间隔 ≤ 2*ctx 的并成一个 hunk
    let end = k
    while (end + 1 < changed.length && changed[end + 1] - changed[end] <= 2 * ctx + 1) end++
    const from = Math.max(0, changed[k] - ctx), to = Math.min(ops.length, changed[end] + ctx + 1)
    const body = ops.slice(from, to)
    const oLen = body.filter((x) => x.t !== '+').length, nLen = body.filter((x) => x.t !== '-').length
    // 长度为 0 时起始行号按惯例取前一行
    const oStart = oLen ? oNo[from] + 1 : oNo[from], nStart = nLen ? nNo[from] + 1 : nNo[from]
    out.push(`@@ -${oStart},${oLen} +${nStart},${nLen} @@`)
    for (const x of body) out.push(x.t + x.s)
    k = end + 1
  }
  if (out.length > MAX_OUT_LINES) return [...out.slice(0, MAX_OUT_LINES), tr('…（diff 共 {n} 行，已截断）', { n: out.length })].join('\n')
  return out.join('\n')
}
