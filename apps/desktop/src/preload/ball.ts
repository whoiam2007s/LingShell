import { contextBridge, ipcRenderer } from 'electron'
import type { BallView } from '@lingshell/shared'

// 悬浮球窗口的 preload：只暴露它要的几个通道（状态推送 + 拖动 / 悬停 / 点击 / 右键 / 去处理），不给通用 invoke
const CHANNELS = new Set(['ball:ready', 'ball:enter', 'ball:leave', 'ball:expand', 'ball:dragStart', 'ball:drag', 'ball:dragEnd', 'ball:click', 'ball:menu', 'ball:openSession'])

contextBridge.exposeInMainWorld('ballAPI', {
  onState: (h: (v: BallView) => void) => {
    const f = (_e: unknown, v: BallView) => h(v)
    ipcRenderer.on('ball:state', f)
    return () => ipcRenderer.removeListener('ball:state', f)
  },
  send: (channel: string, ...args: unknown[]) => { if (CHANNELS.has(channel)) ipcRenderer.send(channel, ...args) },
})
