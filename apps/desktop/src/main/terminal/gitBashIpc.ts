// Git Bash 探测 / 重新检测 / 手动指定（设置 → 通用「Git Bash 路径」与终端区缺失引导卡片共用）。探测逻辑见 terminal-core/gitBash.ts。
import type { GitBashStatus } from '@lingshell/shared'
import { gitBash, refreshGitBash, setGitBashOverride, validateBash } from '@lingshell/terminal-core'

export interface GitBashIpcDeps {
  handle(ch: string, fn: (e: unknown, ...a: unknown[]) => unknown): void
  getPath(): string            // 设置里的 bashPath
  setPath(p: string): void     // 存进设置
  pickFile(): Promise<string | undefined>   // 文件选择框
  platform?: string
  validate?: (p: string) => Promise<string | undefined>   // 测试注入；返回错误原因，undefined = 通过
}

export function registerGitBash(d: GitBashIpcDeps): void {
  const platform = d.platform ?? process.platform
  setGitBashOverride(() => d.getPath() || undefined)
  const status = (): GitBashStatus => {
    if (platform !== 'win32') return { required: false }
    const r = gitBash()
    return { required: true, ...r, ...(d.getPath() ? { custom: d.getPath() } : {}) }
  }
  d.handle('gitBash:status', () => status())
  d.handle('gitBash:redetect', () => { refreshGitBash(); return status() })
  // 选 bash.exe → 校验（--version 是 GNU bash）→ 存设置 → 重新探测。取消返回 null；校验不过抛错（原因给界面显示）
  d.handle('gitBash:pick', async () => {
    const p = await d.pickFile()
    if (!p) return null
    const err = await (d.validate ?? validateBash)(p)
    if (err) throw new Error(`invalid_bash: ${err}`)
    d.setPath(p)
    refreshGitBash()
    return status()
  })
  d.handle('gitBash:clear', () => { d.setPath(''); refreshGitBash(); return status() })
}
