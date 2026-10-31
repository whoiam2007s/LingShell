// 资源管理器（本机）「添加到对话」/ 拖进对话框：路径同「+ → 本地文件 / 目录」。
// 放在 lib：资源管理器（写）和对话输入框（订阅）都要用，直接互相 import 会形成循环依赖
const subs = new Set<(paths: string[]) => void>()
export const LOCAL_PATHS_MIME = 'application/x-lingshell-local-paths'
export const attachPathsToChat = (paths: string[]) => subs.forEach((f) => f(paths))
export function onAttachPaths(f: (paths: string[]) => void): () => void { subs.add(f); return () => { subs.delete(f) } }
