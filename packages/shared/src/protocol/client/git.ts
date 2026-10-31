// AppClient 的Git 助手。主进程注册见 apps/desktop/src/main/git/register.ts，渲染层实现见 apps/ui/src/client/transports/ipc/git.ts

export interface GitApi {
  // Git 助手（见 desktop/main/git/gitIpc.ts）：独立通道读状态 / diff；stage / commit 记执行记录；suggest = AI 写提交说明（一次性模型调用）
  git: {
    status(terminalId: string, dir: string): Promise<import('../../git/index.js').GitStatusResult>
    diff(terminalId: string, root: string, path: string, mode: import('../../git/index.js').GitDiffMode): Promise<string>
    stage(terminalId: string, root: string, paths: string[], stage: boolean): Promise<void>
    commit(terminalId: string, root: string, message: string): Promise<string>
    suggest(terminalId: string, root: string, branch: string, paths?: string[]): Promise<string>
    // 分支 / 历史 / 储藏（只读）与写操作（见 shared/git/gitOps.ts）；op 失败时报错信息带常见原因提示
    refs(terminalId: string, root: string): Promise<import('../../git/index.js').GitRef[]>
    log(terminalId: string, root: string, q: import('../../git/index.js').GitLogQuery): Promise<import('../../git/index.js').GitCommit[]>
    show(terminalId: string, root: string, hash: string): Promise<import('../../git/index.js').GitCommitDetail>
    commitDiff(terminalId: string, root: string, hash: string, path: string): Promise<string>
    stashes(terminalId: string, root: string): Promise<import('../../git/index.js').GitStash[]>
    stashFiles(terminalId: string, root: string, ref: string): Promise<import('../../git/index.js').GitChangedFile[]>
    stashDiff(terminalId: string, root: string, ref: string, path: string, untracked: boolean): Promise<string>
    progress(terminalId: string, root: string): Promise<import('../../git/index.js').GitInProgress | undefined>
    op(terminalId: string, root: string, op: import('../../git/index.js').GitOp, message?: string): Promise<string>
    blame(terminalId: string, root: string, path: string, rev?: string): Promise<import('../../git/index.js').GitBlameLine[]>
    // 合并编辑器读文件：truncated / binary 为 true 时禁止保存；hash 用于保存前校验文件没被外部改过
    readFile(terminalId: string, root: string, path: string): Promise<{ text: string; size?: number; hash?: string; truncated: boolean; binary: boolean }>
    // 比较（b 不给 = 工作区）、AI 更新日志、AI 审查已暂存的改动
    compare(terminalId: string, root: string, a: string, b?: string): Promise<import('../../git/index.js').GitCompareResult>
    compareDiff(terminalId: string, root: string, a: string, b: string | undefined, path: string): Promise<string>
    changelog(terminalId: string, root: string, from: string | undefined, to: string, audience: 'ops' | 'user' | 'dev'): Promise<{ markdown: string; commits: number; truncated: boolean }>
    remotes(terminalId: string, root: string): Promise<import('../../git/index.js').GitRemote[]>
    rebasePlan(terminalId: string, root: string, from: string): Promise<import('../../git/index.js').RebasePlan>
    review(terminalId: string, root: string, paths?: string[]): Promise<{ result?: import('../../git/index.js').GitReviewResult; markdown: string }>
  }
}
