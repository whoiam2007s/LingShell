import { join } from 'node:path'
import { migrateSplit, type AppLayout, type Workspace } from '@lingshell/shared'
import { readJson, writeJson } from './jsonFile.js'

const strList = (v: unknown): string[] | undefined => Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : undefined
// 工作区：丢掉坏条目，分屏同主布局一样经 migrateSplit 校验
const workspaces = (v: unknown): Workspace[] | undefined => Array.isArray(v)
  ? v.filter((w) => w && typeof w.id === 'string' && typeof w.name === 'string' && Array.isArray(w.terminals))
    .map((w) => ({ ...w, terminalSplit: migrateSplit(w.terminalSplit) }))
  : undefined

// 终端布局 + 活动会话持久化：<dir>/layout.json。原子写。
export class LayoutStore {
  private filePath: string
  constructor(dir: string) { this.filePath = join(dir, 'layout.json') }

  get(): AppLayout {
    const p = readJson<Partial<AppLayout>>(this.filePath)
    if (!p) return { terminals: [] }
    // 分屏兼容旧版两窗格格式
    return {
      terminals: p.terminals ?? [], activeTerminalIndex: p.activeTerminalIndex, activeSessionId: p.activeSessionId, chatWidth: p.chatWidth, terminalSplit: migrateSplit(p.terminalSplit),
      favoriteHosts: strList(p.favoriteHosts), recentHosts: strList(p.recentHosts), hostProbe: typeof p.hostProbe === 'boolean' ? p.hostProbe : undefined, workspaces: workspaces(p.workspaces),
    }
  }
  // 浅合并保存：只覆盖传入的字段（terminals / activeSessionId / chatWidth / 主机面板偏好 / 工作区）。
  // 各 writer（终端区、会话区、分割线、主机面板）只更新自己那部分，get() 完整回读避免互相抹除。
  save(patch: Partial<AppLayout>): void {
    writeJson(this.filePath, { ...this.get(), ...patch })
  }
}
