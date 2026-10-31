import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { localTreeOps, packEntries, unpackEntry, searchNames, type RunCmd, type TreeOps } from './fileOps.js'
import { localRunner } from '../ops/index.js'
import { findBash } from '../core/index.js'

// 生成的服务器命令拿本机 sh 真跑一遍（Windows 用 Git Bash）：验证 tar / find 命令可用、特殊字符名称不被注入。不连任何主机
const sh = process.platform === 'win32' ? findBash() : '/bin/sh'
// Git Bash 下路径要写成 /c/Users/...；TreeOps 仍用本机路径（只用来列目录查重名）
const px = (p: string) => (process.platform === 'win32' ? p.replace(/^([A-Za-z]):/, (_m, d: string) => `/${d.toLowerCase()}`).replace(/\\/g, '/') : p)
const nativeOps = localTreeOps()
const ops: TreeOps = { ...nativeOps, win: false, readdir: (p) => nativeOps.readdir(p.replace(/^\/([a-z])\//, (_m, d: string) => `${d}:/`)) }

describe.skipIf(!sh)('远程文件命令（本机 sh 实跑）', () => {
  const run: RunCmd = (cmd, ms) => localRunner(sh!).exec(cmd, { timeoutMs: ms })
  const evil = `it's $(touch PWNED) -x.txt`

  function tree() {
    const d = mkdtempSync(join(tmpdir(), 'lingshell-remote-'))
    mkdirSync(join(d, 'app', 'logs'), { recursive: true })
    writeFileSync(join(d, 'app', 'logs', 'Access.LOG'), 'log')
    writeFileSync(join(d, 'app', evil), 'evil')
    return d
  }

  it('压缩：特殊字符名称原样打包、不执行注入；重名自动改名；解压不覆盖已有文件', async () => {
    const d = tree(), app = px(join(d, 'app'))
    const r1 = await packEntries(ops, run, [`${app}/${evil}`, `${app}/logs`])
    expect(r1.out).toBe(`${app}/app.tar.gz`)
    expect(existsSync(join(d, 'app', 'app.tar.gz'))).toBe(true)
    expect(existsSync(join(d, 'app', 'PWNED'))).toBe(false)
    expect(readdirSync(d)).not.toContain('PWNED')
    const r2 = await packEntries(ops, run, [`${app}/${evil}`, `${app}/logs`])
    expect(r2.out).toBe(`${app}/app (1).tar.gz`)

    // 删掉原文件后解压回来
    rmSync(join(d, 'app', 'logs'), { recursive: true }); rmSync(join(d, 'app', evil))
    expect((await unpackEntry(run, r1.out)).dir).toBe(app)
    expect(readFileSync(join(d, 'app', evil), 'utf8')).toBe('evil')
    expect(readFileSync(join(d, 'app', 'logs', 'Access.LOG'), 'utf8')).toBe('log')

    // 再解压一次：已有同名文件不覆盖
    writeFileSync(join(d, 'app', evil), 'changed')
    await expect(unpackEntry(run, r1.out)).rejects.toThrow(/没有覆盖/)
    expect(readFileSync(join(d, 'app', evil), 'utf8')).toBe('changed')
  }, 30000)

  it('搜索：不区分大小写、包含匹配、通配、区分目录；查询里的引号不注入', async () => {
    const d = tree(), root = px(d)
    const r = await searchNames(run, root, 'log')
    const rel = r.hits.map((h) => [h.path.slice(root.length), h.isDir]).sort()
    expect(rel).toEqual([['/app/logs', true], ['/app/logs/Access.LOG', false]])
    expect((await searchNames(run, root, '*.log')).hits.map((h) => h.name)).toEqual(['Access.LOG'])
    expect((await searchNames(run, root, `it's $(touch PWNED)`)).hits.map((h) => h.name)).toEqual([evil])
    expect(existsSync(join(d, 'PWNED'))).toBe(false)
    expect((await searchNames(run, root, 'nothing-here')).hits).toEqual([])
    await expect(searchNames(run, root, ' ')).rejects.toThrow(/请输入/)
  }, 30000)
})
