// 用本地编辑器打开远程文件（WinSCP / MobaXterm 式）：下载到应用临时目录 → 用系统默认程序或设置里的编辑器打开 →
// 监视本地文件保存（fs.watch 目录 + 防抖）→ 自动回传（先备份远端原文件，同 writeWithBackup）。
// 回传前查远端是否在打开后被别人改过（大小 / 修改时间变了）→ 覆盖 / 放弃 / 另存为服务器上的副本；生产主机每次回传前确认。
// 终端关闭 / 应用退出 → 停止监视、删临时文件。弹框（确认 / 冲突）与打开编辑器由 ipc.ts 注入（Electron dialog / shell）。
import { mkdirSync, rmSync, watch, existsSync, type FSWatcher } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { baseName, parentPath, joinPath, formatSize, gotoArgsOf, fillGotoArgs, unsafeShellPath, tr } from '@lingshell/shared'
import { writeWithBackup, type FileAccess } from './fileOps.js'

export const EXT_EDIT_WARN_BYTES = 20 * 1024 * 1024    // 超过先确认
export const EXT_EDIT_MAX_BYTES = 200 * 1024 * 1024    // 整个读进内存（下载 + 备份），再大就别这么改了
const DEBOUNCE_MS = 500

export interface RemoteStat { size: number; mtime: number }
export type ConflictChoice = 'overwrite' | 'discard' | 'saveAs'

export interface ExternalEditDeps {
  tempRoot: string
  access(terminalId: string): Promise<FileAccess>
  stat(terminalId: string, path: string): Promise<RemoteStat | undefined>
  /** 用编辑器打开本地文件；失败抛错 */
  open(localPath: string, at?: GotoAt): Promise<void>
  confirmLarge(name: string, size: number): Promise<boolean>
  /** 生产主机回传前确认：yes 本次 / always 本次编辑期间不再问 / no 不传 */
  confirmProd(name: string, remote: string): Promise<'yes' | 'always' | 'no'>
  conflict(name: string, remote: string): Promise<ConflictChoice>
  prod(terminalId: string): boolean
  hostKey(terminalId: string): string
  audit(terminalId: string, entry: { command: string; decision: string; filePath: string; backupPath?: string }): void
  notify(title: string, body: string): void
  debounceMs?: number
}

interface Session {
  key: string
  terminalId: string
  remote: string
  local: string
  dir: string
  base: RemoteStat | undefined   // 下载时（及每次回传后）的远端状态，用来判断别人改没改
  last: Buffer                   // 最近一次与远端一致的内容：没变的保存事件不回传
  skipProd: boolean
  watcher?: FSWatcher
  timer?: ReturnType<typeof setTimeout>
  chain: Promise<void>           // 回传串行
}

/** 临时文件名：去掉 Windows 非法字符和 shell 元字符（编辑器命令经 cmd 拼接时不能被注入） */
export function safeLocalName(name: string): string {
  // eslint-disable-next-line no-control-regex
  const s = name.replace(/[<>:"/\\|?*\x00-\x1f&^%!`$;'()[\]{}=,]/g, '_').replace(/[ .]+$/, '').slice(-120)
  return s || 'file'
}

/** 按主机 + 远程路径隔离的子目录名 */
export const sessionDirName = (hostKey: string, remote: string) => createHash('sha256').update(`${hostKey}\0${remote}`).digest('hex').slice(0, 16)

/**
 * 编辑器设置 → 怎么启动：留空 = 系统默认程序；是已存在的可执行文件路径（可带引号）= 直接起进程；
 * 否则当命令行（如 `code`、`code -w`）经 shell 跑，文件路径加双引号（文件名已 safeLocalName，不含引号与元字符）。
 */
export function editorLaunch(editor: string, file: string, exists: (p: string) => boolean = existsSync):
  { kind: 'default' } | { kind: 'exec'; cmd: string; args: string[] } | { kind: 'shell'; line: string } {
  const e = editor.trim()
  if (!e) return { kind: 'default' }
  const unq = e.replace(/^"(.*)"$/, '$1')
  // .cmd/.bat（如 VS Code 的 code.cmd）Node 不许直接 spawn（EINVAL），走 shell
  if (exists(unq)) return /\.(cmd|bat)$/i.test(unq) ? { kind: 'shell', line: `"${unq}" "${file}"` } : { kind: 'exec', cmd: unq, args: [file] }
  return { kind: 'shell', line: `${e} "${file}"` }
}

/** 跳到的行列（终端里点「文件:行号」打开时带上） */
export interface GotoAt { line: number; col?: number }

/**
 * 打开并跳到某行：参数模板见 shared/files/fileLinks.ts（设置里自填 > 按编辑器认预设 > 编辑器留空按 VS Code 的 code -g）。
 * 认不出编辑器又没自填模板 → 退回 editorLaunch（只打开、不跳行）。经 shell 时路径不能带元字符（终端输出不可信）。
 * fallback：编辑器留空时试 code，失败再用系统默认程序打开
 */
export function gotoLaunch(editor: string, custom: string | undefined, file: string, at: GotoAt, exists: (p: string) => boolean = existsSync):
  ({ kind: 'default' } | { kind: 'exec'; cmd: string; args: string[] } | { kind: 'shell'; line: string }) & { fallback?: boolean } {
  const tpl = gotoArgsOf(editor, custom)
  if (!tpl) return editorLaunch(editor, file, exists)
  const e = editor.trim() || 'code'
  const unq = e.replace(/^"(.*)"$/, '$1')
  const fallback = !editor.trim() || undefined
  if (exists(unq) && !/\.(cmd|bat)$/i.test(unq)) return { kind: 'exec', cmd: unq, args: fillGotoArgs(tpl, file, at.line, at.col ?? 1) }
  if (unsafeShellPath(file)) throw new Error(tr('文件路径含特殊字符（如 & " % $），不能经命令行交给编辑器'))
  const prog = exists(unq) ? `"${unq}"` : e
  const args = tpl.replace(/\{file\}/g, file).replace(/\{line\}/g, String(at.line)).replace(/\{col\}/g, String(at.col ?? 1))
  return { kind: 'shell', line: `${prog} ${args}`, ...(fallback ? { fallback } : {}) }
}

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e))
const sameStat = (a?: RemoteStat, b?: RemoteStat) => !!a && !!b && a.size === b.size && a.mtime === b.mtime

export class ExternalEditService {
  private sessions = new Map<string, Session>()   // key = 临时子目录名（主机 + 路径）
  constructor(private d: ExternalEditDeps) {}

  /** 打开（已在编辑的同一文件只重新唤起编辑器，不重新下载、不丢未回传的改动） */
  async open(terminalId: string, remote: string, at?: GotoAt): Promise<{ local: string; reused: boolean }> {
    const key = sessionDirName(this.d.hostKey(terminalId), remote)
    const cur = this.sessions.get(key)
    if (cur && existsSync(cur.local)) { await this.d.open(cur.local, at); return { local: cur.local, reused: true } }
    if (cur) this.stop(key)

    const st = await this.d.stat(terminalId, remote)
    if (!st) throw new Error(tr('文件不存在：{path}', { path: remote }))
    if (st.size > EXT_EDIT_MAX_BYTES) throw new Error(tr('文件过大（{size} > {max}），不适合用编辑器打开：{path}', { size: formatSize(st.size), max: formatSize(EXT_EDIT_MAX_BYTES), path: remote }))
    if (st.size > EXT_EDIT_WARN_BYTES && !(await this.d.confirmLarge(baseName(remote), st.size))) throw new Error('已取消')   // i18n-ignore 界面按这个原文判断「用户取消」、不显示报错（ExplorerDrawer）
    const fa = await this.d.access(terminalId)
    const data = await fa.read(remote, EXT_EDIT_MAX_BYTES)
    if (!data) throw new Error(tr('文件不存在：{path}', { path: remote }))

    const dir = join(this.d.tempRoot, key)
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    const local = join(dir, safeLocalName(baseName(remote)))
    await writeFile(local, data, { mode: 0o600 })
    const s: Session = { key, terminalId, remote, local, dir, base: st, last: data, skipProd: false, chain: Promise.resolve() }
    this.sessions.set(key, s)
    // 监视目录而不是文件：不少编辑器保存是「写临时文件再改名」，盯文件本身会丢事件
    const name = baseName(local)
    s.watcher = watch(dir, (_ev, f) => {
      if (f && f.toString() !== name) return
      clearTimeout(s.timer)
      s.timer = setTimeout(() => { s.chain = s.chain.then(() => this.sync(s)) }, this.d.debounceMs ?? DEBOUNCE_MS)
    })
    s.watcher.on('error', () => {})
    try { await this.d.open(local, at) } catch (e) { this.stop(key); throw e }
    return { local, reused: false }
  }

  /** 正在编辑的文件（测试 / 排查用） */
  list(): { terminalId: string; remote: string; local: string }[] {
    return [...this.sessions.values()].map((s) => ({ terminalId: s.terminalId, remote: s.remote, local: s.local }))
  }

  /** 等所有排队中的回传跑完（测试用） */
  async idle(): Promise<void> { await Promise.all([...this.sessions.values()].map((s) => s.chain)) }

  stopTerminal(terminalId: string): void {
    for (const [k, s] of this.sessions) if (s.terminalId === terminalId) this.stop(k)
  }

  stopAll(): void { for (const k of [...this.sessions.keys()]) this.stop(k) }

  private stop(key: string): void {
    const s = this.sessions.get(key)
    if (!s) return
    this.sessions.delete(key)
    clearTimeout(s.timer)
    s.watcher?.close()
    try { rmSync(s.dir, { recursive: true, force: true }) } catch { /* 编辑器还占着文件（Windows）就留着，系统临时目录会清 */ }
  }

  /** 一次回传：内容没变跳过 → 查远端是否被别人改过 → 生产确认 → 备份并写 → 记执行记录 */
  private async sync(s: Session): Promise<void> {
    if (this.sessions.get(s.key) !== s) return   // 已停止
    const name = baseName(s.remote)
    let data: Buffer
    try { data = await readFile(s.local) } catch { return }   // 改名保存的中间态：文件暂时不在，等下一个事件
    if (data.equals(s.last)) return
    try {
      let target = s.remote
      const now = await this.d.stat(s.terminalId, s.remote)
      if (!sameStat(now, s.base)) {
        const c = await this.d.conflict(name, s.remote)
        if (c === 'discard') { this.d.notify(tr('未回传'), tr('{name}：服务器上的文件已被修改，本次保存没有上传', { name })); return }
        if (c === 'saveAs') target = await this.copyName(s)
      }
      if (this.d.prod(s.terminalId) && !s.skipProd) {
        const a = await this.d.confirmProd(name, target)
        if (a === 'no') { this.d.notify(tr('未回传'), tr('{name}：已取消上传到生产主机', { name })); return }
        if (a === 'always') s.skipProd = true
      }
      const fa = await this.d.access(s.terminalId)
      const r = await writeWithBackup(fa, target, data, new Date(), EXT_EDIT_MAX_BYTES)
      if (target === s.remote) { s.last = data; s.base = await this.d.stat(s.terminalId, s.remote) }
      this.d.audit(s.terminalId, {
        command: target === s.remote ? `外部编辑器回传 ${target}` : `外部编辑器另存 ${target}（${s.remote} 已被他人修改）`,   // i18n-ignore 执行记录
        decision: 'file_edit_external', filePath: target, backupPath: r.backupPath,
      })
      this.d.notify(tr('已回传'), target === s.remote ? `${tr('{name} 已上传到服务器', { name })}${r.backupPath ? tr('（原文件已备份）') : ''}` : tr('另存为 {name}', { name: baseName(target) }))
    } catch (e) {
      this.d.notify(tr('回传失败'), `${name}${tr('：')}${errMsg(e)}`)
    }
  }

  /** 另存：同目录下「名 (本地编辑).扩展名」，重名递增 */
  private async copyName(s: Session): Promise<string> {
    const name = baseName(s.remote), dot = name.lastIndexOf('.')
    const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, '']
    for (let i = 1; ; i++) {
      const p = joinPath(parentPath(s.remote), `${stem} (${tr('本地编辑')}${i > 1 ? ` ${i}` : ''})${ext}`)
      if (!(await this.d.stat(s.terminalId, p))) return p
    }
  }
}
