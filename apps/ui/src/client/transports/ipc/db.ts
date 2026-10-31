// AppClient 数据库部分的 IPC 实现（接口见 packages/shared/src/protocol/client/db.ts，主进程见 apps/desktop/src/main/db/register.ts）
import type { AppClient, DbApi } from '@lingshell/shared'

export function createDbIpc(): DbApi {
  return {
    db: {
      list: () => window.electronAPI.invoke('db:list') as ReturnType<AppClient['db']['list']>,
      save: (c) => window.electronAPI.invoke('db:save', c) as ReturnType<AppClient['db']['save']>,
      delete: (id) => window.electronAPI.invoke('db:delete', id) as ReturnType<AppClient['db']['delete']>,
      ping: (c) => window.electronAPI.invoke('db:ping', c) as Promise<string>,
      view: (id, v, o) => window.electronAPI.invoke('db:view', id, v, o) as ReturnType<AppClient['db']['view']>,
      explain: (id, sql, db) => window.electronAPI.invoke('db:explain', id, sql, db) as ReturnType<AppClient['db']['explain']>,
      query: (id, sql, db, page) => window.electronAPI.invoke('db:query', id, sql, db, page) as ReturnType<AppClient['db']['query']>,
      databases: (id) => window.electronAPI.invoke('db:databases', id) as ReturnType<AppClient['db']['databases']>,
      schemaTables: (id, db) => window.electronAPI.invoke('db:schemaTables', id, db) as ReturnType<AppClient['db']['schemaTables']>,
      schemaTable: (id, db, t) => window.electronAPI.invoke('db:schemaTable', id, db, t) as ReturnType<AppClient['db']['schemaTable']>,
      redisScan: (id, db, p, cur) => window.electronAPI.invoke('db:redisScan', id, db, p, cur) as ReturnType<AppClient['db']['redisScan']>,
      redisKey: (id, db, k) => window.electronAPI.invoke('db:redisKey', id, db, k) as ReturnType<AppClient['db']['redisKey']>,
      redisDel: (id, db, k, prod) => window.electronAPI.invoke('db:redisDel', id, db, k, prod) as ReturnType<AppClient['db']['redisDel']>,
      kill: (id, sid, about, prod) => window.electronAPI.invoke('db:kill', id, sid, about, prod) as Promise<void>,
      script: (id, sc, tx, prod, db) => window.electronAPI.invoke('db:script', id, sc, tx, prod, db) as ReturnType<AppClient['db']['script']>,
      backupPlan: (id, o) => window.electronAPI.invoke('db:backupPlan', id, o) as ReturnType<AppClient['db']['backupPlan']>,
      backupStart: (id, o) => window.electronAPI.invoke('db:backupStart', id, o) as Promise<string>,
      backupStatus: (id) => window.electronAPI.invoke('db:backupStatus', id) as ReturnType<AppClient['db']['backupStatus']>,
      backupCancel: (id, p) => window.electronAPI.invoke('db:backupCancel', id, p) as Promise<void>,
      backupList: (id, dir) => window.electronAPI.invoke('db:backupList', id, dir) as ReturnType<AppClient['db']['backupList']>,
      backupDelete: (id, dir, name) => window.electronAPI.invoke('db:backupDelete', id, dir, name) as Promise<void>,
      backupScheduleGet: (id) => window.electronAPI.invoke('db:backupScheduleGet', id) as ReturnType<AppClient['db']['backupScheduleGet']>,
      backupScheduleSave: (id, s) => window.electronAPI.invoke('db:backupScheduleSave', id, s) as ReturnType<AppClient['db']['backupScheduleSave']>,
      backupScheduleRun: (id) => window.electronAPI.invoke('db:backupScheduleRun', id) as ReturnType<AppClient['db']['backupScheduleRun']>,
    },
  }
}
