// Git Bash 风格的 MSYS 路径 /d/x/y → 原生 D:\x\y（仅 win32）。
// 终端跑的是 Git Bash，模型自然给 /d/... 的路径；但主进程 spawn 用系统 PATH，
// 命中的是 System32 的 bsdtar，它不认 MSYS 路径（could not chdir）→ 产出空包。
export function toNativePath(p: string): string {
  if (process.platform !== 'win32') return p
  const m = /^\/([a-zA-Z])(\/.*)?$/.exec(p)
  return m ? `${m[1].toUpperCase()}:\\${(m[2] ?? '/').slice(1).replace(/\//g, '\\')}` : p
}
