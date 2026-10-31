import './lib/locale.js'   // 第一个：界面语言要在其它模块求值前定好
import { createRoot } from 'react-dom/client'
import { App } from './App.js'
import { LockGate } from './features/lock/index.js'
import { installGlobalErrorLogging, logger } from './lib/logger.js'
import { initAppearance } from './lib/appearance.js'
import { installTooltips } from './lib/tooltip.js'
import './index.css'

installGlobalErrorLogging()
initAppearance()   // 界面主题 / 图标大小 / 缩放快捷键（首帧颜色已由 index.html 内联脚本按缓存设好）
installTooltips()   // title 一律改成自绘 tooltip（随主题、出得快）
logger.scope('boot').info('renderer started')
createRoot(document.getElementById('root')!).render(<LockGate><App /></LockGate>)

// 第一帧画完后再告诉主进程：可以关启动页、显示主窗口了（主进程保证启动页至少显示 3 秒）。
// 不在浏览器里直接跑时没有 electronAPI，忽略
const api = (window as unknown as { electronAPI?: { invoke?: (ch: string, ...a: unknown[]) => Promise<unknown> } }).electronAPI
if (api?.invoke) requestAnimationFrame(() => requestAnimationFrame(() => { void api.invoke!('app:boot-ready').catch(() => {}) }))
