// 本目录对外入口：其它目录只从这里引用（eslint no-restricted-imports 检查）。只导出外部实际用到的。
export { AutoReplyEngine } from './autoReply.js'
export { LOCAL_SHELL, createSideExec } from './bgJobExec.js'
export { DB_LOCAL_SHELL, dbClientDirs, decodeConsole, runFile, runSh } from './localExec.js'
export { TerminalRecorder, pruneRecordings, recordingPath } from './recorder.js'
export { SessionLogger, pruneSessionLogs } from './sessionLog.js'
export { authNote, entriesForHost, hostBlock, remoteAlias, upsertManagedBlock, vscodeRemoteArgs } from './vscodeRemote.js'
export type { SshHostEntry } from './vscodeRemote.js'
export { registerTerminalIpc } from './register.js'
