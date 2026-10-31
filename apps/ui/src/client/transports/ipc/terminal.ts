// AppClient 终端部分的 IPC 实现（接口见 packages/shared/src/protocol/client/terminal.ts，主进程见 apps/desktop/src/main/terminal/register.ts）
import type { AppClient, TerminalApi, AutoReplySummary, CommandHistoryEntry, HostInput, HostSummary, KnownHost, PortForwardInfo, PortForwardInput, QuickCommandsData, RecordingInfo, SavedPortForward, SshAgentInfo, SshConnectInput, SshCreateOpts, SshImportPreview, SshImportResult, TerminalInfo, TmuxSessionInfo } from '@lingshell/shared'

export function createTerminalIpc(): TerminalApi {
  return {
    terminal: {
      list: () => window.electronAPI.invoke('terminal:list') as Promise<TerminalInfo[]>,
      createLocal: (opts?: { cwd?: string; shell?: string }) => window.electronAPI.invoke('terminal:createLocal', opts) as Promise<TerminalInfo>,
      write: (id: string, data: string, opts?: { noHistory?: boolean }) => window.electronAPI.invoke('terminal:write', id, data, opts) as Promise<void>,
      close: (id: string, tmux?: 'kill' | 'keep') => window.electronAPI.invoke('terminal:close', id, tmux) as Promise<void>,
      tmuxJobs: (id: string) => window.electronAPI.invoke('terminal:tmuxJobs', id) as Promise<string[] | null>,
      snapshot: (id: string, lines?: number) => window.electronAPI.invoke('terminal:snapshot', id, lines) as Promise<string>,
      tmuxSessions: (id: string) => window.electronAPI.invoke('terminal:tmuxSessions', id) as Promise<TmuxSessionInfo[]>,
      interrupt: (id: string) => window.electronAPI.invoke('terminal:interrupt', id) as Promise<void>,
      resize: (id: string, cols: number, rows: number) => window.electronAPI.invoke('terminal:resize', id, cols, rows) as Promise<void>,
      reconnect: (id: string) => window.electronAPI.invoke('terminal:reconnect', id) as Promise<void>,
      pwd: (id: string) => window.electronAPI.invoke('terminal:pwd', id) as Promise<string>,
      duplicate: (id: string) => window.electronAPI.invoke('terminal:duplicate', id) as Promise<TerminalInfo>,
      createSsh: (opts: SshCreateOpts) => window.electronAPI.invoke('terminal:createSsh', opts) as Promise<TerminalInfo>,
      testSsh: (connect: SshConnectInput, hostId?: string) => window.electronAPI.invoke('terminal:testSsh', connect, hostId) as Promise<{ ok: boolean; error?: string }>,
      watchStats: (ids: string[]) => window.electronAPI.invoke('terminal:watchStats', ids) as Promise<void>,
    },
    hosts: {
      list: () => window.electronAPI.invoke('hosts:list') as Promise<HostSummary[]>,
      save: (input: HostInput) => window.electronAPI.invoke('hosts:save', input) as Promise<HostSummary>,
      delete: (id: string) => window.electronAPI.invoke('hosts:delete', id) as Promise<void>,
      appendNote: (hostKey: string, text: string) => window.electronAPI.invoke('hosts:appendNote', hostKey, text) as Promise<void>,
      sshConfigPreview: () => window.electronAPI.invoke('hosts:sshConfigPreview') as Promise<SshImportPreview>,
      importSshConfig: (aliases: string[]) => window.electronAPI.invoke('hosts:importSshConfig', aliases) as Promise<SshImportResult>,
      detectAgent: () => window.electronAPI.invoke('hosts:detectAgent') as Promise<SshAgentInfo | null>,
      sessionImportPreview: (source: Parameters<AppClient['hosts']['sessionImportPreview']>[0], pick?: boolean) => window.electronAPI.invoke('hosts:sessionImportPreview', source, pick === true) as Promise<SshImportPreview | undefined>,
      importSessions: (aliases: string[]) => window.electronAPI.invoke('hosts:importSessions', aliases) as Promise<SshImportResult>,
    },
    knownHosts: {
      list: () => window.electronAPI.invoke('knownHosts:list') as Promise<KnownHost[]>,
      decide: (requestId: string, trust: boolean) => window.electronAPI.invoke('knownHosts:decide', requestId, trust) as Promise<void>,
      acceptChanged: (hostPort: string) => window.electronAPI.invoke('knownHosts:acceptChanged', hostPort) as Promise<void>,
      remove: (hostPort: string) => window.electronAPI.invoke('knownHosts:remove', hostPort) as Promise<void>,
      importOpenSsh: () => window.electronAPI.invoke('knownHosts:importOpenSsh') as Promise<number>,
    },
    portForward: {
      list: () => window.electronAPI.invoke('portForward:list') as Promise<PortForwardInfo[]>,
      start: (input: PortForwardInput) => window.electronAPI.invoke('portForward:start', input) as Promise<PortForwardInfo>,
      stop: (id: string) => window.electronAPI.invoke('portForward:stop', id) as Promise<void>,
      retry: (id: string) => window.electronAPI.invoke('portForward:retry', id) as Promise<void>,
      listSaved: () => window.electronAPI.invoke('portForward:listSaved') as Promise<SavedPortForward[]>,
      save: (input: PortForwardInput) => window.electronAPI.invoke('portForward:save', input) as Promise<SavedPortForward>,
      setAutoStart: (id: string, on: boolean) => window.electronAPI.invoke('portForward:setAutoStart', id, on) as Promise<void>,
      deleteSaved: (id: string) => window.electronAPI.invoke('portForward:deleteSaved', id) as Promise<void>,
    },
    history: {
      list: (hostKey: string) => window.electronAPI.invoke('history:list', hostKey) as Promise<CommandHistoryEntry[]>,
      delete: (hostKey: string, index: number) => window.electronAPI.invoke('history:delete', hostKey, index) as Promise<void>,
      clear: (hostKey: string) => window.electronAPI.invoke('history:clear', hostKey) as Promise<void>,
      forTerminal: (terminalId: string) => window.electronAPI.invoke('history:forTerminal', terminalId) as Promise<{ hostKey: string; entries: CommandHistoryEntry[] }>,
      deleteCommand: (terminalId: string, command: string) => window.electronAPI.invoke('history:deleteCommand', terminalId, command) as Promise<void>,
    },
    quickCommands: {
      get: () => window.electronAPI.invoke('quickCommands:get') as Promise<QuickCommandsData>,
      save: (data: QuickCommandsData) => window.electronAPI.invoke('quickCommands:save', data) as Promise<QuickCommandsData>,
    },
    autoReplies: {
      list: () => window.electronAPI.invoke('autoReplies:list') as Promise<AutoReplySummary[]>,
      save: (input) => window.electronAPI.invoke('autoReplies:save', input) as Promise<AutoReplySummary>,
      delete: (id) => window.electronAPI.invoke('autoReplies:delete', id) as Promise<void>,
    },
    recordings: {
      list: () => window.electronAPI.invoke('recordings:list') as Promise<RecordingInfo[]>,
      read: (id: string) => window.electronAPI.invoke('recordings:read', id) as Promise<string>,
      openFolder: (id?: string) => window.electronAPI.invoke('recordings:openFolder', id) as Promise<void>,
      delete: (id: string) => window.electronAPI.invoke('recordings:delete', id) as Promise<void>,
      start: (terminalId: string) => window.electronAPI.invoke('recordings:start', terminalId) as Promise<void>,
      stop: (terminalId: string) => window.electronAPI.invoke('recordings:stop', terminalId) as Promise<void>,
      active: () => window.electronAPI.invoke('recordings:active') as Promise<string[]>,
    },
    sessionLogs: {
      openFolder: (dir?: string) => window.electronAPI.invoke('sessionLogs:openFolder', dir) as Promise<void>,
      openTerminal: (terminalId: string) => window.electronAPI.invoke('sessionLogs:openTerminal', terminalId) as Promise<void>,
    },
    sshAuth: {
      answer: (requestId, answers) => window.electronAPI.invoke('sshAuth:answer', requestId, answers) as Promise<void>,
    },
    proxy: {
      get: () => window.electronAPI.invoke('proxy:get') as ReturnType<AppClient['proxy']['get']>,
      save: (p) => window.electronAPI.invoke('proxy:save', p) as ReturnType<AppClient['proxy']['save']>,
    },
    hostPanel: {
      probe: (ids) => window.electronAPI.invoke('hostPanel:probe', ids) as ReturnType<AppClient['hostPanel']['probe']>,
      duplicate: (id) => window.electronAPI.invoke('hostPanel:duplicate', id) as Promise<HostSummary>,
    },
    keys: {
      list: () => window.electronAPI.invoke('keys:list') as ReturnType<AppClient['keys']['list']>,
      generate: (name, type, passphrase) => window.electronAPI.invoke('keys:generate', name, type, passphrase ?? '') as ReturnType<AppClient['keys']['generate']>,
      pickImport: () => window.electronAPI.invoke('keys:pickImport') as ReturnType<AppClient['keys']['pickImport']>,
      importPicked: (name, passphrase) => window.electronAPI.invoke('keys:importPicked', name, passphrase ?? '') as ReturnType<AppClient['keys']['importPicked']>,
      delete: (id) => window.electronAPI.invoke('keys:delete', id) as Promise<void>,
      export: (id, which) => window.electronAPI.invoke('keys:export', id, which) as Promise<string | undefined>,
      deploy: (id, hostId) => window.electronAPI.invoke('keys:deploy', id, hostId) as ReturnType<AppClient['keys']['deploy']>,
      useForHost: (id, hostId) => window.electronAPI.invoke('keys:useForHost', id, hostId) as Promise<void>,
    },
    localShells: {
      list: () => window.electronAPI.invoke('terminal:localShells') as ReturnType<AppClient['localShells']['list']>,
    },
    credentials: {
      list: () => window.electronAPI.invoke('credentials:list') as ReturnType<AppClient['credentials']['list']>,
      save: (input) => window.electronAPI.invoke('credentials:save', input) as ReturnType<AppClient['credentials']['save']>,
      delete: (id) => window.electronAPI.invoke('credentials:delete', id) as Promise<void>,
      assign: (hostIds, id) => window.electronAPI.invoke('credentials:assign', hostIds, id) as Promise<number>,
    },
    hostBatch: {
      preview: (ids, patch) => window.electronAPI.invoke('hostBatch:preview', ids, patch) as ReturnType<AppClient['hostBatch']['preview']>,
      apply: (ids, patch) => window.electronAPI.invoke('hostBatch:apply', ids, patch) as Promise<number>,
      last: () => window.electronAPI.invoke('hostBatch:last') as ReturnType<AppClient['hostBatch']['last']>,
      undo: () => window.electronAPI.invoke('hostBatch:undo') as Promise<number>,
    },
    gitBash: {
      status: () => window.electronAPI.invoke('gitBash:status') as ReturnType<AppClient['gitBash']['status']>,
      redetect: () => window.electronAPI.invoke('gitBash:redetect') as ReturnType<AppClient['gitBash']['redetect']>,
      pick: () => window.electronAPI.invoke('gitBash:pick') as ReturnType<AppClient['gitBash']['pick']>,
      clear: () => window.electronAPI.invoke('gitBash:clear') as ReturnType<AppClient['gitBash']['clear']>,
    },
  }
}
