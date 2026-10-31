// 外部编辑器的 Electron 接线：弹框（大文件 / 生产确认 / 冲突）、启动编辑器、IPC fs:editExternal。逻辑在 externalEdit.ts
import { dialog, shell, type BrowserWindow } from 'electron'
import { spawn } from 'node:child_process'
import { formatSize, tr } from '@lingshell/shared'
import { ExternalEditService, editorLaunch, gotoLaunch, type ExternalEditDeps, type GotoAt } from './externalEdit.js'

export interface ExternalEditIpcDeps extends Omit<ExternalEditDeps, 'open' | 'confirmLarge' | 'confirmProd' | 'conflict'> {
  handle(channel: string, fn: (e: unknown, ...args: unknown[]) => unknown): void
  win: BrowserWindow
  editor(): string   // 设置里的「外部编辑器」，空 = 系统默认程序
  gotoArgs?(): string   // 设置里的「跳到行的参数」，空 = 按编辑器自动
}

/** 起编辑器（at 有值 = 跳到该行，参数见 gotoLaunch）：直接起进程等 spawn 成功；命令行（经 shell）1.5 秒内非 0 退出算失败（如 code 不在 PATH）。
 *  编辑器留空且 code 起不来 → 退回系统默认程序（不跳行） */
export async function launchEditor(editor: string, file: string, at?: GotoAt, gotoTpl?: string): Promise<void> {
  const how = at ? gotoLaunch(editor, gotoTpl, file, at) : editorLaunch(editor, file)
  if (how.kind === 'default') return shell.openPath(file).then((err) => { if (err) throw new Error(tr('没有能打开它的程序：{err}', { err })) })
  try { await run(how, editor || 'code') } catch (e) { if ('fallback' in how && how.fallback) return launchEditor('', file); throw e }
}

function run(how: { kind: 'exec'; cmd: string; args: string[] } | { kind: 'shell'; line: string }, editor: string): Promise<void> {
  return new Promise((res, rej) => {
    const cp = how.kind === 'exec'
      ? spawn(how.cmd, how.args, { detached: true, stdio: 'ignore' })
      : spawn(how.line, { shell: true, detached: true, stdio: 'ignore', windowsHide: true })
    const t = setTimeout(() => { cp.unref(); res() }, 1500)
    cp.once('error', (e) => { clearTimeout(t); rej(new Error(tr('启动编辑器失败：{err}', { err: e.message }))) })
    if (how.kind === 'exec') cp.once('spawn', () => { clearTimeout(t); cp.unref(); res() })
    else cp.once('exit', (code) => { clearTimeout(t); if (code) rej(new Error(tr('编辑器命令执行失败（退出码 {code}）：{editor}', { code, editor }))); else res() })
  })
}

export function registerExternalEdit(d: ExternalEditIpcDeps): ExternalEditService {
  const ask = (o: Electron.MessageBoxOptions) => dialog.showMessageBox(d.win, o)
  const svc = new ExternalEditService({
    ...d,
    open: (p, at) => launchEditor(d.editor(), p, at, d.gotoArgs?.()),
    confirmLarge: async (name, size) => (await ask({
      type: 'question', title: tr('大文件'), message: tr('{name} 有 {size}，确定下载后用编辑器打开？', { name, size: formatSize(size) }),
      detail: tr('下载和每次保存回传都要传完整个文件。'), buttons: [tr('打开'), tr('取消')], defaultId: 0, cancelId: 1,
    })).response === 0,
    confirmProd: async (name, remote) => {
      const r = await ask({
        type: 'warning', title: tr('上传到生产主机'), message: tr('把本地的修改上传到生产主机？'), detail: `${remote}\n${tr('（原文件会先备份）')}`,
        buttons: [tr('上传'), tr('不上传')], defaultId: 1, cancelId: 1, checkboxLabel: tr('编辑 {name} 期间不再询问', { name }),
      })
      return r.response !== 0 ? 'no' : r.checkboxChecked ? 'always' : 'yes'
    },
    conflict: async (name, remote) => {
      const r = await ask({
        type: 'warning', title: tr('服务器上的文件已被修改'), message: tr('{name} 在你打开后被其他人或程序改过', { name }), detail: `${remote}\n${tr('覆盖：用你的版本覆盖（原文件会先备份）\n另存：上传为同目录下名字带「(本地编辑)」的副本，不动原文件\n放弃：这次保存不上传')}`,
        buttons: [tr('覆盖'), tr('另存'), tr('放弃')], defaultId: 2, cancelId: 2,
      })
      return r.response === 0 ? 'overwrite' : r.response === 1 ? 'saveAs' : 'discard'
    },
  })
  // 只支持远程（本地文件资源管理器里已有「用系统程序打开」）
  d.handle('fs:editExternal', async (_e, s, p) => {
    const tid = (s as { terminalId?: unknown } | null)?.terminalId
    if (typeof tid !== 'string' || !tid) throw new Error(tr('只支持远程主机上的文件'))
    if (typeof p !== 'string' || !p.startsWith('/')) throw new Error(tr('非法的路径'))
    await svc.open(tid, p)
  })
  return svc
}
