// 各终端的当前目录：shell 集成（OSC 633;P;Cwd，见 shared/terminal/shellMarks.ts）每出一次提示符上报一次。
// TerminalPane 写；资源管理器「跟随终端目录」、拖文件到终端上传读。本地 Git Bash 报的是 MSYS 路径（/d/x），转成 Windows 路径。

const cwds = new Map<string, string>()
const subs = new Set<(id: string, cwd: string) => void>()

/** /c/Users/x → C:\Users\x；/c → C:\；其它原样 */
export function msysToWin(p: string): string {
  const m = /^\/([A-Za-z])(?:\/(.*))?$/.exec(p)
  return m ? `${m[1].toUpperCase()}:\\${(m[2] ?? '').replace(/\//g, '\\')}` : p
}

export function setTermCwd(id: string, cwd: string, local: boolean): void {
  const v = local && /^\/[A-Za-z](\/|$)/.test(cwd) ? msysToWin(cwd) : cwd
  if (!v || cwds.get(id) === v) return
  cwds.set(id, v)
  subs.forEach((f) => f(id, v))
}
export const getTermCwd = (id: string): string | undefined => cwds.get(id)
export const clearTermCwd = (id: string): void => { cwds.delete(id) }
/** 拖文件进本地终端插入的文本：按 shell 用各自的引号 / 路径写法，末尾留空格（同 Xshell / Windows Terminal） */
export function shellQuotePaths(paths: string[], shell?: string): string {
  if (shell === 'cmd') return paths.map((p) => `"${p}"`).join(' ') + ' '
  if (shell === 'powershell') return paths.map((p) => `'${p.replace(/'/g, "''")}'`).join(' ') + ' '
  if (shell?.startsWith('wsl')) {
    const linux = paths.map((p) => p.replace(/^([A-Za-z]):[\\/]?/, (_m, d: string) => `/mnt/${d.toLowerCase()}/`).replace(/\\/g, '/'))
    return linux.map((p) => `'${p.replace(/'/g, `'\\''`)}'`).join(' ') + ' '
  }
  return paths.map((p) => `'${p.replace(/'/g, `'\\''`)}'`).join(' ') + ' '   // Git Bash / 远程 POSIX
}

export function onTermCwd(fn: (id: string, cwd: string) => void): () => void {
  subs.add(fn)
  return () => { subs.delete(fn) }
}
