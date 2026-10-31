// 命令面板 → 各区域的动作通道（同 quoteToChat：组件树隔得远，用窗口事件直连，不层层传 props）
import type { SplitMode, TermOs, HostEnv, WorkspaceLayout, QuickScopeCtx } from '@lingshell/shared'

export type PaletteCmd =
  | { type: 'connectHost'; hostId: string }
  | { type: 'newLocal' }
  | { type: 'newSsh' }
  | { type: 'split'; mode: SplitMode }
  | { type: 'termDrawer'; drawer: 'explorer' | 'history' | 'docker' | 'hostcheck' | 'systemd' | 'cron' | 'firewall' | 'topology' | 'git' | 'processes' | 'ports' | 'database' | 'k8s' | 'disk' }
  | { type: 'quick'; setId: string; cmdId: string }
  | { type: 'template'; id: string }
  | { type: 'runbook'; id: string }
  | { type: 'quickAdd'; command: string }   // 终端命令点菜单「存为快速命令」：打开快速命令编辑框并预填
  | { type: 'compareFiles'; mode?: 'keys' }   // mode=keys：直接打开「按键对比」页
  | { type: 'batchExec' }
  | { type: 'focusTerm'; id: string }                // 主机面板「连接」：该主机已有终端 → 切过去
  | { type: 'openWorkspace'; ws: WorkspaceLayout }   // 打开工作区 / 整组打开：终端追加为新标签并按其分屏摆放
  | { type: 'explorerAt'; hostId: string; path: string }   // 传输面板「在资源管理器中定位」：切到该主机的终端并打开资源管理器到 path
  | { type: 'hostDrawer'; hostId: string; drawer: 'hostcheck' | 'systemd' | 'ports' }   // 仪表盘卡片菜单：切到该主机的终端（没开就先连接）再打开抽屉
  | { type: 'postmortem' }   // 生成故障复盘（ChatPanel 处理）
  | { type: 'multiLog'; mode?: 'follow' | 'search' }   // 多主机日志 / 历史检索（MultiLogDialog）
  | { type: 'connProbe'; source?: string }             // 连通性探测（ConnProbeDialog）；source = 预选的源（batchGroups 的 key）
  | { type: 'apiDebug' }     // 打开接口调试面板（ApiDebugDialog 处理）
  | { type: 'diskUsage'; path?: string }   // 磁盘占用抽屉（当前终端），path 预填目录：体检磁盘问题「分析占用」、资源管理器右键

const EVT = 'lingshell:palette'

export function paletteSend(cmd: PaletteCmd): void {
  window.dispatchEvent(new CustomEvent<PaletteCmd>(EVT, { detail: cmd }))
}

export function onPalette(h: (cmd: PaletteCmd) => void): () => void {
  const f = (e: Event) => h((e as CustomEvent<PaletteCmd>).detail)
  window.addEventListener(EVT, f)
  return () => window.removeEventListener(EVT, f)
}

// 用快捷键关面板：交给面板自己走 close()（会把焦点还给打开前的终端 / 输入框）
const CLOSE_EVT = 'lingshell:palette-close'
export function closePalette(): void { window.dispatchEvent(new Event(CLOSE_EVT)) }
export function onPaletteClose(h: () => void): () => void {
  window.addEventListener(CLOSE_EVT, h)
  return () => window.removeEventListener(CLOSE_EVT, h)
}

// 面板打开时要的现场状态（当前终端 / 会话是否可发），由各区域渲染时顺手写入
// term.scope：快速命令的显示范围按它过滤（本机 / 主机 id / 分组，见 shared/terminal/quickCommands.ts）
export const paletteCtx: { term?: { title: string; os?: TermOs; env?: HostEnv; scope?: QuickScopeCtx }; chatReady: boolean; postmortemOff?: string } = { chatReady: false }
