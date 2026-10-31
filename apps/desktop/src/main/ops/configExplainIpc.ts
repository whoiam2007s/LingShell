import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { EXPLAIN_VERSION, buildExplainPrompt, configKind, parseExplain, tr, type ExplainItem, type ExplainResult } from '@lingshell/shared'

// 配置文件解释（见 shared/ops/configExplain.ts）：内容由编辑器传来（当前看到的就是解释的），一次性模型调用；
// 结果按（版本 + 类型 + 原文）sha256 缓存到 <数据目录>/config-explain/<hash>.json，没改动不重复请求。发给模型前按设置脱敏（不改行号）
export interface ConfigExplainDeps {
  handle(channel: string, fn: (e: unknown, ...args: unknown[]) => unknown): void
  dir: string
  complete(system: string, user: string, signal: AbortSignal): Promise<string>
  redact(text: string): string
}

// 缓存文件在用户目录里，可能被手动改坏 / 版本不符：形状不对就当没有缓存，别把坏数据交给界面（res.items.length 会崩）
const cacheOk = (x: unknown, kind: string): x is ExplainResult => {
  const r = x as Partial<ExplainResult> | null
  return !!r && typeof r === 'object' && r.kind === kind && typeof r.at === 'string' && typeof r.truncated === 'boolean' &&
    Array.isArray(r.items) && r.items.every((i) => {
      const t = i as Partial<ExplainItem> | null
      return !!t && Number.isFinite(t.start) && Number.isFinite(t.end) && typeof t.explain === 'string' &&
        typeof t.title === 'string' && (t.level === 'ok' || t.level === 'warn' || t.level === 'danger')
    })
}

export function registerConfigExplain(d: ConfigExplainDeps): void {
  d.handle('configExplain:run', async (_e, path, text, force): Promise<ExplainResult> => {
    if (typeof path !== 'string' || typeof text !== 'string') throw new Error(tr('参数不对'))
    const kind = configKind(path)
    if (!kind) throw new Error(tr('不认识这种配置文件'))
    if (!text.trim()) throw new Error(tr('文件是空的'))
    const hash = createHash('sha256').update(`${EXPLAIN_VERSION}\n${kind}\n${text}`).digest('hex')
    const file = join(d.dir, `${hash}.json`)
    if (force !== true) {
      try {
        const c: unknown = JSON.parse(await readFile(file, 'utf8'))
        if (cacheOk(c, kind)) return { ...c, cached: true }
      } catch { /* 没缓存 / 坏了：重新解释 */ }
    }
    const p = buildExplainPrompt({ kind, path, text: d.redact(text) })
    const items = parseExplain(await d.complete(p.system, p.user, AbortSignal.timeout(120_000)), p.lines)
    if ('error' in items) throw new Error(items.error)
    const r: ExplainResult = { kind, items, truncated: p.truncated, at: new Date().toISOString() }
    await mkdir(d.dir, { recursive: true, mode: 0o700 })
    await writeFile(file, JSON.stringify(r), { encoding: 'utf8', mode: 0o600 })
    return r
  })
}
