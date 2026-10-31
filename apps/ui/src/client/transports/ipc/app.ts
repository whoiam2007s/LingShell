// AppClient 应用级部分的 IPC 实现（接口见 packages/shared/src/protocol/client/app.ts，主进程见 apps/desktop/src/main/app/register.ts）
import type { AppClient, AppApi, AppInfo, AppLayout, AppSettings, ConfigExportOpts, ConfigImportOpts, ConfigImportReport, ConfigPreview, LockStatus, UnlockResult, UpdateStatus } from '@lingshell/shared'

export function createAppIpc(): AppApi {
  return {
    settings: {
      get: () => window.electronAPI.invoke('settings:get') as Promise<AppSettings>,
      save: (s: AppSettings) => window.electronAPI.invoke('settings:save', s) as Promise<void>,
    },
    layout: {
      get: () => window.electronAPI.invoke('layout:get') as Promise<AppLayout>,
      save: (patch: Partial<AppLayout>) => window.electronAPI.invoke('layout:save', patch) as Promise<void>,
    },
    system: {
      pickDirectory: () => window.electronAPI.invoke('system:pickDirectory') as Promise<string | undefined>,
      saveTextFile: (name: string, content: string) => window.electronAPI.invoke('system:saveTextFile', name, content) as Promise<string | undefined>,
      exportDiagnostics: () => window.electronAPI.invoke('system:exportDiagnostics') as Promise<string | undefined>,
      getUpdateStatus: () => window.electronAPI.invoke('system:getUpdateStatus') as Promise<{ currentVersion: string; status: UpdateStatus }>,
      checkUpdate: () => window.electronAPI.invoke('system:checkUpdate') as Promise<UpdateStatus>,
      installUpdate: () => window.electronAPI.invoke('system:installUpdate') as Promise<void>,
      notify: (title: string, body: string) => window.electronAPI.invoke('system:notify', title, body) as Promise<void>,
      relaunch: () => window.electronAPI.invoke('system:relaunch') as Promise<void>,
      appInfo: () => window.electronAPI.invoke('system:appInfo') as Promise<AppInfo>,
      openDir: (which: 'data' | 'logs') => window.electronAPI.invoke('system:openDir', which) as Promise<void>,
    },
    configBackup: {
      export: (opts: ConfigExportOpts) => window.electronAPI.invoke('config:export', opts) as Promise<string | undefined>,
      pickImport: () => window.electronAPI.invoke('config:pickImport') as Promise<{ fileName: string; preview: ConfigPreview } | undefined>,
      import: (opts: ConfigImportOpts) => window.electronAPI.invoke('config:import', opts) as Promise<ConfigImportReport>,
    },
    lock: {
      status: () => window.electronAPI.invoke('lock:status') as Promise<LockStatus>,
      lock: () => window.electronAPI.invoke('lock:lock') as Promise<void>,
      unlock: (pw: string) => window.electronAPI.invoke('lock:unlock', pw) as Promise<UnlockResult>,
      setPassword: (next: string, current?: string) => window.electronAPI.invoke('lock:setPassword', next, current) as Promise<void>,
      disable: (current: string) => window.electronAPI.invoke('lock:disable', current) as Promise<void>,
    },
    sshUrl: {
      takePending: () => window.electronAPI.invoke('sshUrl:takePending') as ReturnType<AppClient['sshUrl']['takePending']>,
    },
    appearance: {
      apply: (look) => window.electronAPI.invoke('appearance:apply', look) as Promise<void>,
    },
    globalHotkey: {
      status: () => window.electronAPI.invoke('globalHotkey:status') as ReturnType<AppClient['globalHotkey']['status']>,
    },
    background: {
      status: () => window.electronAPI.invoke('background:status') as ReturnType<AppClient['background']['status']>,
      configure: (p) => window.electronAPI.invoke('background:configure', p) as ReturnType<AppClient['background']['status']>,
    },
  }
}
