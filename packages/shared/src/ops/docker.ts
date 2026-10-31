// 容器视图（Docker）：命令构造 + 纯解析 + 出错归类。只支持 SSH 终端（Linux / macOS），走独立 exec channel（execRead），不碰交互 shell。
// 容器 id / 名称只取自 docker ps 的解析结果，且拼命令前一律过 isDockerRef 校验（字符集里没有任何 shell 元字符）。
import type { TermOs, TerminalType } from '../protocol/index.js'
import { tk, tr } from '../i18n/i18n.js'

export type DockerMode = 'docker' | 'sudo'   // sudo = sudo -n docker（仅免密 sudo 可用时）
export type DockerAction = 'start' | 'stop' | 'restart'
export type DockerProblem = 'missing' | 'permission' | 'daemon' | 'sudo_denied' | 'error'

export interface DockerContainer {
  id: string
  name: string
  image: string
  status: string     // 「Up 2 hours」等原文
  state: string      // running / exited / paused / created / restarting…
  ports: string
  created: string
}
export interface DockerStat { cpu: string; mem: string; memPct: string }
export interface DockerListResult {
  mode: DockerMode
  containers?: DockerContainer[]
  problem?: DockerProblem
  message?: string     // 出错时的原始输出（截断），给人看
  sudoOk?: boolean     // problem=permission 时：免密 sudo 是否可用（可用才给「用 sudo -n 重试」）
}

export const DOCKER_TIMEOUT_MS = 15_000
export const dockerSupported = (type: TerminalType, os?: TermOs): boolean => type === 'ssh' && (os === 'linux' || os === 'macos')

const REF = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/
export const isDockerRef = (s: unknown): s is string => typeof s === 'string' && s.length <= 128 && REF.test(s)
export const isDockerAction = (s: unknown): s is DockerAction => s === 'start' || s === 'stop' || s === 'restart'
const ref = (s: string) => { if (!isDockerRef(s)) throw new Error(tr('非法的容器标识：{v}', { v: s })); return s }

const bin = (mode: DockerMode) => (mode === 'sudo' ? 'sudo -n docker' : 'docker')
const shQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`
const RC = '@@rc:'
// 远端统一 sh -c 执行（登录 shell 是 fish/csh 也一样）；stderr 并进 stdout，末尾打退出码标记
const wrap = (script: string) => `sh -c ${shQuote(`export LC_ALL=C; ${script} 2>&1; echo "${RC}$?"`)}`
// 看日志：输出可能超过读取上限（256KB），截断会连退出码标记一起丢掉、整段被当成出错。远端只留最后 200KB，标记在最末尾总能保住
const LOG_TAIL_BYTES = 200 * 1024
const wrapTail = (script: string) => `sh -c ${shQuote(`export LC_ALL=C; { ${script} 2>&1; echo "${RC}$?"; } | tail -c ${LOG_TAIL_BYTES}`)}`

export const dockerPsCommand = (mode: DockerMode) => wrap(`${bin(mode)} ps -a --format '{{json .}}'`)
export const dockerStatsCommand = (mode: DockerMode) => wrap(`${bin(mode)} stats --no-stream --format '{{json .}}'`)
export const dockerLogsCommand = (mode: DockerMode, id: string, tail = 200) => wrapTail(`${bin(mode)} logs --tail ${Math.max(1, Math.floor(tail))} ${ref(id)}`)
export const dockerActionCommand = (mode: DockerMode, action: DockerAction, id: string) => wrap(`${bin(mode)} ${action} ${ref(id)}`)
// 探测免密 sudo：-n 不会弹密码，要密码直接失败
export const sudoProbeCommand = () => wrap('sudo -n true')

// 新终端标签里要敲的命令（交互式，不包 sh -c；sudo 模式同样 -n，绝不提示密码）
export const dockerFollowLine = (mode: DockerMode, id: string) => `${bin(mode)} logs -f --tail 100 ${ref(id)}`
export const dockerExecLine = (mode: DockerMode, id: string) =>
  `${bin(mode)} exec -it ${ref(id)} sh -c 'command -v bash >/dev/null && exec bash || exec sh'`

// 拆出退出码标记（取最后一个；被截断没有标记 → rc undefined）
export function splitRc(out: string): { rc?: number; text: string } {
  const i = out.lastIndexOf(RC)
  if (i < 0) return { text: out.trim() }
  const rc = Number.parseInt(out.slice(i + RC.length), 10)
  return { rc: Number.isFinite(rc) ? rc : undefined, text: out.slice(0, i).trim() }
}

const jsonLines = (text: string): Record<string, unknown>[] => {
  const rows: Record<string, unknown>[] = []
  for (const line of text.split(/\r?\n/)) {
    const s = line.trim()
    if (!s.startsWith('{')) continue   // 登录横幅 / 警告行
    try {
      const v: unknown = JSON.parse(s)
      if (v && typeof v === 'object' && !Array.isArray(v)) rows.push(v as Record<string, unknown>)
    } catch { /* 坏行跳过 */ }
  }
  return rows
}
const str = (v: unknown) => (typeof v === 'string' ? v : '')

// 老版本 docker 没有 State 字段：从 Status 推
const stateOf = (state: string, status: string) => {
  if (state) return state.toLowerCase()
  if (/^up\b/i.test(status)) return /\(paused\)/i.test(status) ? 'paused' : 'running'
  if (/^exited\b/i.test(status)) return 'exited'
  if (/^created\b/i.test(status)) return 'created'
  if (/^restarting\b/i.test(status)) return 'restarting'
  return 'unknown'
}

export function parseDockerPs(text: string): DockerContainer[] {
  const out: DockerContainer[] = []
  for (const r of jsonLines(text)) {
    const id = str(r.ID)
    const name = str(r.Names).split(',')[0]
    if (!isDockerRef(id) || !isDockerRef(name)) continue   // 标识不合规的行不展示（后面也不能拼进命令）
    const status = str(r.Status)
    out.push({ id, name, image: str(r.Image), status, state: stateOf(str(r.State), status), ports: str(r.Ports), created: str(r.CreatedAt) || str(r.RunningFor) })
  }
  return out
}

// docker stats 的 ID 是短 id、Name 是容器名：两个 key 都记，按 ps 的 id 前缀或名称取
export function parseDockerStats(text: string): Map<string, DockerStat> {
  const m = new Map<string, DockerStat>()
  for (const r of jsonLines(text)) {
    const s: DockerStat = { cpu: str(r.CPUPerc), mem: str(r.MemUsage), memPct: str(r.MemPerc) }
    if (!s.cpu && !s.mem) continue
    for (const k of [str(r.ID), str(r.Name), str(r.Container)]) if (k) m.set(k, s)
  }
  return m
}
export function statFor(stats: Map<string, DockerStat>, c: DockerContainer): DockerStat | undefined {
  const byName = stats.get(c.name)
  if (byName) return byName
  for (const [k, v] of stats) if (k.length >= 12 && c.id.startsWith(k)) return v
  return undefined
}

// 出错归类（输出已 LC_ALL=C）：顺序有讲究——sudo 自己的报错先认；socket 权限先于「命令不存在」
export function classifyDockerError(rc: number | undefined, text: string, mode: DockerMode): DockerProblem {
  if (mode === 'sudo' && /sudo: (a )?password is required|sudo: a terminal is required|is not in the sudoers|not allowed to execute|sudo: (command )?not found/i.test(text)) return 'sudo_denied'
  if (/permission denied[^\n]*docker(\.sock| daemon socket)|docker\.sock: connect: permission denied/i.test(text)) return 'permission'
  if (rc === 127 || /docker: (command )?not found|docker: not found|command not found: docker/i.test(text)) return 'missing'
  if (/cannot connect to the docker daemon|is the docker daemon running/i.test(text)) return 'daemon'
  return 'error'
}

export const DOCKER_PROBLEM_TEXT: Record<DockerProblem, string> = {
  missing: tk('未安装 Docker（远端找不到 docker 命令）'),
  permission: tk('没有权限访问 Docker：当前用户不在 docker 组（无法访问 /var/run/docker.sock）。可让管理员执行 sudo usermod -aG docker $USER 后重新登录'),
  daemon: tk('Docker 服务未运行（连不上 Docker daemon）'),
  sudo_denied: tk('sudo -n 不可用：该用户没有免密 sudo（不会提示输入密码）'),
  error: tk('docker 命令执行失败'),
}

// 执行记录 decision：docker_start / docker_stop / docker_restart
export const dockerDecision = (a: DockerAction) => `docker_${a}`
export const DOCKER_ACTION_LABEL: Record<DockerAction, string> = { start: tk('启动'), stop: tk('停止'), restart: tk('重启') }
export function dockerAuditLabel(decision: string): string | undefined {
  const a = decision.startsWith('docker_') ? decision.slice(7) : ''
  if (a.startsWith('compose_')) { const c = a.slice(8); return isComposeAction(c) ? `Compose ${tr(COMPOSE_ACTION_LABEL[c])}` : undefined }
  return isDockerAction(a) ? tr('容器{action}', { action: tr(DOCKER_ACTION_LABEL[a]) }) : undefined
}

// ── 本机视图：本地终端也能开容器抽屉（本机 docker CLI，经 Git Bash / sh 跑同样的命令）──
export const dockerLocalSupported = (type: TerminalType): boolean => type === 'local'
// 本机的出错提示（Windows 上 Docker Desktop 没启动时报 error during connect / 找不到 docker_engine 管道）
export const DOCKER_LOCAL_PROBLEM_TEXT: Record<DockerProblem, string> = {
  missing: tk('本机没有安装 Docker（找不到 docker 命令）。安装 Docker Desktop（Windows / macOS）或 Docker Engine（Linux）后点「刷新」即可。'),
  permission: tk('没有权限访问本机 Docker：当前用户不在 docker 组（Linux 上可执行 sudo usermod -aG docker $USER 后重新登录）'),
  daemon: tk('本机 Docker 没有运行：先启动 Docker Desktop（或 dockerd 服务），再点「刷新」'),
  sudo_denied: DOCKER_PROBLEM_TEXT.sudo_denied,
  error: tk('docker 命令执行失败'),
}
/** 本机：Windows 的 Docker Desktop 没启动时的报错也归到 daemon */
export function classifyLocalDockerError(rc: number | undefined, text: string): DockerProblem {
  if (/error during connect|docker_engine|dockerDesktopLinuxEngine/i.test(text)) return 'daemon'
  return classifyDockerError(rc, text, 'docker')
}

// ── Compose 项目（docker compose ls）──
export interface ComposeProject { name: string; status: string; configFiles: string[] }
export type ComposeAction = 'up' | 'down' | 'restart'
export const isComposeAction = (s: unknown): s is ComposeAction => s === 'up' || s === 'down' || s === 'restart'
export const COMPOSE_ACTION_LABEL: Record<ComposeAction, string> = { up: tk('启动（up -d）'), down: tk('停止并删除（down）'), restart: tk('重启') }
// 项目名：compose 只允许小写字母数字和 _ -（老版本允许大写，放宽一点）
export const isComposeName = (s: unknown): s is string => typeof s === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(s)
const isCfgPath = (s: unknown): s is string => typeof s === 'string' && s.length > 0 && s.length <= 1024 && !/[\0\r\n]/.test(s)
const cname = (s: string) => { if (!isComposeName(s)) throw new Error(tr('非法的项目名：{v}', { v: s })); return s }

const COMPOSE_MARK = '@@composels'
// 哨兵：compose 的警告里可能带 [ ]，不能靠第一个 [ / 最后一个 ] 截 JSON
export const composeLsCommand = (mode: DockerMode) => wrap(`echo '${COMPOSE_MARK}'; ${bin(mode)} compose ls -a --format json`)
/** up 要配置文件（-f），down / restart 按项目名就行 */
export function composeActionCommand(mode: DockerMode, action: ComposeAction, p: ComposeProject): string {
  const files = action === 'up' ? p.configFiles.filter(isCfgPath).map((f) => ` -f ${shQuote(f)}`).join('') : ''
  return wrap(`${bin(mode)} compose -p ${cname(p.name)}${files} ${action === 'up' ? 'up -d' : action}`)
}
export const composeLogsCommand = (mode: DockerMode, name: string, tail = 200) =>
  wrapTail(`${bin(mode)} compose -p ${cname(name)} logs --no-color --tail ${Math.max(1, Math.floor(tail))}`)
export const composeFollowLine = (mode: DockerMode, name: string) => `${bin(mode)} compose -p ${cname(name)} logs -f --tail 100`

/** docker compose ls --format json：一个 JSON 数组 [{Name, Status, ConfigFiles}]，ConfigFiles 逗号分隔 */
export function parseComposeLs(text: string): ComposeProject[] {
  const mi = text.lastIndexOf(COMPOSE_MARK)
  const t = mi >= 0 ? text.slice(mi + COMPOSE_MARK.length) : text
  const i = t.indexOf('[')
  if (i < 0) return []
  let arr: unknown
  try { arr = JSON.parse(t.slice(i, t.lastIndexOf(']') + 1)) } catch { return [] }
  if (!Array.isArray(arr)) return []
  return arr.flatMap((x) => {
    const r = (x && typeof x === 'object' ? x : {}) as Record<string, unknown>
    const name = str(r.Name)
    if (!isComposeName(name)) return []
    return [{ name, status: str(r.Status), configFiles: str(r.ConfigFiles).split(',').map((s) => s.trim()).filter(isCfgPath) }]
  })
}
/** 执行记录：docker_compose_up / down / restart */
export const composeDecision = (a: ComposeAction) => `docker_compose_${a}`
