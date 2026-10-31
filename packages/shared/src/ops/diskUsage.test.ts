import { describe, it, expect } from 'vitest'
import {
  bashPath, diskBigCommand, diskCommonCommand, diskDeletedCommand, diskJoin, diskLevelCommand, diskQuote, diskSupported, diskLinuxOnly,
  parseDfLine, parseDiskBig, parseDiskCommon, parseDiskDeleted, parseDiskLevel, parseLsofDeleted, parseProcDeleted,
} from './diskUsage.js'
import { formatSize, shq } from '../files/index.js'

describe('diskUsage 命令拼装', () => {
  it('路径单引号转义、Windows 路径转 C:/', () => {
    expect(shq("a'b")).toBe(`'a'\\''b'`)
    expect(bashPath('C:\\Users\\x')).toBe('C:/Users/x')
    expect(bashPath('/var/log')).toBe('/var/log')
    expect(diskLevelCommand("/data/it's")).toContain(`cd -- '/data/it'\\''s'`)
    expect(diskJoin('/', 'var')).toBe('/var')
    expect(diskJoin('/var', 'log')).toBe('/var/log')
    expect(diskJoin('C:/', 'x')).toBe('C:/x')
  })
  it('都带 timeout、只读（不出现 rm / > 重定向写文件）', () => {
    for (const c of [diskLevelCommand('/'), diskBigCommand('/'), diskCommonCommand(), diskDeletedCommand()]) {
      expect(c).toMatch(/\bT \d+ /)
      expect(c).not.toMatch(/\brm\b|[^2&]>\s*[^&/]/)
    }
    expect(diskLevelCommand('/x', 9)).toContain('T 9 du -x -k -a $DEP .')
    expect(diskBigCommand('/x', 100)).toContain('-size +100M')
  })
  it('常见占用有总时长预算（13 项各 10s 会超过 exec 超时）；/proc 扫描有上限', () => {
    const c = diskCommonCommand()
    expect(c).toContain('left=$(( 20')
    expect(c).toContain('T "$left" du -sxk')
    expect(c).toContain('@@cut $cut')
    expect(diskCommonCommand(10, 5)).toContain('left=$(( 5')
    expect(diskDeletedCommand()).toContain('-gt 20000')
  })
  it('支持范围：本地 / 非 Windows SSH；常见占用与已删除只认 Linux SSH', () => {
    expect(diskSupported('local', 'windows')).toBe(true)
    expect(diskSupported('ssh', 'windows')).toBe(false)
    expect(diskSupported('ssh', 'linux')).toBe(true)
    expect(diskLinuxOnly('ssh', 'linux')).toBe(true)
    expect(diskLinuxOnly('ssh', 'macos')).toBe(false)
    expect(diskLinuxOnly('local', 'linux')).toBe(false)
  })
})

describe('parseDiskLevel', () => {
  const out = [
    '@@df', '/dev/vda1        41152812 37000000   2000000      95% /',
    '@@dirs', 'var', 'home', 'opt',
    '@@du',
    '12\t./a.txt',
    "du: cannot read directory './root': Permission denied",
    '30000000\t./var',
    '500\t./home',
    '7000\t./opt',
    '30008000\t.',
    '@@rc 1',
  ].join('\n')
  it('按大小倒序、分清目录和文件、读出分区与没权限的数量', () => {
    const r = parseDiskLevel(out, '/')
    expect(r.totalKb).toBe(30008000)
    expect(r.truncated).toBe(false)
    expect(r.denied).toBe(1)
    expect(r.entries.map((e) => [e.name, e.dir, e.path])).toEqual([['var', true, '/var'], ['opt', true, '/opt'], ['home', true, '/home'], ['a.txt', false, '/a.txt']])
    expect(r.fs).toMatchObject({ mount: '/', usedPct: 95, availKb: 2000000 })
  })
  it('超时（rc 124、没有合计行）：合计用已统计部分，标截断', () => {
    const r = parseDiskLevel('@@dirs\nbig\n@@du\n100\t./big\n5\t./f\n@@rc 124', '/data')
    expect(r.truncated).toBe(true)
    expect(r.totalKb).toBe(105)
    expect(r.entries[0]).toMatchObject({ path: '/data/big', dir: true })
  })
  it('目录不存在 / 没输出抛错', () => {
    expect(() => parseDiskLevel('@@nodir', '/nope')).toThrow('目录不存在')
    expect(() => parseDiskLevel('', '/')).toThrow('没有输出')
  })
  it('df 行：文件系统名带空格、macOS 风格', () => {
    expect(parseDfLine('map auto_home      0      0      0   100%    /System/Volumes/Data/home')).toMatchObject({ fs: 'map auto_home', mount: '/System/Volumes/Data/home', usedPct: 100 })
    expect(parseDfLine('C:/Program Files/Git 499000000 400000000 99000000 81% /')).toMatchObject({ mount: '/', usedPct: 81 })
    expect(parseDfLine('垃圾')).toBeUndefined()
  })
})

describe('parseDiskBig', () => {
  it('第一行是结束标记，后面按字节倒序；路径拼成绝对路径', () => {
    const r = parseDiskBig('@@big\n99999999999999999999\t@@rc 0\n104857600\t./var/log/a.log\n52428800\t./b.iso\n', '/data')
    expect(r.truncated).toBe(false)
    expect(r.files).toEqual([{ path: '/data/var/log/a.log', bytes: 104857600 }, { path: '/data/b.iso', bytes: 52428800 }])
  })
  it('find 超时标截断', () => {
    expect(parseDiskBig('@@big\n99999999999999999999\t@@rc 124\n', '/').truncated).toBe(true)
  })
})

describe('parseDiskCommon', () => {
  it('认出常见点（含展开后的 ~/.cache）、读不到的不带 kb、journal 摘要、预算用完标截断', () => {
    const r = parseDiskCommon('@@uid 0\n@@items\n/var/log\t2048\n/var/lib/docker\t\n/home/u/.cache\t100\n/var/log/journal\t4096000\n@@cut 1\n@@journal\nArchived and active journals take up 3.9G in the file system.\n')
    expect(r.root).toBe(true)
    expect(r.items.map((i) => i.path)).toEqual(['/var/log/journal', '/var/log', '/home/u/.cache', '/var/lib/docker'])
    expect(r.items.find((i) => i.path === '/var/lib/docker')?.kb).toBeUndefined()
    expect(r.items[0].tip).toContain('journalctl --vacuum-size')
    expect(r.journal).toContain('3.9G')
    expect(r.truncated).toBe(true)
    expect(parseDiskCommon('@@uid 0\n@@items\n@@cut 0\n').truncated).toBeUndefined()
  })
})

describe('已删除仍被占用', () => {
  const lsof = [
    'COMMAND   PID USER   FD   TYPE DEVICE  SIZE/OFF NLINK    NODE NAME',
    'java     1234 app    5w   REG  253,1 2147483648     0  131075 /var/log/app/old.log (deleted)',
    'java     1234 app    6w   REG  253,1 2147483648     0  131075 /var/log/app/old.log (deleted)',
    'nginx     900 root   3u   REG  253,1     1048576     0  13 /tmp/my file.tmp (deleted)',
    'systemd     1 root  12u  unix 0x0000         0t0     0   1 type=STREAM (deleted)',
    'bash     2000 u      1r   REG  253,1        100     1   14 /home/u/kept',
  ]
  it('lsof +L1：只要普通文件，同进程同 inode 去重，路径带空格', () => {
    const r = parseLsofDeleted(lsof)
    expect(r).toEqual([
      { pid: 1234, command: 'java', fd: '5', bytes: 2147483648, path: '/var/log/app/old.log' },
      { pid: 900, command: 'nginx', fd: '3', bytes: 1048576, path: '/tmp/my file.tmp' },
    ])
  })
  it('/proc 回退：跳过 memfd 与 /dev', () => {
    const r = parseProcDeleted(['10\tmysqld\t7\t5000\t/var/lib/mysql/ib_tmp (deleted)', '11\tchrome\t9\t100\t/memfd:shm (deleted)', '12\tx\t1\t1\t/dev/shm/y (deleted)'])
    expect(r).toEqual([{ pid: 10, command: 'mysqld', fd: '7', bytes: 5000, path: '/var/lib/mysql/ib_tmp' }])
  })
  it('parseDiskDeleted：合计、来源、排序', () => {
    const r = parseDiskDeleted(['@@uid 1000', '@@lsof', ...lsof].join('\n'))
    expect(r.source).toBe('lsof')
    expect(r.root).toBe(false)
    expect(r.totalBytes).toBe(2147483648 + 1048576)
    expect(r.items[0].command).toBe('java')
    expect(parseDiskDeleted('@@uid 0\n@@proc\n').items).toEqual([])
    expect(() => parseDiskDeleted('')).toThrow()
  })
})

it('diskQuote：给 AI 的摘要带分区、前几项与「不要直接删除」', () => {
  const level = parseDiskLevel('@@df\n/dev/sda1 100 95 5 95% /\n@@dirs\nvar\n@@du\n90\t./var\n95\t.\n@@rc 0', '/')
  const t = diskQuote({ host: 'web1', level, deleted: { source: 'lsof', root: true, totalBytes: 10, items: [{ pid: 1, command: 'java', bytes: 10, path: '/x.log' }] }, fmt: formatSize })
  expect(t).toContain('主机「web1」')
  expect(t).toContain('已用 95%')
  expect(t).toContain('[目录] /var')
  expect(t).toContain('java(pid 1) /x.log')
  expect(t).toContain('不要直接删除')
})
