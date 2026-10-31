// ── 趋势预测：磁盘多少天写满 / 证书多少天过期 ─────────────────
// 磁盘用最小二乘线性外推，两种数据来源都用、分开标注依据：
// - 主机体检档案（profiles，每台最多 20 份）：长期，优先取近 7 天；只有少数几份时用全部档案的时间序列
// - 仪表盘采样环形缓冲（60 点 × 15–60 秒）：短期，只看最满的那个挂载点
// 去噪：只用最后一次「明显下降」（清理过磁盘）之后的那段；去掉孤立尖刺；点数 / 时间跨度 / 拟合度不够就不给（界面不显示）
import type { HostProfile, CertInfo } from './hostProfile.js'
import type { DashPoint } from './hostDashboard.js'
import { tr } from '../i18n/i18n.js'

export interface TrendPoint { at: number; v: number }
const DAY = 86_400_000

/** 最小二乘直线 v = slope·at + intercept（slope 单位：每毫秒）；点不足 2 个或时间全相同返回 undefined。r2 = 拟合优度 */
export function linearFit(pts: TrendPoint[]): { slope: number; intercept: number; r2: number } | undefined {
  const n = pts.length
  if (n < 2) return undefined
  const t0 = pts[0].at   // 平移时间轴，避免 epoch 毫秒平方丢精度
  let sx = 0, sy = 0, sxx = 0, sxy = 0
  for (const p of pts) { const x = p.at - t0; sx += x; sy += p.v; sxx += x * x; sxy += x * p.v }
  const den = n * sxx - sx * sx
  if (den <= 0) return undefined
  const slope = (n * sxy - sx * sy) / den
  const b = (sy - slope * sx) / n
  const mean = sy / n
  let ssTot = 0, ssRes = 0
  for (const p of pts) { const f = slope * (p.at - t0) + b; ssRes += (p.v - f) ** 2; ssTot += (p.v - mean) ** 2 }
  return { slope, intercept: b - slope * t0, r2: ssTot === 0 ? 1 : 1 - ssRes / ssTot }
}

/** 去噪：按时间排序、同一时刻取后者；去掉比两侧邻点都高 / 低超过 spike 的孤立点；再从最后一次下降超过 drop 个百分点（清理过）之后算起 */
export function denoise(pts: TrendPoint[], drop = 5, spike = 5): TrendPoint[] {
  const m = new Map<number, number>()
  for (const p of [...pts].sort((a, b) => a.at - b.at)) if (Number.isFinite(p.v)) m.set(p.at, p.v)
  const raw = [...m].map(([at, v]) => ({ at, v }))
  let a = raw.filter((p, i) => {
    if (i === 0 || i === raw.length - 1) return true
    const l = raw[i - 1].v, r = raw[i + 1].v
    return !((p.v - l > spike && p.v - r > spike) || (l - p.v > spike && r - p.v > spike))
  })
  for (let i = a.length - 1; i > 0; i--) if (a[i - 1].v - a[i].v > drop) { a = a.slice(i); break }
  return a
}

export interface ForecastOpts { minPoints: number; minSpanMs: number; minR2: number; maxDays: number; now: number }
export const PROFILE_FORECAST: Omit<ForecastOpts, 'now'> = { minPoints: 3, minSpanMs: DAY / 2, minR2: 0.5, maxDays: 180 }
export const SAMPLE_FORECAST: Omit<ForecastOpts, 'now'> = { minPoints: 10, minSpanMs: 10 * 60_000, minR2: 0.6, maxDays: 180 }

/** 已用百分比序列 → 约几天写满（100%）。不涨 / 数据不足 / 太乱 / 超过 maxDays → undefined */
export function forecastFull(pts: TrendPoint[], o: ForecastOpts): { days: number; perDay: number; points: number; spanMs: number; current: number } | undefined {
  const a = denoise(pts)
  if (a.length < o.minPoints) return undefined
  const spanMs = a[a.length - 1].at - a[0].at
  if (spanMs < o.minSpanMs) return undefined
  const f = linearFit(a)
  if (!f || f.r2 < o.minR2) return undefined
  const perDay = f.slope * DAY
  if (perDay < 0.05) return undefined   // 一天涨不到 0.05 个百分点：当作不涨
  const current = Math.min(100, Math.max(a[a.length - 1].v, f.slope * o.now + f.intercept))
  const days = (100 - current) / perDay
  if (!(days >= 0) || days > o.maxDays) return undefined
  return { days, perDay, points: a.length, spanMs, current }
}

export type TrendBasis = 'profiles' | 'samples'
export interface DiskForecast { mount: string; days: number; perDay: number; basis: TrendBasis; points: number; spanMs: number; current: number }
export interface CertForecast { path: string; days: number; notAfter: string }
export interface HostTrend { disks: DiskForecast[]; certs: CertForecast[]; samples?: DiskForecast; profiles: number }

/** 体检档案 → 各挂载点的已用 % 序列（只用 check 类型；快照不采磁盘） */
export function profileDiskSeries(ps: Pick<HostProfile, 'at' | 'type' | 'disks'>[]): Map<string, TrendPoint[]> {
  const m = new Map<string, TrendPoint[]>()
  for (const p of ps) {
    if (p.type !== 'check' || !p.disks) continue
    const at = Date.parse(p.at)
    if (!Number.isFinite(at)) continue
    for (const d of p.disks) m.set(d.mount, [...(m.get(d.mount) ?? []), { at, v: d.usedPct }])
  }
  return m
}

/** 档案外推：优先近 7 天的点（够用时），否则用全部档案；只看最新一次体检里还在的挂载点。按天数升序 */
export function forecastFromProfiles(ps: Pick<HostProfile, 'at' | 'type' | 'disks'>[], now: number): DiskForecast[] {
  const out: DiskForecast[] = []
  // 已经卸载 / 删掉的挂载点：旧档案里还有它的点，但不能继续预测
  const latest = ps.filter((p) => p.type === 'check' && p.disks?.length).sort((a, b) => b.at.localeCompare(a.at))[0]
  const alive = latest ? new Set(latest.disks!.map((d) => d.mount)) : undefined
  for (const [mount, all] of profileDiskSeries(ps)) {
    if (alive && !alive.has(mount)) continue
    const week = all.filter((p) => now - p.at <= 7 * DAY)
    const f = forecastFull(week, { ...PROFILE_FORECAST, now }) ?? forecastFull(all, { ...PROFILE_FORECAST, now })
    if (f) out.push({ mount, ...f, basis: 'profiles' })
  }
  return out.sort((a, b) => a.days - b.days)
}

/** 仪表盘采样外推：最满挂载点（只取与最新点同一挂载点的样本） */
export function forecastFromSamples(points: DashPoint[], now: number): DiskForecast | undefined {
  const last = [...points].reverse().find((p) => p.disk !== undefined)
  if (!last) return undefined
  const pts = points.filter((p) => p.disk !== undefined && p.diskMount === last.diskMount).map((p) => ({ at: p.at, v: p.disk! }))
  const f = forecastFull(pts, { ...SAMPLE_FORECAST, now })
  return f && { mount: last.diskMount ?? '', ...f, basis: 'samples' }
}

/** 证书：有到期日直接算剩余天数（负数 = 已过期），按天数升序；到期日解析不出来的（档案被改坏）跳过 */
export function certForecasts(certs: CertInfo[] | undefined, now: number): CertForecast[] {
  return (certs ?? []).flatMap((c) => {
    if (!c.notAfter) return []
    const at = Date.parse(c.notAfter)
    return Number.isFinite(at) ? [{ path: c.path, notAfter: c.notAfter, days: Math.floor((at - now) / DAY) }] : []
  }).sort((a, b) => a.days - b.days)
}

/** 档案（新旧不限）+ 采样点 → 一台主机的趋势；证书取最近一份体检 */
export function hostTrend(ps: Pick<HostProfile, 'at' | 'type' | 'disks' | 'certs'>[], points: DashPoint[], now: number): HostTrend {
  const checks = ps.filter((p) => p.type === 'check').sort((a, b) => b.at.localeCompare(a.at))
  const samples = forecastFromSamples(points, now)
  return { disks: forecastFromProfiles(checks, now), certs: certForecasts(checks[0]?.certs, now), ...(samples ? { samples } : {}), profiles: checks.length }
}

/** 颜色档：< 3 天红，< 14 天黄 */
export const trendLevel = (days: number): 'danger' | 'warn' | 'normal' => (days < 3 ? 'danger' : days < 14 ? 'warn' : 'normal')
// 「约 9 天」/「不到 1 天」（后者不加「约」，免得读成「约 不到 1 天」）
export const dayText = (d: number) => (d < 1 ? tr('不到 1 天') : tr('约 {n} 天', { n: Math.round(d) }))
/** 「约 9 天满」 */
export const fullShort = (f: Pick<DiskForecast, 'days'>) => tr('{days}满', { days: dayText(f.days) })
/** 依据说明：「依据近 6 天 4 次体检，每天约 +1.2%」/「依据最近 25 分钟采样（短期），…」 */
export function basisText(f: Pick<DiskForecast, 'basis' | 'points' | 'spanMs' | 'perDay'>): string {
  const span = f.spanMs >= DAY ? tr('{n} 天', { n: Math.round(f.spanMs / DAY) }) : f.spanMs >= 3_600_000 ? tr('{n} 小时', { n: Math.round(f.spanMs / 3_600_000) }) : tr('{n} 分钟', { n: Math.max(1, Math.round(f.spanMs / 60_000)) })
  const rate = tr('每天约 +{pct}%', { pct: f.perDay.toFixed(f.perDay >= 0.1 ? 1 : 2) })
  return f.basis === 'profiles' ? tr('依据近 {span} {n} 次体检，{rate}', { span, n: f.points, rate }) : tr('依据最近 {span}采样（短期，仅供参考），{rate}', { span, rate })
}
/** 「/data 按近 7 天增长，约 9 天后写满」 */
export const diskForecastText = (f: DiskForecast) => f.basis === 'profiles' ? tr('{mount} 按体检档案的增长，{days}后写满', { mount: f.mount, days: dayText(f.days) }) : tr('{mount} 按最近采样的增长，{days}后写满', { mount: f.mount, days: dayText(f.days) })
export const certForecastText = (c: CertForecast) => (c.days < 0 ? tr('证书已过期 {n} 天：{path}', { n: -c.days, path: c.path }) : c.days === 0 ? tr('证书今天到期：{path}', { path: c.path }) : tr('证书 {n} 天后过期：{path}', { n: c.days, path: c.path }))
