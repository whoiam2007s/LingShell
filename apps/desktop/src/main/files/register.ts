// 文件领域：资源管理器、文件读写与比对、目录同步、外部编辑、预览、上传下载、报错定位（从 ipc.ts 原样搬来，顺序不变）
import { ipcMain, shell, dialog, app } from 'electron'
import { resolve, join } from 'node:path'
import { connectSsh, type SshConn } from '@lingshell/terminal-core'
import { type FsScope, type DirEntry, tr, type CompareTarget, type CompareOpts, type CompareResult, COMPARE_MIN, COMPARE_MAX } from '@lingshell/shared'
import { log, type MainContext } from '../core/index.js'
import { toNativePath } from './paths.js'
import { uploadConflicts } from './transferTree.js'
import { localTreeOps, sftpTreeOps, localAccess, readText, assertUnchanged, saveText, type FileAccess, sftpAccess, type TreeOps } from './fileOps.js'
import { registerExplorer } from './explorerIpc.js'
import { registerExternalEdit } from './externalEditIpc.js'
import { registerDirSync } from './dirSync.js'
import { registerTransfer } from './transferIpc.js'
import os from 'node:os'
import type { SFTPWrapper } from 'ssh2'
import { compareFiles } from './fileCompare.js'
import { listLocal, listRemote, localPlaces, remotePlaces } from './fsList.js'
import { sudoRunner, sudoCheck, sudoListDir, sudoTreeOps, sudoAccess } from './explorerSudo.js'
import { WIN_SFTP } from './explorerOps.js'
import { registerFilePreview } from './filePreviewIpc.js'
import { registerFileLinks } from './fileLinksIpc.js'

export function registerFilesIpc(ctx: MainContext) {
  const { terminals, termHostKey, auditTerminal, liveTerminal, transfer, win, sys, fileAccessOf, hostOf, paths, hostStore,
    visibleTerm, shouldHideOnClose, beginQuit, cancelQuit, notify, unifiedDiff } = ctx

  // 资源管理器目录树
  const isLocal = (s: FsScope): s is 'local' => s === 'local'

  // 列目录（见 fsList.ts）：本地 / 远程都带大小、修改时间、权限，符号链接解析指向
  // sudo 模式（见 explorerSudo.ts）：密码只存在内存里，按终端；验证过的才存
  const sudoPw = new Map<string, string>()
  const execIn = (tid: string) => (cmd: string, ms: number, stdin?: string) => terminals.execFull(tid, cmd, { timeoutMs: ms, maxBytes: 8 * 1024 * 1024, stdin })
  const sudoRun = (tid: string) => sudoRunner(execIn(tid), () => sudoPw.get(tid), () => sudoPw.delete(tid))
  ipcMain.handle('fs:sudoAuth', async (_e, tid: unknown, pw: unknown) => {
    if (typeof tid !== 'string' || typeof pw !== 'string') throw new Error(tr('参数不对'))
    await sudoCheck(execIn(tid), pw)
    sudoPw.set(tid, pw)
  })
  // 只有 SFTP 的 Windows 服务器：SFTP 主目录形如 /C:/Users/x（按终端缓存）
  const winCache = new Map<string, Promise<boolean>>()
  const isWinTerm = (tid: string) => {
    let p = winCache.get(tid)
    if (!p) { p = terminals.sftp(tid).then((sf) => new Promise<boolean>((res) => sf.realpath('.', (e, h) => res(!e && WIN_SFTP.test(h))))); winCache.set(tid, p); p.catch(() => winCache.delete(tid)) }
    return p
  }
  ipcMain.handle('fs:sudoForget', (_e, tid: unknown) => { if (typeof tid === 'string') sudoPw.delete(tid) })
  ipcMain.handle('fs:listDir', async (_e, scope: FsScope, dirPath: string): Promise<DirEntry[]> => {
    if (isLocal(scope)) return listLocal(dirPath)
    if (scope.sudo) return sudoListDir(sudoRun(scope.terminalId), dirPath)
    return listRemote(await terminals.sftp(scope.terminalId), dirPath)
  })
  ipcMain.handle('fs:places', async (_e, scope: FsScope) => (isLocal(scope) ? localPlaces() : remotePlaces(await terminals.sftp(scope.terminalId))))

  // 新建 / 重命名 / 删除 / 多项下载（见 explorerIpc.ts）：远程走该终端已有的 SFTP 会话
  registerExplorer({
    handle: (ch, fn) => ipcMain.handle(ch, fn),
    ops: async (s) => (isLocal(s) ? localTreeOps() : s.sudo ? sudoTreeOps(sudoRun(s.terminalId)) : sftpTreeOps(await terminals.sftp(s.terminalId))),
    exec: (id, cmd, ms) => terminals.execFull(id, cmd, { timeoutMs: ms, maxBytes: 512 * 1024 }),
    isWin: (sc) => isWinTerm(sc.terminalId),
    runFor: (sc) => (sc.sudo ? sudoRun(sc.terminalId) : (cmd, ms) => terminals.execFull(sc.terminalId, cmd, { timeoutMs: ms, maxBytes: 512 * 1024 })),
    trash: (p) => shell.trashItem(resolve(p)),   // trashItem 在 Windows 上不认正斜杠路径
    audit: (terminalId, e) => auditTerminal(terminalId, e, { logCommand: true }),
    transfer,
  })
  // 本地 ↔ 远程目录比较与同步（见 dirSync.ts）：远程走该终端的 SFTP 会话，sha256 走独立 exec channel；远程有写/删记 dir_sync
  registerDirSync({
    handle: (ch, fn) => ipcMain.handle(ch, fn),
    sftp: (id) => terminals.sftp(id),
    run: (id) => (cmd, ms) => terminals.execFull(id, cmd, { timeoutMs: ms, maxBytes: 512 * 1024 }),
    trash: (p) => shell.trashItem(resolve(p)),
    audit: (terminalId, e) => auditTerminal(terminalId, e, { logCommand: true }),
  })
  // 传输队列面板 + 有进行中的传输时关窗口 / 退出先确认（见 transferIpc.ts）
  registerTransfer({ handle: (ch, fn) => ipcMain.handle(ch, fn), transfer, showItemInFolder: (p) => shell.showItemInFolder(p),
    // 关窗只是藏到托盘时不问（见 background.ts）；真正退出才确认，取消则恢复「关窗进托盘」
    onWindowClose: (h) => win.on('close', (e) => { if (!shouldHideOnClose()) h(e) }), closeWindow: () => { beginQuit(); win.close() },
    confirmQuit: async (n) => {
      const ok = (await dialog.showMessageBox(win, { type: 'warning', title: tr('传输未完成'), message: tr('还有 {n} 个传输未完成', { n }),
        detail: tr('退出会中止它们；不支持断点续传，下次需要重新传。'), buttons: [tr('仍要退出'), tr('取消')], defaultId: 1, cancelId: 1, noLink: true })).response === 0
      if (!ok) cancelQuit()
      return ok
    } })

  ipcMain.handle('fs:openLocal', async (_e, targetPath: string) => { await shell.openPath(targetPath) })

  // 用本地编辑器打开远程文件，保存自动回传（见 externalEdit.ts）；终端关闭 / 窗口关闭时停止监视并删临时文件
  const externalEdit = registerExternalEdit({
    handle: (ch, fn) => ipcMain.handle(ch, fn), win, tempRoot: join(app.getPath('temp'), 'lingshell-edit'),
    editor: () => sys().externalEditor,
    access: fileAccessOf,
    stat: async (tid, p) => {
      const sftp = await terminals.sftp(tid)
      return new Promise((res, rej) => sftp.stat(p, (e, st) => (e ? ((e as { code?: unknown }).code === 2 ? res(undefined) : rej(e)) : res({ size: st.size, mtime: st.mtime }))))
    },
    prod: (tid) => hostOf(termHostKey.get(tid) ?? '')?.env === 'prod',
    hostKey: (tid) => termHostKey.get(tid) ?? tid,
    audit: (terminalId, e) => auditTerminal(terminalId, e, { logCommand: true }),
    notify: (t, b) => notify(win, t, b),
  })

  // 用户手动查看/编辑文件（不经 AI）：读写复用 fileOps（同一套大小/二进制限制与备份），保存记一条「手动编辑」执行记录以便还原
  const scopeAccess = async (s: FsScope) => (isLocal(s) ? localAccess(paths.root) : s.sudo ? sudoAccess(sudoRun(s.terminalId), await fileAccessOf(s.terminalId), await terminals.sftp(s.terminalId)) : fileAccessOf(s.terminalId))
  ipcMain.handle('fs:readText', async (_e, scope: FsScope, p: string) => readText(await scopeAccess(scope), p))
  // 保存前预览：先查并发修改（早拒绝），再出 diff
  ipcMain.handle('fs:diffText', async (_e, scope: FsScope, p: string, base: string, next: string) => {
    await assertUnchanged(await scopeAccess(scope), p, base)
    return unifiedDiff(base, next, p)
  })
  ipcMain.handle('fs:writeText', async (_e, scope: FsScope, p: string, base: string, next: string) => {
    const r = await saveText(await scopeAccess(scope), p, base, next)
    auditTerminal(isLocal(scope) ? '' : scope.terminalId, {
      command: `手动编辑 ${p}`, decision: 'user_edit', filePath: p, backupPath: r.backupPath,   // i18n-ignore 执行记录原文
    }, { logCommand: true })
  })
  // 资源管理器预览（见 filePreviewIpc.ts）
  registerFilePreview({ handle: (ch, fn) => ipcMain.handle(ch, fn), access: scopeAccess, tempDir: join(app.getPath('temp'), 'lingshell-preview'), openPath: (p) => shell.openPath(p) })

  // 临时 sftp 连接列远程目录（上传 dialog 浏览用），只返回目录
  ipcMain.handle('fs:listDirByHost', async (_e, hostId: string, dirPath: string): Promise<DirEntry[]> => {
    const opts = hostStore.resolveConnectOpts(hostId)
    // ponytail: 上传 dialog 浏览远程目录用临时连接（含跳板），列完即弃；频繁浏览可加连接缓存，YAGNI
    const conn = await connectSsh(opts)
    try {
      return await new Promise((resolve, reject) => {
        conn.client.sftp((err, sftp) => {
          if (err) return reject(err)
          sftp.readdir(dirPath, (e2, list) => {
            if (e2) return reject(e2)
            resolve(list.filter((it) => it.attrs.isDirectory()).map((it) => ({
              name: it.filename, path: (dirPath.endsWith('/') ? dirPath : dirPath + '/') + it.filename, isDir: true,
            })))
          })
        })
      })
    } finally { conn.close() }   // 成功/出错都断开（含跳板），避免连接泄漏
  })

  // 多主机比对配置文件（只读、用户手动发起：不进执行记录，只记一行运行日志）。
  // 已保存主机：有在线的可见终端就复用它的 SFTP 会话（不多占 MaxSessions）；没有就临时连一次，比完即断（同 listDirByHost）
  ipcMain.handle('fs:compare', async (_e, targets: CompareTarget[], p: string, opts: CompareOpts): Promise<CompareResult[]> => {
    if (!Array.isArray(targets) || targets.length < COMPARE_MIN || targets.length > COMPARE_MAX) throw new Error(tr('请选择 {min}–{max} 台主机', { min: COMPARE_MIN, max: COMPARE_MAX }))
    if (typeof p !== 'string' || !p.trim()) throw new Error(tr('请填写文件路径'))
    const baseline = Number.isInteger(opts?.baseline) && opts.baseline >= 0 && opts.baseline < targets.length ? opts.baseline : 0
      const temps: SshConn[] = []
    let done = false
    const open = (t: CompareTarget) => async (): Promise<FileAccess> => {
      if (t.kind === 'local') return localAccess(paths.root)
      if (t.kind === 'terminal') return fileAccessOf(t.terminalId)
      const tid = liveTerminal(t.hostId, { running: true })
      if (tid) return fileAccessOf(tid)
      const o = hostStore.resolveConnectOpts(t.hostId)
      const conn = await connectSsh(o)
      if (done) { conn.close(); throw new Error(tr('已超时')) }   // 超时后才连上：直接断，不泄漏
      temps.push(conn)
      return sftpAccess(await new Promise<SFTPWrapper>((res, rej) => conn.client.sftp((e, s) => (e ? rej(e) : res(s)))), o.encoding)
    }
    log('info', 'main', 'fs', 'compare', { path: p, targets: targets.length, ignoreNoise: !!opts?.ignoreNoise })
    try {
      return await compareFiles(targets.map(open), p.trim(), baseline, !!opts?.ignoreNoise)
    } finally { done = true; for (const c of temps) c.close() }
  })

  // 加密上传/下载（后台专用 ssh2 连接，与 UI 终端隔离）
  ipcMain.handle('transfer:upload', async (_e, hostId: string, localPath: string, targetDir: string, encrypt: boolean) => {
    if (WIN_SFTP.test(targetDir)) throw new Error(tr('Windows 服务器不支持加密上传（没有 tar / openssl），请选「不加密」直传'))
    const opts = hostStore.resolveConnectOpts(hostId)
    await transfer.upload(opts, localPath, targetDir, encrypt, hostId)
  })
  // 直传上传（不加密）：目标 = 某个终端（复用它的 SFTP 会话，临时连接的主机也能传）或已保存主机（有在线终端就复用，否则临时连、传完断开）
  type UpTarget = { terminalId?: string; hostId?: string }
  const upTarget = (t: unknown): UpTarget => {
    const o = (t ?? {}) as UpTarget
    if (typeof o.terminalId === 'string' && o.terminalId) return { terminalId: o.terminalId }
    if (typeof o.hostId === 'string' && o.hostId) return { hostId: o.hostId }
    throw new Error(tr('非法的上传目标'))
  }
  const liveUpTerm = (hostId: string) => liveTerminal(hostId, { running: true })
  const upOps = (t: UpTarget) => async (): Promise<{ ops: TreeOps; done?: () => void }> => {
    const tid = t.terminalId ?? liveUpTerm(t.hostId!)
    if (tid) return { ops: sftpTreeOps(await terminals.sftp(tid)) }
    const conn = await connectSsh(hostStore.resolveConnectOpts(t.hostId!))
    try { return { ops: sftpTreeOps(await new Promise<SFTPWrapper>((res, rej) => conn.client.sftp((e, s) => (e ? rej(e) : res(s))))), done: () => conn.close() } }
    catch (e) { conn.close(); throw e }
  }
  const strList = (v: unknown) => { if (!Array.isArray(v) || !v.length || v.some((x) => typeof x !== 'string' || !x)) throw new Error(tr('非法的文件列表')); return v as string[] }
  const absDir = (v: unknown) => { if (typeof v !== 'string' || !v.startsWith('/')) throw new Error(tr('目标目录必须是绝对路径')); return v }
  // 上传前：目标目录里已有的同名项（让用户选覆盖 / 跳过 / 保留两者）
  ipcMain.handle('transfer:uploadConflicts', async (_e, t: unknown, localPaths: unknown, dir: unknown) => {
    const c = await upOps(upTarget(t))()
    try { return await uploadConflicts(c.ops, strList(localPaths).map(toNativePath), absDir(dir)) } finally { c.done?.() }
  })
  ipcMain.handle('transfer:uploadDirect', (_e, t: unknown, localPaths: unknown, dir: unknown, policy: unknown) => {
    const target = upTarget(t), d = absDir(dir), ps = strList(localPaths)
    const pol = policy === 'overwrite' || policy === 'rename' ? policy : 'skip'
    const term = target.terminalId ? terminals.list().find((x) => x.id === target.terminalId) : undefined
    const hostId = target.hostId ?? (target.terminalId ? termHostKey.get(target.terminalId) : undefined)
    const label = `${term?.title ?? (hostId ? hostStore.list().find((h) => h.id === hostId)?.label : '') ?? ''}:${d}`
    // 后台跑：进度经 transfer:progress，立即返回
    transfer.uploadDirect(upOps(target), ps, d, pol, label, hostId && hostId !== 'local' ? { hostId, path: d } : undefined).catch(() => {})
  })
  ipcMain.handle('transfer:pause', (_e, id: unknown) => { if (typeof id === 'string') transfer.pause(id) })
  ipcMain.handle('transfer:discard', (_e, id: unknown) => (typeof id === 'string' ? transfer.discard(id) : undefined))

  // ponytail: 临时连接终端下载暂不支持(无 hostId 拿凭据)，仅已保存主机
  ipcMain.handle('transfer:download', async (_e, terminalId: string, remotePath: string, localDir: string) => {
    const hostKey = termHostKey.get(terminalId)
    if (!hostKey || hostKey === 'local') throw new Error('download_requires_saved_host')
    const opts = hostStore.resolveConnectOpts(hostKey)   // hostKey 是 hostId（已保存主机）
    await transfer.download(opts, remotePath, localDir)
  })
  registerFileLinks({
    handle: (ch, fn) => ipcMain.handle(ch, fn), terminal: visibleTerm,
    editor: () => sys().externalEditor, gotoArgs: () => sys().editorGotoArgs ?? '',
    externalOpen: (tid, p, at) => externalEdit.open(tid, p, at),
    execRead: (tid, c, ms) => terminals.execRead(tid, c, ms),
    hostOf: (tid) => hostOf(termHostKey.get(tid) ?? ''), hosts: () => hostStore.list(),
    sshTarget: (tid) => { const o = terminals.sshOpts(tid); return { host: o.host, port: o.port, username: o.username } },
    // 自测可经环境变量改写目标文件（开发版才认），免得动真实的 ~/.ssh/config
    sshConfigPath: () => (!app.isPackaged && process.env.LINGSHELL_SSH_CONFIG) || join(os.homedir(), '.ssh', 'config'),
    log: (lv, m, d) => log(lv, 'main', 'fileLinks', m, d),
  })
  return { externalEdit }
}
