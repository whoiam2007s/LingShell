// SKILL.md 读写（纯函数，便于测试）：YAML frontmatter（name / description / 可选 whenToUse、invocation 两个开关）+ 正文。
// 不引入 yaml 依赖：只解析 skill 用得到的顶层标量（含引号串、| / > 块），其它键（metadata、license…）原样保留、写回时不丢。
// 规则与 dsh-skill-filesystem 一致：name 须 kebab-case；两个 invocation 开关只认布尔值，写错整条 skill 作废（fail closed）。
import { tr } from '@lingshell/shared'

export const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
export const isSkillName = (s: string): boolean => s.length <= 64 && SKILL_NAME.test(s)

export interface SkillMeta {
  name: string
  description: string
  whenToUse?: string
  disableModelInvocation?: boolean   // frontmatter `disable-model-invocation: true` → 不给 AI 自动调用
  userInvocable?: boolean            // frontmatter `user-invocable: false` → 不出现在「+ → Skills」
}

export type ParsedSkill = { ok: true; meta: SkillMeta; body: string; extra: string[] } | { ok: false; error: string }

interface Entry { key: string; value?: string; raw: string[] }

const BOOL: Record<string, boolean> = { true: true, yes: true, on: true, '1': true, false: false, no: false, off: false, '0': false }

function unquote(v: string): string {
  if (v.startsWith('"')) { try { return JSON.parse(v) as string } catch { return v.slice(1, v.endsWith('"') ? -1 : undefined) } }
  if (v.startsWith("'")) return v.slice(1, v.endsWith("'") ? -1 : undefined).replace(/''/g, "'")
  return v.replace(/\s+#.*$/, '')   // 普通标量去行尾注释
}

// 顶层键逐个切开：键行 + 其后缩进/空行（块标量、嵌套映射、续行）
function entries(lines: string[]): Entry[] {
  const out: Entry[] = []
  for (const line of lines) {
    const m = /^([A-Za-z_][\w-]*)\s*:(.*)$/.exec(line)
    if (m) { out.push({ key: m[1], raw: [line], value: m[2].trim() }); continue }
    const cur = out[out.length - 1]
    if (cur) cur.raw.push(line)
  }
  for (const e of out) e.value = scalarOf(e)
  return out
}

function scalarOf(e: Entry): string | undefined {
  const head = e.value ?? ''
  const rest = e.raw.slice(1)
  const block = /^([|>])[+-]?\d*\s*(#.*)?$/.exec(head)
  if (block) {
    const lines = rest.map((l) => l.replace(/\s+$/, ''))
    while (lines.length && !lines[lines.length - 1]) lines.pop()
    const indent = Math.min(...lines.filter(Boolean).map((l) => /^\s*/.exec(l)![0].length))
    const body = lines.map((l) => l.slice(Number.isFinite(indent) ? indent : 0))
    return block[1] === '|' ? body.join('\n') : body.join('\n').replace(/([^\n])\n(?!\n)/g, '$1 ').replace(/\n\n/g, '\n')
  }
  const cont = rest.filter((l) => !/^\s*#/.test(l)).map((l) => l.trim()).filter(Boolean)   // 续行（去注释行）
  if (!head) return cont.length ? undefined : ''   // 空值后跟缩进内容 = 嵌套结构，不当标量
  if (head.startsWith('"') || head.startsWith("'")) return unquote([head, ...cont].join(' '))   // 引号串可跨行
  return [unquote(head), ...cont].join(' ')
}

/** 解析 SKILL.md 全文 */
export function parseSkillMd(text: string): ParsedSkill {
  const src = (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text).replace(/\r\n?/g, '\n')
  const lines = src.split('\n')
  if (lines[0]?.trim() !== '---') return { ok: false, error: tr('SKILL.md 缺少开头的 YAML frontmatter（第一行应为 ---）') }
  const end = lines.findIndex((l, i) => i > 0 && /^(---|\.\.\.)\s*$/.test(l))
  if (end < 0) return { ok: false, error: tr('SKILL.md 的 frontmatter 没有结束的 ---') }
  const es = entries(lines.slice(1, end))
  const get = (k: string) => es.find((e) => e.key === k)
  const name = get('name')?.value?.trim() ?? ''
  if (!name) return { ok: false, error: tr('frontmatter 缺少 name') }
  if (!isSkillName(name)) return { ok: false, error: tr('name「{name}」不合法：只能用小写字母、数字和连字符（如 nginx-check），最长 64 字符', { name }) }
  const description = get('description')?.value?.trim() ?? ''
  if (!description) return { ok: false, error: tr('frontmatter 缺少 description') }
  const meta: SkillMeta = { name, description }
  const when = get('whenToUse') ?? get('when_to_use')
  if (typeof when?.value === 'string' && when.value.trim()) meta.whenToUse = when.value.trim()
  for (const [key, field, camel] of [['disable-model-invocation', 'disableModelInvocation', 'disableModelInvocation'], ['user-invocable', 'userInvocable', 'userInvocable']] as const) {
    if (get(camel)) return { ok: false, error: tr('frontmatter 请写 {key}（不是 {camel}）', { key, camel }) }
    const e = get(key)
    if (!e) continue
    const b = BOOL[String(e.value ?? '').trim().toLowerCase()]
    if (b === undefined) return { ok: false, error: tr('{key} 只能是 true / false', { key }) }
    meta[field] = b
  }
  const known = new Set(['name', 'description', 'whenToUse', 'when_to_use', 'disable-model-invocation', 'user-invocable'])
  const extra = es.filter((e) => !known.has(e.key)).flatMap((e) => e.raw)
  const body = lines.slice(end + 1).join('\n').replace(/^\n+/, '').replace(/\s+$/, '')
  return { ok: true, meta, body, extra }
}

/** 生成 SKILL.md。字符串用 JSON 双引号写（合法 YAML），extra 是原文件里的其它键（原样保留） */
export function buildSkillMd(meta: SkillMeta, body: string, extra: string[] = []): string {
  const lines = ['---', `name: ${meta.name}`, `description: ${JSON.stringify(meta.description.trim())}`]
  if (meta.whenToUse) lines.push(`whenToUse: ${JSON.stringify(meta.whenToUse)}`)
  if (meta.disableModelInvocation !== undefined) lines.push(`disable-model-invocation: ${meta.disableModelInvocation}`)
  if (meta.userInvocable !== undefined) lines.push(`user-invocable: ${meta.userInvocable}`)
  while (extra.length && !extra[extra.length - 1].trim()) extra = extra.slice(0, -1)
  lines.push(...extra, '---', '', body.trim(), '')
  return lines.join('\n')
}
