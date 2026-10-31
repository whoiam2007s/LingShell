import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'
// base './'：生产用 file:// 加载 index.html，绝对路径 /assets/* 会解析到盘符根 → 白屏。
// 两个入口：index.html = 主窗口；ball.html = 悬浮球窗口（见 src/ball/，desktop/main/app/background.ts）
const at = (f: string) => fileURLToPath(new URL(f, import.meta.url))
export default defineConfig({
  base: './', plugins: [react()], server: { host: '127.0.0.1', port: 5183, strictPort: true },
  build: { rollupOptions: { input: { index: at('./index.html'), ball: at('./ball.html') } } },
})
