import { describe, it, expect } from 'vitest'
import { isDestructiveCommand, isDestructiveTool } from './danger.js'

describe('isDestructiveCommand：什么算「真删除」', () => {
  it('Unix 删除命令', () => {
    for (const c of [
      'rm a.txt',
      'rm -rf build',
      'rm -fr node_modules',
      'sudo rm /etc/nginx/nginx.conf',
      'rmdir empty-dir',
      'unlink /tmp/x',
      'shred -u secret.key',
    ]) expect(isDestructiveCommand(c), c).toBe(true)
  })

  it('Windows 删除命令', () => {
    for (const c of [
      'del C:\\temp\\a.txt',
      'erase /Q build\\*.log',
      'Remove-Item -Recurse -Force .\\dist',
      'powershell -Command "Remove-Item x"',
      'Clear-RecycleBin -Force',
    ]) expect(isDestructiveCommand(c), c).toBe(true)
  })

  it('宽松匹配：纯文本里出现也算（刻意多问一句）', () => {
    expect(isDestructiveCommand('echo "rm -rf is dangerous"')).toBe(true)
  })

  it('链式命令里出现删除也算', () => {
    expect(isDestructiveCommand('cd /app && rm -f cache.db')).toBe(true)
    expect(isDestructiveCommand('ls; rm a')).toBe(true)
    expect(isDestructiveCommand('echo hi | xargs rm')).toBe(true)
  })

  it('不是删除的不误报', () => {
    for (const c of [
      'ls -la',
      'cat a.txt',
      'git status',
      'mv a.txt b.txt',                    // 覆盖但不是删除（按约定不算）
      'npm run build',
    ]) expect(isDestructiveCommand(c), c).toBe(false)
    // docker rm 删的是容器不是文件，但宽松口径会一起问 —— 已接受（多问一句好过误删）
    expect(isDestructiveCommand('docker rm -f web')).toBe(true)
  })

  it('空命令不报', () => {
    expect(isDestructiveCommand('')).toBe(false)
    expect(isDestructiveCommand('   ')).toBe(false)
  })
})

describe('isDestructiveTool：文件工具侧的删除', () => {
  it('删除类工具', () => {
    expect(isDestructiveTool('delete_file')).toBe(true)
    expect(isDestructiveTool('fs_delete', { path: '/a' })).toBe(true)
    expect(isDestructiveTool('remove_file')).toBe(true)
  })

  it('删除计划：真删才算，预览不算', () => {
    expect(isDestructiveTool('delete_plan', { dryRun: false })).toBe(true)
    expect(isDestructiveTool('delete_plan', {})).toBe(true)          // 没有 dryRun 就当会删
    expect(isDestructiveTool('delete_plan', { dryRun: true })).toBe(false)
  })

  it('其它工具不算', () => {
    expect(isDestructiveTool('write_file')).toBe(false)
    expect(isDestructiveTool('exec_in_terminal')).toBe(false)
  })
})
