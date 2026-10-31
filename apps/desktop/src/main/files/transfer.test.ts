import { describe, it, expect } from 'vitest'
import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildDecryptCommand, overallPercent, opensslCompatibleEncrypt, toNativePath, TransferService } from './transfer.js'

// 系统是否有 openssl（无则跳过往返测试，不算失败）
function opensslAvailable(): Promise<boolean> {
  return new Promise((res) => { const p = spawn('openssl', ['version']); p.on('error', () => res(false)); p.on('close', (c) => res(c === 0)) })
}
// 用系统 openssl 解密 opensslCompatibleEncrypt 的输出，返回明文
function opensslDecrypt(enc: Buffer, password: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const p = spawn('openssl', ['enc', '-d', '-aes-256-cbc', '-pbkdf2', '-pass', `pass:${password}`])
    const out: Buffer[] = []; const err: Buffer[] = []
    p.stdout.on('data', (d) => out.push(d)); p.stderr.on('data', (d) => err.push(d))
    p.on('close', (code) => code === 0 ? resolve(Buffer.concat(out)) : reject(new Error(Buffer.concat(err).toString())))
    p.stdin.write(enc); p.stdin.end()
  })
}

describe('transfer 纯逻辑', () => {
  it('解密命令行首加空格 + HISTCONTROL=ignorespace（抑制 history）', () => {
    const cmd = buildDecryptCommand('/tmp/x.enc', '/target/dir')
    expect(cmd.startsWith(' ')).toBe(true)                  // 行首空格
    expect(cmd).toContain('HISTCONTROL=ignorespace')
    expect(cmd).toContain('set -eo pipefail')               // 管道任一环节失败即整条失败(不被末尾 rm 掩盖)
    expect(cmd).toContain('openssl enc -d -aes-256-cbc -pbkdf2')
    expect(cmd).toContain("mkdir -p '/target/dir'")         // 目标目录不存在则先建
    expect(cmd).toContain("tar xzf - -C '/target/dir' && rm -f '/tmp/x.enc'")   // 解压成功才删临时包(&& 不掩盖失败)
  })
  it('口令不进命令串（走 stdin），路径含单引号被安全包裹', () => {
    const cmd = buildDecryptCommand("/tmp/a'b", '/d')
    expect(cmd).toContain('-pass stdin')
    expect(cmd).not.toContain('pass:')
    expect(cmd).toContain("-in '/tmp/a'\\''b'")             // ' → '\'' ，不破坏引号闭合
  })
  it('overallPercent：三段各占 1/3（0-33-66-100）', () => {
    expect(overallPercent('pack', 0)).toBe(0)
    expect(overallPercent('pack', 100)).toBe(33)          // 打包完 → 段1满
    expect(overallPercent('transfer', 0)).toBe(33)
    expect(overallPercent('transfer', 50)).toBe(50)       // 33 + 50%*33 ≈ 49.5 → round 50
    expect(overallPercent('transfer', 100)).toBe(66)
    expect(overallPercent('extract', 100)).toBe(100)
    expect(overallPercent('done', 100)).toBe(100)
  })
})

// 上传失败的头号根因：模型给 Git Bash 风格路径 → System32 的 bsdtar chdir 失败 → 空包 →
// 加密后 32 字节 → 远端 gzip: unexpected end of file。本地必须先炸，且路径要先归一化。
describe('本地打包不能静默失败', () => {
  const win = process.platform === 'win32'
  const svc = new TransferService(() => {})
  const pack = (dir: string, name: string, out: string) =>
    (svc as unknown as { packEncrypt(d: string, o: string, p: string, e: boolean): Promise<void> })
      .packEncrypt(join(dir, name), out, 'pw', false)

  it.runIf(win)('toNativePath：MSYS 路径转原生，其余原样', () => {
    expect(toNativePath('/d/test-projects/x.tar.gz')).toBe('D:\\test-projects\\x.tar.gz')
    expect(toNativePath('/c/')).toBe('C:\\')
    expect(toNativePath('D:\\already\\native')).toBe('D:\\already\\native')
    expect(toNativePath('/usr/local/bin')).toBe('/usr/local/bin')   // 不是单字母盘符，别动
  })

  it('tar 失败时抛异常，而不是产出 32 字节的"空加密包"', async () => {
    const out = join(mkdtempSync(join(tmpdir(), 'tf-')), 'pkg')
    await expect(pack(join(tmpdir(), 'no-such-dir-9f3a'), 'nope.txt', out)).rejects.toThrow(/tar exit/)
  }, 20_000)   // 真起 tar 子进程：全量并行跑测试时负载高会超过默认 5s

  it('取消打包：杀掉 tar，抛异常', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tf-'))
    writeFileSync(join(dir, 'a.txt'), 'x')
    const ac = new AbortController()
    ac.abort()
    const p = (svc as unknown as { packEncrypt(d: string, o: string, p: string, e: boolean, s: AbortSignal): Promise<void> })
      .packEncrypt(join(dir, 'a.txt'), join(dir, 'pkg'), 'pw', false, ac.signal)
    await expect(p).rejects.toThrow()
  }, 20_000)

  it('正常文件能打出非空包（确认上面的失败不是误伤）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tf-'))
    writeFileSync(join(dir, 'a.txt'), 'hello'.repeat(100))
    const out = join(dir, 'pkg')
    await pack(dir, 'a.txt', out)
    expect(statSync(out).size).toBeGreaterThan(32)
  }, 20_000)
})

// 关键安全路径：Node crypto 加密（openssl 缺失时的回退）产出的密文，必须能被远端 openssl enc -d 解密。
describe('Node crypto 加密 ↔ openssl 解密 往返', () => {
  it('opensslCompatibleEncrypt 的输出可被 openssl 原样解密（有 openssl 时）', async () => {
    if (!(await opensslAvailable())) return   // 无 openssl 环境跳过（不算失败）
    const plaintext = Buffer.from('hello 加密上传 🚀 the quick brown fox'.repeat(50), 'utf8')
    // 用生产同款密码：randomBytes(24).toString('base64')（纯 ASCII）。
    // 不用非 ASCII 密码——本地 MSYS openssl 对命令行 UTF-8 参数会做编码转换，导致收到的密码字节与 Node 不一致（远端 Linux openssl 无此问题，生产密码本就是 base64）。
    const password = Buffer.from('unit-test-fixed-24bytes!!').toString('base64')
    const enc = opensslCompatibleEncrypt(plaintext, password)
    expect(enc.subarray(0, 8).toString('ascii')).toBe('Salted__')   // openssl 魔术头
    const decrypted = await opensslDecrypt(enc, password)
    expect(decrypted.equals(plaintext)).toBe(true)                  // 往返一致
  })
})
