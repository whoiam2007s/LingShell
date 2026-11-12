import { describe, it, expect } from 'vitest'
import {
  DIR_BACKUP_DIR, DIR_BACKUP_EXCLUDES, checkBackupSource, dirBackupFileName, planDirBackup, dirBackupCommand,
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
