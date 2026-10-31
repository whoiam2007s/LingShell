// 主机体检 / 主机档案 / 配置漂移 / AI 变更前后快照（主进程侧；脚本、解析、问题判定、差异见 shared/ops/hostProfile.ts）。
// 采集全走 SSH 独立 exec channel（不碰交互 shell、不进命令历史、不经 AI），只读。
// 档案落 <数据目录>/profiles/<主机>/<时间>-<check|snapshot>.json（两类各留最近 20 份）；
// 关键配置文件内容按 sha256 存 files/<sha>.txt（多份档案共用，清旧档案时顺手清掉没人引用的）。
// 变更报告（每会话一个文件）存 profiles/_turns/<会话>.json。
import { createHash } from 'node:crypto'
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  CONFIG_FILES, HOSTCHECK_MAX_OUTPUT, HOSTCHECK_TIMEOUT_MS, PROFILE_KEEP, SNAPSHOT_TIMEOUT_MS,
  diffIsEmpty, diffProfiles, findIssues, hostCheckCommand, hostCheckSupported, hostDirName, parseHostProfile, summarizeDiff,
  type AgentEvent, type HostProfile, type ProfileMeta, type ProfileType, type TerminalInfo, type TurnHostChange, type TurnHostReport,
} from '@lingshell/shared'
import { tr } from '@lingshell/shared'

const sha = (s: string) => createHash('sha256').update(Buffer.from(s, 'utf8')).digest('hex')
const SHA_RE = /^[0-9a-f]{64}$/
const ID_RE = /^[0-9TZ-]+-(check|snapshot)$/
const TURN_REPORT_KEEP = 200
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e))

export class ProfileStore {
  constructor(private root: string) {}
  private dir(hostKey: string) { return join(this.root, hostDirName(hostKey)) }

  /** 存一份档案 + 本次带回的配置文件内容；按类型只留最近 PROFILE_KEEP 份 */
  async save(p: HostProfile, contents: Map<string, string>): Promise<HostProfile> {
    const dir = this.dir(p.hostKey)
    await mkdir(join(dir, 'files'), { recursive: true })
    for (const [, text] of contents) await writeFile(join(dir, 'files', `${sha(text)}.txt`), text, 'utf8')
    const stamp = p.at.replace(/[:.]/g, '-')
    let id = `${stamp}-${p.type}`
    for (let i = 1; await exists(join(dir, `${id}.json`)); i++) id = `${stamp}${i}-${p.type}`   // 同一毫秒拍两次（几乎不会）
    const saved = { ...p, id }
    await writeFile(join(dir, `${id}.json`), JSON.stringify(saved), 'utf8')
    await this.prune(p.hostKey)
    return saved
  }

  private async ids(hostKey: string): Promise<string[]> {
    const names = await readdir(this.dir(hostKey)).catch(() => [] as string[])
    return names.filter((n) => n.endsWith('.json')).map((n) => n.slice(0, -5)).filter((id) => ID_RE.test(id)).sort().reverse()
  }

  private async prune(hostKey: string) {
    const ids = await this.ids(hostKey)
    const drop = (['check', 'snapshot'] as ProfileType[]).flatMap((t) => ids.filter((id) => id.endsWith(`-${t}`)).slice(PROFILE_KEEP))
    for (const id of drop) await rm(join(this.dir(hostKey), `${id}.json`), { force: true })
    if (!drop.length) return
    // 没有档案再引用的文件内容一并删
    const keep = new Set<string>()
    for (const id of ids.filter((x) => !drop.includes(x))) for (const f of (await this.get(hostKey, id))?.files ?? []) if (f.sha256) keep.add(f.sha256)
    for (const n of await readdir(join(this.dir(hostKey), 'files')).catch(() => [] as string[])) if (!keep.has(n.replace(/\.txt$/, ''))) await rm(join(this.dir(hostKey), 'files', n), { force: true })
  }

  /** 历史（新的在前） */
  async list(hostKey: string): Promise<ProfileMeta[]> {
    const out: ProfileMeta[] = []
    for (const id of await this.ids(hostKey)) {
      const p = await this.get(hostKey, id)
      if (p) out.push({ id, type: p.type, at: p.at, issues: findIssues(p).length, ...(p.hostLabel ? { label: p.hostLabel } : {}) })
    }
    return out
  }

  async get(hostKey: string, id: string): Promise<HostProfile | undefined> {
    if (!ID_RE.test(id)) return undefined
    try { return JSON.parse(await readFile(join(this.dir(hostKey), `${id}.json`), 'utf8')) as HostProfile } catch { return undefined }
  }

  async content(hostKey: string, hash: string): Promise<string | undefined> {
    if (!SHA_RE.test(hash)) return undefined
    return readFile(join(this.dir(hostKey), 'files', `${hash}.txt`), 'utf8').catch(() => undefined)
  }

  async putContent(hostKey: string, text: string): Promise<string> {
    await mkdir(join(this.dir(hostKey), 'files'), { recursive: true })
    const h = sha(text)
    await writeFile(join(this.dir(hostKey), 'files', `${h}.txt`), text, 'utf8')
    return h
  }

  // ── 变更报告 ──
  private turnsFile(sessionId: string) { return join(this.root, '_turns', `${hostDirName(sessionId)}.json`) }
  async turnReports(sessionId: string): Promise<TurnHostReport[]> {
    try { return JSON.parse(await readFile(this.turnsFile(sessionId), 'utf8')) as TurnHostReport[] } catch { return [] }
  }
  async addTurnReport(r: TurnHostReport) {
    const all = [...(await this.turnReports(r.sessionId)).filter((x) => !(x.dshId === r.dshId && x.turnId === r.turnId)), r].slice(-TURN_REPORT_KEEP)
    await mkdir(join(this.root, '_turns'), { recursive: true })
    await writeFile(this.turnsFile(r.sessionId), JSON.stringify(all), 'utf8')
  }
}

const exists = (p: string) => readFile(p).then(() => true, () => false)

export interface ExecResult { output: string; stopped?: 'timeout' | 'aborted'; truncated?: boolean }
export type ExecFn = (cmd: string, o: { timeoutMs: number; maxBytes: number }) => Promise<ExecResult>

/** 跑一次采集并解析（不存盘）。超时被截断的标 partial：已收到的段照常用 */
export async function collectProfile(exec: ExecFn, type: ProfileType, base: { hostKey: string; hostLabel?: string }, now = new Date()) {
  const r = await exec(hostCheckCommand(type), { timeoutMs: type === 'check' ? HOSTCHECK_TIMEOUT_MS : SNAPSHOT_TIMEOUT_MS, maxBytes: HOSTCHECK_MAX_OUTPUT })
  const { profile, contents } = parseHostProfile(r.output, { type, at: now.toISOString(), ...base })
  // 超时 / 输出被截断 / 一段都没采到：标 partial，界面不能把「没数据」当成「一切正常」
  if (r.stopped || r.truncated || !r.output.includes('@@hc:')) profile.partial = true
  return { profile, contents }
}

// 「拉取当前内容」只认体检采的那些路径（远端路径拼进命令前先校验）
const CONFIG_RE = new RegExp(`^(${CONFIG_FILES.map((p) => p.replace(/[.]/g, '\\.').replace('*', '[A-Za-z0-9_.-]+')).join('|')})$`)
export const isConfigPath = (p: unknown): p is string => typeof p === 'string' && CONFIG_RE.test(p) && !p.includes('..')
export const fetchFileCommand = (p: string) => `sh -c 'f="\${LINGSHELL_HC_ROOT:-}${p}"; [ -r "$f" ] || exit 3; base64 "$f"'`

export interface HostCheckDeps {
  handle(channel: string, fn: (e: unknown, ...args: unknown[]) => unknown): void
  store: ProfileStore
  terminal(id: string): TerminalInfo | undefined           // 用户可见的终端
  hostKey(terminalId: string): string
  exec(terminalId: string): ExecFn
  liveTerminalOf(hostKey: string): string | undefined      // 该主机任一仍在线的终端（回合末原终端已关时用）
  diff(before: string, after: string, path: string): string
  // 变更保险
  enabled(): boolean
  isReadOnly(command: string): boolean
  turnOf(sessionId: string): { dshId: string; turnId: string } | undefined
  dshIdOf(sessionId: string): string
  emit(sessionId: string, turnId: string): void
  log(level: 'info' | 'warn', message: string, data?: unknown): void
}

interface TurnHost { terminalId: string; label: string; before: Promise<HostProfile | Error> }
interface TurnState { sessionId: string; dshId: string; turnId: string; hosts: Map<string, TurnHost> }

export function registerHostCheck(d: HostCheckDeps) {
  const target = (id: unknown) => {
    const t = typeof id === 'string' ? d.terminal(id) : undefined
    if (!t) throw new Error('terminal_not_found')
    if (!hostCheckSupported(t.type, t.os)) throw new Error(tr('主机体检只支持 Linux 的 SSH 终端'))
    return t
  }
  const snap = async (tid: string, type: ProfileType, label?: string) => {
    const hostKey = d.hostKey(tid)
    const { profile, contents } = await collectProfile(d.exec(tid), type, { hostKey, ...(label ? { hostLabel: label } : {}) })
    return d.store.save(profile, contents)
  }

  d.handle('hostCheck:run', async (_e, id) => {
    const t = target(id)
    const p = await snap(t.id, 'check', t.title)
    d.log('info', 'hostCheck 完成', { hostKey: p.hostKey, partial: !!p.partial, issues: findIssues(p).length })   // i18n-ignore 日志
    return p
  })
  d.handle('hostCheck:history', async (_e, id) => {
    const t = target(id)
    const hostKey = d.hostKey(t.id)
    return { hostKey, items: await d.store.list(hostKey) }
  })
  d.handle('hostCheck:get', async (_e, id, pid) => {
    const p = await d.store.get(d.hostKey(target(id).id), String(pid))
    if (!p) throw new Error(tr('这份档案已不存在'))
    return p
  })
  // 两次档案之间某文件的差异：内容都在本地缓存里才能比
  d.handle('hostCheck:fileDiff', async (_e, hostKey, path, from, to) => {
    if (typeof hostKey !== 'string' || typeof path !== 'string') throw new Error(tr('参数错误'))
    const a = typeof from === 'string' ? await d.store.content(hostKey, from) : ''
    const b = typeof to === 'string' ? await d.store.content(hostKey, to) : ''
    if (a === undefined || b === undefined) throw new Error(tr('没有保存那次的文件内容（文件超过 256KB、不是文本或读不到），可点「拉取当前内容」和上次缓存比较'))
    return { diff: d.diff(a, b, path) || tr('（内容无变化）') }
  })
  // 拉取远端当前内容，和本地缓存的某次内容（base）比较；拉回的内容也缓存下来
  d.handle('hostCheck:fetchFile', async (_e, id, path, base) => {
    const t = target(id)
    if (!isConfigPath(path)) throw new Error(tr('只能拉取体检采集的关键配置文件'))
    const hostKey = d.hostKey(t.id)
    const r = await d.exec(t.id)(fetchFileCommand(path), { timeoutMs: 15_000, maxBytes: 2 * 1024 * 1024 })
    const b64 = r.output.replace(/\s+/g, '')
    if (r.stopped || !b64) throw new Error(tr('读不到这个文件（不存在、没有权限或超时）'))
    const text = Buffer.from(b64, 'base64').toString('utf8')
    if (text.includes('\0')) throw new Error(tr('这是二进制文件，无法比较'))
    const hash = await d.store.putContent(hostKey, text)
    const old = typeof base === 'string' ? await d.store.content(hostKey, base) : undefined
    if (old === undefined) return { sha256: hash, diff: d.diff('', text, path), noBase: true }
    return { sha256: hash, diff: d.diff(old, text, path) || tr('（内容无变化）') }
  })

  // ── 变更保险：AI 一轮里第一次对某台主机做改动前拍快照，回合结束再拍一次，有变化就出变更报告 ──
  const turns = new Map<string, TurnState>()
  const key = (sid: string, turnId: string) => `${sid}\n${turnId}`
  const withTimeout = <T>(p: Promise<T>, ms: number) => Promise.race([p, new Promise<T>((_r, rej) => setTimeout(() => rej(new Error(tr('快照超时'))), ms).unref?.())])

  /** 工具执行前调（不抛、最多等 ~10s）：只读命令 / 关了开关 / 非 Linux SSH / 本轮已拍过的主机不拍 */
  async function beforeChange(sessionId: string, terminalIds: string[], command?: string): Promise<void> {
    if (!d.enabled() || (command !== undefined && d.isReadOnly(command))) return
    const turn = d.turnOf(sessionId)
    if (!turn) return
    const k = key(sessionId, turn.turnId)
    let st = turns.get(k)
    if (!st) turns.set(k, st = { sessionId, ...turn, hosts: new Map() })
    const fresh: Promise<unknown>[] = []
    for (const tid of terminalIds) {
      const t = d.terminal(tid)
      if (!t || t.status !== 'running' || !hostCheckSupported(t.type, t.os)) continue
      const hk = d.hostKey(tid)
      if (st.hosts.has(hk)) continue
      const before = withTimeout(snap(tid, 'snapshot', t.title), SNAPSHOT_TIMEOUT_MS + 2000).catch((e: unknown) => new Error(msg(e)))
      st.hosts.set(hk, { terminalId: tid, label: t.title, before })
      fresh.push(before)
    }
    await Promise.all(fresh)
  }

  async function finish(st: TurnState) {
    const hosts: TurnHostChange[] = []
    for (const [hostKey, h] of st.hosts) {
      const before = await h.before
      const base = { hostKey, hostLabel: h.label }
      if (before instanceof Error) { hosts.push({ ...base, summary: [], error: tr('改动前快照没拍成：{err}', { err: before.message }) }); continue }
      const tid = d.terminal(h.terminalId)?.status === 'running' ? h.terminalId : d.liveTerminalOf(hostKey)
      if (!tid) { hosts.push({ ...base, beforeId: before.id, summary: [], error: tr('回合结束时该主机已没有在线终端，没拍改动后快照') }); continue }
      try {
        const after = await withTimeout(snap(tid, 'snapshot', h.label), SNAPSHOT_TIMEOUT_MS + 2000)
        const diff = diffProfiles(before, after)
        hosts.push({ ...base, beforeId: before.id, afterId: after.id, ...(diffIsEmpty(diff) ? {} : { diff }), summary: summarizeDiff(diff) })
      } catch (e) {
        hosts.push({ ...base, beforeId: before.id, summary: [], error: tr('改动后快照没拍成：{err}', { err: msg(e) }) })
      }
    }
    // 没有任何变化就不出报告（减少噪音）；有变化时连同拍失败的主机一起列出
    if (!hosts.some((h) => h.summary.length)) { d.log('info', 'hostChanges 本轮无变化', { turnId: st.turnId, hosts: hosts.length }); return }   // i18n-ignore 日志
    await d.store.addTurnReport({ sessionId: st.sessionId, dshId: st.dshId, turnId: st.turnId, at: new Date().toISOString(), hosts })
    d.emit(st.sessionId, st.turnId)
  }

  function onEvent(ev: AgentEvent) {
    if (ev.type !== 'agent:turnCompleted' && ev.type !== 'agent:turnFailed') return
    const st = turns.get(key(ev.sessionId, ev.turnId))
    if (!st) return
    turns.delete(key(ev.sessionId, ev.turnId))
    finish(st).catch((e: unknown) => d.log('warn', 'hostChanges 生成变更报告失败', { err: msg(e) }))   // i18n-ignore 日志
  }

  d.handle('hostChanges:list', async (_e, sid) => {
    if (typeof sid !== 'string' || !sid) return []
    const dshId = d.dshIdOf(sid)
    return (await d.store.turnReports(sid)).filter((r) => r.dshId === dshId)
  })

  return { beforeChange, onEvent }
}
