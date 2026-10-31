import { describe, it, expect, vi, afterAll } from 'vitest'
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TerminalInfo } from '@lingshell/shared'

vi.mock('electron', () => ({ dialog: {}, shell: { openPath: async () => '' } }))
const { findLocalFile, parseRemoteLocate, registerFileLinks, remoteLocateCommand, resolveLocal, writeSshConfig } = await import('./fileLinksIpc.js')
const { gotoLaunch } = await import('./externalEdit.js')
const { findBash } = await import('../core/diagnostics.js')
const { localRunner } = await import('../ops/batchExec.js')

const root = mkdtempSync(join(tmpdir(), 'ga-links-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))
mkdirSync(join(root, 'src', 'main', 'java', 'com'), { recursive: true })
mkdirSync(join(root, 'node_modules', 'x'), { recursive: true })
writeFileSync(join(root, 'src', 'main', 'java', 'com', 'Main.java'), 'class Main {}')
writeFileSync(join(root, 'node_modules', 'x', 'Main.java'), '')
writeFileSync(join(root, 'src', 'a.ts'), 'x')

describe('本地路径解析', () => {
  it('相对路径按 cwd；找不到按文件名在 cwd 下找（跳过 node_modules）', () => {
    expect(resolveLocal('src/a.ts', root)).toBe(join(root, 'src', 'a.ts'))
    expect(resolveLocal('Main.java', root)).toBe(join(root, 'src', 'main', 'java', 'com', 'Main.java'))
    expect(resolveLocal('nope.ts', root)).toBeUndefined()
    expect(findLocalFile(root, 'com/Main.java')).toBe(join(root, 'src', 'main', 'java', 'com', 'Main.java'))
  })
  it.skipIf(process.platform !== 'win32')('Git Bash 的 /c/x 路径', () => {
    const msys = '/' + root[0].toLowerCase() + root.slice(2).replace(/\\/g, '/') + '/src/a.ts'
    expect(resolveLocal(msys, undefined)).toBe(join(root, 'src', 'a.ts'))
  })
})

describe('远程定位结果', () => {
  it('根目录下拼接的 // 去掉一个；路径中间真实的 // 原样保留', () => {
    expect(parseRemoteLocate('@@ok //x.ts', 'x.ts')).toBe('/x.ts')
    expect(parseRemoteLocate('@@ok /a//b.ts', 'b.ts')).toBe('/a//b.ts')
    expect(parseRemoteLocate('@@pwd /\n@@hit ./x.ts', 'x.ts')).toBe('/x.ts')
  })
})

describe('ssh config 写入', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ga-sshcfg-'))
  afterAll(() => rmSync(dir, { recursive: true, force: true }))
  it('替换内容、不留临时文件；新文件 0600、原文件权限不变', () => {
    const f = join(dir, 'config')
    writeSshConfig(f, 'Host a\n')
    expect(readFileSync(f, 'utf8')).toBe('Host a\n')
    expect(readdirSync(dir)).toEqual(['config'])
    if (process.platform !== 'win32') {
      expect(statSync(f).mode & 0o777).toBe(0o600)
      chmodSync(f, 0o640)
      writeSshConfig(f, 'Host b\n')
      expect(readFileSync(f, 'utf8')).toBe('Host b\n')
      expect(statSync(f).mode & 0o777).toBe(0o640)
    }
  })
  it.skipIf(process.platform === 'win32')('符号链接：写真实文件，链接本身不动', () => {
    const real = join(dir, 'real_config'), link = join(dir, 'link_config')
    writeFileSync(real, 'old')
    symlinkSync(real, link)
    writeSshConfig(link, 'new')
    expect(lstatSync(link).isSymbolicLink()).toBe(true)
    expect(readFileSync(real, 'utf8')).toBe('new')
  })
})

describe('编辑器跳行启动方式', () => {
  const yes = () => true, no = () => false
  it('VS Code（命令名）经 shell：code -g "file:line:col"', () => {
    expect(gotoLaunch('code', undefined, 'C:\\p\\a.ts', { line: 42, col: 7 }, no)).toEqual({ kind: 'shell', line: 'code -g "C:\\p\\a.ts:42:7"' })
  })
  it('编辑器留空：试 code -g，失败回退系统默认（fallback）', () => {
    expect(gotoLaunch('', undefined, '/a.py', { line: 3 }, no)).toEqual({ kind: 'shell', line: 'code -g "/a.py:3:1"', fallback: true })
  })
  it('exe 路径直接起进程；JetBrains / Notepad++ 预设；自填模板优先', () => {
    expect(gotoLaunch('C:\\JB\\idea64.exe', undefined, 'C:\\a b\\x.kt', { line: 5 }, yes)).toEqual({ kind: 'exec', cmd: 'C:\\JB\\idea64.exe', args: ['--line', '5', 'C:\\a b\\x.kt'] })
    expect(gotoLaunch('C:\\npp\\notepad++.exe', undefined, 'a.c', { line: 2, col: 4 }, yes)).toEqual({ kind: 'exec', cmd: 'C:\\npp\\notepad++.exe', args: ['-n2', '-c4', 'a.c'] })
    expect(gotoLaunch('myed', '+{line} {file}', 'a.c', { line: 9 }, no)).toEqual({ kind: 'shell', line: 'myed +9 a.c' })
  })
  it('认不出的编辑器只打开不跳行；经 shell 时路径有元字符拒绝', () => {
    expect(gotoLaunch('notepad', undefined, 'a.c', { line: 9 }, no)).toEqual({ kind: 'shell', line: 'notepad "a.c"' })
    expect(() => gotoLaunch('code', undefined, 'a&calc.ts', { line: 1 }, no)).toThrow('特殊字符')
  })
})

const bash = findBash()
describe.skipIf(process.platform === 'win32' && !bash)('远程定位命令（用本机 bash 当远端执行）', () => {
  const run = async (p: string, cwd?: string) => (await localRunner(bash ?? undefined).exec(remoteLocateCommand(p, cwd), { timeoutMs: 20_000 })).output
  const posix = (p: string) => (process.platform === 'win32' ? '/' + p[0].toLowerCase() + p.slice(2).replace(/\\/g, '/') : p)
  it('存在：返回绝对路径；不在：按名字找（结尾吻合优先）；都没有：undefined', async () => {
    const cwd = posix(root)
    expect(parseRemoteLocate(await run('src/a.ts', cwd), 'src/a.ts')).toBe(`${cwd}/src/a.ts`)
    expect(parseRemoteLocate(await run('Main.java', cwd), 'Main.java')).toBe(`${cwd}/src/main/java/com/Main.java`)
    expect(parseRemoteLocate(await run('zzz.go', cwd), 'zzz.go')).toBeUndefined()
  }, 30_000)
})

describe('fileLinks:open（本地终端，编辑器换成记录参数的 node 脚本）', () => {
  it('解析路径后带行列启动编辑器', async () => {
    const out = join(root, 'args.txt')
    const handlers = new Map<string, (...a: unknown[]) => unknown>()
    registerFileLinks({
      handle: (ch, fn) => handlers.set(ch, fn),
      terminal: (id) => (id === 't1' ? { id, type: 'local', title: 'l', status: 'running' } as TerminalInfo : undefined),
      editor: () => process.execPath,
      gotoArgs: () => `-e "require('fs').writeFileSync(process.argv[1],process.argv.slice(2).join('|'))" ${out.replace(/\\/g, '/')} "{file}" {line} {col}`,
      externalOpen: async () => {}, execRead: async () => '', hostOf: () => undefined, hosts: () => [],
      sshTarget: () => ({ host: '', port: 22, username: '' }), sshConfigPath: () => join(root, 'ssh_config'),
    })
    const r = await handlers.get('fileLinks:open')!(null, 't1', { path: 'Main.java', line: 88, cwd: root }) as { path: string }
    expect(r.path).toBe(join(root, 'src', 'main', 'java', 'com', 'Main.java'))
    for (let i = 0; i < 50 && !existsSync(out); i++) await new Promise((res) => setTimeout(res, 100))
    expect(readFileSync(out, 'utf8')).toBe(`${r.path}|88|1`)
    await expect(handlers.get('fileLinks:open')!(null, 't1', { path: 'none.ts', line: 1, cwd: root })).rejects.toThrow('找不到文件')
    await expect(handlers.get('fileLinks:open')!(null, 'tx', { path: 'a', line: 1 })).rejects.toThrow('terminal_not_found')
  }, 20_000)
})

describe.skipIf(process.platform !== 'win32')('VS Code Remote：远端 Server 还没跑时，等它起来后补发一次打开文件', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vsc-'))
  afterAll(() => rmSync(dir, { recursive: true, force: true }))
  writeFileSync(join(dir, 'code.cmd'), '@echo %* >> "%~dp0code.log"\r\n')
  const log = () => (existsSync(join(dir, 'code.log')) ? readFileSync(join(dir, 'code.log'), 'utf8').trim().split(/\r?\n/) : [])
  const setup = (states: string[]) => {
    const handlers = new Map<string, (...a: unknown[]) => unknown>()
    let k = 0
    registerFileLinks({
      handle: (ch, fn) => handlers.set(ch, fn),
      terminal: (id) => ({ id, type: 'ssh', title: 's', status: 'running' } as TerminalInfo),
      editor: () => join(dir, 'code.cmd'), gotoArgs: () => '',
      externalOpen: async () => {}, execRead: async () => states[Math.min(k++, states.length - 1)],
      hostOf: () => ({ id: 'h1', label: 'pw', host: '10.0.0.9', port: 22, username: 'root', authType: 'password' } as never), hosts: () => [],
      sshTarget: () => ({ host: '', port: 22, username: '' }), sshConfigPath: () => join(dir, 'ssh_config'),
    })
    return handlers
  }
  it('第一次（Server 没在跑）：先发一次，Server 起来后再补发一次', async () => {
    const h = setup(['VSC_DOWN', 'VSC_DOWN', 'VSC_UP'])
    await h.get('fileLinks:vscodeOpen')!(null, 't', '/etc/ssh/sshd_config', { line: 40 })
    expect(log()).toHaveLength(1)
    for (let i = 0; i < 60 && log().length < 2; i++) await new Promise((r) => setTimeout(r, 500))
    expect(log()).toHaveLength(2)
    expect(log()[1]).toMatch(/"--remote" "ssh-remote\+lingshell-pw-[0-9a-f]+" "-g" "\/etc\/ssh\/sshd_config:40:1"/)
    expect(readFileSync(join(dir, 'ssh_config'), 'utf8')).toContain('HostName 10.0.0.9')
  }, 40_000)
  it('Server 已经在跑：只发一次，不补发', async () => {
    rmSync(join(dir, 'code.log'), { force: true })
    const h = setup(['VSC_UP'])
    await h.get('fileLinks:vscodeOpen')!(null, 't', '/etc/hosts', { line: 3 })
    await new Promise((r) => setTimeout(r, 10_000))
    expect(log()).toHaveLength(1)
  }, 20_000)
})
