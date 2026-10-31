import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { AppEvent } from '@lingshell/shared'

// 每个终端窗格、会话面板等各自订阅 app:event，十几个是正常用量，不是泄漏；放宽默认 10 的告警阈值
ipcRenderer.setMaxListeners(100)

contextBridge.exposeInMainWorld('electronAPI', {
  invoke: (channel: string, ...args: unknown[]) => ipcRenderer.invoke(channel, ...args),
  onEvent: (handler: (ev: AppEvent) => void) => {
    const listener = (_e: unknown, ev: AppEvent) => handler(ev)
    ipcRenderer.on('app:event', listener)
    return () => ipcRenderer.removeListener('app:event', listener)
  },
  // 从系统拖进来的文件取本地绝对路径（File.path 已废弃）；非本地文件返回 ''
  pathForFile: (f: File) => webUtils.getPathForFile(f),
  // 渲染层日志：转发给主进程写入 web.log
  log: (rec: { level: string; scope?: string; message: string; data?: unknown; time?: string }) =>
    ipcRenderer.send('log:write', rec),
  // 窗口控制（自定义标题栏用）
  window: {
    minimize: () => ipcRenderer.invoke('window:minimize'),
    toggleMaximize: () => ipcRenderer.invoke('window:toggleMaximize') as Promise<boolean>,
    close: () => ipcRenderer.invoke('window:close'),
    isMaximized: () => ipcRenderer.invoke('window:isMaximized') as Promise<boolean>,
    platform: () => ipcRenderer.invoke('window:platform') as Promise<string>,
    onMaximizedChange: (handler: (maximized: boolean) => void) => {
      const listener = (_e: unknown, v: boolean) => handler(v)
      ipcRenderer.on('window:maximized', listener)
      return () => ipcRenderer.removeListener('window:maximized', listener)
    },
  },
})
