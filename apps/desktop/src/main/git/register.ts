// Git 助手（从 ipc.ts 原样搬来，顺序不变）
import { ipcMain } from 'electron'
import type { MainContext } from '../core/index.js'
import { registerGit } from './gitIpc.js'
import { runSh } from '../terminal/index.js'
import type { registerAiIpc } from '../ai/index.js'

type Deps = Pick<ReturnType<typeof registerAiIpc>, 'controller'>

export function registerGitIpc(ctx: MainContext, deps: Deps) {
  const { terminals, hiddenTerms, redactForAi, auditTerminal } = ctx
  const { controller } = deps
  // Git 助手（见 gitIpc.ts）：独立通道（SSH exec channel / 本机 sh）；暂存 / 提交记执行记录；提交说明 = 一次性模型调用（脱敏）
  const sideRun = (id: string) => (cmd: string, o: { timeoutMs: number; maxBytes?: number; stdin?: string }) =>
    terminals.list().find((t) => t.id === id)?.type === 'ssh' ? terminals.execFull(id, cmd, o) : runSh(cmd, o)
  registerGit({
    handle: (ch, fn) => ipcMain.handle(ch, fn),
    terminal: (id) => terminals.list().find((t) => t.id === id && !hiddenTerms.has(t.id)),
    run: sideRun,
    complete: (s, u, sig, src) => controller.complete(s, u, sig, src),
    redact: (s) => redactForAi(s, true),
    audit: (terminalId, e) => auditTerminal(terminalId, e, { logCommand: true }),
  })
}
