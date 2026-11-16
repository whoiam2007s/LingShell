import { describe, expect, it } from 'vitest'
import {
  checkDbConnInput, checkMcpServerInput, checkModelProfileInput, checkSkillInput,
  isAiConfigKind, looksSensitiveKey, maskedNote, placeholderOf, sanitizeSecretMap, summarizeEntity,
} from './entityConfig.js'

describe('isAiConfigKind', () => {
  it('只认四类实体', () => {
    for (const k of ['skill', 'db_connection', 'model_profile', 'mcp_server']) expect(isAiConfigKind(k)).toBe(true)
    expect(isAiConfigKind('host')).toBe(false)
    expect(isAiConfigKind(undefined)).toBe(false)
  })
})

describe('敏感值 → 中文占位', () => {
  it('键名像密钥才替换，普通变量原样保留', () => {
    const { value, masked } = sanitizeSecretMap({ GITHUB_TOKEN: 'ghp_real', LOG_LEVEL: 'info', API_KEY: 'sk-1' })
    expect(value.GITHUB_TOKEN).toBe(placeholderOf('GITHUB_TOKEN'))
    expect(value.LOG_LEVEL).toBe('info')
    expect(value.API_KEY).toBe(placeholderOf('API_KEY'))
    expect(masked).toEqual(['GITHUB_TOKEN', 'API_KEY'])
  })

  it('占位里有键名，用户知道该填什么；不携带任何真实值', () => {
    expect(placeholderOf('SLACK_TOKEN')).toContain('SLACK_TOKEN')
    expect(placeholderOf('SLACK_TOKEN')).toContain('请替换成真实的')
    expect(placeholderOf('SLACK_TOKEN')).not.toContain('xoxb')
  })

  it('已经被换成占位的不重复计入 masked', () => {
    const once = sanitizeSecretMap({ TOKEN: 'abc' }).value
    expect(sanitizeSecretMap(once).masked).toEqual([])
  })

  it('looksSensitiveKey 认得常见写法，不误伤普通键', () => {
    for (const k of ['TOKEN', 'apiKey', 'API_KEY', 'DB_PASSWORD', 'authorization', 'client_secret', 'DSN']) {
      expect(looksSensitiveKey(k)).toBe(true)
    }
    for (const k of ['LOG_LEVEL', 'BASE_URL', 'NODE_ENV', 'MONGO_DB']) expect(looksSensitiveKey(k)).toBe(false)
  })

  it('maskedNote 空列表返回空串', () => {
    expect(maskedNote([])).toBe('')
    expect(maskedNote(['A'], 'env')).toContain('A')
  })
})

describe('checkSkillInput', () => {
  const body = '## 步骤\n1. 跑 nginx -t'
  it('合法输入通过', () => {
    const r = checkSkillInput({ name: 'nginx-check', description: '检查 nginx 配置', body })
    expect(r.ok && r.value.name).toBe('nginx-check')
  })
  it('名称必须是小写连字符', () => {
    expect(checkSkillInput({ name: 'Nginx Check', description: 'x', body }).ok).toBe(false)
    expect(checkSkillInput({ name: 'a_b', description: 'x', body }).ok).toBe(false)
  })
  it('描述与正文必填', () => {
    expect(checkSkillInput({ name: 'a', description: ' ', body }).ok).toBe(false)
    expect(checkSkillInput({ name: 'a', description: 'x', body: '   ' }).ok).toBe(false)
  })
  it('可选开关透传', () => {
    const r = checkSkillInput({ name: 'a', description: 'x', body, enabled: false, modelInvocable: true })
    expect(r.ok && r.value.enabled).toBe(false)
    expect(r.ok && r.value.modelInvocable).toBe(true)
  })
})

describe('checkDbConnInput', () => {
  it('密码只接受密钥保险箱里已存在的名称', () => {
    const known = ['mysql-root', 'app-db']
    const ok = checkDbConnInput({ name: '订单库', hostKey: 'local', kind: 'mysql', secret: 'mysql-root' }, known)
    expect(ok.ok && ok.value.secret).toBe('mysql-root')
    const bad = checkDbConnInput({ name: '订单库', hostKey: 'local', kind: 'mysql', secret: 'hunter2' }, known)
    expect(bad.ok).toBe(false)
    expect(bad.ok === false && bad.error).toContain('mysql-root')
  })
  it('不传已知密钥表时不判定密码（纯逻辑场景）', () => {
    expect(checkDbConnInput({ name: '订单库', hostKey: 'local', kind: 'mysql', secret: 'anything' }).ok).toBe(true)
  })
  it('复用 sanitizeDbConn 的错误文案', () => {
    const r = checkDbConnInput({ name: '', kind: 'mysql' })
    expect(r.ok === false && r.error).toMatch(/名称/)
  })
})

describe('checkModelProfileInput', () => {
  it('正常配置通过且不带 apiKey 字段', () => {
    const r = checkModelProfileInput({ name: '快模型', provider: 'deepseek', model: 'deepseek-chat', thinking: 'low' })
    expect(r.ok && r.value.thinking).toBe('low')
    // 就算模型硬塞 apiKey 也不会进结果（AI 不写密钥）
    expect(JSON.stringify(r.ok && r.value)).not.toContain('apiKey')
  })
  it('不给 apiKey 也能通过（key 由用户在设置页填）', () => {
    expect(checkModelProfileInput({ provider: 'deepseek', model: 'deepseek-chat' }).ok).toBe(true)
  })
  it('未知提供商 / 空模型名被拒', () => {
    expect(checkModelProfileInput({ provider: 'openai2', model: 'x' }).ok).toBe(false)
    expect(checkModelProfileInput({ provider: 'deepseek', model: ' ' }).ok).toBe(false)
  })
  it('id / 地址 / 上下文 / 思考深度都要合法', () => {
    expect(checkModelProfileInput({ provider: 'deepseek', model: 'm', id: 'Bad-Id' }).ok).toBe(false)
    expect(checkModelProfileInput({ provider: 'deepseek', model: 'm', baseUrl: 'ftp://x' }).ok).toBe(false)
    expect(checkModelProfileInput({ provider: 'deepseek', model: 'm', contextWindow: 1.5 }).ok).toBe(false)
    expect(checkModelProfileInput({ provider: 'deepseek', model: 'm', thinking: 'max' }).ok).toBe(false)
  })
  it('不填名称时用模型名', () => {
    const r = checkModelProfileInput({ provider: 'deepseek', model: 'deepseek-chat' })
    expect(r.ok && r.value.name).toBe('deepseek-chat')
  })
})

describe('checkMcpServerInput', () => {
  it('stdio 必须有启动命令', () => {
    expect(checkMcpServerInput({ name: 'fs', transport: 'stdio' }).ok).toBe(false)
    const r = checkMcpServerInput({ name: 'fs', transport: 'stdio', command: 'npx', args: ['-y', 'server-fs'] })
    expect(r.ok && r.value.command).toBe('npx')
  })
  it('http 必须有合法 URL', () => {
    expect(checkMcpServerInput({ name: 'api', transport: 'http' }).ok).toBe(false)
    expect(checkMcpServerInput({ name: 'api', transport: 'http', url: 'nope' }).ok).toBe(false)
    expect(checkMcpServerInput({ name: 'api', transport: 'http', url: 'https://x.dev/mcp' }).ok).toBe(true)
  })
  it('env / headers 里的敏感值换成中文占位，其余保留', () => {
    const r = checkMcpServerInput({
      name: 'gh', transport: 'stdio', command: 'npx',
      env: { GITHUB_TOKEN: 'ghp_fake', LOG_LEVEL: 'debug' },
      headers: { Authorization: 'Bearer abc' },
    })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.env?.GITHUB_TOKEN).toBe(placeholderOf('GITHUB_TOKEN'))
    expect(r.value.env?.LOG_LEVEL).toBe('debug')
    expect(r.value.headers?.Authorization).toBe(placeholderOf('Authorization'))
    expect(r.value.masked).toEqual(['env.GITHUB_TOKEN', 'headers.Authorization'])
  })
  it('transport 非法被拒', () => {
    expect(checkMcpServerInput({ name: 'x', transport: 'sse' }).ok).toBe(false)
  })
})

describe('summarizeEntity', () => {
  it('四类各出一行，含关键字段', () => {
    expect(summarizeEntity('skill', { name: 'a', description: 'd', enabled: false })).toContain('已停用')
    expect(summarizeEntity('db_connection', { name: '订单库', kind: 'mysql', id: 'db1', database: 'shop' })).toContain('db1')
    expect(summarizeEntity('model_profile', { name: '快', provider: 'deepseek', model: 'm', baseUrl: 'u', hasApiKey: false })).toContain('未填 API Key')
    expect(summarizeEntity('mcp_server', { name: 'gh', transport: 'stdio', command: 'npx', envKeys: ['TOKEN'] })).toContain('env TOKEN')
  })
})
