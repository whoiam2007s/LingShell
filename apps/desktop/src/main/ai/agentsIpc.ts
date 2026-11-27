// 设置 → Agents：本地 Agent（角色）库的增删改 / 启停 / 打开目录。
// 库本身在 dsh-controller（LocalAgents，<数据目录>/agents/）；项目内 .lingshell/agents、.claude/agents、.codex/agents 只读扫描。
// 会话绑定（agent:sessionAgent / agent:setSessionAgent）在 register.ts 里直接接控制器。
import { mkdir } from 'node:fs/promises'
import { LocalAgents } from '@lingshell/dsh-controller'
import { tr, type AgentInput } from '@lingshell/shared'

export interface AgentsIpcDeps {
  handle(channel: string, fn: (e: unknown, ...args: unknown[]) => unknown): void
  root: string                                                 // <数据目录>/agents
  attach(lib: LocalAgents): void                               // 接到 DshController（cfg.agentDef）
  openPath(p: string): Promise<string>                         // shell.openPath：成功返回 ''
  log?: (level: 'info' | 'warn', msg: string, data?: unknown) => void
}

const str = (v: unknown, what: string): string => {
  if (typeof v !== 'string' || !v) throw new Error(tr('非法的{what}', { what }))
  return v
}
const wd = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v : undefined)

export function registerAgents(d: AgentsIpcDeps): LocalAgents {
  const lib = new LocalAgents(d.root, d.log)
  d.attach(lib)
  d.handle('agents:list', (_e, workDir) => lib.list(wd(workDir)))
  d.handle('agents:read', (_e, id, workDir) => lib.read(str(id, 'Agent'), wd(workDir)))
  d.handle('agents:save', (_e, input, old) => {
    const i = input as AgentInput
    if (!i || typeof i.name !== 'string' || typeof i.description !== 'string' || typeof i.body !== 'string') throw new Error(tr('非法的 Agent 定义'))
    return lib.save(i, typeof old === 'string' && old ? old : undefined)
  })
  d.handle('agents:remove', (_e, id) => lib.remove(str(id, 'Agent')))
  d.handle('agents:setEnabled', (_e, id, on) => lib.setEnabled(str(id, 'Agent'), on === true))
  d.handle('agents:openDir', async () => {
    await mkdir(d.root, { recursive: true })
    const err = await d.openPath(d.root)
    if (err) throw new Error(err)
  })
  return lib
}
