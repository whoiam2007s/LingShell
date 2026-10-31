// 资源管理器记住上次停在的目录：按对话（session:<id>）/ 按终端（term:<id>）各记一个，存 localStorage。
// 第一次打开用对话的工作目录 / 终端的当前目录，之后再打开回到上次的目录。
const KEY = 'lingshell.explorerLastDir', MAX = 300

const load = (): Record<string, string> => {
  try { const v = JSON.parse(localStorage.getItem(KEY) ?? '{}'); return v && typeof v === 'object' && !Array.isArray(v) ? v : {} } catch { return {} }
}
export const getLastDir = (key: string): string | undefined => load()[key] || undefined
export function setLastDir(key: string, dir: string): void {
  const all = load()
  if (all[key] === dir) return
  delete all[key]
  all[key] = dir
  const keys = Object.keys(all)
  for (const k of keys.slice(0, Math.max(0, keys.length - MAX))) delete all[k]   // 只留最近的（后写的排在后面）
  try { localStorage.setItem(KEY, JSON.stringify(all)) } catch { /* 存不了就只是不记 */ }
}
