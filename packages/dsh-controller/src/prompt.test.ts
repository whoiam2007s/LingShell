import { describe, it, expect, afterEach } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt, { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import { setLocale } from '@lingshell/shared'
import { installPromptSection, buildPromptSection, installTerminalsSection, buildTerminalsSection, installWorkDirSection, installKnowledgeSection, installFleetSection, buildFleetSection, installLanguageSection, buildLanguageSection } from './prompt.js'

describe('系统提示词段', () => {
  it('经真实 dsh SystemPrompt 组装：规则每次组装现读，含 {{ 也不炸', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    let rules = ''
    installPromptSection(ctx, () => rules)
    const render = async () => renderPrompt(await (ctx as any).systemPrompt.assemble())

    const p1 = await render()
    expect(p1).toContain('propose_host_knowledge')
    expect(p1).toContain('主机知识库')
    expect(p1).not.toContain('用户自定义规则')

    rules = '回复用中文\n不要重启 nginx，用 reload；模板形如 {{ .Name }}'
    const p2 = await render()
    expect(p2).toContain('用户自定义规则')
    expect(p2).toContain('不要重启 nginx，用 reload')
  })

  it('含「先给回滚方案再执行」规则：写操作带 rollback / rollback_note，不可回滚要写明', () => {
    const p = buildPromptSection('')
    expect(p).toContain('rollback（')
    expect(p).toContain('rollback_note')
    expect(p).toContain('「不可回滚」')
  })

  it('空白规则不出规则段', () => {
    expect(buildPromptSection('  \n ')).not.toContain('用户自定义规则')
  })
})

describe('当前终端段', () => {
  it('每次组装现读终端清单（开/关终端后下一次请求即更新），标出 SSH/生产', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    let terms: { id: string; title: string; type: string; env?: string; os?: string }[] = [{ id: 'term_a1', title: '本地 1', type: 'local', os: 'windows' }]
    installTerminalsSection(ctx, () => terms)
    const render = async () => renderPrompt(await (ctx as any).systemPrompt.assemble())
    const p1 = await render()
    expect(p1).toContain('term_a1 · 本地 1（本地，Windows · Git Bash）')
    expect(p1).toContain('命令要匹配各终端的系统')
    terms = [{ id: 'term_b2', title: '腾讯云PW {{x}}', type: 'ssh', env: 'prod', os: 'linux' }, { id: 'term_c3', title: '老机器', type: 'ssh', os: 'unknown' }]
    const p = await render()
    expect(p).toContain('term_b2 · 腾讯云PW { {x}}（SSH，Linux，生产）')   // 标题里的 {{ 不能炸 dsh 模板
    expect(p).toContain('term_c3 · 老机器（SSH）')   // unknown 不标系统
    expect(p).not.toContain('term_a1')
  })
  it('没有终端时提示用 create_terminal', () => {
    expect(buildTerminalsSection([])).toContain('create_terminal')
  })
  it('带最近目录：写进终端行，并提示不必为了回答目录问题单独跑 pwd、多台用 exec_on_terminals', () => {
    const s = buildTerminalsSection([{ id: 'term_x', title: '本地', type: 'local', cwd: 'C:\\Users\\me' }])
    expect(s).toContain('当前目录 C:\\Users\\me')
    expect(s).toContain('不必为了回答单独跑 pwd')
    expect(s).toContain('exec_on_terminals')
  })
  it('仅手动终端在清单里标出来，WSL 标 Linux', () => {
    const s = buildTerminalsSection([
      { id: 'term_ps', title: 'PowerShell 1', type: 'local', os: 'windows', shell: 'powershell', manualOnly: true },
      { id: 'term_u', title: 'Ubuntu 1', type: 'local', os: 'linux', shell: 'wsl:Ubuntu' },
    ])
    expect(s).toContain('- term_ps · PowerShell 1（本地，PowerShell · 仅手动（AI 不可执行命令））')
    expect(s).toContain('- term_u · Ubuntu 1（本地，WSL · Ubuntu（Linux））')
  })
})

describe('会话工作目录段', () => {
  it('按 agent 现求值：说明工作目录 vs 终端 cwd；空目录整段不出；路径里的 {{ 不炸', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    let wd = 'D:\\test-projects\\git-demo'
    installWorkDirSection(ctx, (id) => (id === 'a1' ? wd : undefined))
    const render = async (agent?: { id: string }) => renderPrompt(await (ctx as any).systemPrompt.assemble(agent ? { agent } : {}))
    const p = await render({ id: 'a1' })
    expect(p).toContain('会话工作目录')
    expect(p).toContain('D:\\test-projects\\git-demo')
    expect(p).toContain('create_terminal')
    expect(p).toContain('pwd')
    expect(p).toContain('不要假定它们就在会话工作目录')
    wd = 'D:\\x {{y}}'
    expect(await render({ id: 'a1' })).toContain('D:\\x { {y}}')
    expect(await render({ id: 'a2' })).not.toContain('会话工作目录')
    expect(await render()).not.toContain('会话工作目录')
  })
})

describe('主机知识库段 / 跨主机提问段', () => {
  it('知识库按 agent 现求值：没用到主机为空（段落消失），卡片里的 {{ 原样输出不炸', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    const texts: Record<string, string> = { a1: '## 主机知识库\n模板 {{ .Name }}' }
    installKnowledgeSection(ctx, (id) => texts[id] ?? '')
    const render = async (agent?: { id: string }) => renderPrompt(await (ctx as any).systemPrompt.assemble(agent ? { agent } : {}))
    expect(await render({ id: 'a1' })).toContain('模板 {{ .Name }}')
    expect(await render({ id: 'a2' })).not.toContain('主机知识库')
    expect(await render()).not.toContain('主机知识库')
  })
  it('跨主机提问：列主机与分组、引导表格对比；没有主机整段不出', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    let hosts = [{ id: 'h1', label: 'web-1 {{x}}', group: 'web', env: 'prod' as const }, { id: 'h2', label: 'web-2', group: 'web' }]
    installFleetSection(ctx, () => hosts)
    const p = renderPrompt(await (ctx as any).systemPrompt.assemble())
    expect(p).toContain('run_on_hosts')
    expect(p).toContain('- web-1 {{x}} · id=h1 · 分组=web · 生产')
    expect(p).toContain('分组：web（2 台）')
    expect(p).toContain('Markdown 表格')
    hosts = []
    expect(renderPrompt(await (ctx as any).systemPrompt.assemble())).not.toContain('跨主机提问')
    expect(buildFleetSection([])).toBe('')
  })
})

describe('界面语言段', () => {
  afterEach(() => setLocale('zh-CN'))

  it('英文界面：提示词里带「用英文回复」；中文界面：整段不出，提示词与不装该段时逐字一致', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    installPromptSection(ctx, () => '')
    const render = async () => renderPrompt(await (ctx as any).systemPrompt.assemble())
    const before = await render()

    installLanguageSection(ctx)
    expect(await render()).toBe(before)   // zh：空段被丢掉
    expect(buildLanguageSection()).toBe('')

    setLocale('en')   // 每次组装现求值：切换后下一次请求就生效
    const en = await render()
    expect(en).toContain('## Interface language')
    expect(en).toContain('Reply in English')
    expect(en.indexOf('## Interface language')).toBeLessThan(en.indexOf('## 主机知识库与规则'))
  })
})
