import '../lib/locale.js'   // 第一个：界面语言（与主窗口共用缓存）
import { createRoot } from 'react-dom/client'
import { Ball } from './Ball.js'
import '../index.css'

// 悬浮球窗口入口（ball.html）：只用 preload 暴露的 window.ballAPI，不连主窗口的 client
createRoot(document.getElementById('root')!).render(<Ball />)
