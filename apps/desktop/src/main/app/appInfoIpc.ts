// 「关于」/「备份与诊断」用：只读的应用与运行环境信息 + 打开数据目录 / 日志目录。
// 打开哪个目录由主进程决定（渲染层只传 'data' | 'logs'），不接受任意路径。
import { mkdir } from 'node:fs/promises'
import { tr, type AppInfo } from '@lingshell/shared'

export interface AppInfoIpcDeps {
  handle(channel: string, fn: (e: unknown, ...args: unknown[]) => unknown): void
  version: string
  dataDir: string
  logsDir: string
  openPath(p: string): Promise<string>   // electron shell.openPath：成功返回 ''，失败返回错误文本
}

export function registerAppInfo(d: AppInfoIpcDeps): void {
  d.handle('system:appInfo', (): AppInfo => ({
    version: d.version, electron: process.versions.electron ?? '', chrome: process.versions.chrome ?? '', node: process.versions.node,
    platform: process.platform, arch: process.arch, dataDir: d.dataDir, logsDir: d.logsDir,
  }))
  d.handle('system:openDir', async (_e, which) => {
    if (which !== 'data' && which !== 'logs') throw new Error(tr('非法的目录'))
    const dir = which === 'data' ? d.dataDir : d.logsDir
    await mkdir(dir, { recursive: true })
    const err = await d.openPath(dir)
    if (err) throw new Error(err)
  })
}
