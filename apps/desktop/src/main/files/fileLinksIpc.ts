// 终端里「文件:行号」点击打开（识别见 shared/files/fileLinks.ts）+ VS Code Remote 打开远程目录 / 文件（ssh config 托管块见 vscodeRemote.ts）。
//  - 本地终端：按终端目录解析相对路径（找不到就在终端目录下按文件名找），用设置里的外部编辑器跳到该行（code -g 等）；
//  - SSH 终端：经独立 exec channel 确认文件在哪（同样按名字找），再「下载到本地编辑器打开（保存自动回传）」或「VS Code Remote 打开」。
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { atomicWrite } from '@lingshell/config'
import {
  editorKind, msysToWinPath, resolveLinkPath, shq, unsafeShellPath, baseName, tr,
  type FileLinkReq, type HostSummary, type TerminalInfo,
} from '@lingshell/shared'
import { launchEditor } from './externalEditIpc.js'
import type { GotoAt } from './externalEdit.js'
import { authNote, entriesForHost, hostBlock, remoteAlias, upsertManagedBlock, vscodeRemoteArgs, type SshHostEntry } from '../terminal/index.js'

export interface VscodePlan { alias: string; configPath: string; needWrite: boolean; block: string; note: string }

export interface FileLinksDeps {
  handle(channel: string, fn: (e: unknown, ...args: unknown[]) => unknown): void
  terminal(id: string): TerminalInfo | undefined
  editor(): string
  gotoArgs(): string
  /** 下载到本地临时目录、用编辑器打开并跳行，保存自动回传（externalEdit.ts） */
  externalOpen(terminalId: string, remote: string, at: GotoAt): Promise<unknown>
  execRead(terminalId: string, command: string, timeoutMs: number): Promise<string>
  /** 终端对应的已保存主机（临时连接返回 undefined） */
  hostOf(terminalId: string): HostSummary | undefined
  hosts(): HostSummary[]
  /** 临时连接的地址（没存为主机的 SSH 终端） */
  sshTarget(terminalId: string): { host: string; port: number; username: string }
  sshConfigPath(): string
  log?(level: 'info' | 'warn', message: string, data?: unknown): void
}

const SKIP = new Set(['node_modules', '.git', '.svn', '.hg', 'dist', 'build', 'out', 'target', '.next', '.nuxt', '.venv', 'venv', '__pycache__', '.idea', '.gradle', 'coverage'])

/** 原子替换 ssh config（复用配置文件的 atomicWrite：临时文件 + rename + Windows 占用重试），保留原权限，符号链接写真实文件 */
export function writeSshConfig(configPath: string, text: string): void {
  let target = configPath
  try { target = realpathSync(configPath) } catch { /* 文件还不存在：按原路径新建 */ }
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 })   // 新建 ~/.ssh 时是 0700
  let mode = 0o600
  try { mode = statSync(target).mode & 0o777 } catch { /* 新文件 */ }
  atomicWrite(target, text)
  try { chmodSync(target, mode) } catch { /* 权限补不回去也不影响内容（Windows 上本来也忽略） */ }
}

/** 在 root 下按文件名找（广度优先，最多 6 层、2 万项，跳过依赖 / 构建目录）；rel 是原链接路径，结尾吻合的优先 */
export function findLocalFile(root: string, rel: string, maxDepth = 6, maxEntries = 20_000): string | undefined {
  const name = baseName(rel), tail = rel.replace(/\\/g, '/').replace(/^(\.\.?\/)+/, '')
  const hits: string[] = []
  let queue = [root], seen = 0
  for (let d = 0; d <= maxDepth && queue.length && seen < maxEntries; d++) {
    const next: string[] = []
    for (const dir of queue) {
      let ents: import('node:fs').Dirent[]
      try { ents = readdirSync(dir, { withFileTypes: true }) } catch { continue }
      for (const e of ents) {
        if (++seen > maxEntries) break
        const p = join(dir, e.name)
        if (e.isDirectory()) { if (!SKIP.has(e.name) && !e.name.startsWith('.')) next.push(p) }
        else if (e.name === name) hits.push(p)
      }
    }
    if (hits.length) break
    queue = next
  }
  return hits.find((h) => h.replace(/\\/g, '/').endsWith(`/${tail}`)) ?? hits[0]
}

/** 本地：解析出存在的文件路径（Git Bash 的 /c/x 先转 C:\x） */
export function resolveLocal(p: string, cwd: string | undefined, win = process.platform === 'win32'): string | undefined {
  let q = win && /^\/[A-Za-z](\/|$)/.test(p) ? msysToWinPath(p) : p
  if (q.startsWith('~/')) q = join(homedir(), q.slice(2))
  const base = cwd && existsSync(cwd) ? cwd : homedir()
  const abs = isAbsolute(q) ? q : resolve(base, q)
  try { if (statSync(abs).isFile()) return abs } catch { /* 找名字 */ }
  return isAbsolute(q) && !cwd ? undefined : findLocalFile(base, p)
}

/** 远程：确认文件存在并取绝对路径；不在就在终端目录下按名字找（最多 6 层） */
export function remoteLocateCommand(p: string, cwd: string | undefined): string {
  const P = p.startsWith('~/') ? `"$HOME"/${shq(p.slice(2))}` : shq(p)
  return [
    cwd ? `cd -- ${shq(cwd)} 2>/dev/null || cd` : 'cd',
    `P=${P}`,
    'echo "@@pwd $(pwd)"',
    'if [ -f "$P" ]; then echo "@@ok $(cd "$(dirname -- "$P")" && pwd)/$(basename -- "$P")"',
    `else find . -maxdepth 6 -type f -name ${shq(baseName(p))} -not -path "*/node_modules/*" -not -path "*/.git/*" 2>/dev/null | head -n 20 | sed "s/^/@@hit /"; fi`,
  ].join('\n')
}
// 根目录下的文件：$(pwd)/名字 = //名字，去掉多出来的那个斜杠；路径中间本来就有的 // 不能动（可能是真实目录名）
const tidyRemote = (p: string) => (p.startsWith('//') && !p.startsWith('///') ? p.slice(1) : p)

export function parseRemoteLocate(out: string, rel: string): string | undefined {
  const L = out.split(/\r?\n/)
  const ok = L.find((l) => l.startsWith('@@ok '))
  if (ok) return tidyRemote(ok.slice(5))
  const pwd = L.find((l) => l.startsWith('@@pwd '))?.slice(6) ?? ''
  const hits = L.filter((l) => l.startsWith('@@hit ')).map((l) => tidyRemote(`${pwd.replace(/\/$/, '')}/${l.slice(6).replace(/^\.\//, '')}`))
  const tail = rel.replace(/^(\.\.?\/)+/, '')
  return hits.find((h) => h.endsWith(`/${tail}`)) ?? hits[0]
}

const posInt = (v: unknown) => (typeof v === 'number' && Number.isInteger(v) && v > 0 && v < 10_000_000 ? v : undefined)

export function registerFileLinks(d: FileLinksDeps) {
  const term = (id: unknown) => {
    const t = typeof id === 'string' ? d.terminal(id) : undefined
    if (!t) throw new Error('terminal_not_found')
    return t
  }

  /** VS Code 系编辑器就用它（code / cursor …），否则 code */
  const codeCmd = () => (editorKind(d.editor()) === 'vscode' ? d.editor().trim() : 'code')

  const plan = (tid: string): VscodePlan & { entries: SshHostEntry[]; text: string } => {
    const h = d.hostOf(tid)
    const entries = h ? entriesForHost(h, (id) => d.hosts().find((x) => x.id === id)) : (() => {
      const s = d.sshTarget(tid)
      return [{ alias: remoteAlias(`${s.host}:${s.port}`, s.host), host: s.host, port: s.port, user: s.username }]
    })()
    const configPath = d.sshConfigPath()
    let text = ''
    try { text = readFileSync(configPath, 'utf8') } catch { /* 还没有 config */ }
    let changed = false
    const blocks: string[] = []
    for (const e of entries) { const b = hostBlock(e); blocks.push(b); const r = upsertManagedBlock(text, e.alias, b); changed ||= r.changed; text = r.text }
    return { alias: entries[0].alias, configPath, needWrite: changed, block: blocks.join('\n\n'), note: authNote(h?.authType), entries, text }
  }

  // 启动 code（--remote / --folder-uri …）；2 秒内没退出就当已交给 VS Code
  const launchCode = (args: string[]) => {
    const cmd = codeCmd(), unq = cmd.replace(/^"(.*)"$/, '$1')
    return new Promise<void>((res, rej) => {
      let cp: ReturnType<typeof spawn>
      if (existsSync(unq) && !/\.(cmd|bat)$/i.test(unq)) cp = spawn(unq, args, { detached: true, stdio: 'ignore' })
      else {
        if (args.some(unsafeShellPath)) return rej(new Error(tr('路径含特殊字符（如 & " % $），不能经命令行交给 VS Code')))
        cp = spawn(`${existsSync(unq) ? `"${unq}"` : cmd} ${args.map((a) => `"${a}"`).join(' ')}`, { shell: true, detached: true, stdio: 'ignore', windowsHide: true })
      }
      const t = setTimeout(() => { cp.unref(); res() }, 2000)
      cp.once('error', (e) => { clearTimeout(t); rej(new Error(tr('启动 VS Code 失败：{err}', { err: e.message }))) })
      cp.once('exit', (code) => { clearTimeout(t); if (code) rej(new Error(tr('VS Code 命令执行失败（退出码 {code}）：确认已安装 VS Code 并把 code 加进 PATH，且装了 Remote - SSH 扩展', { code }))); else res() })
    })
  }
  // 远端有没有在跑的 VS Code Server（新旧两种目录布局的 server-main 进程）
  const serverUp = (tid: string) => d.execRead(tid, `pgrep -f ${shq('vscode-server.*server-main')} >/dev/null 2>&1 && echo VSC_UP || echo VSC_DOWN`, 10_000).then((o) => /VSC_UP/.test(o), () => false)

  const openVscode = async (tid: string, path: string, o: { dir?: boolean; line?: number; col?: number }) => {
    const p = plan(tid)
    if (p.needWrite) {
      writeSshConfig(p.configPath, p.text)
      d.log?.('info', 'ssh config 托管块已写入', { alias: p.alias })   // i18n-ignore 日志
    }
    const args = vscodeRemoteArgs(p.alias, path, o)
    // 远端还没有在跑的 VS Code Server（第一次连 / 已自动退出）：VS Code 边装边开窗口时会把要打开的文件丢掉，
    // 只剩欢迎页。后台每 3 秒看一次，Server 跑起来后等几秒再发一次同样的命令（窗口已连上，这次能打开并跳行）
    const wasUp = o.dir ? true : await serverUp(tid)
    await launchCode(args)
    if (wasUp) return
    void (async () => {
      for (let i = 0; i < 60; i++) {
        await new Promise((r) => setTimeout(r, 3000))
        if (!(await serverUp(tid))) continue
        await new Promise((r) => setTimeout(r, 6000))
        await launchCode(args).catch((e) => d.log?.('warn', 'VS Code 补发打开命令失败', { err: String(e) }))   // i18n-ignore 日志
        d.log?.('info', 'VS Code Server 已启动，补发一次打开文件', { alias: p.alias, path })   // i18n-ignore 日志
        return
      }
    })()
  }

  d.handle('fileLinks:open', async (_e, id, req) => {
    const t = term(id)
    const r = (req ?? {}) as Partial<FileLinkReq>
    if (typeof r.path !== 'string' || !r.path || r.path.length > 4096 || /[\r\n\0]/.test(r.path)) throw new Error(tr('非法的路径'))
    const line = posInt(r.line) ?? 1, col = posInt(r.col)
    const cwd = typeof r.cwd === 'string' && r.cwd ? r.cwd : undefined
    const at = { line, ...(col ? { col } : {}) }
    if (t.type !== 'ssh') {
      const file = resolveLocal(r.path, cwd)
      if (!file) throw new Error(cwd ? tr('找不到文件：{path}（在 {cwd} 下也没找到同名文件）', { path: r.path, cwd }) : tr('找不到文件：{path}', { path: r.path }))
      await launchEditor(d.editor(), file, at, d.gotoArgs())
      return { path: file }
    }
    const rel = resolveLinkPath(r.path, undefined)
    const file = parseRemoteLocate(await d.execRead(t.id, remoteLocateCommand(rel, cwd), 15_000), rel)
    if (!file) throw new Error(tr('远程主机上找不到文件：{path}', { path: r.path }))
    if (r.how === 'vscode') await openVscode(t.id, file, at)
    else await d.externalOpen(t.id, file, at)
    return { path: file }
  })

  d.handle('fileLinks:vscodePlan', (_e, id) => {
    const t = term(id)
    if (t.type !== 'ssh') throw new Error(tr('只支持 SSH 终端'))
    const { entries: _x, text: _y, ...p } = plan(t.id)
    return p
  })

  d.handle('fileLinks:vscodeOpen', async (_e, id, path, o) => {
    const t = term(id)
    if (t.type !== 'ssh') throw new Error(tr('只支持 SSH 终端'))
    if (typeof path !== 'string' || !path.startsWith('/') || /[\r\n\0]/.test(path)) throw new Error(tr('非法的路径'))
    const x = (o ?? {}) as { dir?: unknown; line?: unknown; col?: unknown }
    await openVscode(t.id, path, { dir: x.dir === true, ...(posInt(x.line) ? { line: posInt(x.line) } : {}), ...(posInt(x.col) ? { col: posInt(x.col) } : {}) })
  })
}
