import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, truncateSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { crc32 } from 'node:zlib'
import { LocalSkills, unsafeEntry } from './skills.js'

const md = (name: string, desc = `${name} 的描述`, extra = '') => `---\nname: ${name}\ndescription: ${desc}\n${extra}---\n\n${name} 的正文`

// 手搓一个 stored（不压缩）zip：可以放进任意条目名（含 ../ 越界路径），不依赖外部工具
function zip(entries: { name: string; data: string }[]): Buffer {
  const parts: Buffer[] = [], central: Buffer[] = []
  let off = 0
  for (const e of entries) {
    const name = Buffer.from(e.name), data = Buffer.from(e.data), crc = crc32(data)
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6)
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(name.length, 26)
    const cen = Buffer.alloc(46); cen.writeUInt32LE(0x02014b50, 0); cen.writeUInt16LE(20, 4); cen.writeUInt16LE(20, 6); cen.writeUInt16LE(0x0800, 8)
    cen.writeUInt32LE(crc, 16); cen.writeUInt32LE(data.length, 20); cen.writeUInt32LE(data.length, 24); cen.writeUInt16LE(name.length, 28); cen.writeUInt32LE(off, 42)
    parts.push(local, name, data); central.push(cen, name)
    off += 30 + name.length + data.length
  }
  const cd = Buffer.concat(central)
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(off, 16)
  return Buffer.concat([...parts, cd, end])
}

let base = '', root = '', lib: LocalSkills
beforeEach(() => { base = mkdtempSync(join(tmpdir(), 'skills-t-')); root = join(base, 'skills'); lib = new LocalSkills(root) })
afterEach(() => { lib.close(); rmSync(base, { recursive: true, force: true }) })

const put = (dir: string, files: Record<string, string>) => {
  for (const [f, c] of Object.entries(files)) { mkdirSync(join(dir, f, '..'), { recursive: true }); writeFileSync(join(dir, f), c) }
}

describe('本地 provider', () => {
  it('列出合法 skill + 资源清单；坏文件 / 没 SKILL.md 的带原因、不注册；重名的后一个不启用', async () => {
    put(join(root, 'good'), { 'SKILL.md': md('good'), 'scripts/run.sh': 'echo', 'references/a.md': 'x' })
    put(join(root, 'bad'), { 'SKILL.md': '没有 frontmatter' })
    put(join(root, 'empty'), { 'readme.txt': 'x' })
    put(join(root, 'zdup'), { 'SKILL.md': md('good') })
    const all = await lib.list()
    expect(all.find((s) => s.dir === 'good')).toMatchObject({ name: 'good', enabled: true, modelInvocable: true, userInvocable: true, files: ['references/a.md', 'scripts/run.sh'] })
    expect(all.find((s) => s.dir === 'bad')?.error).toContain('frontmatter')
    expect(all.find((s) => s.dir === 'empty')?.error).toContain('SKILL.md')
    expect(all.find((s) => s.dir === 'zdup')).toMatchObject({ enabled: false, error: expect.stringContaining('重名') })
    const p = lib.provider()
    const cands = await p.list()
    expect(cands.map((c) => c.name)).toEqual(['good'])
    expect(cands[0]).toMatchObject({ provider: 'lingshell', rank: 300, resourceBase: { kind: 'directory', path: join(root, 'good') } })
    const def = await p.get(cands[0])
    expect(def).toMatchObject({ name: 'good', content: 'good 的正文' })
  })

  it('frontmatter 的 invocation 开关生效；启停 / AI 可自动调用记在状态文件，不改 SKILL.md', async () => {
    put(join(root, 'manual-only'), { 'SKILL.md': md('manual-only', 'd', 'disable-model-invocation: true\n') })
    put(join(root, 'ai-only'), { 'SKILL.md': md('ai-only', 'd', 'user-invocable: false\n') })
    expect((await lib.list()).map((s) => [s.name, s.modelInvocable, s.userInvocable])).toEqual([['ai-only', true, false], ['manual-only', false, true]])
    let n = 0
    lib.onChange(() => n++)
    const before = readFileSync(join(root, 'ai-only', 'SKILL.md'), 'utf8')
    await lib.setFlags('ai-only', { enabled: false })
    await lib.setFlags('manual-only', { modelInvocable: true })
    expect(n).toBe(2)
    expect(readFileSync(join(root, 'ai-only', 'SKILL.md'), 'utf8')).toBe(before)
    expect((await lib.provider().list()).map((c) => [c.name, c.invocation.modelInvocable])).toEqual([['manual-only', true]])
  })

  it('新建 / 修改（含改名，保留其它 frontmatter 键）/ 删除', async () => {
    await lib.save({ name: 'my-skill', description: '描述', body: '做这件事' })
    expect((await lib.list())[0]).toMatchObject({ name: 'my-skill', origin: 'created' })
    await expect(lib.save({ name: 'Bad Name', description: 'd', body: '' })).rejects.toThrow(/小写字母/)
    await expect(lib.save({ name: 'my-skill', description: 'd', body: '' })).rejects.toThrow(/同名/)
    writeFileSync(join(root, 'my-skill', 'SKILL.md'), md('my-skill', 'd', 'license: MIT\n'))
    await lib.save({ name: 'renamed', description: '新描述', body: '新正文' }, 'my-skill')
    expect(existsSync(join(root, 'my-skill'))).toBe(false)
    expect(readFileSync(join(root, 'renamed', 'SKILL.md'), 'utf8')).toContain('license: MIT')
    expect(await lib.read('renamed')).toEqual({ name: 'renamed', description: '新描述', body: '新正文' })
    expect((await lib.list())[0].origin).toBe('created')   // 状态跟着改名走
    await lib.remove('renamed')
    expect(await lib.list()).toEqual([])
  })
})

describe('导入', () => {
  it('文件夹：预览 SKILL.md 与文件清单，确认后落到 skills/<name>/', async () => {
    const src = join(base, 'src-skill')
    put(src, { 'SKILL.md': md('from-dir'), 'assets/t.txt': 't', '.git/HEAD': 'x' })
    const pv = await lib.inspectImport(src)
    expect(pv).toMatchObject({ name: 'from-dir', conflict: false, files: ['SKILL.md', 'assets/t.txt'] })
    expect(pv.skillMd).toContain('from-dir 的正文')
    expect(await lib.commitImport(pv.token)).toBe('from-dir')
    expect(existsSync(join(root, 'from-dir', 'assets', 't.txt'))).toBe(true)
    expect(existsSync(join(root, 'from-dir', '.git'))).toBe(false)
    expect((await lib.list())[0]).toMatchObject({ name: 'from-dir', origin: 'imported', enabled: true })
  })

  it('zip / .skill：包外面包了一层目录也认', async () => {
    const f = join(base, 'pkg.skill')
    writeFileSync(f, zip([{ name: 'wrap/SKILL.md', data: md('zipped') }, { name: 'wrap/scripts/a.sh', data: 'echo hi' }]))
    const pv = await lib.inspectImport(f)
    expect(pv).toMatchObject({ name: 'zipped', files: ['SKILL.md', 'scripts/a.sh'] })
    await lib.commitImport(pv.token)
    expect(readFileSync(join(root, 'zipped', 'scripts', 'a.sh'), 'utf8')).toBe('echo hi')
  })

  it('路径穿越的 zip 直接拒绝，且什么都没写出去', async () => {
    const f = join(base, 'evil.zip')
    writeFileSync(f, zip([{ name: 'SKILL.md', data: md('evil') }, { name: '../escaped.txt', data: 'x' }]))
    await expect(lib.inspectImport(f)).rejects.toThrow(/越界/)
    expect(existsSync(join(base, 'escaped.txt'))).toBe(false)
    expect(unsafeEntry('C:\\x.txt')).toBe(true)
    expect(unsafeEntry('/etc/passwd')).toBe(true)
    expect(unsafeEntry('a/b/../../c')).toBe(true)
    expect(unsafeEntry('a/..b/c')).toBe(false)
  })

  it('压缩包本身超过 50MB 直接拒绝（不先解压落盘）', async () => {
    const f = join(base, 'huge.zip')
    writeFileSync(f, '')
    truncateSync(f, 51 * 1024 * 1024)
    await expect(lib.inspectImport(f)).rejects.toThrow(/超过 50MB/)
  })

  it('没有 SKILL.md / frontmatter 不合法 / 不支持的文件类型 → 报错', async () => {
    const f = join(base, 'none.zip')
    writeFileSync(f, zip([{ name: 'readme.md', data: 'x' }]))
    await expect(lib.inspectImport(f)).rejects.toThrow(/没有 SKILL.md/)
    const g = join(base, 'badfm.zip')
    writeFileSync(g, zip([{ name: 'SKILL.md', data: '---\nname: Bad\ndescription: d\n---\n' }]))
    await expect(lib.inspectImport(g)).rejects.toThrow(/不合法/)
    writeFileSync(join(base, 'x.rar'), 'x')
    await expect(lib.inspectImport(join(base, 'x.rar'))).rejects.toThrow(/只支持/)
  })

  it('重名：提示冲突 + 建议新名；不选覆盖就拒绝；覆盖 / 改名导入都行', async () => {
    put(join(root, 'dup'), { 'SKILL.md': md('dup', '旧的') })
    const src = join(base, 'dup-src')
    put(src, { 'SKILL.md': md('dup', '新的') })
    const pv = await lib.inspectImport(src)
    expect(pv).toMatchObject({ conflict: true, suggestedName: 'dup-2' })
    await expect(lib.commitImport(pv.token)).rejects.toThrow(/同名/)
    expect(await lib.commitImport(pv.token, { rename: 'dup-2' })).toBe('dup-2')
    expect(await lib.read('dup-2')).toMatchObject({ name: 'dup-2', description: '新的' })
    const pv2 = await lib.inspectImport(src)
    await lib.commitImport(pv2.token, { overwrite: true })
    expect(await lib.read('dup')).toMatchObject({ description: '新的' })
  })
})
