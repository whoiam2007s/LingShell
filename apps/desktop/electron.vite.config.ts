import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import { resolve } from 'node:path'

// electron-vite 只负责 main + preload 的构建。
// externalizeDepsPlugin：把 electron 及 node_modules 依赖保持 external（不打进 bundle），
// 运行时再 require —— 否则 electron 模块被内联，其 getElectronPath 找不到 path.txt。
//
// renderer（前端 UI）是独立的 apps/ui 项目：
//   - dev：ui 跑自己的 vite dev server，main 通过 ELECTRON_RENDERER_URL 加载
//   - dist：ui 先 `vite build` 出 apps/ui/dist，由 electron-builder 的 extraResources 收入
// workspace 包是 TS 源码（未单独构建），必须打进 bundle，从 external 排除。
const wsExclude = ['@lingshell/shared', '@lingshell/terminal-core', '@lingshell/dsh-controller', '@lingshell/config', '@lingshell/platform', '@lingshell/auth-registry']

// 这些必须保持 external（运行时 require，不打进 bundle）：
//  - electron：内联会破坏其 getElectronPath（找不到 path.txt）
//  - node-pty：原生模块，必须运行时加载为 Electron ABI 编译的版本
//  - ssh2：纯 JS 但有可选原生依赖 cpu-features(.node)，内联会卡在解析 .node。external 运行时加载
//  - cpu-features：ssh2 的可选原生加速依赖，必须 external
//  - koffi：dsh 会话持久化(jsonl)的 FFI 依赖，原生件，必须 external
// dsh 自己那堆 @deepseek-ai/* 是普通 npm 包，externalizeDepsPlugin 默认就保持 external。
// @deepseek-ai/* 必须 external：externalizeDepsPlugin 只认 apps/desktop/package.json 的依赖，
// 而这些包是 dsh-controller 的依赖，它看不见 → 会被内联进 bundle，于是包内
// require('../package.json')（读自身版本号）相对路径失效，启动直接 Cannot find module。
// 同时它们也列进了 apps/desktop 的 dependencies，pnpm 才会把符号链接放到能解析到的位置。
//  - electron-updater：CJS 且 autoUpdater 是懒加载 getter，保持原样运行时 require，不让打包器改写
//  - @modelcontextprotocol/sdk：MCP 客户端，同 @deepseek-ai/* 是 dsh-controller 引入的，不强制就被整包内联
//    （连 zod/ajv/cross-spawn 一起），保持 external 由 apps/desktop 的依赖运行时加载
const forceExternal = ['electron', 'node-pty', 'ssh2', 'cpu-features', 'koffi', 'electron-updater', /^@deepseek-ai\//, /^@modelcontextprotocol\//]

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin({ exclude: wsExclude })],
    build: {
      outDir: 'out/main',
      rollupOptions: {
        input: resolve(__dirname, 'src/main/index.ts'),
        external: forceExternal
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin({ exclude: wsExclude })],
    build: {
      outDir: 'out/preload',
      rollupOptions: {
        // index = 主窗口；ball = 悬浮球窗口（只暴露它要的通道，见 src/preload/ball.ts）
        input: { index: resolve(__dirname, 'src/preload/index.ts'), ball: resolve(__dirname, 'src/preload/ball.ts') },
        external: forceExternal,
        // preload 必须是 CommonJS（Electron 沙箱不支持 ESM import）。
        // 输出 .cjs 文件名 → 即使 package.json type:module，也按 CommonJS 执行。
        output: { format: 'cjs', entryFileNames: '[name].cjs' }
      }
    }
  }
})
