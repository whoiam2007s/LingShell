import { describe, it, expect, afterEach } from 'vitest'
import { fileURLToPath } from 'node:url'
import type { McpServerConfig } from '@lingshell/shared'
import { McpManager, mcpNamespaces, mcpToolName, mcpParameters, mcpResultText, mcpDecision, mcpArgsView, MCP_RESULT_MAX } from './mcp.js'

const FIXTURE = fileURLToPath(new URL('./__fixtures__/mcp-server.mjs', import.meta.url))
const fixture = (over: Partial<McpServerConfig> = {}): McpServerConfig =>
  ({ id: 'srv1', name: 'fixture', enabled: true, transport: 'stdio', command: process.execPath, args: [FIXTURE], env: { ELECTRON_RUN_AS_NODE: '1' }, ...over })

describe('MCP 名字规范化', () => {
  it('服务名：可用字符保留，全中文退成 srv_<id>，重名追加 id', () => {
    const m = mcpNamespaces([{ id: 'a1', name: 'Grafana Prod' }, { id: 'b2', name: '监控' }, { id: 'c3', name: 'Grafana Prod' }])
    expect(m.get('a1')).toBe('Grafana_Prod')
    expect(m.get('b2')).toBe('srv_b2')
    expect(m.get('c3')).toBe('Grafana_Prod_c3')
  })
  it('工具名：干净的原样拼，非法字符/超长时替换截断并追加哈希，结果合法且不撞名', () => {
    expect(mcpToolName('db', 'query')).toBe('mcp__db__query')
    const a = mcpToolName('db', 'run.sql'), b = mcpToolName('db', 'run_sql')
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(a).not.toBe(b)
    const long = mcpToolName('db', 'x'.repeat(100))
    expect(long.length).toBeLessThanOrEqual(64)
    expect(long).toMatch(/^mcp__db__x+_[0-9a-f]{12}$/)
  })
})

describe('MCP schema 透传', () => {
  it('补 type:object、去掉 $schema/$id、塞可选 explain，其余原样', () => {
    const { parameters, explain } = mcpParameters({ $schema: 'x', $id: 'y', properties: { q: { type: 'string', anyOf: [{ minLength: 1 }] } }, required: ['q'] })
    expect(explain).toBe(true)
    expect(parameters).toEqual({
      type: 'object', required: ['q'],
      properties: { q: { type: 'string', anyOf: [{ minLength: 1 }] }, explain: expect.objectContaining({ type: 'string' }) },
    })
  })
  it('服务端自己有 explain 参数就不动；缺 inputSchema 也给出空对象 schema', () => {
    expect(mcpParameters({ type: 'object', properties: { explain: { type: 'boolean' } } })).toEqual({ explain: false, parameters: { type: 'object', properties: { explain: { type: 'boolean' } } } })
    expect(mcpParameters(undefined).parameters).toMatchObject({ type: 'object', properties: { explain: {} } })
  })
})

describe('MCP 结果映射', () => {
  it('文本拼接；图片/音频/二进制资源只报类型和大小', () => {
    const t = mcpResultText({ content: [
      { type: 'text', text: 'a' },
      { type: 'image', mimeType: 'image/png', data: 'A'.repeat(4096) },
      { type: 'resource', resource: { uri: 'file:///x.txt', text: 'hello' } },
      { type: 'resource', resource: { uri: 'file:///x.bin', mimeType: 'application/zip', blob: 'AAAA' } },
      { type: 'resource_link', name: 'doc', uri: 'https://d' },
    ] })
    expect(t).toBe('a\n[图片 image/png，约 3.0 KB，未内联]\n[资源 file:///x.txt]\nhello\n[资源 file:///x.bin（application/zip，约 0.0 KB，未内联）]\n[资源链接 doc https://d]')
    expect(t).not.toContain('AAAA')
  })
  it('超长截断并告知模型；只有 structuredContent 时给 JSON；空结果有占位', () => {
    const t = mcpResultText({ content: [{ type: 'text', text: 'y'.repeat(MCP_RESULT_MAX + 5) }] })
    expect(t.startsWith('y'.repeat(MCP_RESULT_MAX))).toBe(true)
    expect(t).toContain(`共 ${MCP_RESULT_MAX + 5} 字符`)
    expect(mcpResultText({ content: [], structuredContent: { n: 1 } })).toBe('{\n  "n": 1\n}')
    expect(mcpResultText({ content: [] })).toBe('（无输出）')
  })
  it('授权卡参数：去掉 explain、格式化', () => {
    expect(mcpArgsView({ sql: 'select 1', explain: '查' })).toBe('{\n  "sql": "select 1"\n}')
  })
})

describe('MCP 授权决策', () => {
  it('默认每次问', () => expect(mcpDecision({ autoApproved: false, trust: 'autonomous' })).toEqual({ kind: 'ask', reason: 'mcp' }))
  it('免确认的工具放行（只读档、巡检里也放行）', () => {
    expect(mcpDecision({ autoApproved: true }).kind).toBe('allow')
    expect(mcpDecision({ autoApproved: true, trust: 'readonly', unattended: true }).kind).toBe('allow')
  })
  it('只读信任档：未免确认的拒绝', () => expect(mcpDecision({ autoApproved: false, trust: 'readonly' })).toMatchObject({ kind: 'deny', reason: expect.stringContaining('只读') }))
  it('无人值守巡检：需要确认的直接拒绝，绝不挂起', () => expect(mcpDecision({ autoApproved: false, trust: 'confirm', unattended: true })).toMatchObject({ kind: 'deny', reason: expect.stringContaining('无人值守') }))
})

describe('McpManager（真起 stdio MCP 服务）', () => {
  let mgr: McpManager | undefined
  afterEach(async () => { await mgr?.close(); mgr = undefined })

  it('连接 → 注册带命名空间的工具 → 调用（剥 explain / 截断 / 图片 / isError）→ 删除配置即注销', async () => {
    const statuses: string[] = []
    mgr = new McpManager({ onStatus: (s) => statuses.push(s.map((x) => x.state).join(',')) })
    const defs = new Map<string, any>()
    mgr.bind((def) => { defs.set(def.name, def); return () => defs.delete(def.name) })
    await mgr.apply([fixture({ name: 'Fix Tools', autoApprove: ['echo'] })])
    expect(mgr.status()[0]).toMatchObject({ state: 'connected', tools: expect.arrayContaining([expect.objectContaining({ name: 'echo', publicName: 'mcp__Fix_Tools__echo' })]) })
    expect(statuses).toEqual(['connecting', 'connected'])
    expect([...defs.keys()].sort()).toEqual(['mcp__Fix_Tools__big', 'mcp__Fix_Tools__echo', 'mcp__Fix_Tools__fail', 'mcp__Fix_Tools__img'])
    const echo = defs.get('mcp__Fix_Tools__echo')
    expect(echo.description).toBe('[MCP · Fix Tools] 回显参数')
    expect(echo.parameters.$schema).toBeUndefined()
    expect(mgr.lookup('mcp__Fix_Tools__echo')).toMatchObject({ server: 'Fix Tools', tool: 'echo', autoApproved: true })
    expect(mgr.lookup('mcp__Fix_Tools__big')?.autoApproved).toBe(false)

    expect(await echo.execute({ text: 'hi', explain: '回显一下' }, {})).toBe('echo:{"text":"hi"}')
    expect(await defs.get('mcp__Fix_Tools__big').execute({}, {})).toContain('[结果过长已截断')
    expect(await defs.get('mcp__Fix_Tools__img').execute({}, {})).toBe('截图如下\n[图片 image/png，约 2.0 KB，未内联]')
    await expect(defs.get('mcp__Fix_Tools__fail').execute({}, {})).rejects.toThrow('boom')

    // 只改免确认：不重连，决策立即生效
    await mgr.apply([fixture({ name: 'Fix Tools', autoApprove: [] })])
    expect(mgr.lookup('mcp__Fix_Tools__echo')?.autoApproved).toBe(false)
    expect(defs.size).toBe(4)

    await mgr.apply([])
    expect(defs.size).toBe(0)
    expect(mgr.status()).toEqual([])
  }, 30_000)

  it('启动失败的服务只标 failed，不影响其他服务；bind 之前连上的在 bind 时补注册', async () => {
    mgr = new McpManager()
    await mgr.apply([
      fixture({ id: 'bad', name: 'bad', command: 'definitely-not-a-command-xyz' }),
      fixture(),
      fixture({ id: 'off', name: 'off', enabled: false }),
    ])
    const st = Object.fromEntries(mgr.status().map((s) => [s.name, s]))
    expect(st.bad.state).toBe('failed')
    expect(st.bad.error).toBeTruthy()
    expect(st.fixture.state).toBe('connected')
    expect(st.off.state).toBe('disabled')
    const names: string[] = []
    mgr.bind((def) => { names.push(def.name); return () => {} })
    expect(names).toHaveLength(4)
  }, 30_000)

  it('连接测试：列出工具后断开，不注册', async () => {
    mgr = new McpManager()
    const tools = await mgr.test(fixture({ name: 'probe' }))
    expect(tools.map((t) => t.publicName)).toContain('mcp__probe__echo')
    expect(mgr.status()).toEqual([])
  }, 30_000)
})
