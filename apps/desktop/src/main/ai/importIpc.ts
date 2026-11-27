// 第三方导入：扫描各家用 AI 客户端 / CLI 的用户目录，把它们的 agents / skills / MCP 配置导进本应用。
// 只读对方的配置、只写我们自己的库（<数据目录>/agents、<数据目录>/skills、设置里的 MCP），永不修改对方文件。
// 扫描按平台逐个做（UI 每完成一个平台就渲染一组，天然就是「实时进度」）。
import { cp, mkdir, readdir, readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { LocalAgents, LocalSkills } from '@lingshell/dsh-controller'
import { tr, type McpServerInput } from '@lingshell/shared'

export type ImportKind = 'agent' | 'skill' | 'mcp'
export const IMPORT_KINDS: ImportKind[] = ['agent', 'skill', 'mcp']

export interface ImportItem {
  /** 全局唯一：`<platform>:<kind>:<name>`，commit 时用它回查缓存 */
  id: string
  platform: string
  kind: ImportKind
  name: string
  description?: string
  /** 源文件 / 目录（给人看） */
  path?: string
  /** MCP：命令或 URL 的一行摘要 */
  detail?: string
  /** MCP 的完整配置（导入时直接写进设置） */
  mcp?: McpServerInput
}

export interface ImportGroup {
  platform: string
  label: string
  /** 该平台的数据目录（平台名可点，直接在这里打开） */
  dir: string
  exists: boolean
  items: ImportItem[]
}

export interface ImportIpcDeps {
  handle(channel: string, fn: (e: unknown, ...args: unknown[]) => unknown): void
  agents: () => LocalAgents
  skills: () => LocalSkills
  saveMcp: (input: McpServerInput) => void
  openPath: (p: string) => Promise<string>
  log?: (level: 'info' | 'warn', msg: string, data?: unknown) => void
}

// 支持的客户端 / CLI：目录不存在的平台在弹窗里显示「没有找到目录」，不影响其它平台。
const PLATFORMS: { id: string; label: string; dir: () => string }[] = [
  { id: 'claude', label: 'Claude Code', dir: () => join(homedir(), '.claude') },
  { id: 'codex', label: 'Codex', dir: () => join(homedir(), '.codex') },
  { id: 'cursor', label: 'Cursor', dir: () => join(homedir(), '.cursor') },
  { id: 'dsh', label: 'DeepSeek Harness', dir: () => join(homedir(), '.dsh') },
  { id: 'openclaw', label: 'OpenClaw', dir: () => join(homedir(), '.openclaw') },
  { id: 'openharness', label: 'OpenHarness', dir: () => join(homedir(), '.openharness') },
  { id: 'pi', label: 'PI', dir: () => join(homedir(), '.pi') },
  { id: 'gemini', label: 'Gemini CLI', dir: () => join(homedir(), '.gemini') },
  { id: 'qwen', label: 'Qwen Code', dir: () => join(homedir(), '.qwen') },
  { id: 'glm', label: 'GLM', dir: () => join(homedir(), '.glm') },
  { id: 'minimax', label: 'MiniMax', dir: () => join(homedir(), '.minimax') },
  { id: 'kimi', label: 'Kimi', dir: () => join(homedir(), '.kimi') },
  { id: 'opencode', label: 'OpenCode', dir: () => join(homedir(), '.config', 'opencode') },
  { id: 'agents', label: 'Agents', dir: () => join(homedir(), '.agents') },
]

const exists = async (p: string): Promise<boolean> => { try { await stat(p); return true } catch { return false } }
const unquote = (s: string) => s.trim().replace(/^["']|["']$/g, '')

/** 简易 TOML 片段解析：只认 [mcp_servers.xxx] 下的 command / args / url */
function parseCodexMcp(text: string, platform: string): ImportItem[] {
  const out: ImportItem[] = []
  let cur: { name: string; command?: string; args?: string[]; url?: string } | null = null
  const flush = () => {
    if (!cur) return
    const c = cur
    if (c.command || c.url) {
      out.push({
        id: `${platform}:mcp:${c.name}`, platform, kind: 'mcp', name: c.name,
        detail: c.command ? [c.command, ...(c.args ?? [])].join(' ') : c.url,
        mcp: c.command
          ? { name: c.name, enabled: true, transport: 'stdio', command: c.command, ...(c.args?.length ? { args: c.args } : {}) }
          : { name: c.name, enabled: true, transport: 'http', url: c.url },
      })
    }
    cur = null
  }
  for (const raw of text.replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.trim()
    const head = /^\[mcp_servers\.([A-Za-z0-9_-]+)\]$/.exec(line)
    if (head) { flush(); cur = { name: head[1] }; continue }
    if (line.startsWith('[')) { flush(); continue }
    if (!cur) continue
    const kv = /^([A-Za-z_]+)\s*=\s*(.+)$/.exec(line)
    if (!kv) continue
    const [, k, v] = kv
    if (k === 'command') cur.command = unquote(v)
    else if (k === 'url') cur.url = unquote(v)
    else if (k === 'args') cur.args = [...v.matchAll(/"([^"]*)"/g)].map((m) => m[1])
  }
  flush()
  return out
}

/** 从一份 JSON 配置里取 mcpServers（各家结构基本一致，个别用 mcp 键） */
function mcpFromJson(raw: unknown, platform: string, file: string, out: ImportItem[]): void {
  const obj = raw as { mcpServers?: Record<string, McpCfg>; mcp?: { servers?: Record<string, McpCfg> } } | null
  const servers = obj?.mcpServers ?? obj?.mcp?.servers
  if (!servers) return
  for (const [name, cfg] of Object.entries(servers)) {
    if (!cfg || typeof cfg !== 'object') continue
    const c = cfg as McpCfg
    const id = `${platform}:mcp:${name}`
    if (out.some((x) => x.id === id)) continue   // 同一个名字在多个文件里出现时只留第一个
    out.push({
      id, platform, kind: 'mcp', name,
      detail: c.command ? [c.command, ...(c.args ?? [])].join(' ') : (c.url ?? c.serverUrl),
      path: file,
      mcp: c.command
        ? { name, enabled: true, transport: 'stdio', command: c.command, ...(c.args?.length ? { args: c.args } : {}), ...(c.env ? { env: c.env } : {}) }
        : { name, enabled: true, transport: 'http', ...(c.url ?? c.serverUrl ? { url: c.url ?? c.serverUrl } : {}), ...(c.headers ? { headers: c.headers } : {}) },
    })
  }
}

interface McpCfg { command?: string; args?: string[]; url?: string; serverUrl?: string; env?: Record<string, string>; headers?: Record<string, string> }

export function registerImport(d: ImportIpcDeps): void {
  // 最近一次扫描的候选（commit 时按 id 回查，避免把 MCP 配置在 IPC 里来回传）
  const cache = new Map<string, ImportItem>()

  const scanOne = async (kind: ImportKind, platform: string): Promise<ImportGroup> => {
    const p = PLATFORMS.find((x) => x.id === platform)
    if (!p) throw new Error(tr('未知的平台：{p}', { p: platform }))
    const dir = p.dir()
    const group: ImportGroup = { platform: p.id, label: p.label, dir, exists: await exists(dir), items: [] }

    if (kind === 'agent') {
      const agentsDir = join(dir, 'agents')
      let names: string[]
      try { names = (await readdir(agentsDir)).filter((n) => n.endsWith('.md')).sort() } catch { return group }
      for (const n of names) {
        const file = join(agentsDir, n)
        const text = await readFile(file, 'utf8').catch(() => '')
        const name = (/^name\s*:\s*(.+)$/m.exec(text)?.[1] ?? n.replace(/\.md$/, '')).trim()
        const desc = (/^description\s*:\s*(.+)$/m.exec(text)?.[1] ?? '').trim()
        group.items.push({ id: `${p.id}:agent:${name}`, platform: p.id, kind, name, ...(desc ? { description: desc } : {}), path: file })
      }
      return group
    }

    if (kind === 'skill') {
      const skillsDir = join(dir, 'skills')
      let entries: string[]
      try { entries = (await readdir(skillsDir, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name).sort() } catch { return group }
      for (const n of entries) {
        const sd = join(skillsDir, n)
        const f = join(sd, 'SKILL.md')
        if (!(await exists(f))) continue
        const text = await readFile(f, 'utf8').catch(() => '')
        const name = (/^name\s*:\s*(.+)$/m.exec(text)?.[1] ?? n).trim()
        const desc = (/^description\s*:\s*(.+)$/m.exec(text)?.[1] ?? '').trim()
        group.items.push({ id: `${p.id}:skill:${name}`, platform: p.id, kind, name, ...(desc ? { description: desc } : {}), path: sd })
      }
      return group
    }

    // MCP：先看各家的 JSON 配置（mcp.json / settings.json / .mcp.json / ~/.<平台>.json），Codex 再看 TOML
    for (const f of [join(dir, 'mcp.json'), join(dir, 'settings.json'), join(dir, '.mcp.json'), join(homedir(), `.${p.id}.json`)]) {
      if (!(await exists(f))) continue
      try { mcpFromJson(JSON.parse(await readFile(f, 'utf8')), p.id, f, group.items) } catch { /* 配置坏了就跳过 */ }
    }
    const toml = join(dir, 'config.toml')
    if (await exists(toml)) {
      for (const it of parseCodexMcp(await readFile(toml, 'utf8').catch(() => ''), p.id)) {
        if (!group.items.some((x) => x.id === it.id)) group.items.push({ ...it, path: toml })
      }
    }
    return group
  }

  d.handle('import:platforms', () => PLATFORMS.map((p) => ({ id: p.id, label: p.label, dir: p.dir() })))
  d.handle('import:scan', async (_e, kind, platform) => {
    if (!IMPORT_KINDS.includes(kind as ImportKind)) throw new Error(tr('未知的导入类型：{k}', { k: String(kind) }))
    const g = await scanOne(kind as ImportKind, String(platform ?? ''))
    for (const it of g.items) cache.set(it.id, it)
    return g
  })
  d.handle('import:openDir', async (_e, platform) => {
    const p = PLATFORMS.find((x) => x.id === String(platform ?? ''))
    if (!p) throw new Error(tr('未知的平台：{p}', { p: String(platform) }))
    const dir = p.dir()
    await mkdir(dir, { recursive: true }).catch(() => {})
    const err = await d.openPath(dir)
    if (err) throw new Error(err)
  })
  d.handle('import:commit', async (_e, kind, ids) => {
    const list = (Array.isArray(ids) ? ids : []).map((x) => String(x))
    let ok = 0
    const failed: string[] = []
    for (const id of list) {
      const it = cache.get(id)
      if (!it || it.kind !== kind) { failed.push(id); continue }
      try {
        if (it.kind === 'agent' && it.path) {
          const lib = d.agents()
          const text = await readFile(it.path, 'utf8')
          const m = /^---\n([\s\S]*?)\n---\n?/.exec(text)
          const meta = m ? m[1] : ''
          const body = m ? text.slice(m[0].length).trim() : text
          const name = (/^name\s*:\s*(.+)$/m.exec(meta)?.[1] ?? it.name).trim()
          const desc = (/^description\s*:\s*(.+)$/m.exec(meta)?.[1] ?? it.description ?? '').trim()
          const tools = (/^tools\s*:\s*(.+)$/m.exec(meta)?.[1] ?? '').trim()
          await lib.save({
            name, description: desc || it.name, body,
            ...(tools ? { tools: tools.replace(/^\[|\]$/g, '').split(/[,，]/).map((s) => s.trim()).filter(Boolean) } : {}),
          })
        } else if (it.kind === 'skill' && it.path) {
          const lib = d.skills()
          const root = lib.dir
          await mkdir(root, { recursive: true })
          await cp(it.path, join(root, it.name), { recursive: true, force: true })
          await lib.list()   // 扫一遍让新 skill 立即可见
        } else if (it.kind === 'mcp' && it.mcp) {
          d.saveMcp(it.mcp)
        } else { failed.push(id); continue }
        ok++
      } catch (e) {
        d.log?.('warn', 'import failed', { id, err: String(e).slice(0, 200) })
        failed.push(id)
      }
    }
    return { ok, failed }
  })
}
