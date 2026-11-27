import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { LocalAgents, agentToolDeny, buildAgentMd, parseAgentMd } from './agents.js'

const dirs: string[] = []
const tmp = async (): Promise<string> => {
  const d = await mkdtemp(join(tmpdir(), 'lingshell-agents-'))
  dirs.push(d)
  return d
}
afterEach(async () => {
  const { rm } = await import('node:fs/promises')
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true })
})

const md = (name: string, extra = '', body = '你是测试角色。') => `---\nname: ${name}\ndescription: 测试用 ${name}\n${extra}---\n\n${body}\n`

describe('parseAgentMd', () => {
  it('解析 frontmatter 与正文', () => {
    const r = parseAgentMd(md('shell-reviewer', 'model: deepseek-chat\npermission: read\ntools: [read_file, exec_in_terminal]\n'))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.meta.name).toBe('shell-reviewer')
    expect(r.meta.model).toBe('deepseek-chat')
    expect(r.meta.permission).toBe('read')
    expect(r.meta.tools).toEqual(['read_file', 'exec_in_terminal'])
    expect(r.body).toBe('你是测试角色。')
  })

  it('支持多行数组写法的 tools', () => {
    const r = parseAgentMd(`---\nname: a\ndescription: b\ntools:\n  - read_file\n  - write_file\n---\n正文\n`)
    expect(r.ok && r.meta.tools).toEqual(['read_file', 'write_file'])
  })

  it('缺 name / description 报错', () => {
    expect(parseAgentMd('---\ndescription: x\n---\n').ok).toBe(false)
    expect(parseAgentMd('---\nname: x\n---\n').ok).toBe(false)
  })

  it('name 只允许小写字母数字连字符', () => {
    expect(parseAgentMd(md('Bad Name')).ok).toBe(false)
  })

  it('round-trip：buildAgentMd 能被 parseAgentMd 读回', () => {
    const text = buildAgentMd({ name: 'x', description: 'y', tools: ['read_file'], permission: 'read' }, '正文')
    const r = parseAgentMd(text)
    expect(r.ok && r.meta).toMatchObject({ name: 'x', description: 'y', tools: ['read_file'], permission: 'read' })
  })
})

describe('agentToolDeny', () => {
  it('不传白名单 = 不限制', () => {
    expect(agentToolDeny('exec_in_terminal', undefined)).toBeUndefined()
    expect(agentToolDeny('exec_in_terminal', [])).toBeUndefined()
  })
  it('不再限制工具：传了白名单也照样放行', () => {
    expect(agentToolDeny('exec_in_terminal', ['read_file'])).toBeUndefined()
    expect(agentToolDeny('write_file', ['read_file', 'exec_in_terminal'])).toBeUndefined()
  })
  it('白名单内的放行', () => {
    expect(agentToolDeny('read_file', ['read_file'])).toBeUndefined()
  })
})

describe('LocalAgents 扫描', () => {
  it('用户级默认启用，项目内（含 .claude / .codex）强制启用并忽略历史开关，id 带来源后缀', async () => {
    const root = await tmp()
    const wd = await tmp()
    await mkdir(root, { recursive: true })
    await writeFile(join(root, 'mine.md'), md('mine'), 'utf8')
    // 项目内的 Agent 跟着项目走：.agents.json 里存过的 false 一律忽略
    await writeFile(
      join(root, '.agents.json'),
      JSON.stringify({ 'proj@project': { enabled: false }, 'cc@claude': { enabled: false } }),
      'utf8',
    )
    await mkdir(join(wd, '.lingshell', 'agents'), { recursive: true })
    await writeFile(join(wd, '.lingshell', 'agents', 'proj.md'), md('proj'), 'utf8')
    await mkdir(join(wd, '.claude', 'agents'), { recursive: true })
    await writeFile(join(wd, '.claude', 'agents', 'cc.md'), md('cc'), 'utf8')

    const lib = new LocalAgents(root)
    const list = await lib.list(wd)
    const byName = Object.fromEntries(list.map((a) => [a.id, a]))
    expect(byName['mine']?.enabled).toBe(true)
    expect(byName['proj@project']?.enabled).toBe(true)
    expect(byName['cc@claude']?.enabled).toBe(true)
    expect(byName['proj@project']?.external).toBe(true)
  })

  it('同名时只保留用户级那一条（id 仍是 name），项目内副本不再重复列出', async () => {
    const root = await tmp()
    const wd = await tmp()
    await writeFile(join(root, 'dup.md'), md('dup'), 'utf8')
    await mkdir(join(wd, '.lingshell', 'agents'), { recursive: true })
    await writeFile(join(wd, '.lingshell', 'agents', 'dup.md'), md('dup'), 'utf8')
    const lib = new LocalAgents(root)
    const list = await lib.list(wd)
    expect(list.filter((a) => a.name === 'dup').map((a) => a.id)).toEqual(['dup'])
  })

  it('解析失败的文件也列出来（带 error），不让它静默消失', async () => {
    const root = await tmp()
    const wd = await tmp()
    await mkdir(join(wd, '.lingshell', 'agents'), { recursive: true })
    await writeFile(join(wd, '.lingshell', 'agents', 'broken.md'), 'no frontmatter', 'utf8')
    const lib = new LocalAgents(root)
    const list = await lib.list(wd)
    expect(list.some((a) => a.error)).toBe(true)
  })

  it('保存 / 读取 / 启停 / 删除', async () => {
    const root = await tmp()
    const lib = new LocalAgents(root)
    await lib.save({ name: 'newcomer', description: '新角色', body: '正文', tools: ['read_file'], permission: 'read' })
    const a = await lib.read('newcomer')
    expect(a?.description).toBe('新角色')
    expect(a?.tools).toEqual(['read_file'])
    await lib.setEnabled('newcomer', false)
    expect((await lib.read('newcomer'))?.enabled).toBe(false)
    await lib.remove('newcomer')
    expect(await lib.read('newcomer')).toBeUndefined()
  })

  it('外部来源不能删除（只能停用）', async () => {
    const root = await tmp()
    const lib = new LocalAgents(root)
    await expect(lib.remove('x@claude')).rejects.toThrow()
  })
})
