import { describe, it, expect, beforeAll } from 'vitest'
import { mkdirSync, mkdtempSync, writeFileSync, existsSync, symlinkSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { SUDO_NEED_PW } from '@lingshell/shared'
import { sudoRunner, sudoCheck, sudoListDir, sudoTreeOps, sudoAccess, parseSudoList, sudoError, type ExecIn } from './explorerSudo.js'
import type { FileAccess } from './fileOps.js'

describe('sudo 输出识别 / 列表解析', () => {
  it('常见失败转成说明，要密码的带标记', () => {
    expect(sudoError('sudo: a password is required')).toContain(SUDO_NEED_PW)
    expect(sudoError('Sorry, try again.\nsudo: 1 incorrect password attempt')).toContain('不对')
    expect(sudoError('www is not in the sudoers file.  This incident will be reported.')).toBe('当前登录用户没有 sudo 权限')
    expect(sudoError('ok')).toBeUndefined()
  })
  it('find -printf 的输出 → 条目（目录、文件、链接、坏链接、带空格的名字）', () => {
    const out = 'd\t4096\t1700000000.5\t755\troot\troot\t\td\tetc\0f\t12\t1700000001.0\t600\troot\troot\t\tf\tshadow file\0l\t9\t1700000002.0\t777\troot\troot\t/srv/v2\td\tcurrent\0l\t5\t1700000003.0\t777\troot\troot\t/nope\tN\tdead\0'
    expect(parseSudoList('/x', out)).toEqual([
      { name: 'etc', path: '/x/etc', isDir: true, size: 4096, mtime: 1700000000, mode: 0o755, owner: 'root', group: 'root' },
      { name: 'shadow file', path: '/x/shadow file', isDir: false, size: 12, mtime: 1700000001, mode: 0o600, owner: 'root', group: 'root' },
      { name: 'current', path: '/x/current', isDir: true, size: 9, mtime: 1700000002, mode: 0o777, owner: 'root', group: 'root', isLink: true, linkTarget: '/srv/v2' },
      { name: 'dead', path: '/x/dead', isDir: false, size: 5, mtime: 1700000003, mode: 0o777, owner: 'root', group: 'root', isLink: true, linkTarget: '/nope', linkBroken: true },
    ])
  })
})

// 真 shell：Git Bash + 假 sudo（-S 读一行密码，对了才放行；-n 在没验证过之前要密码）
const bash = 'C:\\Program Files\\Git\\bin\\bash.exe'
describe.runIf(process.platform === 'win32' && existsSync(bash))('sudo 模式（Git Bash + 假 sudo 真跑）', () => {
  let d: string, D: string, exec: ExecIn
  beforeAll(() => {
    d = mkdtempSync(join(tmpdir(), 'lingshell-sudo-'))
    D = d.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_m, x: string) => `/${x.toLowerCase()}`)
    const bin = join(d, 'bin'); mkdirSync(bin)
    writeFileSync(join(bin, 'sudo'), [
      '#!/bin/bash',
      'n=0; S=0; v=0',
      'while [ $# -gt 0 ]; do case "$1" in -n) n=1; shift;; -S) S=1; shift;; -p) shift 2;; -v) v=1; shift;; -*) shift;; *) break;; esac; done',
      `stamp=${D}/.stamp`,
      'if [ $S = 1 ]; then IFS= read -r pw; if [ "$pw" != "pw" ]; then echo "Sorry, try again." >&2; exit 1; fi; touch "$stamp"',
      'elif [ ! -f "$stamp" ]; then echo "sudo: a password is required" >&2; exit 1; fi',
      '[ $v = 1 ] && exit 0',
      'exec "$@"', ''].join('\n'))
    mkdirSync(join(d, 'root', 'conf.d'), { recursive: true })
    writeFileSync(join(d, 'root', 'secret.conf'), Buffer.from([0, 1, 2, 255, 10, 65]))
    try { symlinkSync(join(d, 'root', 'conf.d'), join(d, 'root', 'link'), 'junction') } catch { /* 建不了就不测链接 */ }
    exec = (command, ms, stdin) => new Promise((res) => {
      const p = spawn(bash, ['-c', command], { env: { ...process.env, PATH: `${join(d, 'bin')};${process.env.PATH}` } })
      let out = ''
      p.stdout.on('data', (x) => (out += x)); p.stderr.on('data', (x) => (out += x))
      const t = setTimeout(() => { p.kill(); res({ code: null, output: out, stopped: 'timeout' }) }, ms)
      p.on('close', (code) => { clearTimeout(t); res({ code, output: out }) })
      if (stdin !== undefined) p.stdin.end(stdin); else p.stdin.end()
    })
  })
  it('没验证前 -n 要密码；密码错报错；对了以后带密码跑', async () => {
    let pw: string | undefined
    const run = sudoRunner(exec, () => pw, () => (pw = undefined))
    await expect(run('echo hi', 10_000)).rejects.toThrow(SUDO_NEED_PW)
    await expect(sudoCheck(exec, 'bad')).rejects.toThrow('不对')
    await sudoCheck(exec, 'pw')
    pw = 'pw'
    expect((await run('echo hi | tr a-z A-Z', 10_000)).output.trim()).toBe('HI')
    pw = 'wrong'
    await expect(run('true', 10_000)).rejects.toThrow('不对')
    expect(pw).toBeUndefined()   // 错的密码会被忘掉
  }, 30_000)
  it('列目录 / 新建 / 改名不覆盖 / 删除 / 读二进制', async () => {
    const run = sudoRunner(exec, () => 'pw', () => {})
    const ls = await sudoListDir(run, `${D}/root`)
    expect(ls.map((e) => e.name).sort()).toEqual(expect.arrayContaining(['conf.d', 'secret.conf']))
    expect(ls.find((e) => e.name === 'conf.d')).toMatchObject({ isDir: true })
    await expect(sudoListDir(run, `${D}/nope`)).rejects.toThrow(/No such file/)
    const ops = sudoTreeOps(run)
    await ops.mkdir(`${D}/root/new dir`)
    await ops.createFile(`${D}/root/new dir/a.txt`)
    await expect(ops.createFile(`${D}/root/new dir/a.txt`)).rejects.toThrow()
    expect(await ops.lstat(`${D}/root/new dir`)).toMatchObject({ isDir: true })
    expect(await ops.lstat(`${D}/root/missing`)).toBeUndefined()
    writeFileSync(join(d, 'root', 'b.txt'), 'b')
    await expect(ops.rename(`${D}/root/b.txt`, `${D}/root/new dir/a.txt`)).rejects.toThrow('已存在')
    await ops.rename(`${D}/root/b.txt`, `${D}/root/c.txt`)
    expect(existsSync(join(d, 'root', 'c.txt'))).toBe(true)
    await ops.unlink(`${D}/root/c.txt`)
    expect(existsSync(join(d, 'root', 'c.txt'))).toBe(false)
    const plain = { resolve: async (p: string) => p, backupDir: async () => '/home/u/.lingshell/backups' } as unknown as FileAccess
    const acc = sudoAccess(run, plain, {} as never)
    expect(await acc.read(`${D}/root/secret.conf`)).toEqual(readFileSync(join(d, 'root', 'secret.conf')))
    expect(await acc.read(`${D}/root/none`)).toBeUndefined()
    await expect(acc.read(`${D}/root/secret.conf`, 3)).rejects.toThrow('文件过大')
  }, 60_000)
})
