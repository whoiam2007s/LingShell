// 资源管理器的写操作 IPC：新建 / 重命名 / 删除（本地进回收站、远程 SFTP 递归）/ 多项下载 / 取消传输；
// 远程专用的改权限 / 压缩 / 解压 / 按名称搜索。
// 渲染层参数一律当不可信，逐个校验类型。远程删除、重命名、改权限、压缩、解压记执行记录（本地的不记：可从回收站找回，且不涉及服务器）。
import { tr, type FsScope, type ConflictPolicy, type HashAlgo } from '@lingshell/shared'
import { pastePlan, paste, localStats, remoteStats, localChecksum, remoteChecksum, remoteOwners, remoteChown, localSearchNames, localSearchContent, remoteSearchContent, treeStats, treeChecksum, treeSearchNames, winUnsupported } from './explorerOps.js'
import { assertDeletable, createEntry, deleteTree, planDelete, renameEntry, chmodEntry, packEntries, unpackEntry, searchNames, isFsError, type TreeOps, type ExecResult, type RunCmd } from './fileOps.js'
import { SudoError } from './explorerSudo.js'
import type { TransferService } from './transfer.js'

export interface ExplorerIpcDeps {
  handle(channel: string, fn: (e: unknown, ...args: unknown[]) => unknown): void
  ops(scope: FsScope): Promise<TreeOps>
  exec(terminalId: string, command: string, timeoutMs: number): Promise<ExecResult>   // 该终端连接上的独立 exec channel
  trash(path: string): Promise<void>                 // 本地删除 = 移到回收站（electron shell.trashItem）
  audit(terminalId: string, entry: { command: string; decision: string; filePath: string }): void
  transfer: Pick<TransferService, 'downloadTree' | 'cancel'>
  runFor?(scope: RemoteScope): RunCmd               // sudo 模式时给包了 sudo 的执行器
  isWin?(scope: RemoteScope): Promise<boolean>      // 只有 SFTP、没有 sh 的 Windows 服务器（OpenSSH 自带的）
}
type RemoteScope = { terminalId: string; sudo?: boolean }

// what：已翻译的参数名（tr('arg|路径') 等）
const str = (v: unknown, what: string): string => { if (typeof v !== 'string' || !v) throw new Error(tr('非法的{what}', { what })); return v }
const strs = (v: unknown): string[] => {
  if (!Array.isArray(v) || !v.length) throw new Error(tr('非法的路径列表'))
  return v.map((x) => str(x, tr('arg|路径')))
}
const scopeOf = (s: unknown): FsScope => {
  if (s === 'local') return s
  if (s && typeof s === 'object' && typeof (s as { terminalId?: unknown }).terminalId === 'string') return { terminalId: (s as { terminalId: string }).terminalId, ...((s as { sudo?: unknown }).sudo === true ? { sudo: true } : {}) }
  throw new Error(tr('非法的范围'))
}

export function registerExplorer(d: ExplorerIpcDeps): void {
  // 执行记录：sudo 模式做的标出来
  const audit = (sc: RemoteScope, e: { command: string; decision: string; filePath: string }) => d.audit(sc.terminalId, sc.sudo ? { ...e, command: `[sudo] ${e.command}` } : e)
  d.handle('fs:create', async (_e, s, dir, name, kind) => {
    const scope = scopeOf(s)
    return createEntry(await d.ops(scope), str(dir, tr('arg|目录')), str(name, tr('arg|名称')), kind === 'dir' ? 'dir' : 'file')
  })
  d.handle('fs:rename', async (_e, s, p, name) => {
    const scope = scopeOf(s)
    const to = await renameEntry(await d.ops(scope), str(p, tr('arg|路径')), str(name, tr('arg|名称')))
    if (scope !== 'local' && to !== p) audit(scope, { command: `重命名 ${p} → ${to}`, decision: 'file_rename', filePath: to })   // i18n-ignore 执行记录
    return to
  })
  d.handle('fs:deletePlan', async (_e, s, ps) => planDelete(await d.ops(scopeOf(s)), strs(ps)))
  d.handle('fs:remove', async (_e, s, p) => {
    const scope = scopeOf(s), path = str(p, tr('arg|路径')), ops = await d.ops(scope)
    if (scope === 'local') { await assertDeletable(ops, path); await d.trash(path); return }
    // 删到一半失败（如权限不足）也记一条：可能已经删掉了一部分（动手前的检查没过 = 什么都没删，不记）
    const r = await deleteTree(ops, path).catch((e: Error) => {
      if (!isFsError(e, 'precheck')) audit(scope, { command: `删除 ${path} 中途失败：${e.message}`, decision: 'file_delete', filePath: path })   // i18n-ignore 执行记录
      throw e
    })
    audit(scope, { command: `删除 ${path}（${r.files} 个文件、${r.dirs} 个文件夹）`, decision: 'file_delete', filePath: path })   // i18n-ignore 执行记录
  })
  // 后台跑，进度经 transfer:progress；立即返回，失败也在浮层里显示
  d.handle('transfer:downloadMany', async (_e, s, ps, dir) => {
    const scope = scopeOf(s)
    if (scope === 'local') throw new Error(tr('只支持从远程主机下载'))
    // 排队：轮到了（及重试时）才取该终端的 SFTP 会话
    d.transfer.downloadTree(() => d.ops(scope), strs(ps), str(dir, tr('arg|本地目录'))).catch(() => {})
  })
  d.handle('transfer:cancel', (_e, id) => d.transfer.cancel(str(id, tr('arg|任务'))))

  // ── 远程专用：改权限 / 压缩 / 解压 / 搜索。服务器命令走独立 exec channel（d.exec），不碰交互终端 ──
  const remote = (s: unknown): RemoteScope => {
    const scope = scopeOf(s)
    if (scope === 'local') throw new Error(tr('只支持远程主机'))
    return scope
  }
  const win = async (sc: RemoteScope) => !!(await d.isWin?.(sc))
  // what：已翻译的操作名
  const noWin = async (sc: RemoteScope, what: string) => { if (await win(sc)) throw winUnsupported(what) }
  const run = (sc: RemoteScope): RunCmd => d.runFor?.(sc) ?? ((cmd, ms) => d.exec(sc.terminalId, cmd, ms))
  // 多项逐个改；中途失败也把已改的记下来
  d.handle('fs:chmod', async (_e, s, ps, m, rec) => {
    const sc = remote(s), paths = strs(ps), ops = await d.ops(sc)
    await noWin(sc, tr('修改权限'))
    if (typeof m !== 'number') throw new Error(tr('非法的权限值'))
    for (const p of paths) {
      const command = await chmodEntry(ops, run(sc), p, m, rec === true)
      audit(sc, { command, decision: 'file_chmod', filePath: p })
    }
  })
  d.handle('fs:pack', async (_e, s, ps) => {
    const sc = remote(s)
    await noWin(sc, tr('压缩'))
    const r = await packEntries(await d.ops(sc), run(sc), strs(ps))
    audit(sc, { command: r.command, decision: 'file_archive', filePath: r.out })
    return r.out
  })
  d.handle('fs:unpack', async (_e, s, p) => {
    const sc = remote(s), path = str(p, tr('arg|路径'))
    await noWin(sc, tr('解压'))
    const r = await unpackEntry(run(sc), path).catch((e: Error) => {
      // 解压到一半失败也可能已写出部分文件，记一条（格式不支持 / 服务器缺工具 / sudo 没过 = 什么都没做，不记）
      if (!isFsError(e, 'precheck') && !(e instanceof SudoError)) audit(sc, { command: `解压 ${path} 失败：${e.message}`, decision: 'file_extract', filePath: path })   // i18n-ignore 执行记录
      throw e
    })
    audit(sc, { command: r.command, decision: 'file_extract', filePath: path })
    return r.dir
  })
  // 只读，不记执行记录。本地也能搜（node 遍历）；kind='content' 按内容搜
  d.handle('fs:search', async (_e, s, root, q, kind) => {
    const scope = scopeOf(s), r = str(root, tr('arg|目录')), query = str(q, tr('arg|名称'))
    if (kind === 'content') { if (scope === 'local') return localSearchContent(r, query); await noWin(scope, tr('按内容搜索')); return remoteSearchContent(run(scope), r, query) }
    if (scope === 'local') return localSearchNames(r, query)
    return (await win(scope)) ? treeSearchNames(await d.ops(scope), r, query) : searchNames(run(scope), r, query)
  })

  // ── 复制 / 剪切 / 粘贴（同一台主机内；远程在服务器上 cp / mv，记执行记录） ──
  const policyOf = (v: unknown): ConflictPolicy => (v === 'overwrite' || v === 'rename' ? v : 'skip')
  d.handle('fs:pastePlan', async (_e, s, ps, dir) => pastePlan(await d.ops(scopeOf(s)), strs(ps), str(dir, tr('arg|目标目录'))))
  d.handle('fs:paste', async (_e, s, ps, dir, mode, policy) => {
    const scope = scopeOf(s), ops = await d.ops(scope)
    const m = mode === 'move' ? 'move' : 'copy'
    if (scope === 'local') return paste({ ops }, strs(ps), str(dir, tr('arg|目标目录')), m, policyOf(policy))
    return paste({ ops, ...((await win(scope)) ? { tree: true } : { run: run(scope) }), audit: (command, filePath) => audit(scope, { command, decision: m === 'move' ? 'file_move' : 'file_copy', filePath }) }, strs(ps), str(dir, tr('arg|目标目录')), m, policyOf(policy))
  })
  // ── 属性：大小统计 / 校验和；远程改属主 ──
  d.handle('fs:stats', async (_e, s, ps) => {
    const scope = scopeOf(s)
    if (scope === 'local') return localStats(strs(ps))
    return (await win(scope)) ? treeStats(await d.ops(scope), strs(ps)) : remoteStats(run(scope), strs(ps))
  })
  d.handle('fs:checksum', async (_e, s, p, algo) => {
    const scope = scopeOf(s), a: HashAlgo = algo === 'md5' || algo === 'sha1' ? algo : 'sha256'
    if (scope === 'local') return localChecksum(str(p, tr('arg|路径')), a)
    return (await win(scope)) ? treeChecksum(await d.ops(scope), str(p, tr('arg|路径')), a) : remoteChecksum(run(scope), str(p, tr('arg|路径')), a)
  })
  d.handle('fs:owners', async (_e, s) => { const sc = remote(s); await noWin(sc, tr('修改属主')); return remoteOwners(run(sc)) })
  d.handle('fs:chown', async (_e, s, ps, owner, group, rec) => {
    const sc = remote(s), paths = strs(ps)
    await noWin(sc, tr('修改属主'))
    const command = await remoteChown(run(sc), paths, typeof owner === 'string' ? owner : '', typeof group === 'string' ? group : '', rec === true)
    for (const p of paths) audit(sc, { command, decision: 'file_chown', filePath: p })
  })
}
