import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'
// base './'：生产用 file:// 加载 index.html，绝对路径 /assets/* 会解析到盘符根 → 白屏。
// 两个入口：index.html = 主窗口；ball.html = 悬浮球窗口（见 src/ball/，desktop/main/app/background.ts）
const at = (f: string) => fileURLToPath(new URL(f, import.meta.url))
export default defineConfig({
  base: './', plugins: [react()], server: { host: '127.0.0.1', port: 5183, strictPort: true },
  build: {
    rollupOptions: {
      input: { index: at('./index.html'), ball: at('./ball.html') },
      output: {
        // 把大依赖拆成独立 chunk：本地 file:// 加载虽快，但拆开后首屏只需解析用到的部分，
        // 也避免单个 3MB chunk 触发体积告警。rolldown（Vite 8）只接受函数形式。
        manualChunks(id: string) {
          if (!id.includes('node_modules')) return
          if (id.includes('@xterm')) return 'xterm'
          if (
            id.includes('react-markdown') ||
            id.includes('/remark-') ||
            id.includes('/micromark') ||
            id.includes('/mdast-') ||
            id.includes('/hast-') ||
            id.includes('/unified/') ||
            id.includes('/unist-')
          ) return 'markdown'
          if (id.includes('@radix-ui')) return 'radix'
          if (id.includes('/react/') || id.includes('/react-dom/') || id.includes('/scheduler/')) return 'react'
          return
        },
      },
    },
  },
})
