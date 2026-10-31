/* eslint-disable @typescript-eslint/no-explicit-any */
// 我方终端能力的 dsh 插件形态：工具注册 + 授权网关。
//
// 与旧 MCP 版（CodeWhale 时期的 mcp-bridge，已删除）的关键差别：**授权不再写在工具体内**。
// dsh 的 tools/pre-execute 是原生的 allow/deny/ask 三态网关，看得到工具名、入参和
// 发起调用的 agent，所以鉴权整体上移到网关，工具体只管干活。少一层协议、少一半代码。
import { randomBytes } from 'node:crypto'
import type { AuthLevel, HostEnv, FleetHost, FleetRow, KnowledgeScope, AiReviewResult } from '@lingshell/shared'
import { resolveFleetTargets, summarizeFleet, clampInt, FLEET_MAX_HOSTS, FLEET_DEFAULT_TIMEOUT_SEC, FLEET_MAX_TIMEOUT_SEC, FLEET_DECISION, KNOWLEDGE_CATEGORIES, normalizeQuickProposal, runbookFromProposal, tr, tk } from '@lingshell/shared'
import { unifiedDiff } from './diff.js'
import { withRedaction, type SecretsFn } from './redaction.js'
import { wireOf, type SecretVault } from './secretVault.js'

// 只依赖形状不依赖实现，便于测试注入假对象
export interface TerminalLike {
  // shell / manualOnly：本地 PowerShell / cmd / 探测没通过的 WSL 是「仅手动」终端，往里发命令的工具直接拒绝
  list(): { id: string; title: string; type: string; status: string; locked: boolean; os?: string; shell?: string; manualOnly?: boolean }[]
  readSnapshot(terminalId: string, lines: number): string
  // opts.wire：实际发进 shell 的命令（密钥保险箱占位符已换成明文）；command 是占位符原文（回显 / 命令历史）
  // opts.silent：不回显命令 / 输出、不记命令历史（后台任务没有旁路通道时用，见 sideExec）
  execCapture(terminalId: string, command: string, signal?: AbortSignal, timeoutMs?: number, opts?: { wire?: string; silent?: boolean }): Promise<{ output: string; exitCode: number; truncated?: boolean }>
}

export interface AuditRecord {
  sessionId: string
  terminalId: string   // 原始终端 id（主机标识由主进程按需解析）
  command?: string
  decision: string; exitCode?: number; truncated?: boolean
  filePath?: string; backupPath?: string   // write_file：改了哪个文件、原文件备份在哪（执行记录据此「还原」）
  mcpServer?: string; mcpTool?: string     // MCP 工具调用（terminalId 为空）
  created?: boolean; afterHash?: string    // write_file：本次是新建 / 写入内容摘要（按回合撤销用）
  rule?: string                            // 按命令规则放行 / 询问的：规则描述
  dshId?: string; turnId?: string          // 所属 dsh 会话与轮次（DshController 统一补，工具体不用管）
  rollback?: string; rollbackNote?: string // exec_in_terminal：AI 给的回滚命令与说明（执行记录据此「一键回滚」）
  callId?: string                          // 工具调用 id：对话里的工具卡片据此找到这条记录
  hostKey?: string; terminalTitle?: string // 不经终端的（run_on_hosts）：直接给主机 id 与名字
  review?: AiReviewResult                  // AI 复核结果（授权 / 执行记录里显示）
}

/** AI 提议知识卡的请求（工具已把 terminal_id 解析成 hostKey）；主进程补全归属、校验后发卡片给 UI */
export interface KnowledgeProposalReq {
  cardId?: string; scope?: KnowledgeScope; target?: string
  title: string; content: string; category?: string
}

// deny=拒绝并附原因；command=改过的命令；fail=授权前就已失败（如 write_file 预览出错），原样抛给模型；
// base=write_file 授权卡展示 diff 时的原文（null=文件不存在），写入前比对，变了就不写；
// rule=按命令规则放行 / 询问（执行记录里注明）
export interface UserOverride { deny?: string; command?: string; fail?: string; base?: string | null; rule?: string; review?: AiReviewResult }

export interface TerminalToolDeps {
  terminals: TerminalLike
  // 把 terminalId 解析成授权粒度（'local' | hostId | 'host:port'）
  resolveHostKey(terminalId: string): string
  // 纯决策：不做 IO、不弹窗（AuthRegistry.decide 的形状）
  // rule：命中的命令规则（放行 / 询问 / 禁止），执行记录与授权卡上注明
  decide(sessionId: string, hostKey: string, needed: 'read' | 'write', command?: string): { kind: 'allow'; rule?: string } | { kind: 'deny'; reason: string; rule?: string } | { kind: 'prompt'; reason: string; risk: string; rule?: string }
  // 用户点了「允许」之后落记录（危险命令一次性放行时不调）
  grant(sessionId: string, hostKey: string, level: AuthLevel): void
  audit(rec: AuditRecord): void
  createLocalTerminal?(sessionId: string): Promise<{ terminalId: string; title: string }>
  createSshTerminal?(sessionId: string, hostId: string): Promise<{ terminalId: string; title: string }>
  uploadFile?(localPath: string, terminalId: string, targetDir: string): Promise<{ host: string; encrypted: boolean }>
  // 文件读写走终端所在主机（本地 fs / SSH 的 SFTP），不经交互终端。readFile 不存在返回 undefined
  readFile?(terminalId: string, path: string): Promise<string | undefined>
  // 覆盖前先备份原文件；返回实际写入的路径与备份路径（新建文件无备份）
  writeFile?(terminalId: string, path: string, content: string): Promise<{ path: string; backupPath?: string; hash?: string }>
  downloadFile?(terminalId: string, remotePath: string): Promise<{ localPath: string }>
  execTimeoutMs?(): number
  // dsh agent id → 我方会话 id（上下文重置后两者不同；缺省视为相同）
  sessionIdOf?(agentId: string): string
  // 取走用户在授权卡上对这次调用的改动：deny=拒绝并附原因，command=改过的命令
  takeUserOverride?(callId: string): UserOverride | undefined
  // 终端所在主机的分级与知识卡标题（无则空对象），随 list_terminals / create_terminal 输出给模型
  hostMeta?(terminalId: string): { env?: HostEnv; knowledge?: string[] }
  // 终端最近已知的当前目录（提示符上报 / 上次 pwd 的缓存，不触发探测）：随 list_terminals 和系统提示给模型，省掉只为「在哪个目录」跑 pwd
  terminalCwd?(terminalId: string): string | undefined
  // AI 提议新增 / 更新知识卡：只发卡片给 UI，不落盘。归属不合法（临时主机、分组不存在、卡片不存在）时抛错
  proposeKnowledge?(sessionId: string, req: KnowledgeProposalReq): { targetLabel: string }
  // 跨主机提问：可访问的已保存主机（只有名称 / id / 分组 / 环境）、并行执行、只读判定
  fleetHosts?(): FleetHost[]
  // sessionId：主进程据此判断是不是无人值守会话（巡检）：无人值守时临时连接遇到未知指纹直接失败，不弹确认框
  runOnHosts?(hosts: FleetHost[], command: string, timeoutMs: number, signal?: AbortSignal, sessionId?: string): Promise<FleetRow[]>
  isReadOnly?(command: string): boolean
  log?(level: 'debug' | 'info' | 'warn' | 'error', message: string, data?: unknown): void
  // 发给 AI 前脱敏：已知机密明文；返回 undefined = 脱敏关闭（见 redaction.ts）
  aiSecrets?: SecretsFn
  // 命令是否确定只读（只读白名单）：非只读的 exec_in_terminal 要求带回滚方案。缺省 = 不检查
  isReadOnly?(command: string): boolean
  // 改动类工具真正执行前调（变更保险：首次改某台主机前拍快照）。command 缺省 = 文件写入 / 上传；实现方自己限时、不抛
  beforeChange?(sessionId: string, terminalIds: string[], command?: string): Promise<void>
  // 密钥保险箱（见 secretVault.ts）：exec 类命令里的 {{secret:名称}} 发进终端前展开、工具结果回写成占位符。缺省 = 不支持
  secretVault?: SecretVault
  // 后台任务（start_background / check_background）的旁路通道：不经用户的交互终端（SSH = 同连接上的独立 exec channel，本地 = 子进程），
  // 终端里不出现包装命令、也不占用终端。cwd=true：先进入该终端的当前目录。
  // 返回 undefined = 这个终端没有旁路（如 WSL）；抛错 = 通道开不出来。两种情况都退回交互终端里静默执行（不回显、不进历史）
  sideExec?(terminalId: string, command: string, o: { timeoutMs: number; signal?: AbortSignal; cwd?: boolean }): Promise<{ output: string; exitCode: number } | undefined>
}

// 工具名 → 需要的权限档；不在表里的（list_terminals / create_terminal）无需授权
const NEEDS: Record<string, 'read' | 'write'> = {
  read_terminal: 'read',
  exec_in_terminal: 'write',
  exec_on_terminals: 'write',  // 多主机：每台目标主机都要过授权（见 decideMulti）
  upload_file: 'write',
  start_background: 'write',   // 与 exec_in_terminal 同档：args.command 照样过危险命令检查
  check_background: 'read',
  read_file: 'read',
  write_file: 'write',
  download_file: 'read',
  run_on_hosts: 'read',        // 只读命令（不是只读直接拒），每台目标主机都要读取授权（见 decideFleet）
}
// 已有授权也逐次确认（一次性，不升级）：上传/下载能把文件在本机与主机间搬运（外泄风险）。
// write_file 不在此列：覆盖前自动备份、可一键还原，按信任档走（首次写入/确认档/生产主机仍弹卡看 diff），
// 否则同一文件连改几处就要连点几次。
const ALWAYS_ASK = new Set(['upload_file', 'download_file'])

// 可被 turn 取消打断的等待（用户点停止不必干等）
function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new Error('aborted'))
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve() }, ms)
    const onAbort = () => { clearTimeout(t); reject(new Error('aborted')) }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

const DIFF_MAX_LINES = 150
function truncateLines(text: string, max: number): string {
  const lines = text.split('\n')
  return lines.length <= max ? text : `${lines.slice(0, max).join('\n')}\n${tr('… （还有 {n} 行未显示）', { n: lines.length - max })}`
}

export function neededFor(toolName: string): 'read' | 'write' { return NEEDS[toolName] ?? 'write' }

/**
 * 单次调用实际需要的权限档：exec 类工具能跑任意命令，静态表里是 write；
 * 但命令命中只读白名单（pwd / ls / cat / df …，与巡检同一套判定）时按 read 授权，
 * 免得第一次执行 `pwd` 就把整台主机升成写入授权。非只读命令仍是 write。
 * isReadOnly 没注入（部分单测 / 嵌入场景）时保持静态表。
 */
export function neededForCall(deps: Pick<TerminalToolDeps, 'isReadOnly'>, toolName: string, args: unknown): 'read' | 'write' {
  const n = NEEDS[toolName] ?? 'write'
  // start_background 会留下一个持续运行的进程，即使命令本身只读也仍按写入授权
  if (n !== 'write' || !deps.isReadOnly || toolName === 'start_background') return n
  const cmd = (args as { command?: unknown } | null)?.command
  return typeof cmd === 'string' && cmd.trim() && deps.isReadOnly(cmd) ? 'read' : 'write'
}

// 往交互 shell 里发哨兵命令的工具：仅手动终端（非 bash）跑不了。read_terminal 与文件工具不经 shell，照常可用
const SHELL_TOOLS = new Set(['exec_in_terminal', 'exec_on_terminals', 'start_background', 'check_background'])
function manualOnlyDeny(deps: Pick<TerminalToolDeps, 'terminals'>, toolName: string, ids: string[]): Decision | undefined {
  if (!SHELL_TOOLS.has(toolName)) return undefined
  const bad = deps.terminals.list().filter((t) => t.manualOnly && ids.includes(t.id))
  if (!bad.length) return undefined
  return {
    kind: 'deny',
    reason: tr('shell_not_supported: 终端 {list}是仅手动终端（PowerShell / cmd 等非 bash shell），AI 不能在里面执行命令。请改用 Git Bash 本地终端（可用 create_terminal 新开）或 SSH 终端；需要 PowerShell 时在 Git Bash 里用 powershell.exe -NoProfile -Command', {
      list: bad.map((t) => tr('{id}（{title}）', { id: t.id, title: t.title })).join(tr('、')),
    }),
  }
}

/** 授权卡/执行记录上给人看的一行：exec 类是命令本身，文件类是动作 + 路径 */
export function describeCall(toolName: string, args: unknown): string | undefined {
  const a = (args ?? {}) as Record<string, unknown>
  if (typeof a.command === 'string') return a.command
  if (toolName === 'upload_file') return tr('上传 {src} → {dir}', { src: String(a.local_path), dir: String(a.target_dir) })
  if (toolName === 'read_file') return tr('读取 {path}', { path: String(a.path) })
  if (toolName === 'write_file') return tr('写入 {path}', { path: String(a.path) })
  if (toolName === 'download_file') return tr('下载 {path}', { path: String(a.path) })
  // 没有命令参数的读工具：授权卡上也要说清楚在干什么，否则卡片是空的
  if (toolName === 'check_background') return tr('查询后台任务 {id}（只读：状态 + 日志末尾）', { id: String(a.job_id) })
  if (toolName === 'read_terminal') return tr('读取终端屏幕内容')
  return undefined
}

/** 模型给的命令说明（explain）：授权卡/工具卡上给人看；没填就没有，不拦执行 */
export function explainOf(args: unknown): string | undefined {
  const e = (args as { explain?: unknown } | null)?.explain
  return typeof e === 'string' && e.trim() ? e.trim().slice(0, 200) : undefined
}

// ── 回滚方案：AI 执行变更类命令时一并给出回滚命令（rollback）与说明（rollback_note）──
// 只管 exec_in_terminal（单台、可一键回滚）；只读白名单内的命令不要求
const ROLLBACK_MAX = 4000
export function rollbackOf(args: unknown): { rollback?: string; rollbackNote?: string } {
  const a = (args ?? {}) as { rollback?: unknown; rollback_note?: unknown }
  const r = typeof a.rollback === 'string' ? a.rollback.trim().slice(0, ROLLBACK_MAX) : ''
  const n = typeof a.rollback_note === 'string' ? a.rollback_note.trim().slice(0, 500) : ''
  return { ...(r ? { rollback: r } : {}), ...(n ? { rollbackNote: n } : {}) }
}

/** 非只读的 exec_in_terminal 却既没给 rollback 也没给 rollback_note（deps 没有 isReadOnly 时不检查） */
export function missingRollback(deps: Pick<TerminalToolDeps, 'isReadOnly'>, toolName: string, args: unknown): boolean {
  if (toolName !== 'exec_in_terminal' || !deps.isReadOnly) return false
  const cmd = (args as { command?: unknown } | null)?.command
  if (typeof cmd !== 'string' || !cmd.trim() || deps.isReadOnly(cmd)) return false
  const r = rollbackOf(args)
  return !r.rollback && !r.rollbackNote
}

// 显示处（rollbackDeny）再 tr()：拒绝原因同时显示在工具卡上
export const ROLLBACK_REQUIRED = tk('rollback_required: 这是生产主机上的变更命令，必须同时给出回滚方案才会执行：在 rollback 参数里写能撤销本次改动的命令（可多行；改文件前先备份，回滚用备份还原），在 rollback_note 里说明为什么这样回滚；确实无法回滚的，rollback 留空，在 rollback_note 里写明「不可回滚」及原因；这条命令其实只读的，在 rollback_note 写「只读，无需回滚」。补全后重新调用。')

/** 生产主机上缺回滚方案的变更命令：直接拒（原因进模型让它补），不弹卡 */
export function rollbackDeny(deps: Pick<TerminalToolDeps, 'isReadOnly' | 'hostMeta'>, toolName: string, args: unknown): Decision | undefined {
  if (!missingRollback(deps, toolName, args)) return undefined
  const tid = terminalIdOf(args)
  return tid && deps.hostMeta?.(tid)?.env === 'prod' ? { kind: 'deny', reason: tr(ROLLBACK_REQUIRED) } : undefined
}

/**
 * 授权卡里与工具相关的展示字段：主机、命令、说明；多主机工具再带全部目标（主机列表）。
 * 纯函数，DshController 的 approval/request 直接展开进 ApprovalRequest。
 */
export function approvalView(deps: Pick<TerminalToolDeps, 'resolveHostKey' | 'terminals' | 'isReadOnly' | 'fleetHosts'>, toolName: string, args: unknown) {
  const tids = targetTerminalsOf(toolName, args)
  const titles = new Map(deps.terminals.list().map((t) => [t.id, t.title]))
  const explain = explainOf(args)
  if (toolName === 'run_on_hosts') {
    // 不经终端：一张卡列出将访问的全部主机（授权粒度就是主机 id）
    const hosts = fleetTargetsOf(deps, args)
    return {
      terminalId: hosts[0]?.id ?? 'local', command: describeCall(toolName, args), ...(explain ? { explain } : {}),
      targets: hosts.map((h) => ({ terminalId: h.id, hostKey: h.id, label: h.label })),
    }
  }
  return {
    terminalId: deps.resolveHostKey(tids[0] ?? 'local'),
    command: describeCall(toolName, args),
    ...(explain ? { explain } : {}),
    ...(toolName === 'exec_in_terminal' ? rollbackOf(args) : {}),
    ...(missingRollback(deps, toolName, args) ? { rollbackMissing: true } : {}),
    ...(toolName === 'exec_on_terminals'
      ? { targets: tids.map((terminalId) => ({ terminalId, hostKey: deps.resolveHostKey(terminalId), label: titles.get(terminalId) ?? terminalId })) }
      : {}),
  }
}

export const EXPLAIN_GUIDANCE = '命令说明：调用 exec_in_terminal / start_background / exec_on_terminals 时务必填 explain——'   // i18n-ignore 模型提示词 / 工具说明 / 给模型的结果
  + '用一句不懂运维的人也能看懂的中文（60 字以内）说明这条命令做什么、有什么风险（如「查看磁盘占用，只读无风险」「重启 nginx，期间网站会断开几秒」）。'   // i18n-ignore 模型提示词 / 工具说明 / 给模型的结果
  + '它会显示在用户的授权卡上，帮用户判断是否允许；不要夸大或淡化风险。'   // i18n-ignore 模型提示词 / 工具说明 / 给模型的结果

// ── 文件工具的纯逻辑 ─────────────────────────────────────────
const MAX_READ_LINES = 2000
const MAX_READ_CHARS = 200_000

/** 按 1 起、含两端的行号区间取文本；超上限截断并标 truncated，模型可据 end_line 续读 */
export function sliceLines(text: string, start?: number, end?: number) {
  const lines = text.replace(/\n$/, '').split('\n')
  const total = text === '' ? 0 : lines.length
  const s = Math.max(1, Math.floor(start ?? 1))
  const want = Math.min(total, Math.floor(end ?? total))
  let e = Math.min(want, s + MAX_READ_LINES - 1)
  let content = lines.slice(s - 1, e).join('\n')
  let truncated = e < want
  if (content.length > MAX_READ_CHARS) {
    // 尽量只保留完整的行，end_line 指向最后一行（单行就超长时只能截半行）
    const cut = content.lastIndexOf('\n', MAX_READ_CHARS)
    content = content.slice(0, cut > 0 ? cut : MAX_READ_CHARS)
    e = s + content.split('\n').length - 1
    truncated = true
  }
  return { total_lines: total, start_line: s, end_line: e, content, ...(truncated ? { truncated: true } : {}) }
}

/**
 * write_file 的新内容：content=整文件；old_text+new_text=精确替换（须唯一命中）。
 * 模型给的片段是 \n 换行，文件若是 CRLF 则按 CRLF 再试一次。
 */
export function applyEdit(old: string | undefined, args: { content?: unknown; old_text?: unknown; new_text?: unknown }): string {
  if (typeof args.content === 'string') return args.content
  if (typeof args.old_text !== 'string' || typeof args.new_text !== 'string') {
    throw new Error(tr('write_file 需要 content（整文件新内容）或 old_text + new_text（精确替换）'))
  }
  if (old === undefined) throw new Error(tr('文件不存在，不能用 old_text/new_text 编辑；新建文件请传 content'))
  if (!args.old_text) throw new Error(tr('old_text 不能为空'))
  const tryWith = (from: string, to: string): string | undefined => {
    const i = old.indexOf(from)
    if (i < 0) return undefined
    if (old.indexOf(from, i + 1) >= 0) throw new Error(tr('old_text 在文件中出现多次，请多带几行上下文使其唯一'))
    return old.slice(0, i) + to + old.slice(i + from.length)
  }
  const crlf = (s: string) => s.replace(/\r?\n/g, '\r\n')
  const r = tryWith(args.old_text, args.new_text) ?? (old.includes('\r\n') ? tryWith(crlf(args.old_text), crlf(args.new_text)) : undefined)
  if (r === undefined) throw new Error(tr('old_text 在文件中未找到（须逐字一致，含缩进与换行）；可先 read_file 确认原文'))
  return r
}

const assertText = (t: string, path: string) => {
  if (t.includes('\0')) throw new Error(tr('{path} 是二进制文件，不支持按文本读写', { path }))
}

/** 读原文并算出新内容（授权卡预览与工具体共用，保证两边一致）。old=undefined 表示新建 */
export async function planWrite(deps: TerminalToolDeps, args: any): Promise<{ old?: string; next: string }> {
  if (!deps.readFile || !deps.writeFile) throw new Error(tr('文件读写不可用'))
  if (typeof args?.path !== 'string' || !args.path) throw new Error(tr('write_file 缺少 path'))
  const old = await deps.readFile(args.terminal_id, args.path)
  if (old !== undefined) assertText(old, args.path)
  return { old, next: applyEdit(old, args) }
}

// ── 后台任务：给超过 exec 超时的长任务用 ──────────────────────────────────────────
// 思路：用 execCapture 跑一条"瞬时返回"的包装命令，把真正的任务 nohup 到后台，
// 输出落 <JOB_DIR>/<id>.log，结束时退出码写 <id>.exit，pid 写 <id>.pid；之后按 id 轮询。
// 只用 POSIX sh 语法，Git Bash（Windows）与远端 Linux bash/sh 通用。
export const JOB_DIR = '/tmp/lingshell-jobs'
const JOB_ID_RE = /^[0-9a-f]{16}$/
const PID_MARK = '__LINGSHELL_JOB_PID__='
const STATUS_MARK = '__LINGSHELL_JOB_STATUS__'

/** 单引号转义，同 terminal-core/sentinel.ts：' → '\'' */
const shQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`

export function newJobId(): string { return randomBytes(8).toString('hex') }
/** job_id 会直接拼进 shell 命令，只认 16 位小写 hex，杜绝注入 */
export function isJobId(v: unknown): v is string { return typeof v === 'string' && JOB_ID_RE.test(v) }

/**
 * 启动后台任务的包装命令。用户命令作为位置参数 $1 传给内层 shell 再 eval，
 * 免去二次转义；放在 ( ) 子 shell 里跑，命令里的 exit 也不会跳过退出码落盘。
 * 外层 ( … & ) 子 shell：关掉交互 shell 的作业控制，不打印 [1] pid / Done 噪音，
 * 也不在交互 shell 里留变量。退出码先写 .tmp 再 mv，轮询读不到半截文件。
 */
export function buildStartBackgroundCommand(jobId: string, command: string): string {
  if (!isJobId(jobId)) throw new Error(tr('非法 job_id：{id}', { id: jobId }))
  const base = `${JOB_DIR}/${jobId}`
  // 顺手清掉 7 天前的旧任务文件（.log/.exit/.pid），否则大日志一直堆在远端 /tmp
  return `mkdir -p ${JOB_DIR} && { find ${JOB_DIR} -type f -mtime +7 -delete 2>/dev/null; true; } && ( nohup "$(command -v bash || echo sh)" -c '(eval "$1"); echo $? > "$2.tmp"; mv -f "$2.tmp" "$2"' lingshell-job ${shQuote(command)} ${base}.exit`
    + ` > ${base}.log 2>&1 < /dev/null & echo $! > ${base}.pid; echo "${PID_MARK}$!" )`
}

export function parseStartBackgroundOutput(output: string): number | undefined {
  const m = new RegExp(`${PID_MARK}(\\d+)`).exec(output)
  return m ? Number(m[1]) : undefined
}

/**
 * 查询后台任务状态 + 日志末尾。先看 .exit（已结束），再看 pid 是否存活（运行中），
 * 再看一次 .exit（防进程恰好在两次检查之间结束），都不是则 unknown（id 不存在 / 进程被杀没留退出码）。
 */
// waitSec > 0：先在远端等任务结束（每秒查一次），最多等这么久再报状态——
// 模型自己没法"等一会儿"，不在这里等它就只能连珠炮式轮询（实测 90 秒任务查了三十多次）
export function buildCheckBackgroundCommand(jobId: string, lines = 80, waitSec = 0): string {
  if (!isJobId(jobId)) throw new Error(tr('非法 job_id：{id}', { id: jobId }))
  const b = `${JOB_DIR}/${jobId}`
  const n = Math.max(1, Math.floor(lines))
  const w = Math.max(0, Math.floor(waitSec))
  const wait = w > 0
    ? ` i=0; while [ ! -f ${b}.exit ] && kill -0 "$(cat ${b}.pid 2>/dev/null)" 2>/dev/null && [ $i -lt ${w} ]; do sleep 1; i=$((i+1)); done;`
    : ''
  return `(${wait} if [ -f ${b}.exit ]; then s="finished $(cat ${b}.exit)";`
    + ` elif kill -0 "$(cat ${b}.pid 2>/dev/null)" 2>/dev/null; then s=running;`
    + ` elif [ -f ${b}.exit ]; then s="finished $(cat ${b}.exit)";`
    + ` else s=unknown; fi; echo "${STATUS_MARK} $s"; tail -n ${n} ${b}.log 2>/dev/null )`
}

export interface BackgroundStatus { job_id: string; status: 'running' | 'finished' | 'unknown'; exit_code?: number; tail: string }

export function parseCheckBackgroundOutput(jobId: string, output: string): BackgroundStatus {
  const text = output.replace(/\r/g, '')
  const m = new RegExp(`${STATUS_MARK} (running|finished|unknown)(?: (\\d+))?[^\\n]*\\n?`).exec(text)
  if (!m) return { job_id: jobId, status: 'unknown', tail: text }
  const status = m[1] as BackgroundStatus['status']
  const tail = text.slice(m.index + m[0].length).replace(/\n$/, '')
  return status === 'finished' && m[2] !== undefined
    ? { job_id: jobId, status, exit_code: Number(m[2]), tail }
    : { job_id: jobId, status, tail }
}

/** 从一次工具调用里取出它操作的 terminalId（不同工具字段名一致，但集中一处好改） */
export function terminalIdOf(args: unknown): string | undefined {
  const a = args as { terminal_id?: unknown }
  return typeof a?.terminal_id === 'string' ? a.terminal_id : undefined
}

export const MULTI_MIN = 2
export const MULTI_MAX = 10

/** exec_on_terminals 的目标终端 id（去重）；不是字符串数组返回 undefined */
export function terminalIdsOf(args: unknown): string[] | undefined {
  const ids = (args as { terminal_ids?: unknown } | null)?.terminal_ids
  if (!Array.isArray(ids) || !ids.every((x) => typeof x === 'string')) return undefined
  return [...new Set(ids as string[])]
}

/** 一次调用涉及的全部终端：多主机工具是 terminal_ids，其余是 terminal_id（审计/授权逐台落） */
export function targetTerminalsOf(toolName: string, args: unknown): string[] {
  if (toolName === 'exec_on_terminals') return terminalIdsOf(args) ?? []
  const t = terminalIdOf(args)
  return t ? [t] : []
}

export type Decision = { kind: 'allow'; rule?: string } | { kind: 'deny'; reason: string } | { kind: 'ask'; reason?: string; rule?: string }
const ruleOf = (rule?: string) => (rule ? { rule } : {})

// 多主机一张卡的原因：取最严重的那台（危险 > 提权 > 首次访问）
const REASON_RANK: Record<string, number> = { first_access: 1, elevation: 2, dangerous_command: 3 }

/**
 * 多主机批量执行：每台目标主机（按 hostKey 去重）都要过 decide。
 * 任一台拒 → 整体拒（拒的那些落审计）；任一台要问 → 合成一张卡问一次；全放行才放行。
 */
function decideMulti(deps: TerminalToolDeps, sessionId: string, args: unknown): Decision {
  const ids = terminalIdsOf(args)
  if (!ids) return { kind: 'deny', reason: tr('exec_on_terminals 缺少 terminal_ids（终端 id 数组）') }
  if (ids.length < MULTI_MIN || ids.length > MULTI_MAX) {
    return { kind: 'deny', reason: tr('exec_on_terminals 需要 {min}–{max} 个不同终端，收到 {n} 个（单台请用 exec_in_terminal）', { min: MULTI_MIN, max: MULTI_MAX, n: ids.length }) }
  }
  const known = new Set(deps.terminals.list().map((t) => t.id))
  const missing = ids.filter((id) => !known.has(id))
  if (missing.length) {
    return { kind: 'deny', reason: tr('terminal_not_found: 终端 {id} 不存在（应用重启后终端 id 会变），请先用 list_terminals 查当前终端', { id: missing.join(', ') }) }
  }
  const manual = manualOnlyDeny(deps, 'exec_on_terminals', ids)
  if (manual) return manual
  const command = typeof (args as any)?.command === 'string' ? (args as any).command : undefined
  const needed = neededForCall(deps, 'exec_on_terminals', args)
  const seen = new Map<string, ReturnType<TerminalToolDeps['decide']>>()
  for (const id of ids) {
    const hk = deps.resolveHostKey(id)
    if (!seen.has(hk)) seen.set(hk, deps.decide(sessionId, hk, needed, command))
  }
  const denied = ids.filter((id) => seen.get(deps.resolveHostKey(id))!.kind === 'deny')
  if (denied.length) {
    const reasons = [...new Set([...seen.values()].flatMap((d) => (d.kind === 'deny' ? [d.reason] : [])))]
    for (const terminalId of denied) {
      deps.audit({ sessionId, terminalId, command, decision: `deny:${reasons.join('; ')}` })
    }
    return { kind: 'deny', reason: tr('permission_denied: 终端 {ids} 无权执行（{reasons}），整批未执行', { ids: denied.join(', '), reasons: reasons.join('; ') }) }
  }
  let reason: string | undefined
  for (const d of seen.values()) {
    if (d.kind === 'prompt' && (REASON_RANK[d.reason] ?? 0) >= (REASON_RANK[reason ?? ''] ?? 0)) reason = d.reason
  }
  const rule = [...seen.values()].find((d) => d.rule)?.rule
  return reason === undefined ? { kind: 'allow', ...ruleOf(rule) } : { kind: 'ask', reason, ...ruleOf(rule) }
}

/**
 * 一次工具调用「用到」了哪些主机（hostKey）：终端类工具 = 终端所在主机（未知终端不算）；
 * create_terminal = 要开的主机；run_on_hosts = 目标主机。知识库注入据此判断会话涉及哪些主机
 */
export function hostsTouchedBy(deps: Pick<TerminalToolDeps, 'terminals' | 'resolveHostKey' | 'fleetHosts'>, toolName: string, args: unknown): string[] {
  if (toolName === 'run_on_hosts') return fleetTargetsOf(deps, args).map((h) => h.id)
  if (toolName === 'create_terminal') {
    const a = (args ?? {}) as { type?: unknown; hostId?: unknown }
    return a.type === 'ssh' ? (typeof a.hostId === 'string' && a.hostId ? [a.hostId] : []) : ['local']
  }
  const known = new Set(deps.terminals.list().map((t) => t.id))
  const ids = targetTerminalsOf(toolName, args).filter((id) => known.has(id))
  return [...new Set(ids.map((id) => deps.resolveHostKey(id)))]
}

/** run_on_hosts 的目标主机（targets 解析后；认不出的忽略，决策时另行拒绝） */
export function fleetTargetsOf(deps: Pick<TerminalToolDeps, 'fleetHosts'>, args: unknown): FleetHost[] {
  return resolveFleetTargets((args as { targets?: unknown } | null)?.targets, deps.fleetHosts?.() ?? []).hosts
}

const fleetCommandOf = (args: unknown) => String((args as { command?: unknown } | null)?.command ?? '').trim()

/** 只读判定 + 目标解析：不合格返回拒绝原因（决策与工具体共用，工具体再查一次防绕过） */
function fleetCheck(deps: TerminalToolDeps, args: unknown): { hosts: FleetHost[]; command: string } | { error: string } {
  if (!deps.fleetHosts || !deps.runOnHosts || !deps.isReadOnly) return { error: tr('跨主机执行不可用') }
  const command = fleetCommandOf(args)
  if (!command) return { error: tr('run_on_hosts 缺少 command') }
  if (!deps.isReadOnly(command)) {
    return { error: tr('not_readonly: run_on_hosts 只允许只读命令（查看类：cat / ls / grep / df / ps / systemctl status / journalctl …；不能有写重定向、命令替换、sudo、删改类命令），「{command}」不是只读命令，整批未执行。需要改动请对单台主机用 exec_in_terminal（会走授权）', { command }) }
  }
  const all = deps.fleetHosts()
  const { hosts, unknown } = resolveFleetTargets((args as { targets?: unknown } | null)?.targets, all)
  if (unknown.length) {
    const groups = [...new Set(all.flatMap((h) => (h.group ? [h.group] : [])))]
    return { error: tr('host_not_found: 找不到 {names}（targets 填已保存主机的 id、分组名或主机名）。可用分组：{groups}；主机见系统提示「跨主机提问」段', { names: unknown.join(tr('、')), groups: groups.join(tr('、')) || tr('无') }) }
  }
  if (!hosts.length) return { error: tr('run_on_hosts 缺少 targets（主机 id 或分组名列表）') }
  if (hosts.length > FLEET_MAX_HOSTS) return { error: tr('一次最多 {max} 台主机，收到 {n} 台，请缩小范围', { max: FLEET_MAX_HOSTS, n: hosts.length }) }
  return { hosts, command }
}

/**
 * 跨主机提问：只读命令，每台目标主机（主机 id 即授权粒度）都要读取授权 + 命令规则。
 * 任一台拒 → 整批拒；任一台要问 → 合成一张卡（列出全部主机）问一次；全放行才放行。
 */
function decideFleet(deps: TerminalToolDeps, sessionId: string, args: unknown): Decision {
  const c = fleetCheck(deps, args)
  if ('error' in c) return { kind: 'deny', reason: c.error }
  const ds = c.hosts.map((h) => ({ h, d: deps.decide(sessionId, h.id, 'read', c.command) }))
  const denied = ds.filter((x) => x.d.kind === 'deny')
  if (denied.length) {
    const reasons = [...new Set(denied.map((x) => (x.d as { reason: string }).reason))]
    for (const { h } of denied) deps.audit({ sessionId, terminalId: '', hostKey: h.id, terminalTitle: h.label, command: c.command, decision: `deny:${reasons.join('; ')}` })
    return { kind: 'deny', reason: tr('permission_denied: 主机 {hosts} 无权执行（{reasons}），整批未执行', { hosts: denied.map((x) => x.h.label).join(tr('、')), reasons: reasons.join('; ') }) }
  }
  let reason: string | undefined
  for (const { d } of ds) if (d.kind === 'prompt' && (REASON_RANK[d.reason] ?? 0) >= (REASON_RANK[reason ?? ''] ?? 0)) reason = d.reason
  const rule = ds.find((x) => x.d.rule)?.d.rule
  return reason === undefined ? { kind: 'allow', ...ruleOf(rule) } : { kind: 'ask', reason, ...ruleOf(rule) }
}

/**
 * 授权决策：把 AuthRegistry 的三态翻成 dsh 的 PreToolDecision。
 * 纯函数（decide 本身无 IO），单独抽出来是为了脱离 dsh 运行时直接测。
 */
export function decideFor(deps: TerminalToolDeps, sessionId: string, toolName: string, args: unknown): Decision {
  if (!NEEDS[toolName]) return { kind: 'allow' }               // 无需授权的工具
  if (toolName === 'exec_on_terminals') return decideMulti(deps, sessionId, args)
  if (toolName === 'run_on_hosts') return decideFleet(deps, sessionId, args)
  const needed = neededForCall(deps, toolName, args)
  const terminalId = terminalIdOf(args)
  if (!terminalId) return { kind: 'deny', reason: tr('{tool} 缺少 terminal_id', { tool: toolName }) }
  // 终端不存在（常见：应用重启后 id 变了，模型还拿着旧 id）→ 直接拒，别弹卡：
  // resolveHostKey 对未知 id 回落 'local'，弹出来的会是「本地」的授权卡，用户点允许就把本地写权限给错了
  if (!deps.terminals.list().some((t) => t.id === terminalId)) {
    return { kind: 'deny', reason: tr('terminal_not_found: 终端 {id} 不存在（应用重启后终端 id 会变），请先用 list_terminals 查当前终端', { id: terminalId }) }
  }
  const manual = manualOnlyDeny(deps, toolName, [terminalId])
  if (manual) return manual
  const rb = rollbackDeny(deps, toolName, args)
  if (rb) return rb
  const hostKey = deps.resolveHostKey(terminalId)
  const command = typeof (args as any)?.command === 'string' ? (args as any).command : undefined
  const d = deps.decide(sessionId, hostKey, needed, command)
  // 上传/下载能把文件送出/拉回，写入授权不够，每次都让用户确认（一次性，不升级）
  if (d.kind === 'allow' && ALWAYS_ASK.has(toolName)) return { kind: 'ask', reason: 'dangerous_command' }
  if (d.kind === 'allow') return { kind: 'allow', ...ruleOf(d.rule) }
  if (d.kind === 'deny') {
    deps.audit({ sessionId, terminalId, command: describeCall(toolName, args), decision: `deny:${d.reason}`, ...ruleOf(d.rule) })
    return { kind: 'deny', reason: `permission_denied: ${d.reason}` }
  }
  return { kind: 'ask', reason: d.reason, ...ruleOf(d.rule) }
}

/**
 * 用户在授权卡上点了「允许」之后要做的事：危险命令是一次性放行不升级，其余落记录。
 * 与 MCP 版 McpBridge.guard 的后半段同语义。
 */
export function commitGrant(deps: TerminalToolDeps, sessionId: string, toolName: string, args: unknown, reason?: string, rule?: string): void {
  if (toolName === 'run_on_hosts') {
    // 只给当时确实要问的主机落读取授权（已放行的不动）
    const command = fleetCommandOf(args)
    for (const h of fleetTargetsOf(deps, args)) {
      if (reason !== 'dangerous_command' && deps.decide(sessionId, h.id, 'read', command).kind === 'prompt') deps.grant(sessionId, h.id, 'read')
      deps.audit({ sessionId, terminalId: '', hostKey: h.id, terminalTitle: h.label, command, decision: `allow:${reason ?? 'user'}`, ...ruleOf(rule) })
    }
    return
  }
  if (toolName === 'exec_on_terminals') {
    // 只给当时确实要问的主机落授权（已放行的不动，免得把被降级成只读的主机顺手升成写）；危险命令一次性放行
    const command = typeof (args as any)?.command === 'string' ? (args as any).command : undefined
    const needed = neededForCall(deps, 'exec_on_terminals', args)
    const granted = new Set<string>()
    for (const terminalId of terminalIdsOf(args) ?? []) {
      const hk = deps.resolveHostKey(terminalId)
      if (reason !== 'dangerous_command' && !granted.has(hk) && deps.decide(sessionId, hk, needed, command).kind === 'prompt') {
        granted.add(hk)
        deps.grant(sessionId, hk, needed)
      }
      deps.audit({ sessionId, terminalId, command, decision: `allow:${reason ?? 'user'}`, ...ruleOf(rule) })
    }
    return
  }
  const terminalId = terminalIdOf(args)
  if (!NEEDS[toolName] || !terminalId) return
  const needed = neededForCall(deps, toolName, args)
  const hostKey = deps.resolveHostKey(terminalId)
  if (reason !== 'dangerous_command') deps.grant(sessionId, hostKey, needed)
  deps.audit({ sessionId, terminalId, command: describeCall(toolName, args), decision: `allow:${reason ?? 'user'}`, ...ruleOf(rule) })
}

// ── 多主机批量执行的结果整理 ─────────────────────────────
const MULTI_OUTPUT_TAIL = 4000

export interface MultiResult { terminal_id: string; title: string; host: string; exit_code: number; output: string; truncated: boolean; error?: string }

/** 按（退出码, 输出）把主机分组，组按首次出现排序；输出比较前去掉 \r 与首尾空白（各主机行尾习惯不同） */
export function groupSameOutput(rs: { terminal_id: string; exit_code: number; full: string }[]): string[][] {
  const groups = new Map<string, string[]>()
  for (const r of rs) {
    const k = `${r.exit_code}\0${r.full.replace(/\r/g, '').trim()}`
    groups.set(k, [...(groups.get(k) ?? []), r.terminal_id])
  }
  return [...groups.values()]
}

const str = (description: string) => ({ type: 'string' as const, required: true, description })
const textOut = { schema: { type: 'string' as const }, render: (_a: unknown, v: string) => [{ type: 'text' as const, text: v }] }

/**
 * 工具定义表。工具体**不做鉴权**（网关已经把住），只管干活并把结果 JSON 化。
 * 返回的是 defineTool 的入参，由 install 时喂给 dsh；这样这层不依赖 dsh 运行时，可直接单测。
 */
export function terminalToolDefs(deps: TerminalToolDeps) {
  const sidOf = (exec: any): string => {
    const agentId = String(exec?.agent?.id ?? '')
    return deps.sessionIdOf?.(agentId) ?? agentId
  }
  // 授权卡上"拒绝并说明原因"是放行到这里再拒：dsh 的拒绝文案写死，带不了原因给模型
  const userOverride = (exec: any): UserOverride | undefined => {
    const o = deps.takeUserOverride?.(String(exec?.callId ?? ''))
    if (o?.deny !== undefined) throw new Error(tr('用户拒绝执行。原因：{reason}', { reason: o.deny }))
    if (o?.fail !== undefined) throw new Error(o.fail)
    return o
  }
  const withMeta = <T extends object>(terminalId: string, o: T) => ({ ...o, ...deps.hostMeta?.(terminalId) })
  // 有密钥要展开才带 wire（没有就按原样四个参数调，与密钥保险箱之前一致）
  const capture = (id: string, command: string, signal: AbortSignal | undefined, ms: number | undefined, wire?: { wire: string }) =>
    wire ? deps.terminals.execCapture(id, command, signal, ms, wire) : deps.terminals.execCapture(id, command, signal, ms)
  // 后台任务的包装命令（mkdir / nohup / 轮询循环）不进用户终端：优先走旁路通道，没有再在终端里静默跑
  const bgRun = async (id: string, command: string, signal: AbortSignal | undefined, ms: number | undefined, wire?: { wire: string }, cwd = false) => {
    if (deps.sideExec) {
      try {
        const r = await deps.sideExec(id, wire?.wire ?? command, { timeoutMs: ms ?? 50_000, signal, cwd })
        if (r) return r
      } catch (e) {
        if (signal?.aborted) throw e
        deps.log?.('warn', '后台任务旁路通道不可用，改在终端里静默执行', { error: e instanceof Error ? e.message : String(e) })   // i18n-ignore 日志
      }
    }
    return deps.terminals.execCapture(id, command, signal, ms, { ...wire, silent: true })
  }
  const beforeChange = async (exec: any, tids: string[], command?: string) => { await deps.beforeChange?.(sidOf(exec), tids, command).catch(() => {}) }
  const optInt = (description: string) => ({ type: 'integer' as const, description })
  const optStr = (description: string) => ({ type: 'string' as const, description })
  // 不设 required：模型漏填也照常执行，只是授权卡上没有说明
  const explain = optStr('必填：一句通俗中文（≤60 字）说明这条命令做什么、有什么风险，显示在用户的授权卡上')   // i18n-ignore 模型提示词 / 工具说明 / 给模型的结果
  const defs = [
    {
      name: 'list_terminals',
      description: '列出当前所有终端（id/标题/类型/状态）。该主机在知识库里有知识卡会带 knowledge（卡片标题；用到该主机后全文出现在系统提示「主机知识库」段），'   // i18n-ignore 模型提示词 / 工具说明 / 给模型的结果
        + '标了分级会带 env（prod=生产，写操作逐条确认），最近知道目录的会带 cwd（提示符上报 / 上次探测的缓存，可能不是最新；要精确再用 pwd）。'   // i18n-ignore 模型提示词 / 工具说明 / 给模型的结果
        + 'manualOnly=true 的是用户的仅手动终端（PowerShell / cmd 等），不能在里面执行命令。无需授权。',   // i18n-ignore 模型提示词 / 工具说明 / 给模型的结果
      parameters: {},
      output: textOut,
      async execute() {
        return JSON.stringify(deps.terminals.list().map((t) => {
          const cwd = deps.terminalCwd?.(t.id)
          return { ...withMeta(t.id, t), ...(cwd ? { cwd } : {}) }
        }))
      },
    },
    {
      name: 'read_terminal',
      description: '读取指定终端的当前屏幕快照。需该主机的读取授权。',   // i18n-ignore 模型提示词 / 工具说明 / 给模型的结果
      parameters: { terminal_id: str('终端 id，先用 list_terminals 取') },   // i18n-ignore 模型提示词 / 工具说明 / 给模型的结果
      output: textOut,
      async execute(args: any, exec: any) {
        userOverride(exec)
        const snap = deps.terminals.readSnapshot(args.terminal_id, 200)
        deps.audit({ sessionId: sidOf(exec), terminalId: args.terminal_id, decision: 'read_allowed' })
        return snap
      },
    },
    {
      name: 'exec_in_terminal',
      description: '在指定终端执行一条命令，返回输出与退出码。只读命令需该主机的读取授权，写命令需写入授权；危险命令会二次确认。'   // i18n-ignore 模型提示词 / 工具说明 / 给模型的结果
        + '多台终端要执行同一条命令时用 exec_on_terminals（合并成一张授权卡），不要逐台调用 exec_in_terminal。'   // i18n-ignore 模型提示词 / 工具说明 / 给模型的结果
        + '同一终端是串行的：一次只发一条，多条命令请用 && 或 ; 串成一条。'   // i18n-ignore 模型提示词 / 工具说明 / 给模型的结果
        + '有执行超时上限：可能跑很久的命令（编译/安装/迁移/大文件下载/长时间脚本）改用 start_background。'   // i18n-ignore 模型提示词 / 工具说明 / 给模型的结果
        + '务必填 explain（给用户看的命令说明）。'   // i18n-ignore 模型提示词 / 工具说明 / 给模型的结果
        + '变更类命令（改配置/启停服务/装删包/移动删除文件等）必须同时填 rollback（回滚命令）与 rollback_note（回滚说明），无法回滚的在 rollback_note 写明「不可回滚」及原因；生产主机上缺少会被拒绝。',   // i18n-ignore 模型提示词 / 工具说明 / 给模型的结果
      parameters: {
        terminal_id: str('终端 id'), command: str('要执行的命令'), explain,   // i18n-ignore 模型提示词 / 工具说明 / 给模型的结果
        rollback: optStr('变更类命令必填：撤销本次改动的回滚命令（可多行），用户可在执行记录里一键执行；只读命令不填'),   // i18n-ignore 模型提示词 / 工具说明 / 给模型的结果
        rollback_note: optStr('回滚说明：为什么这样回滚 / 注意事项；无法回滚时写「不可回滚」及原因'),   // i18n-ignore 模型提示词 / 工具说明 / 给模型的结果
      },
      output: textOut,
      async execute(args: any, exec: any) {
        const o = userOverride(exec)
        const edited = o?.command
        const command = edited ?? args.command
        const wire = wireOf(deps.secretVault, args.terminal_id, command)   // 范围不符抛错（用户在授权卡上改出来的引用也要查）
        await beforeChange(exec, [args.terminal_id], command)
        const r = await capture(args.terminal_id, command, exec?.signal, deps.execTimeoutMs?.(), wire)
        const callId = exec?.callId === undefined ? undefined : String(exec.callId)
        deps.audit({
          sessionId: sidOf(exec), terminalId: args.terminal_id, command,
          decision: edited ? 'exec_allowed:edited' : 'exec_allowed', exitCode: r.exitCode, truncated: r.truncated, ...ruleOf(o?.rule),
          ...rollbackOf(args), ...(callId ? { callId } : {}), ...(o?.review ? { review: o.review } : {}),
        })
        return JSON.stringify({
          ...(edited ? { note: '用户在授权时修改了命令，实际执行的是 executed_command', executed_command: edited } : {}),   // i18n-ignore 模型提示词 / 工具说明 / 给模型的结果
          output: r.output, exit_code: r.exitCode, truncated: !!r.truncated,
        })
      },
    },
    {
      name: 'exec_on_terminals',
      description: `在多台主机（${MULTI_MIN}–${MULTI_MAX} 个终端）上并行执行同一条命令并汇总结果，用于批量巡检/对比配置与版本。`   // i18n-ignore 模型提示词 / 工具说明 / 给模型的结果
        + '返回每台的退出码与输出末尾，summary.same_output_groups 把输出完全相同的终端归为一组（只有一组=各台一致），failed 列出退出码非 0 的终端。'   // i18n-ignore 模型提示词 / 工具说明 / 给模型的结果
        + '只读命令按读取、写命令按写入，每台目标主机的授权合并成一张卡；危险命令会二次确认。只适合快速返回的命令，长任务请逐台用 start_background。'   // i18n-ignore 模型提示词 / 工具说明 / 给模型的结果
        + '务必填 explain（给用户看的命令说明）。',   // i18n-ignore 模型提示词 / 工具说明 / 给模型的结果
      parameters: {
        terminal_ids: {
          type: 'array' as const, required: true as const, items: { type: 'string' as const },
          description: `目标终端 id 列表（${MULTI_MIN}–${MULTI_MAX} 个，不同终端），先用 list_terminals 取`,   // i18n-ignore 模型提示词 / 工具说明 / 给模型的结果
        },
        command: str('要在每台上执行的命令'),   // i18n-ignore 模型提示词 / 工具说明 / 给模型的结果
        explain,
      },
      output: textOut,
      async execute(args: any, exec: any) {
        const rule = userOverride(exec)?.rule
        const ids = terminalIdsOf(args) ?? []
        if (ids.length < MULTI_MIN || ids.length > MULTI_MAX) throw new Error(tr('terminal_ids 需要 {min}–{max} 个不同终端', { min: MULTI_MIN, max: MULTI_MAX }))
        const command = String(args.command ?? '')
        const titles = new Map(deps.terminals.list().map((t) => [t.id, t.title]))
        const sessionId = sidOf(exec)
        const timeoutMs = deps.execTimeoutMs?.()
        await beforeChange(exec, ids, command)
        // 并行跑；单台失败（断线/超时）不影响其他台，记成该台的错误
        const runs = await Promise.all(ids.map(async (id) => {
          const base = { terminal_id: id, title: titles.get(id) ?? id, host: deps.resolveHostKey(id) }
          try {
            const r = await capture(id, command, exec?.signal, timeoutMs, wireOf(deps.secretVault, id, command))
            deps.audit({ sessionId, terminalId: id, command, decision: 'exec_allowed:multi', exitCode: r.exitCode, truncated: r.truncated, ...ruleOf(rule) })
            // 先回写再截末尾：免得密钥被截成半截留在开头
            return { ...base, exit_code: r.exitCode, full: deps.secretVault ? deps.secretVault.mask(r.output) : r.output, truncated: !!r.truncated }
          } catch (e) {
            const error = e instanceof Error ? e.message : String(e)
            deps.audit({ sessionId, terminalId: id, command, decision: `exec_failed:multi:${error.slice(0, 100)}` })
            return { ...base, exit_code: -1, full: '', truncated: false, error }
          }
        }))
        if (exec?.signal?.aborted) throw new Error('aborted')
        const results: MultiResult[] = runs.map(({ full, ...r }) => ({
          ...r,
          output: full.length > MULTI_OUTPUT_TAIL ? full.slice(-MULTI_OUTPUT_TAIL) : full,
          truncated: r.truncated || full.length > MULTI_OUTPUT_TAIL,
        }))
        return JSON.stringify({
          results,
          summary: {
            same_output_groups: groupSameOutput(runs),
            failed: runs.filter((r) => r.exit_code !== 0).map((r) => r.terminal_id),
          },
        })
      },
    },
    {
      name: 'start_background',
      description: '在指定终端把一条命令放到后台运行并立即返回 job_id（输出写入日志文件）。'   // i18n-ignore 模型提示词 / 工具说明 / 给模型的结果
        + 'exec_in_terminal 有执行超时上限，凡是可能超时的任务（编译/安装/迁移/大文件下载/长时间脚本）都用本工具启动，'   // i18n-ignore 模型提示词 / 工具说明 / 给模型的结果
        + '然后用 check_background 按合理间隔（如每 15~60 秒，视任务时长）轮询状态与日志末尾，直到 finished；'   // i18n-ignore 模型提示词 / 工具说明 / 给模型的结果
        + '不要用 sleep 循环空等，也不要自己在 exec_in_terminal 里用 nohup / & / setsid 放后台。'   // i18n-ignore 模型提示词 / 工具说明 / 给模型的结果
        + '任务在独立通道里启动（不显示在用户终端里），工作目录同该终端的当前目录，但不继承终端里临时 export 的变量 / 激活的虚拟环境，需要时写进命令（如 source venv/bin/activate && …）。'   // i18n-ignore 模型提示词 / 工具说明 / 给模型的结果
        + '需该主机的写入授权；危险命令会二次确认。务必填 explain（给用户看的命令说明）。',   // i18n-ignore 模型提示词 / 工具说明 / 给模型的结果
      parameters: { terminal_id: str('终端 id'), command: str('要在后台执行的命令（可用 && 串多条）'), explain },   // i18n-ignore 模型提示词 / 工具说明 / 给模型的结果
      output: textOut,
      async execute(args: any, exec: any) {
        const o = userOverride(exec)
        const edited = o?.command
        const command = edited ?? args.command
        const jobId = newJobId()
        // 先展开再包装：明文在包装命令的单引号里也按同一套规则转义
        const wire = wireOf(deps.secretVault, args.terminal_id, command, (c) => buildStartBackgroundCommand(jobId, c))
        await beforeChange(exec, [args.terminal_id], command)
        const r = await bgRun(args.terminal_id, buildStartBackgroundCommand(jobId, command), exec?.signal, deps.execTimeoutMs?.(), wire, true)
        const pid = parseStartBackgroundOutput(r.output)
        deps.audit({
          sessionId: sidOf(exec), terminalId: args.terminal_id, command,
          decision: edited ? 'background_started:edited' : 'background_started', exitCode: r.exitCode, ...ruleOf(o?.rule),
        })
        if (pid === undefined) throw new Error(tr('后台任务启动失败（exit {code}）：{output}', { code: r.exitCode, output: r.output }))
        return JSON.stringify({
          ...(edited ? { note: '用户在授权时修改了命令，实际执行的是 executed_command', executed_command: edited } : {}),   // i18n-ignore 模型提示词 / 工具说明 / 给模型的结果
          job_id: jobId, pid, log_file: `${JOB_DIR}/${jobId}.log`,
        })
      },
    },
    {
      name: 'check_background',
      description: '查询 start_background 启动的后台任务：status=running/finished/unknown，finished 时带 exit_code，'   // i18n-ignore 模型提示词 / 工具说明 / 给模型的结果
        + '并返回日志末尾 80 行。会先在远端等任务结束最多 wait_seconds 秒（默认 30，任务结束立即返回），'   // i18n-ignore 模型提示词 / 工具说明 / 给模型的结果
        + '所以直接连续调用即可，无需自己间隔；预计很久的任务可把 wait_seconds 调大。需该主机的读取授权。'   // i18n-ignore 模型提示词 / 工具说明 / 给模型的结果
        + '须在启动该任务的同一主机的终端上查询。',   // i18n-ignore 模型提示词 / 工具说明 / 给模型的结果
      parameters: {
        terminal_id: str('终端 id（与启动时同一主机）'), job_id: str('start_background 返回的 job_id'),   // i18n-ignore 模型提示词 / 工具说明 / 给模型的结果
        wait_seconds: optInt('最多等待任务结束的秒数，默认 30（受命令超时限制，会自动收紧）'),   // i18n-ignore 模型提示词 / 工具说明 / 给模型的结果
      },
      output: textOut,
      async execute(args: any, exec: any) {
        if (!isJobId(args.job_id)) throw new Error(tr('非法 job_id：{id}（应为 start_background 返回的 16 位 hex）', { id: String(args.job_id) }))
        userOverride(exec)
        // 等待不能超过本次命令的超时（留 10 秒余量），否则命令被截断、拿不到状态
        const timeoutMs = deps.execTimeoutMs?.()
        const cap = Math.max(0, Math.floor((timeoutMs ?? 50_000) / 1000) - 10)
        const waitSec = Math.min(Number.isFinite(Number(args.wait_seconds)) ? Number(args.wait_seconds) : 30, cap)
        const r = await bgRun(args.terminal_id, buildCheckBackgroundCommand(args.job_id, 80, waitSec), exec?.signal, timeoutMs)
        deps.audit({ sessionId: sidOf(exec), terminalId: args.terminal_id, command: `check_background ${args.job_id}`, decision: 'read_allowed' })
        return JSON.stringify(parseCheckBackgroundOutput(args.job_id, r.output))
      },
    },
    {
      name: 'wait',
      description: '原地等待指定秒数（1–300）再继续。用于需要时间生效的场景：重启服务后等它起来、等部署/DNS/缓存生效、'   // i18n-ignore 模型提示词 / 工具说明 / 给模型的结果
        + '两次检查之间留间隔。不占用终端、无需授权；用户点停止会立即结束。不要用 exec_in_terminal 跑 sleep 来等。'   // i18n-ignore 模型提示词 / 工具说明 / 给模型的结果
        + '查后台任务直接用 check_background（它自带等待）。',   // i18n-ignore 模型提示词 / 工具说明 / 给模型的结果
      parameters: {
        seconds: { type: 'integer' as const, required: true, description: '等待秒数，1–300' },   // i18n-ignore 模型提示词 / 工具说明 / 给模型的结果
        reason: optStr('为什么等（显示给用户看）'),   // i18n-ignore 模型提示词 / 工具说明 / 给模型的结果
      },
      output: textOut,
      async execute(args: any, exec: any) {
        const sec = Math.min(300, Math.max(1, Math.floor(Number(args.seconds) || 0)))
        await abortableSleep(sec * 1000, exec?.signal)
        return JSON.stringify({ waited_seconds: sec })
      },
    },
    {
      name: 'create_terminal',
      description: '新开一个终端。type=local 开本地（自动 cd 到会话工作目录）；type=ssh 需传 hostId 开远程。返回新终端 id。',   // i18n-ignore 模型提示词 / 工具说明 / 给模型的结果
      parameters: {
        type: { type: 'string' as const, required: true, description: 'local 或 ssh' },   // i18n-ignore 模型提示词 / 工具说明 / 给模型的结果
        hostId: { type: 'string' as const, description: 'type=ssh 时必填，已保存主机的 id' },   // i18n-ignore 模型提示词 / 工具说明 / 给模型的结果
      },
      output: textOut,
      async execute(args: any, exec: any) {
        const sessionId = sidOf(exec)
        if (args.type === 'ssh') {
          if (!args.hostId) throw new Error(tr('type=ssh 需提供 hostId（已保存的 SSH 主机 id）'))
          if (!deps.createSshTerminal) throw new Error(tr('SSH 终端创建不可用'))
          const r = await deps.createSshTerminal(sessionId, args.hostId)
          return JSON.stringify(withMeta(r.terminalId, { ok: true, ...r }))
        }
        if (!deps.createLocalTerminal) throw new Error(tr('本地终端创建不可用'))
        const r = await deps.createLocalTerminal(sessionId)
        return JSON.stringify(withMeta(r.terminalId, { ok: true, ...r }))
      },
    },
    {
      name: 'propose_host_knowledge',
      description: '提议把一条【长期有效】的知识保存到知识库（新增一张知识卡，或带 card_id 更新已有卡片）。'   // i18n-ignore 模型提示词 / 工具说明 / 给模型的结果
        + '排障中发现服务部署路径、配置/日志位置、启停/重启方式、踩过的坑时主动调用。'   // i18n-ignore 模型提示词 / 工具说明 / 给模型的结果
        + '不会直接写入：用户在对话里看到卡片预览、可修改，点「保存」才写入。'   // i18n-ignore 模型提示词 / 工具说明 / 给模型的结果
        + '一事一卡，标题简短；只记稳定、可复用、非敏感的事实，绝不包含密码、密钥、token、连接串；系统提示「主机知识库」里已有的不要重复新建，要更正就带 card_id 更新。'   // i18n-ignore 模型提示词 / 工具说明 / 给模型的结果
        + 'scope=host（缺省）时用 terminal_id（该终端所在主机）或 host_id 指定主机；scope=group 给 group（分组名）；scope=global 对所有主机通用。',   // i18n-ignore 模型提示词 / 工具说明 / 给模型的结果
      parameters: {
        scope: optStr('host（缺省）/ group / global'),   // i18n-ignore 模型提示词 / 工具说明 / 给模型的结果
        terminal_id: optStr('scope=host：终端 id（取其所在主机），与 host_id 二选一'),   // i18n-ignore 模型提示词 / 工具说明 / 给模型的结果
        host_id: optStr('scope=host：已保存主机 id（本机为 local），与 terminal_id 二选一'),   // i18n-ignore 模型提示词 / 工具说明 / 给模型的结果
        group: optStr('scope=group：分组名'),   // i18n-ignore 模型提示词 / 工具说明 / 给模型的结果
        card_id: optStr('更新已有卡片时填它的 id（系统提示「主机知识库」里方括号中的那个）；新建不填'),   // i18n-ignore 模型提示词 / 工具说明 / 给模型的结果
        title: str('卡片标题，简短（如「nginx 日志位置」）'),   // i18n-ignore 模型提示词 / 工具说明 / 给模型的结果
        content: str('卡片内容（Markdown），简洁、可直接照做'),   // i18n-ignore 模型提示词 / 工具说明 / 给模型的结果
        category: optStr(`分类：${KNOWLEDGE_CATEGORIES.map((c) => `${c.id}=${c.label}`).join(' / ')}（缺省 other）`),   // i18n-ignore 模型提示词 / 工具说明 / 给模型的结果
      },
      output: textOut,
      async execute(args: any, exec: any) {
        if (!deps.proposeKnowledge) throw new Error(tr('知识库不可用'))
        const title = String(args.title ?? '').trim()
        const content = String(args.content ?? '').trim()
        if (!title || !content) throw new Error(tr('title 与 content 不能为空'))
        const scope = args.scope === 'group' || args.scope === 'global' ? args.scope : args.scope === 'host' || args.terminal_id || args.host_id ? 'host' : undefined
        let target: string | undefined
        if (scope === 'host') {
          if (args.host_id) target = String(args.host_id)
          else if (args.terminal_id) {
            // resolveHostKey 对未知终端回落 'local'，不先校验会把知识错记到本机上
            if (!deps.terminals.list().some((t) => t.id === args.terminal_id)) throw new Error(tr('终端不存在：{id}', { id: String(args.terminal_id) }))
            target = deps.resolveHostKey(args.terminal_id)
          } else throw new Error(tr('scope=host 需提供 terminal_id 或 host_id'))
        } else if (scope === 'group') {
          target = String(args.group ?? '').trim()
          if (!target) throw new Error(tr('scope=group 需提供 group（分组名）'))
        }
        const cardId = typeof args.card_id === 'string' && args.card_id.trim() ? args.card_id.trim() : undefined
        if (!scope && !cardId) throw new Error(tr('需指定归属：terminal_id / host_id（主机）、scope=group + group、或 scope=global'))
        const { targetLabel } = deps.proposeKnowledge(sidOf(exec), {
          ...(cardId ? { cardId } : {}), ...(scope ? { scope, target: target ?? '' } : {}), title, content, category: args.category,
        })
        return JSON.stringify({ ok: true, target: targetLabel, status: '已提交给用户确认，保存与否由用户决定，无需等待或重复提议' })   // i18n-ignore 模型提示词 / 工具说明 / 给模型的结果
      },
    },
    // 快速命令 / 运维手册提议：只校验规整、不落盘。对话里按工具入参出可编辑预览卡，用户点「保存」才写入（同知识卡）
    {
      name: 'propose_quick_commands',
      description: '提议把一组命令存成终端底部的「快速命令」（一个命令组 + 若干条按钮）。用户说「把刚才这套检查存成快速命令」时调用。'   // i18n-ignore 模型提示词 / 工具说明 / 给模型的结果
        + '不会直接写入：对话里出可编辑的预览卡，用户点「保存」才写入。命令要可直接在终端执行、只放稳定可复用的；绝不包含密码、密钥、token。',   // i18n-ignore 模型提示词 / 工具说明 / 给模型的结果
      parameters: {
        set_name: str('命令组名，简短（如「nginx 检查」）；与已有组同名时追加到该组'),   // i18n-ignore 模型提示词 / 工具说明 / 给模型的结果
        commands: {
          type: 'array' as const, required: true as const, description: '命令列表（1–30 条）',   // i18n-ignore 模型提示词 / 工具说明 / 给模型的结果
          items: { type: 'object' as const, additionalProperties: true, properties: { name: str('按钮名，简短'), command: str('要发进终端的命令'), description: optStr('一句话说明（可选）') } },   // i18n-ignore 模型提示词 / 工具说明 / 给模型的结果
        },
      },
      output: textOut,
      async execute(args: any) {
        const p = normalizeQuickProposal(args)
        return JSON.stringify({ ok: true, set_name: p.setName, count: p.commands.length, status: '已提交给用户确认（对话里的预览卡），保存与否由用户决定，无需等待或重复提议' })   // i18n-ignore 模型提示词 / 工具说明 / 给模型的结果
      },
    },
    {
      name: 'propose_runbook',
      description: '提议把一套操作沉淀成「运维手册」（标题、说明、按顺序的步骤、参数）。用户说「把刚才这套检查存成手册」时调用。'   // i18n-ignore 模型提示词 / 工具说明 / 给模型的结果
        + '会变的值（主机、IP、路径、服务名）提成参数，命令里用双花括号包住参数名。只读步骤 kind=check，改动系统的 kind=change。'   // i18n-ignore 模型提示词 / 工具说明 / 给模型的结果
        + '不会直接写入：对话里出可编辑的预览卡，用户点「保存」才写入；绝不包含密码、密钥、token。',   // i18n-ignore 模型提示词 / 工具说明 / 给模型的结果
      parameters: {
        title: str('手册标题，简短（如「nginx 502 排查」）'),   // i18n-ignore 模型提示词 / 工具说明 / 给模型的结果
        description: optStr('说明：什么时候用（可选）'),   // i18n-ignore 模型提示词 / 工具说明 / 给模型的结果
        steps: {
          type: 'array' as const, required: true as const, description: '步骤（按执行顺序）',   // i18n-ignore 模型提示词 / 工具说明 / 给模型的结果
          items: { type: 'object' as const, additionalProperties: true, properties: { title: str('步骤标题'), command: optStr('命令（可选，可含参数占位）'), expect: optStr('预期结果（可选）'), kind: optStr('check（只读）或 change（改动）') } },   // i18n-ignore 模型提示词 / 工具说明 / 给模型的结果
        },
        params: {
          type: 'array' as const, description: '参数（可选；步骤里用到但没列出的会自动补上）',   // i18n-ignore 模型提示词 / 工具说明 / 给模型的结果
          items: { type: 'object' as const, additionalProperties: true, properties: { name: str('参数名（与命令里占位一致）'), label: optStr('显示名'), default: optStr('默认值') } },   // i18n-ignore 模型提示词 / 工具说明 / 给模型的结果
        },
      },
      output: textOut,
      async execute(args: any) {
        const r = runbookFromProposal(args)
        return JSON.stringify({ ok: true, title: r.name, steps: r.steps.length, params: r.params.map((p) => p.name), status: '已提交给用户确认（对话里的预览卡），保存与否由用户决定，无需等待或重复提议' })   // i18n-ignore 模型提示词 / 工具说明 / 给模型的结果
      },
    },
    {
      name: 'run_on_hosts',
      description: '跨主机提问：在多台已保存主机上并行执行同一条【只读】命令（每台独立通道，不占用、不需要打开终端），'   // i18n-ignore 模型提示词 / 工具说明 / 给模型的结果
        + '返回每台的状态、退出码、输出（每台取末尾）、耗时、失败原因，summary 给出成功数、失败主机和输出完全相同的分组。'   // i18n-ignore 模型提示词 / 工具说明 / 给模型的结果
        + '用户问「哪些机器…」「所有机器的…」「对比各台…」时用它。targets 填主机 id 或分组名（见系统提示「跨主机提问」段）。'   // i18n-ignore 模型提示词 / 工具说明 / 给模型的结果
        + '只允许只读命令（查看类），非只读直接拒绝；需每台主机的读取授权（合并成一张授权卡）。务必填 explain。',   // i18n-ignore 模型提示词 / 工具说明 / 给模型的结果
      parameters: {
        targets: {
          type: 'array' as const, required: true as const, items: { type: 'string' as const },
          description: '目标：主机 id 或分组名（可混填），如 ["web"] 或 ["host_a","host_b"]',   // i18n-ignore 模型提示词 / 工具说明 / 给模型的结果
        },
        command: str('要在每台上执行的只读命令'),   // i18n-ignore 模型提示词 / 工具说明 / 给模型的结果
        timeout: optInt(`每台超时秒数，默认 ${FLEET_DEFAULT_TIMEOUT_SEC}，最大 ${FLEET_MAX_TIMEOUT_SEC}`),   // i18n-ignore 模型提示词 / 工具说明 / 给模型的结果
        explain,
      },
      output: textOut,
      async execute(args: any, exec: any) {
        const rule = userOverride(exec)?.rule
        const c = fleetCheck(deps, args)
        if ('error' in c) throw new Error(c.error)
        const sec = clampInt(Number(args.timeout), 1, FLEET_MAX_TIMEOUT_SEC, FLEET_DEFAULT_TIMEOUT_SEC)
        const sessionId = sidOf(exec)
        const rows = await deps.runOnHosts!(c.hosts, c.command, sec * 1000, exec?.signal, sessionId)
        // 命令确实发出去了的才记执行记录（连接失败 / 没起就取消的不记；执行到一半被中止的带输出，要记）
        for (const r of rows) {
          if (r.status !== 'ok' && r.status !== 'fail' && r.status !== 'timeout' && !(r.status === 'canceled' && r.executed)) continue
          deps.audit({ sessionId, terminalId: '', hostKey: r.host_id, terminalTitle: r.label, command: c.command, decision: FLEET_DECISION,
            ...(typeof r.exit_code === 'number' ? { exitCode: r.exit_code } : {}), ...(r.truncated || r.status === 'timeout' ? { truncated: true } : {}), ...ruleOf(rule) })
        }
        if (exec?.signal?.aborted) throw new Error('aborted')
        return JSON.stringify({ command: c.command, results: rows, summary: summarizeFleet(rows) })
      },
    },
    {
      name: 'upload_file',
      description: '把【本地文件】上传到 SSH 主机（复用应用的加密传输）。上传动作【必须用本工具】，'   // i18n-ignore 模型提示词 / 工具说明 / 给模型的结果
        + '禁止用 exec_in_terminal 跑 scp/rsync/sftp/base64/cat>file 自行上传。需目标主机的写入授权。',   // i18n-ignore 模型提示词 / 工具说明 / 给模型的结果
      parameters: {
        local_path: str('运行本应用那台机器上的文件绝对路径'),   // i18n-ignore 模型提示词 / 工具说明 / 给模型的结果
        terminal_id: str('SSH 终端 id，据此确定目标主机'),   // i18n-ignore 模型提示词 / 工具说明 / 给模型的结果
        target_dir: str('服务器上的目标目录，不存在会自动创建'),   // i18n-ignore 模型提示词 / 工具说明 / 给模型的结果
      },
      output: textOut,
      async execute(args: any, exec: any) {
        if (!deps.uploadFile) throw new Error(tr('文件上传不可用'))
        userOverride(exec)
        await beforeChange(exec, [args.terminal_id])
        const r = await deps.uploadFile(args.local_path, args.terminal_id, args.target_dir)
        deps.audit({
          sessionId: sidOf(exec), terminalId: args.terminal_id,
          command: `upload ${args.local_path} → ${args.target_dir}`, decision: 'upload_allowed',
        })
        return JSON.stringify({ ok: true, host: r.host, target_dir: args.target_dir, encrypted: r.encrypted })
      },
    },
    {
      name: 'read_file',
      description: '读取终端所在主机（本地或 SSH）上的文本文件，可指定行号区间（1 起，含两端）；单次最多 2000 行，'   // i18n-ignore 模型提示词 / 工具说明 / 给模型的结果
        + '截断时 truncated=true，用 start_line=end_line+1 续读。看文件内容请用本工具，不要在终端里 cat。需该主机的读取授权。',   // i18n-ignore 模型提示词 / 工具说明 / 给模型的结果
      parameters: {
        terminal_id: str('终端 id，据此确定主机'),   // i18n-ignore 模型提示词 / 工具说明 / 给模型的结果
        path: str('文件绝对路径（远程可用 ~/ 开头）'),   // i18n-ignore 模型提示词 / 工具说明 / 给模型的结果
        start_line: optInt('起始行号，缺省 1'),   // i18n-ignore 模型提示词 / 工具说明 / 给模型的结果
        end_line: optInt('结束行号，缺省到文件末尾'),   // i18n-ignore 模型提示词 / 工具说明 / 给模型的结果
      },
      output: textOut,
      async execute(args: any, exec: any) {
        if (!deps.readFile) throw new Error(tr('文件读写不可用'))
        userOverride(exec)
        const text = await deps.readFile(args.terminal_id, args.path)
        if (text === undefined) throw new Error(tr('文件不存在：{path}', { path: String(args.path) }))
        assertText(text, args.path)
        deps.audit({ sessionId: sidOf(exec), terminalId: args.terminal_id, command: tr('读取 {path}', { path: String(args.path) }), decision: 'read_allowed' })
        return JSON.stringify({ path: args.path, ...sliceLines(text, args.start_line, args.end_line) })
      },
    },
    {
      name: 'write_file',
      description: '修改或新建终端所在主机（本地或 SSH）上的文本文件。二选一：content=整文件新内容（新建/重写）；'   // i18n-ignore 模型提示词 / 工具说明 / 给模型的结果
        + 'old_text+new_text=把文件里唯一出现的 old_text 换成 new_text（改局部首选，old_text 须逐字一致并带足上下文）。'   // i18n-ignore 模型提示词 / 工具说明 / 给模型的结果
        + '首次写入该主机、或会话为「确认」档 / 生产主机时会把 diff 给用户确认；覆盖前自动备份原文件，用户可在执行记录里一键还原。'   // i18n-ignore 模型提示词 / 工具说明 / 给模型的结果
        + '改文件请用本工具，不要在终端里用 sed -i / echo > / cat <<EOF 改。需该主机的写入授权。',   // i18n-ignore 模型提示词 / 工具说明 / 给模型的结果
      parameters: {
        terminal_id: str('终端 id，据此确定主机'),   // i18n-ignore 模型提示词 / 工具说明 / 给模型的结果
        path: str('文件绝对路径（远程可用 ~/ 开头）'),   // i18n-ignore 模型提示词 / 工具说明 / 给模型的结果
        content: optStr('整文件新内容（与 old_text/new_text 二选一）'),   // i18n-ignore 模型提示词 / 工具说明 / 给模型的结果
        old_text: optStr('要被替换的原文片段（须在文件中唯一出现）'),   // i18n-ignore 模型提示词 / 工具说明 / 给模型的结果
        new_text: optStr('替换成的新片段'),   // i18n-ignore 模型提示词 / 工具说明 / 给模型的结果
      },
      output: textOut,
      async execute(args: any, exec: any) {
        const o = userOverride(exec)
        const plan = await planWrite(deps, args)
        // 授权卡上展示的是当时的原文；之后文件又被改过就不写，免得用户批的 diff 和实际写的不一致
        if (o && 'base' in o && o.base !== (plan.old ?? null)) throw new Error(tr('文件在授权后被改动过，未写入；请重新 read_file 后再改'))
        await beforeChange(exec, [args.terminal_id])
        const r = await deps.writeFile!(args.terminal_id, args.path, plan.next)
        deps.audit({
          sessionId: sidOf(exec), terminalId: args.terminal_id, command: tr('写入 {path}', { path: r.path }),
          decision: 'write_allowed', filePath: r.path, backupPath: r.backupPath,
          created: plan.old === undefined, ...(r.hash ? { afterHash: r.hash } : {}),
        })
        // diff 随结果回给 UI（工具卡展开可看改了什么，免弹卡时也看得到）；截断控制进模型的长度
        const diff = truncateLines(unifiedDiff(plan.old ?? '', plan.next, r.path), DIFF_MAX_LINES)
        return JSON.stringify({ ok: true, path: r.path, created: plan.old === undefined, ...(r.backupPath ? { backup_path: r.backupPath } : {}), diff })
      },
    },
    {
      name: 'download_file',
      description: '把 SSH 主机上的单个文件下载到本机（~/Downloads/lingshell/ 下，重名自动加时间前缀），返回本地路径。'   // i18n-ignore 模型提示词 / 工具说明 / 给模型的结果
        + '下载请用本工具，不要在终端里跑 scp/sftp/base64。每次都需用户确认。',   // i18n-ignore 模型提示词 / 工具说明 / 给模型的结果
      parameters: {
        terminal_id: str('SSH 终端 id，据此确定主机（须为已保存的主机）'),   // i18n-ignore 模型提示词 / 工具说明 / 给模型的结果
        path: str('远程文件绝对路径'),   // i18n-ignore 模型提示词 / 工具说明 / 给模型的结果
      },
      output: textOut,
      async execute(args: any, exec: any) {
        if (!deps.downloadFile) throw new Error(tr('文件下载不可用'))
        userOverride(exec)
        const r = await deps.downloadFile(args.terminal_id, args.path)
        deps.audit({
          sessionId: sidOf(exec), terminalId: args.terminal_id,
          command: tr('下载 {path} → {local}', { path: String(args.path), local: r.localPath }), decision: 'download_allowed',
        })
        return JSON.stringify({ ok: true, local_path: r.localPath })
      },
    },
  ]
  // 每个工具体外包一层脱敏：返回值就是进模型的内容；拒绝时取走网关记下的 override
  // 密钥保险箱的明文回写不受「发给 AI 前脱敏」开关影响，始终做
  const mask = deps.secretVault ? (s: string) => deps.secretVault!.mask(s) : undefined
  return defs.map((d) => withRedaction(d, () => deps.aiSecrets?.(), (exec) => deps.takeUserOverride?.(String(exec?.callId ?? '')), mask))
}
