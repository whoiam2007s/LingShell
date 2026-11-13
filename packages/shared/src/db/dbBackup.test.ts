import { describe, expect, it } from 'vitest'
import { backupFileName, backupListCommand, backupSpaceCheck, backupsToPrune, checkBackupOpts, isBackupDir, isBackupName, parseBackupList, sanitizeBackupSchedule, canRestore, preRestoreFileName, restoreCommand } from './dbBackup.js'
import type { DbConn } from './dbQuick.js'

const my: DbConn = { id: 'm', name: '订单库', hostKey: 'h', kind: 'mysql', via: 'client', database: 'shop' }

describe('数据库备份（纯逻辑）', () => {
  it('文件名：库名-日期-时间 + 扩展名；中文连接名退回类型', () => {
    expect(backupFileName(my, 'shop', new Date(2026, 9, 18, 3, 4, 5))).toBe('shop-20261018-030405.sql.gz')
    expect(backupFileName({ ...my, kind: 'redis' }, undefined, new Date(2026, 0, 2, 0, 0, 0))).toBe('redis-20260102-000000.rdb.gz')
  })
  it('目录校验：绝对路径或 ~，不许 ..、空格、分号', () => {
    expect(['~/b', '/data/bk', '~'].every(isBackupDir)).toBe(true)
    expect(['b', '/a/../etc', '/a b', '/a;rm', ''].some(isBackupDir)).toBe(false)
  })
  it('选项：库名必填（Redis 除外），表名只许安全字符', () => {
    expect(checkBackupOpts({ ...my, database: undefined }, { dir: '~/b' })).toMatch(/库名/)
    expect(checkBackupOpts(my, { dir: '~/b', tables: ['a', 'b c'] })).toMatch(/表名/)
    expect(checkBackupOpts(my, { dir: '~/b', tables: [' t1 ', ''] })).toEqual({ dir: '~/b', database: 'shop', tables: ['t1'], routines: true })
  })
  it('空间判断：不够拦下，不到两倍提示', () => {
    expect(backupSpaceCheck(100 << 20, 200 << 20).blocked).toMatch(/不够/)
    expect(backupSpaceCheck(300 << 20, 200 << 20).warn).toMatch(/偏紧/)
    expect(backupSpaceCheck(1 << 30, 200 << 20)).toEqual({})
    expect(backupSpaceCheck(undefined, 1)).toEqual({})
  })
  it('列表只认本功能生成的文件名（含 MongoDB .archive.gz）', () => {
    expect(parseBackupList('100\t1700000000\tshop-20261018-030405.sql.gz\n5\t1\tnotes.txt\n7\t2\tx.sql.gz\n').map((f) => f.name)).toEqual(['shop-20261018-030405.sql.gz'])
    expect(parseBackupList('9\t1700000000\tapp-20261018-030405.archive.gz').map((f) => f.name)).toEqual(['app-20261018-030405.archive.gz'])
    expect(backupListCommand('/b')).toContain('*.archive.gz')
  })
  it('保留份数：同库同类型的按时间新→旧留 keep 份，别的库不动', () => {
    const f = (name: string) => ({ name, size: 1, at: 0 })
    const files = ['shop-20261016-030000.sql.gz', 'shop-20261018-030000.sql.gz', 'shop-20261017-030000.sql.gz', 'crm-20261001-030000.sql.gz', 'shopx-20261001-030000.sql.gz'].map(f)
    expect(backupsToPrune(files, my, 'shop', 2)).toEqual(['shop-20261016-030000.sql.gz'])
    expect(backupsToPrune(files, my, 'shop', 5)).toEqual([])
  })
  it('计划校验', () => {
    expect(sanitizeBackupSchedule({ enabled: true, when: { kind: 'daily', time: '03:00' }, keep: 7, opts: { dir: '~/b' } }, my)).toMatchObject({ connId: 'm', enabled: true, keep: 7, opts: { database: 'shop' } })
    expect(sanitizeBackupSchedule({ when: { kind: 'daily', time: '25:00' }, keep: 7, opts: { dir: '~/b' } }, my)).toMatch(/HH:MM/)
    expect(sanitizeBackupSchedule({ when: { kind: 'interval', hours: 6 }, keep: 0, opts: { dir: '~/b' } }, my)).toMatch(/保留份数/)
  })
})

describe('数据库还原（纯逻辑）', () => {
  it('本版只放开 MySQL', () => {
    expect(canRestore('mysql')).toBe(true)
    expect(canRestore('postgres')).toBe(false)
    expect(canRestore('mongo')).toBe(false)
    expect(canRestore('redis')).toBe(false)
  })

  it('还原前快照命名仍符合备份文件名规则，且带 prerestore', () => {
    const n = preRestoreFileName(my, 'shop', new Date(2026, 9, 18, 3, 4, 5))
    expect(n).toBe('shop-prerestore-20261018-030405.sql.gz')
    expect(isBackupName(n)).toBe(true)
  })

  it('还原命令：gunzip 管道进 mysql，密码走 stdin 不进命令行', () => {
    const cmd = restoreCommand(my, '~/bak/shop-20261018-030405.sql.gz', 'shop')
    expect(cmd).toContain('gunzip -c')
    expect(cmd).toContain('mysql')
    expect(cmd).toContain("'shop'")
    expect(cmd).toContain('MYSQL_PWD')
    expect(cmd).not.toMatch(/--password=/)
    expect(cmd).toContain('started $f')
  })

  it('还原命令：docker 连接走 docker exec -i 并转发环境变量', () => {
    const c: DbConn = { ...my, via: 'docker', container: 'db1' }
    const cmd = restoreCommand(c, '/b/shop-20261018-030405.sql.gz', 'shop')
    expect(cmd).toContain('docker exec -i')
    expect(cmd).toContain('db1')
  })

  it('还原命令：非 MySQL / 非法文件名 / 非法库名都拒绝', () => {
    expect(() => restoreCommand({ ...my, kind: 'postgres' } as DbConn, '/b/x-20261018-030405.dump', 'shop')).toThrow(/MySQL/)
    expect(() => restoreCommand(my, '/b/notes.txt', 'shop')).toThrow(/文件名/)
    expect(() => restoreCommand(my, '/b/shop-20261018-030405.sql.gz', 'shop; rm -rf /')).toThrow(/库名/)
  })
})
