// Git 助手（从 ipc.ts 原样搬来，顺序不变）
import { ipcMain } from 'electron'
import type { MainContext } from '../core/index.js'
import { registerGit } from './gitIpc.js'
import { scanGitRepos, scanRemoteRepos } from './scanRepos.js'
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

  // ── 对话头部 / Git 面板用的两个轻量只读接口（需求 1、2）────────────────────
  // branchOf：带 5 秒缓存 —— 对话头部每次渲染都会问，不能每次都起一个 git 进程
  const branchCache = new Map<string, { at: number; branch?: string }>()
  ipcMain.handle('git:branchOf', async (_e, dir: unknown) => {
    const d = typeof dir === 'string' ? dir : ''
    if (!d.trim()) return undefined
    const hit = branchCache.get(d)
    if (hit && Date.now() - hit.at < 5000) return hit.branch
    const r = await runSh('git rev-parse --abbrev-ref HEAD', { cwd: d, timeoutMs: 3000 }).catch(() => undefined)
    const branch = r && r.code === 0 ? r.output.trim().split('\n')[0] : undefined
    branchCache.set(d, { at: Date.now(), branch })
    if (branchCache.size > 64) for (const [k, v] of branchCache) if (Date.now() - v.at > 60_000) branchCache.delete(k)
    return branch || undefined
  })
  // scanRepos：纯文件系统扫描（不看 git），见 scanRepos.ts
  ipcMain.handle('git:scanRepos', async (_e, dir: unknown) => {
    const d = typeof dir === 'string' ? dir : ''
    if (!d.trim()) return { repos: [], truncated: false }
    return scanGitRepos(d)
  })
  // scanReposRemote：走目标终端的通道跑 find（只 SSH 终端；本地路径直接交给上面的本地版）
  ipcMain.handle('git:scanReposRemote', async (_e, terminalId: unknown, dir: unknown) => {
    const id = typeof terminalId === 'string' ? terminalId : ''
    const d = typeof dir === 'string' ? dir : ''
    const t = id ? terminals.list().find((x) => x.id === id) : undefined
    if (!t || t.type !== 'ssh' || !d.trim()) return { repos: [], truncated: false }
    return scanRemoteRepos(d, (cmd, o) => sideRun(id)(cmd, o))
  })
}
