import { spawn } from 'node:child_process'
import { chmodSync, closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, readSync, rmSync, statSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import { dirname, join } from 'node:path'
import { gitBash } from '@lingshell/terminal-core'
import { tr } from '@lingshell/shared'

// 一键导出诊断包：环境信息 + 最近几次运行日志 + 脱敏配置 + 数据量统计。
// 不含：会话对话内容（sessions/ 与 sessions.json 内容）、审计命令、命令历史、api.json token、巡检结果正文、终端录像（只给文件数/大小）。
// 打包：Windows/macOS 用系统 bsdtar 出 .zip（Win10+ 自带 System32\tar.exe），Linux 的 GNU tar 不会写 zip，出 .tar.gz。

export const REDACTED = '[已脱敏]'   // i18n-ignore 诊断包里的固定标记（与发给 AI 前脱敏同一标记，测试按它断言）
const SECRET_KEY = /key|token|secret|password|passphrase|cipher/i
// hosts.json 只保留这些字段，其余（passwordCipher/privateKeyCipher/passphraseCipher 及未来新增字段）一律替换
const HOST_KEEP = new Set(['id', 'label', 'host', 'port', 'username', 'authType', 'env', 'group', 'jumpHostId', 'notes', 'encoding', 'credentialId'])
// credentials.json（命名凭据）同理白名单
const CRED_KEEP = new Set(['id', 'name', 'username', 'authType'])

/** 递归脱敏：键名像机密的值换成 [已脱敏]。数字/布尔放过（如 contextLimitTokens 是配置不是机密） */
export function redactSecrets(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(redactSecrets)
  if (v && typeof v === 'object') {
    return Object.fromEntries(Object.entries(v).map(([k, x]) =>
      [k, SECRET_KEY.test(k) && typeof x !== 'number' && typeof x !== 'boolean' ? REDACTED : redactSecrets(x)]))
  }
  return v
}

/** hosts.json：白名单字段保留，其余全部替换；结构不认识就整体不导出 */
export function redactHosts(v: unknown, keep = HOST_KEEP): unknown {
  if (!Array.isArray(v)) return REDACTED
  return v.map((h) => h && typeof h === 'object'
    ? Object.fromEntries(Object.entries(h).map(([k, x]) => [k, keep.has(k) ? redactSecrets(x) : REDACTED]))
    : REDACTED)
}
export const redactCredentials = (v: unknown): unknown => redactHosts(v, CRED_KEEP)

/** 文本兜底：已知机密明文（API Key、主机密码等）与 sk- 样式的 key 全部替换。日志也过一遍 */
export function scrubText(text: string, secrets: string[]): string {
  let out = text
  // 同时抹 JSON 转义后的形式（多行私钥进了 JSON/日志 data 就是 \n 转义）
  for (const s of secrets) {
    if (!s || s.length < 6) continue
    for (const form of [s, JSON.stringify(s).slice(1, -1)]) out = out.split(form).join(REDACTED)
  }
  return out.replace(/sk-[A-Za-z0-9_-]{16,}/g, REDACTED)
    // 群机器人 Webhook：token 在 query（钉钉/企微）或路径（飞书/Lark），只留域名
    .replace(/(https?:\/\/(?:oapi\.dingtalk\.com|qyapi\.weixin\.qq\.com|open\.feishu\.cn|open\.larksuite\.com))\/[^\s"'\\]*/g, `$1/${REDACTED}`)
    // 旧版本日志的审计行带命令原文（README 承诺不含命令）：JSON 字符串值整体替换，转义引号也跳过
    .replace(/"command":"(?:[^"\\]|\\.)*"/g, '"command":"[已省略]"')   // i18n-ignore 固定标记
}

export interface DiagInput {
  root: string; config: string; logs: string; sessions: string
  recordings?: string               // 终端录像目录：只统计，绝不打包内容
  env: Record<string, unknown>
  secrets: string[]                 // 解密后的机密明文，只用于从输出里抹掉
  logRuns?: number                  // 最近几次运行的日志，默认 3
  logTailBytes?: number             // 每个日志文件只取末尾，默认 2MB
}
export interface DiagFile { name: string; content: string }

// 诊断包说明随界面语言：导出时才求值（模块顶层还没读语言设置）
const readme = () => tr(`灵壳 LingShell 诊断包
================
供开发者排查问题用。导出时已去除机密：
- environment.json   应用/Electron/Node/系统版本、数据目录、Git Bash/openssl 探测结果
- logs/<启动时间>/    最近几次运行的 main.log / web.log（每个只保留末尾约 2MB，已抹掉 API Key、主机密码等已知机密）
- config/settings.json  设置（API Key 等键名像 key/token/secret/password/passphrase/cipher 的字段已替换为 {redacted}）
- config/hosts.json     主机列表（只保留名称/地址/端口/用户名/认证方式/分级/跳板/备注，凭据全部替换）
- config/credentials.json  命名凭据（只保留名称/用户名/认证方式，密码/私钥/口令全部替换）
- config/layout.json、config/schedules.json  布局与巡检计划（同样过脱敏）
- data-stats.json    会话数、执行记录条数、命令历史条数、各文件大小等统计

不包含：会话对话内容、AI 执行过的命令（审计记录）、命令历史、本地 API token（api.json）、dsh 会话日志、巡检结果正文、终端录像（只统计文件数和大小）、群机器人 Webhook 地址与密钥（webhooks.json）、自动应答规则与应答内容（auto-replies.json）。
注意：主机备注、本机备注、自定义规则按原文保留，如含内部信息请分享前自行检查。
`, { redacted: REDACTED })

function readJson(file: string): unknown {
  try { return JSON.parse(readFileSync(file, 'utf8')) } catch { return undefined }
}

/** 读文件末尾 max 字节（截断时在开头标注） */
function tail(file: string, max: number): string {
  const size = statSync(file).size
  if (size <= max) return readFileSync(file, 'utf8')
  const buf = Buffer.alloc(max)
  const fd = openSync(file, 'r')
  try { readSync(fd, buf, 0, max, size - max) } finally { closeSync(fd) }
  return `[已截断：只保留末尾 ${max} 字节，原大小 ${size} 字节]\n` + buf.toString('utf8')   // i18n-ignore 固定标记（测试按它断言）
}

function dirStats(dir: string): { files: number; bytes: number } {
  const r = { files: 0, bytes: 0 }
  if (!existsSync(dir)) return r
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) { const s = dirStats(p); r.files += s.files; r.bytes += s.bytes }
    else if (e.isFile()) { r.files++; r.bytes += statSync(p).size }
  }
  return r
}

const count = (v: unknown) => Array.isArray(v) ? v.length : undefined

/** 组装诊断包内容（纯读，不写盘）。返回相对路径 → 文本 */
export function buildDiagnostics(inp: DiagInput): DiagFile[] {
  const { config, secrets } = inp
  const json = (v: unknown) => scrubText(JSON.stringify(v, null, 2), secrets)
  const files: DiagFile[] = [
    { name: 'README.txt', content: readme() },
    { name: 'environment.json', content: json(inp.env) },
  ]
  // 配置：解析失败的不导出原文（原文里可能有机密）
  const cfg = (name: string, redact: (v: unknown) => unknown) => {
    const p = join(config, name)
    if (!existsSync(p)) return
    const v = readJson(p)
    files.push({ name: `config/${name}`, content: v === undefined ? '"[解析失败，未导出]"' : json(redact(v)) })   // i18n-ignore 固定标记
  }
  cfg('settings.json', redactSecrets)
  cfg('hosts.json', (v) => redactHosts(v))
  cfg('credentials.json', redactCredentials)
  cfg('layout.json', redactSecrets)
  cfg('schedules.json', redactSecrets)

  // 统计：只给条数和大小，不给内容
  const cfgFiles = existsSync(config) ? readdirSync(config, { withFileTypes: true }).filter((e) => e.isFile()) : []
  const history = readJson(join(config, 'command-history.json'))
  const historyArrays = history && typeof history === 'object' ? Object.values(history).filter(Array.isArray) : []
  const auditFile = join(config, 'audit.jsonl')
  files.push({ name: 'data-stats.json', content: json({
    configFiles: Object.fromEntries(cfgFiles.map((e) => [e.name, statSync(join(config, e.name)).size])),
    sessions: count(readJson(join(config, 'sessions.json'))),
    auditEntries: existsSync(auditFile) ? readFileSync(auditFile, 'utf8').split('\n').filter((l) => l.trim()).length : 0,
    commandHistory: { hosts: historyArrays.length, entries: historyArrays.reduce((n, a) => n + a.length, 0) },
    templates: count(readJson(join(config, 'templates.json'))),
    inspectionRuns: count(readJson(join(config, 'inspection-runs.json'))),
    sessionLogsDir: dirStats(inp.sessions),
    logsDir: dirStats(inp.logs),
    recordingsDir: inp.recordings ? dirStats(inp.recordings) : undefined,
  }) })

  // 日志：目录名是启动时间（YYYY-MM-DD_HH-mm-ss），字典序即时间序。只认这种目录：logs/sessions（会话日志，终端输出原文）不进诊断包
  const runs = existsSync(inp.logs)
    ? readdirSync(inp.logs, { withFileTypes: true }).filter((e) => e.isDirectory() && /^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}$/.test(e.name)).map((e) => e.name).sort().slice(-(inp.logRuns ?? 3))
    : []
  for (const run of runs) {
    for (const f of ['main.log', 'web.log']) {
      const p = join(inp.logs, run, f)
      if (existsSync(p)) files.push({ name: `logs/${run}/${f}`, content: scrubText(tail(p, inp.logTailBytes ?? 2 * 1024 * 1024), secrets) })
    }
  }
  return files
}

/** 诊断包扩展名：GNU tar（Linux）写不了 zip */
export const archiveExt = (): string => process.platform === 'linux' ? 'tar.gz' : 'zip'

/** Git Bash 路径（与本地终端同一探测，见 terminal-core/gitBash.ts），非 Windows 返回 SHELL */
export function findBash(): string | undefined {
  if (process.platform !== 'win32') return process.env.SHELL
  return gitBash().path
}

/** 写到临时目录后用系统 tar 打包到 outPath，临时目录用完即删 */
export async function writeArchive(files: DiagFile[], outPath: string): Promise<void> {
  const stage = mkdtempSync(join(os.tmpdir(), 'lingshell-diag-'))
  try {
    for (const f of files) {
      const p = join(stage, f.name)
      mkdirSync(dirname(p), { recursive: true })
      writeFileSync(p, f.content, 'utf8')
    }
    // Windows 显式用 System32 的 bsdtar：PATH 上若是 Git 的 GNU tar，会把 "C:" 当成远程主机
    const tar = process.platform === 'win32' ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar'
    const top = readdirSync(stage)
    await new Promise<void>((resolve, reject) => {
      const p = spawn(tar, ['-a', '-cf', outPath, '-C', stage, ...top], { windowsHide: true })
      let err = ''
      p.stderr.on('data', (d) => { err += String(d) })
      p.on('error', reject)
      p.on('close', (code) => code === 0 ? resolve() : reject(new Error(tr('tar 打包失败（{code}）：{err}', { code: String(code), err: err.trim() }))))
    })
    // 诊断包含主机地址 / 用户名 / 备注：别让同机其他用户读
    if (process.platform !== 'win32') { try { chmodSync(outPath, 0o600) } catch { /* 尽力而为 */ } }
  } finally { rmSync(stage, { recursive: true, force: true }) }
}
