import {
  DOCKER_LOCAL_PROBLEM_TEXT, DOCKER_PROBLEM_TEXT, DOCKER_TIMEOUT_MS, classifyDockerError, classifyLocalDockerError, composeActionCommand, composeDecision, composeFollowLine, composeLogsCommand,
  composeLsCommand, dockerActionCommand, dockerDecision, dockerExecLine, dockerFollowLine, dockerLocalSupported, dockerLogsCommand, dockerPsCommand, dockerStatsCommand,
  dockerSupported, isComposeAction, isComposeName, isDockerAction, isDockerRef, parseComposeLs, parseDockerPs, parseDockerStats, splitRc, sudoProbeCommand,
  type ComposeAction, type ComposeProject, type DockerAction, type DockerListResult, type DockerMode, type DockerProblem, type DockerStat, type TerminalInfo,
} from '@lingshell/shared'
import { tr } from '@lingshell/shared'

// 容器视图主进程侧（命令 / 解析见 shared/ops/docker.ts）：SSH 终端走独立 exec channel；本地终端（本机视图）走本机 sh 子进程。都不碰交互 shell
export type ExecRead = (cmd: string, timeoutMs: number) => Promise<string>
const MSG_MAX = 2000

const run = async (exec: ExecRead, cmd: string) => splitRc(await exec(cmd, DOCKER_TIMEOUT_MS))
// local：本机视图（出错归类 / 提示文字按本机说，不探测 sudo）
const classify = (rc: number | undefined, text: string, mode: DockerMode, local: boolean): DockerProblem => (local ? classifyLocalDockerError(rc, text) : classifyDockerError(rc, text, mode))
const fail = (text: string, mode: DockerMode, rc: number | undefined, local = false) => {
  const p = classify(rc, text, mode, local)
  return new Error(p === 'error' ? text.slice(0, MSG_MAX) || tr(DOCKER_PROBLEM_TEXT.error) : tr((local ? DOCKER_LOCAL_PROBLEM_TEXT : DOCKER_PROBLEM_TEXT)[p]))
}

// 列容器。无权限时顺带探测免密 sudo（sudo -n true，不会弹密码），由用户决定要不要切到 sudo -n
export async function dockerList(exec: ExecRead, mode: DockerMode, local = false): Promise<DockerListResult> {
  const { rc, text } = await run(exec, dockerPsCommand(mode))
  if (rc === 0) return { mode, containers: parseDockerPs(text) }
  const problem = classify(rc, text, mode, local)
  const r: DockerListResult = { mode, problem, message: text.slice(0, MSG_MAX) }
  if (problem === 'permission' && mode === 'docker' && !local) r.sudoOk = (await run(exec, sudoProbeCommand()).catch(() => ({ rc: 1 }))).rc === 0
  return r
}

// docker stats 要采样 1~2 秒，单独按需调；key = 短 id / 名称（UI 用 statFor 对上）
export async function dockerStats(exec: ExecRead, mode: DockerMode, local = false): Promise<Record<string, DockerStat>> {
  const { rc, text } = await run(exec, dockerStatsCommand(mode))
  if (rc !== 0) throw fail(text, mode, rc, local)
  return Object.fromEntries(parseDockerStats(text))
}

export async function dockerLogs(exec: ExecRead, mode: DockerMode, id: string, local = false): Promise<string> {
  const { rc, text } = await run(exec, dockerLogsCommand(mode, id))
  if (rc !== 0) throw fail(text, mode, rc, local)
  return text
}

// 不抛：调用方要先记执行记录（含退出码）再决定报错
export async function dockerAction(exec: ExecRead, mode: DockerMode, action: DockerAction, id: string, local = false): Promise<{ rc?: number; error?: string }> {
  const { rc, text } = await run(exec, dockerActionCommand(mode, action, id))
  return rc === 0 ? { rc } : { rc, error: fail(text, mode, rc, local).message }
}

// Compose 项目：docker compose ls（老版本 docker 没有 compose 子命令时报错给人看）
export async function composeList(exec: ExecRead, mode: DockerMode, local = false): Promise<ComposeProject[]> {
  const { rc, text } = await run(exec, composeLsCommand(mode))
  if (rc !== 0) {
    if (/is not a docker command|unknown command|unknown flag: --format/i.test(text)) throw new Error(tr('该 Docker 没有 compose 插件（docker compose），或版本太老不支持 compose ls'))
    throw fail(text, mode, rc, local)
  }
  return parseComposeLs(text)
}
export async function composeLogs(exec: ExecRead, mode: DockerMode, name: string, local = false): Promise<string> {
  const { rc, text } = await run(exec, composeLogsCommand(mode, name))
  if (rc !== 0) throw fail(text, mode, rc, local)
  return text
}
export async function composeAction(exec: ExecRead, mode: DockerMode, action: ComposeAction, p: ComposeProject, local = false): Promise<{ rc?: number; error?: string }> {
  // up 可能要拉镜像，给足时间
  const { rc, text } = splitRc(await exec(composeActionCommand(mode, action, p), action === 'up' ? 180_000 : 60_000))
  return rc === 0 ? { rc } : { rc, error: fail(text, mode, rc, local).message }
}

// ── IPC：渲染层传来的参数一律当不可信，mode / action / 标识逐个校验 ──
export interface DockerIpcDeps {
  handle(channel: string, fn: (e: unknown, ...args: unknown[]) => unknown): void
  terminal(id: string): TerminalInfo | undefined
  exec(id: string): ExecRead
  // 本机视图：本地终端用本机 docker（不给就不支持本地终端）
  localExec?: ExecRead
  // 记执行记录（hostKey / 终端名 / 会话由 ipc.ts 补）
  audit(terminalId: string, entry: { command: string; decision: string; exitCode?: number }): void
  // 同主机新开终端并敲入一行命令
  openTerminal(terminalId: string, line: string): Promise<void>
}
const modeOf = (m: unknown): DockerMode => (m === 'sudo' ? 'sudo' : 'docker')

export function registerDocker(d: DockerIpcDeps): void {
  // 本地终端：本机 docker，mode 固定 docker（不走 sudo）
  const target = (id: unknown, m: unknown) => {
    const t = typeof id === 'string' ? d.terminal(id) : undefined
    if (!t) throw new Error('terminal_not_found')
    if (d.localExec && dockerLocalSupported(t.type)) return { t, local: true, exec: d.localExec, mode: 'docker' as DockerMode }
    if (!dockerSupported(t.type, t.os)) throw new Error(tr('容器视图只支持本地终端和 Linux / macOS 的 SSH 终端'))
    return { t, local: false, exec: d.exec(t.id), mode: modeOf(m) }
  }
  const refOf = (r: unknown) => { if (!isDockerRef(r)) throw new Error(tr('非法的容器标识')); return r }
  const projOf = (p: unknown): ComposeProject => {
    const o = (p && typeof p === 'object' ? p : {}) as Record<string, unknown>
    if (!isComposeName(o.name)) throw new Error(tr('非法的 Compose 项目名'))
    return { name: o.name, status: '', configFiles: Array.isArray(o.configFiles) ? o.configFiles.filter((f): f is string => typeof f === 'string') : [] }
  }
  d.handle('docker:list', (_e, id, mode) => { const x = target(id, mode); return dockerList(x.exec, x.mode, x.local) })
  d.handle('docker:stats', (_e, id, mode) => { const x = target(id, mode); return dockerStats(x.exec, x.mode, x.local) })
  d.handle('docker:logs', (_e, id, mode, ref) => { const x = target(id, mode); return dockerLogs(x.exec, x.mode, refOf(ref), x.local) })
  d.handle('docker:action', async (_e, id, mode, action, ref, name) => {
    const x = target(id, mode), r = refOf(ref)
    if (!isDockerAction(action)) throw new Error(tr('非法的容器操作'))
    const label = isDockerRef(name) && name !== r ? `${r} (${name})` : r
    const res = await dockerAction(x.exec, x.mode, action, r, x.local)
    d.audit(x.t.id, { command: `${x.mode === 'sudo' ? 'sudo -n docker' : 'docker'} ${action} ${label}`, decision: dockerDecision(action), exitCode: res.rc })
    if (res.error) throw new Error(res.error)
  })
  d.handle('docker:openTerminal', async (_e, id, mode, kind, ref) => {
    const x = target(id, mode)
    if (kind === 'composeLogs') { if (!isComposeName(ref)) throw new Error(tr('非法的 Compose 项目名')); await d.openTerminal(x.t.id, composeFollowLine(x.mode, ref)); return }
    const r = refOf(ref)
    await d.openTerminal(x.t.id, kind === 'exec' ? dockerExecLine(x.mode, r) : dockerFollowLine(x.mode, r))
  })
  d.handle('docker:composeList', (_e, id, mode) => { const x = target(id, mode); return composeList(x.exec, x.mode, x.local) })
  d.handle('docker:composeLogs', (_e, id, mode, name) => {
    const x = target(id, mode)
    if (!isComposeName(name)) throw new Error(tr('非法的 Compose 项目名'))
    return composeLogs(x.exec, x.mode, name, x.local)
  })
  d.handle('docker:composeAction', async (_e, id, mode, action, project) => {
    const x = target(id, mode), p = projOf(project)
    if (!isComposeAction(action)) throw new Error(tr('非法的 Compose 操作'))
    // configFiles 来自渲染层，不能信：重新读服务端项目列表，按项目名取服务端配置文件
    const server = (await composeList(x.exec, x.mode, x.local)).find((pr) => pr.name === p.name)
    if (!server) throw new Error(tr('服务端没有这个 Compose 项目（列表可能已过期），请刷新后重试'))
    if (action === 'up' && !server.configFiles.length) throw new Error(tr('这个 Compose 项目没有可用的配置文件，不能启动；可用「重启」启动已有容器，或到终端里处理'))
    const safe: ComposeProject = { ...p, status: server.status, configFiles: server.configFiles }
    const res = await composeAction(x.exec, x.mode, action, safe, x.local)
    d.audit(x.t.id, { command: `${x.mode === 'sudo' ? 'sudo -n docker' : 'docker'} compose -p ${safe.name} ${action === 'up' ? 'up -d' : action}`, decision: composeDecision(action), exitCode: res.rc })
    if (res.error) throw new Error(res.error)
  })
}
