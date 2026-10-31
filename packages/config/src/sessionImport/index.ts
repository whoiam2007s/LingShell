import { readFileSync, readdirSync, mkdtempSync, rmSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { homedir, tmpdir } from 'node:os'
import { join, extname, basename } from 'node:path'
import { tr, tk, type HostSummary, type SessionImportSource, type SshImportItem, type SshImportPreview, type SshImportResult } from '@lingshell/shared'
import type { HostStore } from '../HostStore.js'
import { decodeBytes, type ImportedSession, type ParsedSessions } from './common.js'
import { parseXsh } from './xshell.js'
import { parsePuttyReg } from './putty.js'
import { parseMobaXterm } from './mobaxterm.js'
import { parseSecureCrt } from './securecrt.js'

export { decodeBytes, parseIni, type ImportedSession } from './common.js'
export { parseXsh } from './xshell.js'
export { parsePuttyReg, unescapePuttyName } from './putty.js'
export { parseMobaXterm } from './mobaxterm.js'
export { parseSecureCrt } from './securecrt.js'

// 从 Xshell / PuTTY / MobaXterm / SecureCRT 导入会话：只导名称/地址/端口/用户名/分组，密码一律不导入。
// 流程同 ~/.ssh/config 导入：load → 预览（勾选，已存在的默认不勾）→ 按勾选的 alias 导入（已存在的同一目标跳过）

export const SOURCE_LABEL: Record<SessionImportSource, string> = { xshell: 'Xshell', putty: 'PuTTY', mobaxterm: 'MobaXterm', securecrt: 'SecureCRT' }
const PASSWORD_NOTE = tk('密码一律不导入：导入后在主机列表里编辑填写密码，或改用「SSH 密钥」')

/** 文件系统 / 注册表注入点（测试用内存实现） */
export interface SessionEnv {
  home: string
  appData: string
  readFile(p: string): Buffer | undefined
  listDir(d: string): { name: string; isDir: boolean }[]
  puttyReg(): Buffer | undefined     // PuTTY 会话的 .reg 导出内容；没有 PuTTY 会话 → undefined
}

export function nodeSessionEnv(): SessionEnv {
  return {
    home: homedir(),
    appData: process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'),
    readFile: (p) => { try { return readFileSync(p) } catch { return undefined } },
    listDir: (d) => { try { return readdirSync(d, { withFileTypes: true }).map((e) => ({ name: e.name, isDir: e.isDirectory() })) } catch { return [] } },
    puttyReg: () => {
      if (process.platform !== 'win32') return undefined
      const dir = mkdtempSync(join(tmpdir(), 'lingshell-putty-'))
      const f = join(dir, 'putty.reg')
      try {
        execFileSync('reg', ['export', 'HKCU\\Software\\SimonTatham\\PuTTY\\Sessions', f, '/y'], { windowsHide: true, stdio: 'ignore', timeout: 15_000 })
        return readFileSync(f)
      } catch { return undefined }   // 键不存在 = 没装过 / 没存会话
      finally { rmSync(dir, { recursive: true, force: true }) }
    },
  }
}

export interface SessionLoad { path: string; found: boolean; sessions: ImportedSession[]; warnings: string[] }

/** 默认位置（按优先级，取第一个存在的）。Xshell 多个版本并存时取版本号最大的 */
export function defaultPaths(source: SessionImportSource, env: SessionEnv): string[] {
  const docs = [join(env.home, 'Documents'), join(env.home, 'OneDrive', 'Documents')]
  switch (source) {
    case 'xshell': return [
      ...docs.flatMap((d) => {
        const base = join(d, 'NetSarang Computer')
        return env.listDir(base).filter((e) => e.isDir).map((e) => e.name).sort((a, b) => Number(b) - Number(a) || b.localeCompare(a))
          .map((v) => join(base, v, 'Xshell', 'Sessions'))
      }),
      join(env.appData, 'NetSarang', 'Xshell', 'Sessions'),
    ]
    case 'mobaxterm': return [join(env.appData, 'MobaXterm', 'MobaXterm.ini'), ...docs.map((d) => join(d, 'MobaXterm', 'MobaXterm.ini'))]
    case 'securecrt': return [join(env.appData, 'VanDyke', 'Config', 'Sessions')]
    case 'putty': return ['HKEY_CURRENT_USER\\Software\\SimonTatham\\PuTTY\\Sessions']
  }
}

const exists = (p: string, env: SessionEnv) => env.readFile(p) !== undefined || env.listDir(p).length > 0

/** 读取并解析。path 缺省 = 默认位置；Xshell/SecureCRT 的 path 是会话目录（也可是单个文件），PuTTY 的是 .reg 文件，MobaXterm 的是 .ini/.mxtsessions */
export function loadSessions(source: SessionImportSource, path: string | undefined, env = nodeSessionEnv()): SessionLoad {
  if (source === 'putty') {
    const buf = path ? env.readFile(path) : env.puttyReg()
    const where = path ?? defaultPaths('putty', env)[0]
    if (!buf) return { path: where, found: false, sessions: [], warnings: [] }
    return { path: where, found: true, ...parsePuttyReg(decodeBytes(buf)) }
  }
  const where = path ?? defaultPaths(source, env).find((p) => exists(p, env)) ?? defaultPaths(source, env)[0]
  if (!exists(where, env)) return { path: where, found: false, sessions: [], warnings: [] }
  if (source === 'mobaxterm') return { path: where, found: true, ...parseMobaXterm(decodeBytes(env.readFile(where) ?? Buffer.alloc(0))) }
  const ext = source === 'xshell' ? '.xsh' : '.ini'
  const parse = source === 'xshell' ? parseXsh : parseSecureCrt
  const out: ParsedSessions = { sessions: [], warnings: [] }
  const one = (file: string, group: string) => {
    const name = basename(file, extname(file))
    if (source === 'securecrt' && (name === '__FolderData__' || name === 'Default')) return
    const r = parse(decodeBytes(env.readFile(file) ?? Buffer.alloc(0)), name, group || undefined)
    if ('skip' in r) out.warnings.push(r.skip); else out.sessions.push(r)
  }
  const buf = env.readFile(where)
  if (buf !== undefined) one(where, '')   // 选的是单个文件
  else {
    let budget = 5000
    const walk = (dir: string, group: string, depth: number) => {
      for (const e of env.listDir(dir)) {
        if (budget <= 0) return
        const p = join(dir, e.name)
        if (e.isDir) { if (depth < 10) walk(p, group ? `${group}/${e.name}` : e.name, depth + 1) }
        else if (extname(e.name).toLowerCase() === ext) { budget--; one(p, group) }
      }
    }
    walk(where, '', 0)
  }
  return { path: where, found: true, ...out }
}

const targetKey = (host: string, port: number, user: string) => `${host.toLowerCase()}:${port}:${user}`

/** 给每条会话一个唯一显示名（重名追加「 (2)」…），预览与导入用同一套 */
function withAliases(sessions: ImportedSession[]): (ImportedSession & { alias: string })[] {
  const used = new Set<string>()
  return sessions.map((s) => {
    let alias = s.name, n = 2
    while (used.has(alias)) alias = `${s.name} (${n++})`
    used.add(alias)
    return { ...s, alias }
  })
}

export function previewSessions(load: SessionLoad, existing: HostSummary[]): SshImportPreview {
  const ex = new Map(existing.map((h) => [targetKey(h.host, h.port, h.username), h.id]))
  const items = withAliases(load.sessions).map((s): SshImportItem => ({
    alias: s.alias, host: s.host, port: s.port, username: s.username, authType: 'password', keyStatus: 'none',
    existingId: ex.get(targetKey(s.host, s.port, s.username)), warnings: s.warnings, ...(s.group ? { group: s.group } : {}),
  }))
  return { path: load.path, found: load.found, items, warnings: load.found && items.length ? [tr(PASSWORD_NOTE), ...load.warnings] : load.warnings }
}

/** 按勾选导入为密码认证（密码待填）。已存在同一目标（地址+端口+用户）的跳过；同一批里重复的只导第一条 */
export function importSessions(store: HostStore, load: SessionLoad, aliases: string[]): SshImportResult {
  const byAlias = new Map(withAliases(load.sessions).map((s) => [s.alias, s]))
  const seen = new Set(store.list().map((h) => targetKey(h.host, h.port, h.username)))
  const warnings: string[] = []
  let imported = 0
  for (const a of aliases) {
    const s = byAlias.get(a)
    if (!s) { warnings.push(tr('找不到会话 {name}，已跳过', { name: a })); continue }
    const k = targetKey(s.host, s.port, s.username)
    if (seen.has(k)) { warnings.push(tr('{name}：已存在相同主机（{target}），已跳过', { name: a, target: `${s.username}@${s.host}:${s.port}` })); continue }
    try { store.save({ label: s.alias, host: s.host, port: s.port, username: s.username, authType: 'password', ...(s.group ? { group: s.group } : {}) }) }
    catch (e) { warnings.push(tr('{name}：导入失败（{error}），已跳过', { name: a, error: e instanceof Error ? e.message : String(e) })); continue }
    seen.add(k)
    imported++
  }
  return { imported, warnings }
}
