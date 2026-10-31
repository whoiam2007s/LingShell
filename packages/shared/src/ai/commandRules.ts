// 命令放行 / 询问 / 禁止规则（设置 → AI 与安全 → 命令规则，参考 VS Code chat.tools.terminal.autoApprove）。
// 判定插在 AI 执行终端命令的授权判定之前：复合命令拆段逐段匹配，任一段命中「禁止」→ 禁止；
// 所有段都命中「放行」→ 放行；有段命中「询问」→ 弹授权卡；否则走原有信任档逻辑。
// 与 danger.ts 一样是启发式（变量拼接 / eval / base64 能绕过），挡手滑、省点击，不对抗恶意。
import { tk, tr } from '../i18n/i18n.js'

export type CommandRuleMatch = 'prefix' | 'regex'
export type CommandRuleAction = 'allow' | 'ask' | 'deny'
export type CommandRuleScope = 'all' | 'groups' | 'hosts'

export interface CommandRule {
  id: string
  match: CommandRuleMatch
  pattern: string            // 前缀：命令段以它开头（区分大小写，含空格照算）；正则：在命令段里搜索（要锚定开头请写 ^）
  action: CommandRuleAction
  scope: CommandRuleScope
  groups?: string[]          // scope=groups：主机分组名
  hosts?: string[]           // scope=hosts：hostKey（'local' = 本地终端，其余为已保存主机 id）
  note?: string
}

export const RULE_ACTION_LABEL: Record<CommandRuleAction, string> = { allow: tk('总是放行'), ask: tk('总是询问'), deny: tk('总是禁止') }

/** 规则的一行描述（执行记录 / 授权卡里「按规则：…」用） */
export function ruleLabel(r: CommandRule): string {
  return `${r.match === 'prefix' ? tr('前缀') : tr('正则')} ${r.pattern} · ${tr(RULE_ACTION_LABEL[r.action])}${r.note?.trim() ? tr('（{note}）', { note: r.note.trim() }) : ''}`
}

/** 正则不合法返回错误文案（该规则不生效），否则 undefined */
export function ruleError(r: Pick<CommandRule, 'match' | 'pattern'>): string | undefined {
  if (!r.pattern) return tr('模式为空，此规则不生效')
  if (r.match !== 'regex') return undefined
  try { new RegExp(r.pattern); return undefined } catch (e) { return tr('正则不合法：{v}', { v: e instanceof Error ? e.message : String(e) }) }
}

// 从 open（'(' 的下标）找配对的 ')'，跳过引号；找不到返回末尾
function closeParen(s: string, open: number): number {
  let depth = 0
  for (let i = open; i < s.length; i++) {
    const c = s[i]
    if (c === '\\') { i++; continue }
    if (c === "'") { const j = s.indexOf("'", i + 1); i = j < 0 ? s.length : j; continue }
    if (c === '"') { i = closeQuote(s, i); continue }
    if (c === '(') depth++
    else if (c === ')' && --depth === 0) return i
  }
  return s.length
}
function closeQuote(s: string, open: number): number {
  for (let i = open + 1; i < s.length; i++) {
    if (s[i] === '\\') { i++; continue }
    if (s[i] === '$' && s[i + 1] === '(') { i = closeParen(s, i + 1); continue }
    if (s[i] === '"') return i
  }
  return s.length
}
function closeTick(s: string, open: number): number {
  for (let i = open + 1; i < s.length; i++) {
    if (s[i] === '\\') { i++; continue }
    if (s[i] === '`') return i
  }
  return s.length
}

// 段首尾的子 shell / 命令组括号去掉：`( cd x && rm y )` 拆出来是 `( cd x` 和 `rm y )`。
// 结尾的 ) } 只在不配对时去（$(…)、${…} 里的不动）
const count = (s: string, c: string) => s.split(c).length - 1
function tidy(seg: string): string {
  let s = seg.trim().replace(/^[({\s]+/, '').replace(/^!\s+/, '')
  while (/[)}]\s*$/.test(s)) {
    const t = s.trimEnd()
    const [o, c] = t.endsWith(')') ? ['(', ')'] : ['{', '}']
    if (count(t, c) <= count(t, o)) break
    s = t.slice(0, -1)
  }
  return s.trim()
}

/**
 * 把复合命令拆成逐条命令段：按 ; && || | |& & 换行 分隔（引号内不拆；2>&1、&> 这类重定向不算分隔），
 * $( ) 与反引号里的子命令（含双引号里的）另作为独立段递归拆出——它们一样会被执行。
 */
export function splitCommand(cmd: string): string[] {
  const out: string[] = []
  const subs: string[] = []
  let cur = ''
  const push = () => { const t = tidy(cur); if (t) out.push(t); cur = '' }
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i]
    if (c === '\\') { cur += cmd.slice(i, i + 2); i++; continue }
    if (c === "'") {
      const j = cmd.indexOf("'", i + 1)
      const end = j < 0 ? cmd.length - 1 : j
      cur += cmd.slice(i, end + 1); i = end; continue
    }
    if (c === '"') {
      const end = closeQuote(cmd, i)
      const body = cmd.slice(i + 1, end)
      // 双引号里的 $( ) / 反引号照样执行
      for (let k = 0; k < body.length; k++) {
        if (body[k] === '\\') { k++; continue }
        if (body[k] === '$' && body[k + 1] === '(') { const e = closeParen(body, k + 1); subs.push(...splitCommand(body.slice(k + 2, e))); k = e; continue }
        if (body[k] === '`') { const e = closeTick(body, k); subs.push(...splitCommand(body.slice(k + 1, e))); k = e }
      }
      cur += cmd.slice(i, end + 1); i = end; continue
    }
    if (c === '$' && cmd[i + 1] === '(') {
      const end = closeParen(cmd, i + 1)
      // $(( )) 是算术展开，不是命令
      if (cmd[i + 2] !== '(') subs.push(...splitCommand(cmd.slice(i + 2, end)))
      cur += cmd.slice(i, end + 1); i = end; continue
    }
    if (c === '`') {
      const end = closeTick(cmd, i)
      subs.push(...splitCommand(cmd.slice(i + 1, end)))
      cur += cmd.slice(i, end + 1); i = end; continue
    }
    if (c === '<' && cmd[i + 1] === '(') {   // 进程替换 <( )
      const end = closeParen(cmd, i + 1)
      subs.push(...splitCommand(cmd.slice(i + 2, end)))
      cur += cmd.slice(i, end + 1); i = end; continue
    }
    if (c === ';' || c === '\n') { push(); continue }
    if (c === '|') { push(); if (cmd[i + 1] === '|' || cmd[i + 1] === '&') i++; continue }
    if (c === '&') {
      if (cmd[i + 1] === '&') { push(); i++; continue }
      // >&、<&、&> 是重定向
      const prev = cur.trimEnd().slice(-1)
      if (prev === '>' || prev === '<' || cmd[i + 1] === '>') { cur += c; continue }
      push(); continue
    }
    cur += c
  }
  push()
  return [...out, ...subs]
}

export interface RuleContext { hostKey: string; group?: string }

function inScope(r: CommandRule, ctx: RuleContext): boolean {
  if (r.scope === 'groups') return !!ctx.group?.trim() && (r.groups ?? []).includes(ctx.group.trim())
  if (r.scope === 'hosts') return (r.hosts ?? []).includes(ctx.hostKey)
  return true
}

function matches(r: CommandRule, seg: string): boolean {
  if (r.match === 'prefix') return seg.startsWith(r.pattern)
  try { return new RegExp(r.pattern).test(seg) } catch { return false }
}

export interface RuleVerdict { action: CommandRuleAction; rule: CommandRule; segment: string }

/**
 * 按规则判定一条命令。无适用规则 / 没有任何定论返回 undefined（走原有信任档）。
 * 每段取第一条命中的规则（列表靠前的先生效）。
 */
export function evaluateCommandRules(rules: CommandRule[] | undefined, command: string, ctx: RuleContext): RuleVerdict | undefined {
  const usable = (rules ?? []).filter((r) => !ruleError(r) && inScope(r, ctx))
  if (!usable.length) return undefined
  const segs = splitCommand(command)
  if (!segs.length) return undefined
  const hits = segs.map((segment) => ({ segment, rule: usable.find((r) => matches(r, segment)) }))
  const deny = hits.find((h) => h.rule?.action === 'deny')
  if (deny) return { action: 'deny', rule: deny.rule!, segment: deny.segment }
  if (hits.every((h) => h.rule?.action === 'allow')) return { action: 'allow', rule: hits[0].rule!, segment: hits[0].segment }
  const ask = hits.find((h) => h.rule?.action === 'ask')
  if (ask) return { action: 'ask', rule: ask.rule!, segment: ask.segment }
  return undefined
}

type Base = { kind: 'allow' } | { kind: 'deny'; reason: string } | { kind: 'prompt'; reason: string; risk: 'safe' | 'dangerous' }
export type RuledDecision =
  | { kind: 'allow'; rule?: string }
  | { kind: 'deny'; reason: string; rule?: string }
  | { kind: 'prompt'; reason: string; risk: 'safe' | 'dangerous'; rule?: string }

/**
 * 把规则判定叠到原有授权决策上（base 惰性求值）：
 *  - 禁止：直接拒（原因写明规则）；
 *  - 放行：免卡。但只读信任档不突破；生产主机上的危险命令仍按原逻辑确认（不标规则）；
 *  - 询问：原本要问的照问（标上规则）；原本放行的改成弹卡；原本拒绝的仍拒。
 */
export function applyRuleVerdict(v: RuleVerdict | undefined, base: () => Base, o: { prod: boolean; readonly: boolean; dangerous: boolean }): RuledDecision {
  if (!v) return base()
  const rule = ruleLabel(v.rule)
  if (v.action === 'deny') return { kind: 'deny', reason: tr('按规则：{rule}', { rule }), rule }
  const b = base()
  if (v.action === 'allow') {
    if (o.readonly || (o.prod && o.dangerous)) return b
    return { kind: 'allow', rule }
  }
  if (b.kind === 'deny') return b
  if (b.kind === 'prompt') return { ...b, rule }
  return { kind: 'prompt', reason: 'elevation', risk: o.dangerous ? 'dangerous' : 'safe', rule }
}
