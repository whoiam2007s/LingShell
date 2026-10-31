// AppClient Git部分的 IPC 实现（接口见 packages/shared/src/protocol/client/git.ts，主进程见 apps/desktop/src/main/git/register.ts）
import type { AppClient, GitApi } from '@lingshell/shared'

export function createGitIpc(): GitApi {
  return {
    git: {
      status: (id, dir) => window.electronAPI.invoke('git:status', id, dir) as ReturnType<AppClient['git']['status']>,
      diff: (id, root, path, mode) => window.electronAPI.invoke('git:diff', id, root, path, mode) as Promise<string>,
      stage: (id, root, paths, stage) => window.electronAPI.invoke('git:stage', id, root, paths, stage) as Promise<void>,
      commit: (id, root, msg) => window.electronAPI.invoke('git:commit', id, root, msg) as Promise<string>,
      suggest: (terminalId, root, branch, paths) => window.electronAPI.invoke('git:suggest', terminalId, root, branch, paths) as Promise<string>,
      refs: (terminalId, root) => window.electronAPI.invoke('git:refs', terminalId, root) as ReturnType<AppClient['git']['refs']>,
      log: (terminalId, root, q) => window.electronAPI.invoke('git:log', terminalId, root, q) as ReturnType<AppClient['git']['log']>,
      show: (terminalId, root, hash) => window.electronAPI.invoke('git:show', terminalId, root, hash) as ReturnType<AppClient['git']['show']>,
      commitDiff: (terminalId, root, hash, path) => window.electronAPI.invoke('git:commitDiff', terminalId, root, hash, path) as Promise<string>,
      stashes: (terminalId, root) => window.electronAPI.invoke('git:stashes', terminalId, root) as ReturnType<AppClient['git']['stashes']>,
      stashFiles: (terminalId, root, ref) => window.electronAPI.invoke('git:stashFiles', terminalId, root, ref) as ReturnType<AppClient['git']['stashFiles']>,
      stashDiff: (terminalId, root, ref, path, untracked) => window.electronAPI.invoke('git:stashDiff', terminalId, root, ref, path, untracked) as Promise<string>,
      progress: (terminalId, root) => window.electronAPI.invoke('git:progress', terminalId, root) as ReturnType<AppClient['git']['progress']>,
      op: (terminalId, root, op, message) => window.electronAPI.invoke('git:op', terminalId, root, op, message) as Promise<string>,
      blame: (terminalId, root, path, rev) => window.electronAPI.invoke('git:blame', terminalId, root, path, rev) as ReturnType<AppClient['git']['blame']>,
      readFile: (terminalId, root, path) => window.electronAPI.invoke('git:readFile', terminalId, root, path) as ReturnType<AppClient['git']['readFile']>,
      compare: (terminalId, root, a, b) => window.electronAPI.invoke('git:compare', terminalId, root, a, b) as ReturnType<AppClient['git']['compare']>,
      compareDiff: (terminalId, root, a, b, path) => window.electronAPI.invoke('git:compareDiff', terminalId, root, a, b, path) as Promise<string>,
      changelog: (terminalId, root, from, to, audience) => window.electronAPI.invoke('git:changelog', terminalId, root, from, to, audience) as ReturnType<AppClient['git']['changelog']>,
      remotes: (terminalId, root) => window.electronAPI.invoke('git:remotes', terminalId, root) as ReturnType<AppClient['git']['remotes']>,
      rebasePlan: (terminalId, root, from) => window.electronAPI.invoke('git:rebasePlan', terminalId, root, from) as ReturnType<AppClient['git']['rebasePlan']>,
      review: (terminalId, root, paths) => window.electronAPI.invoke('git:review', terminalId, root, paths) as ReturnType<AppClient['git']['review']>,
    },
  }
}
