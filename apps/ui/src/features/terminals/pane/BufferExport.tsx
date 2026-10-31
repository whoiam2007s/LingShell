import { tr } from '@lingshell/shared'
import { bufferFileName, readTermBuffer } from './termBuffer.js'

// 导出缓冲区（标签右键菜单）：把终端的整个缓冲（含回滚）保存为 .txt 或复制到剪贴板
const text = (id: string, onError: (msg: string) => void) => {
  const t = readTermBuffer(id)
  if (t === undefined) onError(tr('导出缓冲区失败：终端还没就绪'))
  return t
}
// 渲染层 Blob 下载：Electron 弹系统保存框，不经主进程
export function saveBuffer(id: string, title: string, onError: (msg: string) => void) {
  const t = text(id, onError); if (t === undefined) return
  const url = URL.createObjectURL(new Blob([t], { type: 'text/plain;charset=utf-8' }))
  const a = document.createElement('a')
  a.href = url; a.download = bufferFileName(title); a.click()
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
}
export function copyBuffer(id: string, onError: (msg: string) => void) {
  const t = text(id, onError); if (t === undefined) return
  navigator.clipboard.writeText(t).catch(() => onError(tr('复制失败')))
}
