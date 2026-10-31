// AppClient 的数据库快查。主进程注册见 apps/desktop/src/main/db/register.ts，渲染层实现见 apps/ui/src/client/transports/ipc/db.ts

export interface DbApi {
  // 数据库快查（见 desktop/main/db/dbIpc.ts）：连接存 db-conns.json（密码只存密钥保险箱名称）；save / delete 返回最新列表；
  // ping 测连接（可传未保存的连接）返回版本；view 只读视图；explain 只放 SELECT；kill 终止会话（写操作，生产主机要 prodConfirmed）
  db: {
    list(): Promise<import('../../db/index.js').DbConn[]>
    save(conn: Partial<import('../../db/index.js').DbConn>): Promise<import('../../db/index.js').DbConn[]>
    delete(id: string): Promise<import('../../db/index.js').DbConn[]>
    ping(conn: Partial<import('../../db/index.js').DbConn>): Promise<string>
    // db：切换到的库（空 = 连接里配的）
    view(id: string, view: import('../../db/index.js').DbView, opts?: { limit?: number; db?: string }): Promise<import('../../db/index.js').DbViewResult>
    explain(id: string, sql: string, db?: string): Promise<import('../../db/index.js').DbExplainResult>
    /** 只读即席查询：单条 SELECT / SHOW / DESCRIBE / EXPLAIN */
    /** page：{ offset, limit }——查询语句自己没写 LIMIT 时由应用补 LIMIT / OFFSET 分页（每页上限 1000 行） */
    query(id: string, sql: string, db?: string, page?: { offset?: number; limit?: number }): Promise<import('../../db/index.js').DbQueryResult>
    databases(id: string): Promise<import('../../db/index.js').DbDatabase[]>
    schemaTables(id: string, db: string): Promise<import('../../db/index.js').DbTable>
    schemaTable(id: string, db: string, table: import('../../db/index.js').DbTableRef): Promise<import('../../db/index.js').DbSchemaDetail>
    // Redis Key 浏览：SCAN 分批（cursor '0' 开始，返回 '0' = 扫完）；看一个 key；删除一个 key（写操作，生产要确认，记执行记录）
    redisScan(id: string, db: string, pattern: string, cursor: string): Promise<{ cursor: string; keys: string[] }>
    redisKey(id: string, db: string, key: string): Promise<import('../../db/index.js').RedisKeyInfo>
    redisDel(id: string, db: string, key: string, prodConfirmed: boolean): Promise<void>
    kill(id: string, sessionId: number, about: string, prodConfirmed: boolean): Promise<void>
    /** 执行脚本（写操作，生产主机要 prodConfirmed，记执行记录）；失败不抛错，见 result.ok / error */
    script(id: string, script: string, tx: boolean, prodConfirmed: boolean, db?: string): Promise<import('../../db/index.js').DbScriptResult>
    // 备份（见 shared/db/dbBackup.ts）：在数据库所在机器上后台导出。plan 预检（目录、剩余空间、估算大小、工具）；start 返回备份文件完整路径；
    // status 返回本连接本次运行发起的任务进度；list / delete 管理目录里的备份文件
    backupPlan(id: string, opts: Partial<import('../../db/index.js').BackupOpts>): Promise<import('../../db/index.js').BackupPlan>
    backupStart(id: string, opts: Partial<import('../../db/index.js').BackupOpts>): Promise<string>
    backupStatus(id: string): Promise<import('../../db/index.js').BackupStatus[]>
    backupCancel(id: string, path: string): Promise<void>
    backupList(id: string, dir: string): Promise<import('../../db/index.js').BackupFile[]>
    backupDelete(id: string, dir: string, name: string): Promise<void>
    // 定时备份：每个连接一个计划（null = 删除）；scheduleRun 立即跑一次、跑完返回最新计划
    backupScheduleGet(id: string): Promise<import('../../db/index.js').BackupSchedule | null>
    backupScheduleSave(id: string, s: { enabled: boolean; when: import('../../ops/index.js').ScheduleWhen; keep: number; opts: Partial<import('../../db/index.js').BackupOpts> } | null): Promise<import('../../db/index.js').BackupSchedule | null>
    backupScheduleRun(id: string): Promise<import('../../db/index.js').BackupSchedule>
  }
}
