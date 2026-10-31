import type { AppClient } from '@lingshell/shared'

// 未来 SaaS：实现同一 AppClient 接口，走 HTTP + WebSocket。Phase 1 占位。
// 现在每个命名空间只有一行占位，保持单文件；真要实现时按 ipc/<领域>.ts 的方式拆。
// 每个方法返回 rejected Promise —— 占位但类型契约完整（无 any），调用方的 .catch 能接住（同步 throw 接不住）。
const ni = (): Promise<never> => Promise.reject(new Error('HttpTransport not implemented'))

export class HttpTransport implements AppClient {
  constructor(private baseUrl: string) {}

  terminal: AppClient['terminal'] = {
    list: ni, createLocal: ni, write: ni, close: ni, interrupt: ni, resize: ni, reconnect: ni, pwd: ni, duplicate: ni, createSsh: ni, testSsh: ni, watchStats: ni, tmuxJobs: ni, tmuxSessions: ni, snapshot: ni,
  }
  agent: AppClient['agent'] = {
    createSession: ni, listSessions: ni, sendTurn: ni, interruptTurn: ni, steer: ni, unsteer: ni,
    listPersisted: ni, reconnectSession: ni, deleteSession: ni, renameSession: ni, search: ni, setWorkDir: ni, resetContext: ni, suggestCommand: ni, forkSession: ni,
  }
  settings: AppClient['settings'] = {
    get: ni, save: ni,
  }
  auth: AppClient['auth'] = {
    decide: ni, listForSession: ni, grant: ni, revoke: ni, getTrust: ni, setTrust: ni,
  }
  hosts: AppClient['hosts'] = { list: ni, save: ni, delete: ni, appendNote: ni, sshConfigPreview: ni, importSshConfig: ni, detectAgent: ni, sessionImportPreview: ni, importSessions: ni }
  knownHosts: AppClient['knownHosts'] = { list: ni, decide: ni, acceptChanged: ni, remove: ni, importOpenSsh: ni }
  portForward: AppClient['portForward'] = { list: ni, start: ni, stop: ni, retry: ni, listSaved: ni, save: ni, setAutoStart: ni, deleteSaved: ni }
  layout: AppClient['layout'] = { get: ni, save: ni }
  system: AppClient['system'] = { pickDirectory: ni, saveTextFile: ni, exportDiagnostics: ni, getUpdateStatus: ni, checkUpdate: ni, installUpdate: ni, notify: async () => {}, appInfo: ni, openDir: ni, relaunch: async () => { location.reload() } }
  audit: AppClient['audit'] = { listForSession: ni, listRecent: ni, restore: ni }
  history: AppClient['history'] = { list: ni, delete: ni, clear: ni, forTerminal: ni, deleteCommand: ni }
  fs: AppClient['fs'] = { listDir: ni, listDirByHost: ni, places: ni, remove: ni, deletePlan: ni, create: ni, rename: ni, openLocal: ni, readText: ni, diffText: ni, writeText: ni, compare: ni, chmod: ni, pack: ni, unpack: ni, search: ni, searchContent: ni, pastePlan: ni, paste: ni, stats: ni, checksum: ni, owners: ni, chown: ni, sudoAuth: ni, sudoForget: ni, editExternal: ni }
  transfer: AppClient['transfer'] = { upload: ni, download: ni, downloadMany: ni, cancel: ni, list: ni, retry: ni, clearFinished: ni, revealLocal: ni, reorder: ni, uploadConflicts: ni, uploadDirect: ni, pause: ni, discard: ni }
  templates: AppClient['templates'] = { list: ni, save: ni, delete: ni }
  runbooks: AppClient['runbooks'] = { list: ni, save: ni, delete: ni }
  quickCommands: AppClient['quickCommands'] = { get: ni, save: ni }
  schedules: AppClient['schedules'] = { list: ni, save: ni, delete: ni, runNow: ni, listRuns: ni }
  webhooks: AppClient['webhooks'] = { list: ni, save: ni, delete: ni, test: ni }
  autoReplies: AppClient['autoReplies'] = { list: ni, save: ni, delete: ni }
  recordings: AppClient['recordings'] = { list: ni, read: ni, openFolder: ni, delete: ni, start: ni, stop: ni, active: ni }
  sessionLogs: AppClient['sessionLogs'] = { openFolder: ni, openTerminal: ni }
  configBackup: AppClient['configBackup'] = { export: ni, pickImport: ni, import: ni }
  mcp: AppClient['mcp'] = { list: ni, save: ni, delete: ni, status: ni, test: ni, setAutoApprove: ni }
  lock: AppClient['lock'] = { status: ni, lock: ni, unlock: ni, setPassword: ni, disable: ni }
  batch: AppClient['batch'] = { exec: ni, cancel: ni }
  docker: AppClient['docker'] = { list: ni, stats: ni, logs: ni, action: ni, openTerminal: ni, composeList: ni, composeLogs: ni, composeAction: ni }
  usage: AppClient['usage'] = { summary: ni, session: ni, getPrices: ni, savePrices: ni }
  sshAuth: AppClient['sshAuth'] = { answer: ni }
  proxy: AppClient['proxy'] = { get: ni, save: ni }
  hostPanel: AppClient['hostPanel'] = { probe: ni, duplicate: ni }
  keys: AppClient['keys'] = { list: ni, generate: ni, pickImport: ni, importPicked: ni, delete: ni, export: ni, deploy: ni, useForHost: ni }
  dirSync: AppClient['dirSync'] = { compare: ni, run: ni, progress: ni, cancel: ni }
  processes: AppClient['processes'] = { list: ni, signal: ni }
  logs: AppClient['logs'] = { start: ni, poll: ni, stop: ni }
  localShells: AppClient['localShells'] = { list: ni }
  credentials: AppClient['credentials'] = { list: ni, save: ni, delete: ni, assign: ni }
  hostBatch: AppClient['hostBatch'] = { preview: ni, apply: ni, last: ni, undo: ni }
  sshUrl: AppClient['sshUrl'] = { takePending: ni }
  gitBash: AppClient['gitBash'] = { status: ni, redetect: ni, pick: ni, clear: ni }
  modelProfiles: AppClient['modelProfiles'] = { test: ni, sessionModel: ni, setSessionModel: ni }
  skills: AppClient['skills'] = { list: ni, read: ni, save: ni, remove: ni, setFlags: ni, pickImport: ni, inspect: ni, commitImport: ni, cancelImport: ni, openDir: ni }
  attachments: AppClient['attachments'] = { pickFiles: ni, pickDirs: ni, pickImages: ni, kinds: ni, imageFile: ni, clipboardPaths: ni, send: ni, image: ni, open: ni }
  ports: AppClient['ports'] = { list: ni, forwards: ni, forward: ni, stop: ni }
  turnChanges: AppClient['turnChanges'] = { list: ni, check: ni, diff: ni, undo: ni }
  rollback: AppClient['rollback'] = { check: ni, run: ni }
  watchdogs: AppClient['watchdogs'] = { list: ni, states: ni, save: ni, delete: ni, checkNow: ni, generate: ni, checkScript: ni, paused: ni, setPaused: ni }
  hostCheck: AppClient['hostCheck'] = { run: ni, history: ni, get: ni, fileDiff: ni, fetchFile: ni }
  hostChanges: AppClient['hostChanges'] = { list: ni }
  systemd: AppClient['systemd'] = { list: ni, status: ni, action: ni }
  knowledge: AppClient['knowledge'] = { list: ni, save: ni, remove: ni }
  dashboard: AppClient['dashboard'] = { open: ni, close: ni, snapshot: ni, setSampling: ni, setInterval: ni }
  appearance: AppClient['appearance'] = { apply: async () => {} }   // 浏览器里没有原生主题 / 缩放，页面内的主题照常
  secrets: AppClient['secrets'] = { list: ni, save: ni, delete: ni, copy: ni, send: ni }
  mobile: AppClient['mobile'] = { status: ni, setEnabled: ni, configure: ni, newPairCode: ni, revoke: ni, revokeAll: ni }
  chatPlus: AppClient['chatPlus'] = { digest: ni, search: ni, runShell: ni, answerAsk: ni }
  globalHotkey: AppClient['globalHotkey'] = { status: ni }
  aiLink: AppClient['aiLink'] = { predictCommand: ni, summarizeRecording: ni, recordingSummary: ni }
  cron: AppClient['cron'] = { list: ni, generate: ni, add: ni, remove: ni, toggle: ni }
  firewall: AppClient['firewall'] = { list: ni }
  topology: AppClient['topology'] = { get: ni }
  configExplain: AppClient['configExplain'] = { run: ni }
  preview: AppClient['preview'] = { read: ni, openExternal: ni }
  safety: AppClient['safety'] = { rules: ni, setGroupRules: ni, setHostRules: ni, preview: ni, setPreview: ni, approvePlan: ni, sudoLeases: ni, revokeSudo: ni }
  trend: AppClient['trend'] = { get: ni }
  deployReview: AppClient['deployReview'] = { list: ni, get: ni, create: ni, delete: ni, update: ni, importDoc: ni, pasteDoc: ni, addArtifacts: ni, removeArtifact: ni, analyze: ni, probe: ni, toRunbook: ni, exportPdf: ni }
  compliance: AppClient['compliance'] = { config: ni, setDisabled: ni, run: ni, batch: ni }
  background: AppClient['background'] = { status: ni, configure: ni }
  logMulti: AppClient['logMulti'] = { start: ni, poll: ni, stop: ni, search: ni }
  probe: AppClient['probe'] = { run: ni, cancel: ni }
  git: AppClient['git'] = { status: ni, diff: ni, stage: ni, commit: ni, suggest: ni, refs: ni, log: ni, show: ni, commitDiff: ni, stashes: ni, stashFiles: ni, stashDiff: ni, progress: ni, op: ni, blame: ni, readFile: ni, compare: ni, compareDiff: ni, changelog: ni, review: ni, remotes: ni, rebasePlan: ni }
  api: AppClient['api'] = { load: ni, save: ni, send: ni, clearHistory: ni }
  db: AppClient['db'] = { list: ni, save: ni, delete: ni, ping: ni, view: ni, explain: ni, query: ni, databases: ni, schemaTables: ni, schemaTable: ni, redisScan: ni, redisKey: ni, redisDel: ni, kill: ni, script: ni, backupPlan: ni, backupStart: ni, backupStatus: ni, backupCancel: ni, backupList: ni, backupDelete: ni, backupScheduleGet: ni, backupScheduleSave: ni, backupScheduleRun: ni }
  k8s: AppClient['k8s'] = { probe: ni, namespaces: ni, list: ni, text: ni, logs: ni, restart: ni, health: ni, openTerminal: ni, forward: ni, forwards: ni, stopForward: ni }
  diskUsage: AppClient['diskUsage'] = { level: ni, bigFiles: ni, common: ni, deleted: ni }
  fileLinks: AppClient['fileLinks'] = { open: ni, vscodePlan: ni, vscodeOpen: ni }
  configDiff: AppClient['configDiff'] = { read: ni }
  certs: AppClient['certs'] = { list: ni, save: ni, delete: ni, check: ni, setConfig: ni, discover: ni }
  on(): () => void {
    void this.baseUrl   // 占位：未来用 baseUrl 建立 WebSocket
    return () => {}
  }
}
