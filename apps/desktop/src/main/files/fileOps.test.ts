import { describe, it, expect } from 'vitest'
import { mkdtempSync, readFileSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { localAccess, writeWithBackup, backupName, readText, saveText, type FileAccess } from './fileOps.js'

// 本地 fs 实现，备份目录换成临时目录
function tmpAccess(): { fa: FileAccess; dir: string; bak: string } {
  const dir = mkdtempSync(join(tmpdir(), 'lingshell-fileops-'))
  const bak = join(dir, 'backups')
  return { fa: { ...localAccess(), backupDir: async () => bak }, dir, bak }
}

describe('writeWithBackup', () => {
  it('覆盖前备份原文件，还原（用备份再写一次）后内容复原，且还原本身也有备份', async () => {
    const { fa, dir, bak } = tmpAccess()
    const f = join(dir, 'app.conf')
    await fa.write(f, Buffer.from('old\n'))
    const r = await writeWithBackup(fa, f, Buffer.from('new\n'), new Date(2026, 9, 9, 18, 5, 12, 7))
    expect(readFileSync(f, 'utf8')).toBe('new\n')
    expect(r.backupPath).toBe(`${bak}/${backupName(f, new Date(2026, 9, 9, 18, 5, 12, 7))}`)
    expect(readFileSync(r.backupPath!, 'utf8')).toBe('old\n')
    // 还原 = 把备份写回去（ipc audit:restore 的做法）
    const back = await writeWithBackup(fa, f, (await fa.read(r.backupPath!))!)
    expect(readFileSync(f, 'utf8')).toBe('old\n')
    expect(readFileSync(back.backupPath!, 'utf8')).toBe('new\n')
    expect(readdirSync(bak)).toHaveLength(2)
  })

  it('新建文件不产生备份；读不存在的文件返回 undefined', async () => {
    const { fa, dir, bak } = tmpAccess()
    const f = join(dir, 'fresh.txt')
    expect(await fa.read(f)).toBeUndefined()
    const r = await writeWithBackup(fa, f, Buffer.from('x'))
    expect(r.backupPath).toBeUndefined()
    expect(existsSync(bak)).toBe(false)
  })

  it('备份名：时间在前、路径拼平', () => {
    expect(backupName('/etc/nginx/nginx.conf', new Date(2026, 0, 2, 3, 4, 5, 6))).toBe('20260102-030405-006_etc_nginx_nginx.conf')
    expect(backupName('C:\\a\\b.txt', new Date(2026, 0, 2, 3, 4, 5, 6))).toBe('20260102-030405-006_C_a_b.txt')
  })
})

describe('手动编辑 readText / saveText', () => {
  it('读文本；保存时备份原文件', async () => {
    const { fa, dir } = tmpAccess()
    const f = join(dir, 'a.conf')
    await fa.write(f, Buffer.from('x=1\r\n'))
    const base = await readText(fa, f)
    expect(base).toBe('x=1\r\n')
    const r = await saveText(fa, f, base, 'x=2\r\n')
    expect(readFileSync(f, 'utf8')).toBe('x=2\r\n')
    expect(readFileSync(r.backupPath!, 'utf8')).toBe('x=1\r\n')
  })

  it('打开后被别人改过：拒绝保存，原内容不动', async () => {
    const { fa, dir, bak } = tmpAccess()
    const f = join(dir, 'b.conf')
    await fa.write(f, Buffer.from('v1'))
    const base = await readText(fa, f)
    await fa.write(f, Buffer.from('v2'))
    await expect(saveText(fa, f, base, 'mine')).rejects.toThrow(/重新打开/)
    expect(readFileSync(f, 'utf8')).toBe('v2')
    expect(existsSync(bak)).toBe(false)
  })

  it('拒绝二进制、非 UTF-8、不存在的文件', async () => {
    const { fa, dir } = tmpAccess()
    await fa.write(join(dir, 'bin'), Buffer.from([1, 0, 2]))
    await fa.write(join(dir, 'gbk'), Buffer.from([0xc4, 0xe3, 0xba, 0xc3]))
    await expect(readText(fa, join(dir, 'bin'))).rejects.toThrow(/二进制/)
    await expect(readText(fa, join(dir, 'gbk'))).rejects.toThrow(/UTF-8/)
    await expect(readText(fa, join(dir, 'none'))).rejects.toThrow(/不存在/)
  })

  it('UTF-8 BOM 原样往返', async () => {
    const { fa, dir } = tmpAccess()
    const f = join(dir, 'bom')
    await fa.write(f, Buffer.from([0xef, 0xbb, 0xbf, 0x61]))
    expect((await readText(fa, f)).charCodeAt(0)).toBe(0xfeff)
  })

  it('GBK 主机：按 GBK 解码查看，保存按 GBK 写回；非 GBK 文本拒绝', async () => {
    const { fa: base, dir } = tmpAccess()
    const fa = { ...base, encoding: 'gbk' }
    const f = join(dir, 'g.conf')
    await fa.write(f, Buffer.from([0x23, 0xc4, 0xe3, 0xba, 0xc3, 0x0a]))   // "#你好\n"
    const text = await readText(fa, f)
    expect(text).toBe('#你好\n')
    await saveText(fa, f, text, '#中文\n')
    expect([...readFileSync(f)]).toEqual([0x23, 0xd6, 0xd0, 0xce, 0xc4, 0x0a])
    await fa.write(f, Buffer.from([0x61, 0x81, 0x20]))   // 0x81 后跟空格在 GBK 里非法，解不回原样
    await expect(readText(fa, f)).rejects.toThrow(/GBK/)
  })
})

describe('localAccess 备份目录', () => {
  it('跟随数据根目录（LINGSHELL_DATA_DIR），统一正斜杠', async () => {
    expect(await localAccess(String.raw`C:\tmp\data`).backupDir()).toBe('C:/tmp/data/backups')
  })
})
