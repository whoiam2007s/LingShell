// 启动冒烟（CI 用）：无界面启动一次打包产物，确认渲染进程真的画出了界面、没有致命错误，然后按退出码报告。
//
// 为什么需要它：类型检查 / 单元测试 / 打包都能绿，但"应用启动后白屏"这类问题它们一个都抓不到。
// 触发方式：环境变量 LINGSHELL_SMOKE=1（见 apps/desktop/src/main/index.ts 的 createMainWindow）。
// 输出契约：成功打印 SMOKE_OK <细节>，失败打印 SMOKE_FAIL <原因>，并用退出码 0/1 表达结果。
import { app, type BrowserWindow } from 'electron'

const READY_TIMEOUT_MS = 20_000   // 等 React 首帧最多 20 秒
const HARD_TIMEOUT_MS = 45_000    // 整体兜底

export function runSmokeCheck(win: BrowserWindow): void {
  let finished = false
  const finish = (ok: boolean, detail: string) => {
    if (finished) return
    finished = true
    console.log(`${ok ? 'SMOKE_OK' : 'SMOKE_FAIL'} ${detail}`)   // i18n-ignore 给 CI 抓的标记
    // 先留一点时间把 stdout 刷出去；然后走正常退出（让终端 / 托盘 / 后台任务有机会收尾），
    // 1.5 秒后仍没退再强退兜底 —— 直接 app.exit 会在销毁窗口时留下未收尾的数据流。
    setTimeout(() => {
      app.quit()
      setTimeout(() => app.exit(ok ? 0 : 1), 1500)
    }, 300)
  }

  // 页面加载失败（文件不存在、preload 崩了等）
  win.webContents.once('did-fail-load', (_e, code, desc, url) => {
    finish(false, `did-fail-load ${code} ${desc} url=${url}`)   // i18n-ignore 日志
  })
  // 渲染进程被杀 / 崩溃 —— 白屏最常见的原因
  win.webContents.once('render-process-gone', (_e, details) => {
    finish(false, `render-process-gone reason=${details.reason} exitCode=${details.exitCode}`)   // i18n-ignore 日志
  })

  win.webContents.once('did-finish-load', () => {
    void (async () => {
      const deadline = Date.now() + READY_TIMEOUT_MS
      let children = 0
      try {
        while (Date.now() < deadline) {
          // 挂载点里没子节点就是这个应用的白屏形态（main.tsx 往 #root 里 render）
          children = await win.webContents.executeJavaScript(
            "document.getElementById('root')?.childElementCount ?? 0",
            true,
          ) as number
          if (children > 0) break
          await new Promise((r) => setTimeout(r, 300))
        }
      } catch (e) {
        finish(false, `executeJavaScript failed: ${String(e)}`)   // i18n-ignore 日志
        return
      }
      const title = win.webContents.getTitle()
      finish(children > 0, `rootChildren=${children} title="${title}"`)   // i18n-ignore 日志
    })()
  })

  setTimeout(() => finish(false, 'timeout'), HARD_TIMEOUT_MS)
}
