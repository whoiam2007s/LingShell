// ── 快速命令栏（类 Xshell「快速命令」）──────────────────────
// 终端下方一排按钮，点一下把命令直接写进终端（不经 AI）。存 quick-commands.json，整份读写。
import { templateVars, fillTemplate } from '../ops/ops.js'
import { dangerCheck } from '../ai/danger.js'
import { tk, tr } from '../i18n/i18n.js'
import type { TerminalInfo, TermOs } from '../protocol/index.js'

export type QuickOs = Exclude<TermOs, 'unknown'>
export const QUICK_OS: QuickOs[] = ['linux', 'macos', 'windows']

// target：active = 当前终端；broadcast = 广播开着时发给广播组，否则同 active
// variants：按终端系统替换的版本；strict：仅在设置了版本的系统上可用（其它系统按钮置灰 / 广播跳过）
// scope：只在这些主机 / 分组显示（'local' = 本机终端，host:<主机 id>，group:<分组名>）；缺省 / 空 = 全部
// description：说明（悬停显示；AI 生成的快速命令会带）
export interface QuickCommand {
  id: string; label: string; command: string; appendEnter: boolean; target: 'active' | 'broadcast'
  variants?: Partial<Record<QuickOs, string>>; strict?: boolean
  scope?: string[]; description?: string
}
export interface QuickCommandSet { id: string; name: string; commands: QuickCommand[]; scope?: string[] }
// barVisible / activeSetId 也存在这里，免得为一个开关去动系统设置
export interface QuickCommandsData { sets: QuickCommandSet[]; activeSetId: string; barVisible: boolean }

// Windows 本地终端是 Git Bash：没有 free/uptime/ss，用 powershell 单行（单引号包住，bash 不展开 $）
const PS = (s: string) => `powershell.exe -NoProfile -Command '${s}'`
const WIN_MEM = PS(`$o=Get-CimInstance Win32_OperatingSystem; "Memory: total {0:N1} GB, free {1:N1} GB" -f ($o.TotalVisibleMemorySize/1MB),($o.FreePhysicalMemory/1MB)`)
const WIN_LOAD = PS(`"CPU load: {0}%" -f [math]::Round((Get-CimInstance Win32_Processor | Measure-Object LoadPercentage -Average).Average)`)

export const DEFAULT_QUICK_COMMANDS: QuickCommandsData = {
  activeSetId: 'qs_default', barVisible: true,
  sets: [{ id: 'qs_default', name: tk('常用'), commands: [
    { id: 'qc_df', label: tk('查看磁盘'), command: 'df -h', appendEnter: true, target: 'active' },
    { id: 'qc_free', label: tk('内存'), command: 'free -h', appendEnter: true, target: 'active', variants: { macos: 'top -l 1 | grep PhysMem', windows: WIN_MEM } },
    { id: 'qc_uptime', label: tk('负载'), command: 'uptime', appendEnter: true, target: 'active', variants: { windows: WIN_LOAD } },
    { id: 'qc_ports', label: tk('监听端口'), command: 'ss -lntp', appendEnter: true, target: 'active', variants: { macos: 'lsof -nP -iTCP -sTCP:LISTEN', windows: 'netstat -ano | grep LISTENING' } },
  ] }],
}

// 旧版内置默认（只有一条命令，不分系统）：仍是原样的就地升级成新版
const LEGACY: Record<string, string> = { qc_df: 'df -h', qc_free: 'free -h', qc_uptime: 'uptime' }

/** 旧版内置默认命令升级：命令仍是旧默认且没设过版本的换成新版；默认组还是原样（三条旧默认）才补「监听端口」。
 *  用户改过的一律不动。返回 null = 无需升级（幂等） */
export function migrateQuickCommands(d: QuickCommandsData): QuickCommandsData | null {
  const builtin = new Map(DEFAULT_QUICK_COMMANDS.sets[0].commands.map((c) => [c.id, c]))
  const pristine = (c: QuickCommand) => LEGACY[c.id] === c.command && !c.variants && !c.strict
  let changed = false
  const sets = d.sets.map((s) => {
    const untouched = s.id === 'qs_default' && s.commands.length === 3 && s.commands.every((c, i) => c.id === Object.keys(LEGACY)[i] && pristine(c))
    let commands = s.commands.map((c) => {
      const nu = builtin.get(c.id)
      if (!nu?.variants || !pristine(c)) return c
      changed = true
      return { ...c, variants: { ...nu.variants } }
    })
    if (untouched && !commands.some((c) => c.id === 'qc_ports')) {
      changed = true
      commands = [...commands, structuredClone(builtin.get('qc_ports')!)]
    }
    return { ...s, commands }
  })
  return changed ? { ...d, sets } : null
}

export const newQuickId = (p: 'qc' | 'qs') => `${p}_${Math.random().toString(36).slice(2, 10)}`

/** 校验并规整整份数据：名称不能为空、默认命令与各系统版本至少有一条（抛错）；缺 id 补上、重复 id 换新；
 *  activeSetId 指向不存在的组则回退第一组；至少保留一组 */
export function normalizeQuickCommands(input: Partial<QuickCommandsData> | null | undefined): QuickCommandsData {
  const seen = new Set<string>()
  const uid = (id: unknown, p: 'qc' | 'qs') => { let v = typeof id === 'string' && id ? id : newQuickId(p); if (seen.has(v)) v = newQuickId(p); seen.add(v); return v }
  const sets: QuickCommandSet[] = (Array.isArray(input?.sets) ? input.sets : []).map((s) => {
    const name = String(s?.name ?? '').trim()
    if (!name) throw new Error(tr('命令组名称不能为空'))
    const commands = (Array.isArray(s.commands) ? s.commands : []).map((c) => {
      const label = String(c?.label ?? '').trim(), command = String(c?.command ?? '').replace(/\s+$/, '')
      const variants: Partial<Record<QuickOs, string>> = {}
      for (const os of QUICK_OS) { const v = String(c?.variants?.[os] ?? '').replace(/\s+$/, ''); if (v.trim()) variants[os] = v }
      const hasV = Object.keys(variants).length > 0
      if (!label || (!command.trim() && !hasV)) throw new Error(tr('「{name}」里有命令缺少名称或内容', { name }))
      const scope = normalizeQuickScope(c.scope), description = String(c?.description ?? '').trim()
      return {
        id: uid(c.id, 'qc'), label, command: command.trim() ? command : '', appendEnter: c.appendEnter !== false, target: c.target === 'broadcast' ? 'broadcast' : 'active',
        ...(hasV ? { variants } : {}), ...(hasV && c.strict === true ? { strict: true } : {}),
        ...(scope ? { scope } : {}), ...(description ? { description } : {}),
      } as QuickCommand
    })
    const scope = normalizeQuickScope(s.scope)
    return { id: uid(s.id, 'qs'), name, commands, ...(scope ? { scope } : {}) }
  })
  if (!sets.length) sets.push({ id: newQuickId('qs'), name: tk('常用'), commands: [] })
  const activeSetId = sets.some((s) => s.id === input?.activeSetId) ? input!.activeSetId! : sets[0].id
  return { sets, activeSetId, barVisible: input?.barVisible !== false }
}

/** 按终端系统取实际要发的命令：有该系统版本用版本；strict 且设了版本 → 其它系统不可用；否则用默认命令。
 *  unknown 系统：有默认命令就用默认（strict 也一样，探测不到不代表不能用），没有默认命令 → 不可用 */
export function resolveQuickCommand(cmd: Pick<QuickCommand, 'command' | 'variants' | 'strict'>, os?: TermOs): { command: string } | { unsupported: true } {
  const v = os && os !== 'unknown' ? cmd.variants?.[os] : undefined
  if (v) return { command: v }
  const known = !!os && os !== 'unknown'
  if (known && cmd.strict && Object.keys(cmd.variants ?? {}).length) return { unsupported: true }
  return cmd.command ? { command: cmd.command } : { unsupported: true }
}

/** 命令要发往的终端 id：广播目标且广播开着 → 组内成员，否则当前终端；断开 / AI 占用的跳过 */
export function quickTargets(cmd: Pick<QuickCommand, 'target'>, activeId: string, terms: TerminalInfo[], bcast: ReadonlySet<string> | null): TerminalInfo[] {
  const ids = cmd.target === 'broadcast' && bcast ? bcast : new Set([activeId])
  return terms.filter((t) => ids.has(t.id) && t.status !== 'disconnected' && !t.locked)
}

export interface QuickSendPlan {
  sends: { term: TerminalInfo; text: string }[]   // 每个终端按自己的系统解析、填参数后实际写入的内容
  unsupported: TerminalInfo[]                     // 该系统不可用（strict）→ 跳过
  missing: string[]                               // 还没填的参数（各终端实际要发的命令合起来）
  confirmProd: string[]                           // 生产终端且它要收到的命令危险（需二次确认）
}

/** 填参数后的发送计划 */
export function planQuickSend(cmd: Pick<QuickCommand, 'command' | 'appendEnter' | 'variants' | 'strict'>, values: Record<string, string>, targets: TerminalInfo[]): QuickSendPlan {
  const plan: QuickSendPlan = { sends: [], unsupported: [], missing: [], confirmProd: [] }
  for (const t of targets) {
    const r = resolveQuickCommand(cmd, t.os)
    if ('unsupported' in r) { plan.unsupported.push(t); continue }
    const command = fillTemplate(r.command, values)
    for (const k of templateVars(command)) if (!plan.missing.includes(k)) plan.missing.push(k)   // 没填的占位符还留在命令里
    if (t.env === 'prod' && dangerCheck(command) === 'dangerous') plan.confirmProd.push(t.title)
    plan.sends.push({ term: t, text: command + (cmd.appendEnter ? '\r' : '') })
  }
  return plan
}

/** 这次发送要填的参数（只算会真正发出去的那些版本） */
export const quickVars = (cmd: Parameters<typeof planQuickSend>[0], targets: TerminalInfo[]) => planQuickSend(cmd, {}, targets).missing

// ── 显示范围（按主机 / 分组限定，参考 tabby-quick-cmds）──
const SCOPE_RE = /^(local|host:.+|group:.+)$/
/** 规整显示范围：只留认得的项、去重；空 = undefined（全部主机） */
export function normalizeQuickScope(v: unknown): string[] | undefined {
  const out = [...new Set((Array.isArray(v) ? v : []).map((x) => String(x ?? '').trim()).filter((x) => SCOPE_RE.test(x)))]
  return out.length ? out : undefined
}
/** 当前终端在显示范围里的身份：本地终端 = 本机；SSH 已保存主机 = 主机 id + 分组；临时 SSH 连接只匹配「全部」 */
export interface QuickScopeCtx { local: boolean; hostId?: string; group?: string }
export function quickScopeCtx(t: Pick<TerminalInfo, 'type' | 'hostId'> | undefined, hosts: { id: string; group?: string }[]): QuickScopeCtx | undefined {
  if (!t) return undefined
  if (t.type === 'local') return { local: true }
  const g = t.hostId ? hosts.find((h) => h.id === t.hostId)?.group?.trim() : undefined
  return { local: false, ...(t.hostId ? { hostId: t.hostId } : {}), ...(g ? { group: g } : {}) }
}
/** 范围空 = 全部；没有当前终端时不过滤 */
export function quickScopeMatch(scope: readonly string[] | undefined, ctx: QuickScopeCtx | undefined): boolean {
  if (!scope?.length || !ctx) return true
  return scope.some((s) => s === 'local' ? ctx.local
    : s.startsWith('host:') ? !!ctx.hostId && s.slice(5) === ctx.hostId
    : s.startsWith('group:') ? !!ctx.group && s.slice(6) === ctx.group : false)
}
/** 范围的一行说明（编辑表单 / 悬停）：本机、主机名、「分组 web」 */
export function quickScopeLabel(scope: readonly string[] | undefined, hosts: { id: string; label: string }[]): string {
  if (!scope?.length) return tr('全部主机')
  return scope.map((s) => s === 'local' ? tr('qc|本机') : s.startsWith('host:') ? hosts.find((h) => h.id === s.slice(5))?.label ?? s.slice(5) : tr('分组 {name}', { name: s.slice(6) })).join(tr('list|、'))
}
