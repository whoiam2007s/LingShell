// Agent（角色）：一份 <name>.md = frontmatter（name/description/model/tools/permission）+ 正文（系统提示）。
// 与会话绑定后：正文进系统提示、tools 收窄工具集、permission 决定子代理能不能写。
// 来源：用户级 <数据目录>/agents/（可编辑）、项目内 .lingshell/agents/、以及 Claude Code / Codex 的 agents 目录（只读兼容）。
// 项目内与第三方来源属于「仓库内容」，默认不启用，用户在设置里勾选后才注入。
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join, sep } from 'node:path'
import { tr } from '@lingshell/shared'

export type AgentOrigin = 'user' | 'project' | 'claude' | 'codex'
export type AgentPermission = 'read' | 'write'

export const AGENT_NAME = /^[a-z0-9][a-z0-9-]*$/
export const AGENT_BODY_MAX = 12000
export const AGENT_FILE_MAX = 64 * 1024
export const AGENT_COUNT_MAX = 60

export interface AgentMeta {
  name: string
  description: string
  model?: string
  tools?: string[]
  permission?: AgentPermission
  disableModelInvocation?: boolean
  version?: string
  /** 关联的 Skill 名 */
  skills?: string[]
}

export interface AgentDef extends AgentMeta {
  /** 唯一标识：用户级 = name；项目 / 第三方 = name@origin（同名不同来源不互相覆盖） */
  id: string
  body: string
  origin: AgentOrigin
  file: string
  enabled: boolean
  /** 是否允许模型自主调度（缺省 = 允许；对应 md 里没写 disable-model-invocation） */
  modelInvocable?: boolean
  /** 内容来自仓库 / 别人的工具：默认关，启用前提示确认 */
  external: boolean
  error?: string
}

const ORIGIN_DIRS: { origin: AgentOrigin; rel: string[] }[] = [
  { origin: 'project', rel: ['.lingshell', 'agents'] },
  { origin: 'claude', rel: ['.claude', 'agents'] },
  { origin: 'codex', rel: ['.codex', 'agents'] },
]

const unquote = (v: string): string => {
  const s = v.trim()
  if (s.startsWith('"') && s.endsWith('"') && s.length >= 2) {
    try { return JSON.parse(s) as string } catch { return s.slice(1, -1) }
  }
  return s.startsWith("'") && s.endsWith("'") && s.length >= 2 ? s.slice(1, -1) : s
}

const splitList = (v: string): string[] => {
  const s = v.trim().replace(/^\[/, '').replace(/\]$/, '')
  return s.split(/[,，]/).map((x) => unquote(x.trim())).filter(Boolean)
}

/** 解析 AGENT.md：frontmatter 只认 name / description / model / tools / permission / disable-model-invocation */
export function parseAgentMd(text: string): { ok: true; meta: AgentMeta; body: string } | { ok: false; error: string } {
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  if (lines[0]?.trim() !== '---') return { ok: false, error: tr('AGENT.md 缺少开头的 YAML frontmatter（第一行应为 ---）') }
  const end = lines.findIndex((l, i) => i > 0 && l.trim() === '---')
  if (end < 0) return { ok: false, error: tr('AGENT.md 的 frontmatter 没有结束的 ---') }

  const map = new Map<string, string>()
  const arr = new Map<string, string[]>()
  let cur: string | undefined
  for (const raw of lines.slice(1, end)) {
    const line = raw.trimEnd()
    if (!line.trim()) continue
    const kv = /^([A-Za-z][\w-]*)\s*:\s*(.*)$/.exec(line)
    if (kv) {
      const [, key, rest] = kv
      if (!rest.trim()) { cur = key; arr.set(key, arr.get(key) ?? []); continue }
      cur = undefined
      map.set(key, unquote(rest))
      continue
    }
    const li = /^\s*-\s+(.*)$/.exec(line)
    if (li && cur) arr.set(cur, [...(arr.get(cur) ?? []), unquote(li[1] ?? '')])
  }

  const name = (map.get('name') ?? '').trim()
  const description = (map.get('description') ?? '').trim()
  if (!name) return { ok: false, error: tr('frontmatter 缺少 name') }
  if (!AGENT_NAME.test(name) || name.length > 64) return { ok: false, error: tr('name 只能用小写字母、数字和连字符（≤64 字）：{name}', { name }) }
  if (!description) return { ok: false, error: tr('frontmatter 缺少 description') }

  const rawTools = map.get('tools') ?? (arr.get('tools') ?? []).join(',')
  const tools = rawTools.trim() ? splitList(rawTools) : undefined
  const perm = (map.get('permission') ?? '').trim()
  const permission: AgentPermission | undefined = perm === 'read' || perm === 'write' ? perm : undefined
  const model = map.get('model')?.trim()
  const version = map.get('version')?.trim()
  const skillsRaw = (map.get('skills') ?? (arr.get('skills') ?? []).join(',')).trim()
  const skills = skillsRaw ? splitList(skillsRaw) : undefined
  const body = lines.slice(end + 1).join('\n').trim().slice(0, AGENT_BODY_MAX)

  return {
    ok: true,
    meta: {
      name, description,
      ...(model ? { model } : {}),
      ...(tools?.length ? { tools } : {}),
      ...(permission ? { permission } : {}),
      ...(version ? { version } : {}),
      ...(skills?.length ? { skills } : {}),
      ...(map.get('disable-model-invocation')?.trim() === 'true' ? { disableModelInvocation: true } : {}),
    },
    body,
  }
}

export function buildAgentMd(meta: AgentMeta, body: string): string {
  const lines = ['---', `name: ${meta.name}`, `description: ${meta.description}`]
  if (meta.version) lines.push(`version: ${meta.version}`)
  if (meta.skills?.length) lines.push(`skills: [${meta.skills.join(', ')}]`)
  if (meta.model) lines.push(`model: ${meta.model}`)
  if (meta.tools?.length) lines.push(`tools: [${meta.tools.join(', ')}]`)
  if (meta.permission) lines.push(`permission: ${meta.permission}`)
  if (meta.disableModelInvocation) lines.push('disable-model-invocation: true')
  lines.push('---', '', body.trim(), '')
  return lines.join('\n')
}

/** Agent 的工具白名单：不传 = 全部；传了就只有列表里的（收窄，不能扩权） */
/** Agent 不再限制工具：绑定后拥有全部工具（保留签名，永远放行） */
export function agentToolDeny(_name: string, _tools?: string[]): string | undefined {
  return undefined
}

export function buildAgentSection(def: AgentDef): string {
  const cap = def.tools?.length ? `\n${tr('可用工具仅限：{list}（调用其它工具会被拒绝）。', { list: def.tools.join(', ') })}` : ''
  return `${tr('## 当前 Agent：{name}', { name: def.name })}\n${def.description}\n${cap}\n\n${def.body}`
}

async function mdFiles(dir: string): Promise<string[]> {
  let names: string[]
  try { names = await readdir(dir) } catch { return [] }
  const out: string[] = []
  for (const n of names.sort()) {
    if (n.startsWith('.') || !n.toLowerCase().endsWith('.md')) continue
    out.push(join(dir, n))
    if (out.length >= AGENT_COUNT_MAX) break
  }
  return out
}

/**
 * 本地 Agent 库：用户级可编辑（<root>/<name>.md），项目内 / Claude / Codex 目录只读扫描。
 * 启用状态存 <root>/.agents.json（用户级默认启用，外部来源默认关闭）。
 */
export class LocalAgents {
  constructor(private root: string, private log?: (level: 'info' | 'warn', msg: string, data?: unknown) => void) {}

  private get stateFile(): string { return join(this.root, '.agents.json') }

  private async state(): Promise<Record<string, { enabled?: boolean }>> {
    try {
      const raw = JSON.parse(await readFile(this.stateFile, 'utf8')) as unknown
      return raw && typeof raw === 'object' ? (raw as Record<string, { enabled?: boolean }>) : {}
    } catch { return {} }
  }

  private async saveState(s: Record<string, { enabled?: boolean }>): Promise<void> {
    await mkdir(this.root, { recursive: true })
    await writeFile(this.stateFile, JSON.stringify(s, null, 2), 'utf8')
  }

  private dirs(workDir?: string): { origin: AgentOrigin; dir: string }[] {
    // 设置页只列「我的」（root）；项目内的 Agent 跟着项目走，只在那个项目的会话里出现。
    // ~/.claude、~/.codex 这些第三方目录不进列表 —— 它们只在「从第三方导入」弹窗里出现，导入后才归我所有
    const out: { origin: AgentOrigin; dir: string }[] = []
    const wd = workDir?.trim()
    if (wd) out.push(...ORIGIN_DIRS.map((d) => ({ origin: d.origin, dir: join(wd, ...d.rel) })))
    return out
  }

  /** 扫一个目录里的 md；解析失败也返回一条（error 有值），让用户看见哪个文件坏了 */
  private async scan(dir: string, origin: AgentOrigin): Promise<AgentDef[]> {
    const files = await mdFiles(dir)
    const out: AgentDef[] = []
    for (const file of files) {
      try {
        const st = await stat(file)
        if (st.size > AGENT_FILE_MAX) {
          out.push({ id: '', name: '', description: '', body: '', origin, file, enabled: false, external: origin !== 'user', error: tr('文件太大（{kb}KB，上限 {max}KB）', { kb: Math.round(st.size / 1024), max: AGENT_FILE_MAX / 1024 }) })
          continue
        }
        const p = parseAgentMd(await readFile(file, 'utf8'))
        if (!p.ok) {
          out.push({ id: '', name: `(${file.split(sep).pop() ?? ''})`, description: '', body: '', origin, file, enabled: false, external: origin !== 'user', error: p.error })
          continue
        }
        out.push({ id: '', ...p.meta, body: p.body, origin, file, enabled: false, external: origin !== 'user' })
      } catch (e) {
        this.log?.('warn', 'agent read failed', { file, err: String(e).slice(0, 200) })
      }
    }
    return out
  }

  async list(workDir?: string): Promise<AgentDef[]> {
    const st = await this.state()
    const out: AgentDef[] = []
    const byName = new Map<string, AgentDef>()

    for (const a of await this.scan(this.root, 'user')) {
      if (a.error) { out.push(a); continue }
      const def: AgentDef = { ...a, id: a.name, enabled: st[a.name]?.enabled ?? true }
      byName.set(def.name, def)
      out.push(def)
    }
    for (const { origin, dir } of this.dirs(workDir)) {
      for (const a of await this.scan(dir, origin)) {
        if (a.error) { out.push(a); continue }
        const id = `${a.name}@${origin}`
        // 用户级同名优先（用户自己写的那份是他明确要用的）
        // 项目内的 Agent 默认启用：它就在当前项目的目录里，跟着项目走、不需要再去设置里勾选；
        // ~/.claude、~/.codex 这类第三方用户目录仍默认关，避免别的工具留下的角色悄悄生效
        // 项目目录里的 .claude/agents、.codex/agents 也属于「这个项目」：一律启用，
        // 不看也写不进开关状态（这些不出现在设置页，没法关，也不该被历史开关挡住）；
        // 只有用户家目录下的第三方目录才默认关
        const wd = workDir?.trim()
        const inProject = origin === 'project' || (!!wd && dir.startsWith(wd))
        const def: AgentDef = { ...a, id, enabled: inProject ? true : (st[id]?.enabled ?? false) }
        // 同名的用户级版本已经占了位置：不再重复列出。
        // 否则「从第三方导入」之后会出现两条同名项，其中一条还是只读的第三方副本，看着像导入没生效
        if (byName.has(def.name)) continue
        byName.set(def.name, def)
        out.push(def)
      }
    }
    return out
  }

  /** 按 id 取：用户级 id = name；外部 = name@origin。找不到返回 undefined */
  async read(id: string, workDir?: string): Promise<AgentDef | undefined> {
    const all = await this.list(workDir)
    return all.find((a) => a.id === id && !a.error)
  }

  async save(input: AgentMeta & { body: string }, old?: string): Promise<void> {
    const name = input.name.trim()
    if (!AGENT_NAME.test(name) || name.length > 64) throw new Error(tr('name 只能用小写字母、数字和连字符（≤64 字）'))
    if (!input.description.trim()) throw new Error(tr('请填写描述（AI 靠它判断什么时候用这个 Agent）'))
    const file = join(this.root, `${name}.md`)
    if (old && old !== name) {
      const prev = join(this.root, `${old}.md`)
      const st = await this.state()
      const next = { ...st }
      delete next[old]
      next[name] = next[old] ?? { enabled: true }
      await this.saveState(next)
      await rm(prev, { force: true })
    }
    await mkdir(this.root, { recursive: true })
    await writeFile(file, buildAgentMd({ ...input, name }, input.body), 'utf8')
  }

  async remove(id: string): Promise<void> {
    if (id.includes('@')) throw new Error(tr('外部来源的 Agent 只能停用，不能删除（请在原目录里删）'))
    await rm(join(this.root, `${id}.md`), { force: true })
    const st = await this.state()
    if (st[id]) { const next = { ...st }; delete next[id]; await this.saveState(next) }
  }

  async setEnabled(id: string, enabled: boolean): Promise<void> {
    const st = await this.state()
    await this.saveState({ ...st, [id]: { enabled } })
  }

  get dir(): string { return this.root }
}
