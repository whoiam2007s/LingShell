import { describe, it, expect } from 'vitest'
import {
  DIR_BACKUP_DIR, DIR_BACKUP_EXCLUDES, checkBackupSource, dirBackupFileName, planDirBackup, dirBackupCommand,
  checkRestoreTarget, planDirRestore, dirRestoreCommand, dirRestoreSnapshotName,
} from './dirBackup.js'

describe('目录备份：源路径校验', () => {
  it('接受绝对路径与 ~ 路径', () => {
    expect(checkBackupSource('/var/log')).toBeUndefined()
    expect(checkBackupSource('  /opt/app  ')).toBeUndefined()
    expect(checkBackupSource('~/projects/demo')).toBeUndefined()
  })

  it('拒绝空、相对路径、根目录、不可见字符', () => {
    expect(checkBackupSource('')).toBeTruthy()
    expect(checkBackupSource('var/log')).toBeTruthy()
    expect(checkBackupSource('/')).toBeTruthy()
    expect(checkBackupSource('~')).toBeTruthy()
    expect(checkBackupSource('~/')).toBeTruthy()
    expect(checkBackupSource('/tmp/a\u0000b')).toBeTruthy()
  })
})

describe('目录备份：文件名与计划', () => {
  it('文件名带目录名与时间戳，去掉尾部斜杠', () => {
    const now = new Date(2026, 0, 2, 3, 4, 5)
    expect(dirBackupFileName('/opt/my app/', now)).toBe('my_app-20260102-030405.tar.gz')
    expect(dirBackupFileName('~/demo', now)).toBe('demo-20260102-030405.tar.gz')
  })

  it('默认落到 ~/lingshell-backups，并带默认排除项', () => {
    const p = planDirBackup('/var/log', {}, new Date(2026, 0, 2, 3, 4, 5))
    expect(p.out).toBe(`${DIR_BACKUP_DIR}/log-20260102-030405.tar.gz`)
    for (const e of DIR_BACKUP_EXCLUDES) expect(p.excludes).toContain(e)
  })

  it('自定义目录与额外排除项去重', () => {
    const p = planDirBackup('/data', { dir: '/backup/', exclude: ['.cache', '.git', '  '] })
    expect(p.out.startsWith('/backup/data-')).toBe(true)
    expect(p.excludes.filter((e) => e === '.git')).toHaveLength(1)
    expect(p.excludes).toContain('.cache')
  })
})

describe('目录备份：命令拼装', () => {
  // shScript 会把整个脚本再包一层单引号（内部 ' 变成 '\''），所以断言用「包含关键片段」而不是完整引号形式
  it('~ 路径用 $HOME 展开，源目录切到父目录并只打包目录本身', () => {
    const cmd = dirBackupCommand(planDirBackup('/var/log', {}, new Date(2026, 0, 2, 3, 4, 5)))
    expect(cmd).toContain('mkdir -p "$HOME/lingshell-backups"')
    expect(cmd).toContain('tar -czf "$HOME/lingshell-backups/log-20260102-030405.tar.gz"')
    expect(cmd).toContain('-C')
    expect(cmd).toContain('/var')
    expect(cmd).toContain('./log')
  })

  it('排除项都进命令，且带 tar 缺失兜底', () => {
    const cmd = dirBackupCommand(planDirBackup('/opt/app', { exclude: ['.cache'] }))
    expect(cmd).toContain('.git')
    expect(cmd).toContain('node_modules')
    expect(cmd).toContain('.cache')
    expect((cmd.match(/--exclude=/g) ?? []).length).toBe(DIR_BACKUP_EXCLUDES.length + 1)
    expect(cmd).toContain('command -v tar')
  })

  it('目录名带空格时整体引用', () => {
    const cmd = dirBackupCommand(planDirBackup('/opt/my app'))
    expect(cmd).toContain('/opt')
    expect(cmd).toContain('./my app')
  })
})

describe('目录还原', () => {
  it('目标校验：拒绝根 / 一级系统目录，接受具体项目目录', () => {
    for (const bad of ['/', '~', '/etc', '/var', '/usr', '/home', '/root']) {
      expect(checkRestoreTarget(bad)).toBeTruthy()
    }
    expect(checkRestoreTarget('/opt/app')).toBeUndefined()
    expect(checkRestoreTarget('~/projects/app')).toBeUndefined()
    expect(checkRestoreTarget('relative/path')).toMatch(/\/ 或 ~/)
    expect(checkRestoreTarget('')).toMatch(/请填写/)
  })

  it('还原前快照名带 prerestore 且回到统一备份目录', () => {
    expect(dirRestoreSnapshotName('/opt/app', new Date(2026, 9, 18, 3, 4, 5))).toBe('app-prerestore-20261018-030405.tar.gz')
    const plan = planDirRestore('/tmp/a.tar.gz', '/opt/app', {}, new Date(2026, 9, 18, 3, 4, 5))
    expect(plan.snapshot).toBe(`${DIR_BACKUP_DIR}/app-prerestore-20261018-030405.tar.gz`)
    expect(plan.clean).toBe(false)
  })

  it('默认只覆盖同名：命令里没有 rm -rf，解压到父目录', () => {
    const cmd = dirRestoreCommand(planDirRestore('/bak/app-20261018-030405.tar.gz', '/opt/app'))
    expect(cmd).toContain('tar -xzf')
    expect(cmd).toContain("'/opt'")
    expect(cmd).not.toContain('rm -rf')
    // 快照必须先于解压
    expect(cmd.indexOf('tar -czf')).toBeGreaterThan(-1)
    expect(cmd.indexOf('tar -czf')).toBeLessThan(cmd.indexOf('tar -xzf'))
  })

  it('clean 模式：快照之后才 rm -rf，且只删目标目录这一层', () => {
    const cmd = dirRestoreCommand(planDirRestore('/bak/app-20261018-030405.tar.gz', '/opt/app', { clean: true }))
    expect(cmd).toMatch(/rm -rf [^\n]*app/)   // 删的是目标目录本身（shScript 会把路径再包一层引号，按片段匹配）
    expect(cmd).toContain('/opt')
    expect(cmd.indexOf('SNAPSHOT_FAILED')).toBeLessThan(cmd.indexOf('rm -rf'))
    expect(cmd.indexOf('rm -rf')).toBeLessThan(cmd.indexOf('tar -xzf'))
  })

  it('~ 路径在命令里展开成 $HOME', () => {
    const cmd = dirRestoreCommand(planDirRestore('/bak/app-20261018-030405.tar.gz', '~/projects/app'))
    expect(cmd).toContain('"$HOME/projects"')
    expect(cmd).toContain('./app')
  })
})
