import { describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { dbClientDirs } from '../terminal/index.js'

describe.skipIf(process.platform !== 'win32')('本机数据库客户端目录（Windows 安装程序默认不进 PATH）', () => {
  it('找出 MySQL / PostgreSQL 标准安装目录里有客户端的 bin，新版本在前；没有客户端的目录不算', () => {
    const root = mkdtempSync(join(tmpdir(), 'pf-'))
    const mk = (rel: string, exe?: string) => { mkdirSync(join(root, rel), { recursive: true }); if (exe) writeFileSync(join(root, rel, exe), '') }
    mk('MySQL/MySQL Server 8.0/bin', 'mysql.exe'); mk('MySQL/MySQL Server 8.4/bin', 'mysql.exe'); mk('MySQL/MySQL Shell 8.4/bin')
    mk('PostgreSQL/9/bin', 'psql.exe'); mk('PostgreSQL/16/bin', 'psql.exe')
    expect(dbClientDirs(root).map((d) => d.slice(root.length + 1).replace(/\\/g, '/'))).toEqual(['MySQL/MySQL Server 8.4/bin', 'MySQL/MySQL Server 8.0/bin', 'PostgreSQL/16/bin', 'PostgreSQL/9/bin'])
    expect(dbClientDirs(join(root, 'nope'))).toEqual([])
  })
})
