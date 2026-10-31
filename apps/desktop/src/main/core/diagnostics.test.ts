import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HostStore, type Encryptor } from '@lingshell/config'
import { redactSecrets, redactHosts, redactCredentials, scrubText, buildDiagnostics, writeArchive, archiveExt, REDACTED } from './diagnostics.js'

const FAKE_KEY = 'sk-fake0123456789abcdefTEST'
const FAKE_PW = 'hunter2-Very-Secret'

describe('redactSecrets', () => {
  it('嵌套对象/数组里键名像机密的值都替换，其它原样；数字布尔放过', () => {
    const out = redactSecrets({
      provider: 'deepseek', apiKeyCipher: 'AAA', apiKeyPlain: FAKE_KEY,
      system: { contextLimitTokens: 600000, customRules: 'x', nested: [{ accessToken: 't1', name: 'n' }, { db: { Password: 'p', host: 'h' } }] },
      clientSecret: { a: 1 }, sshPassphrase: 'pp',
    })
    expect(out).toEqual({
      provider: 'deepseek', apiKeyCipher: REDACTED, apiKeyPlain: REDACTED,
      system: { contextLimitTokens: 600000, customRules: 'x', nested: [{ accessToken: REDACTED, name: 'n' }, { db: { Password: REDACTED, host: 'h' } }] },
      clientSecret: REDACTED, sshPassphrase: REDACTED,
    })
  })
})

describe('redactHosts', () => {
  it('凭据字段全部替换，白名单字段保留', () => {
    const out = redactHosts([{
      id: '1', label: 'web', host: '10.0.0.1', port: 22, username: 'root', authType: 'password', env: 'prod', notes: 'n',
      passwordCipher: 'c1', privateKeyCipher: 'c2', passphraseCipher: 'c3', password: FAKE_PW, futureField: 'x',
    }]) as Record<string, unknown>[]
    expect(out[0]).toMatchObject({ id: '1', label: 'web', host: '10.0.0.1', port: 22, username: 'root', authType: 'password', env: 'prod', notes: 'n' })
    for (const k of ['passwordCipher', 'privateKeyCipher', 'passphraseCipher', 'password', 'futureField']) expect(out[0][k]).toBe(REDACTED)
    expect(JSON.stringify(out)).not.toContain(FAKE_PW)
  })
  it('结构不认识整体不导出', () => { expect(redactHosts({ a: 1 })).toBe(REDACTED) })
})

describe('scrubText', () => {
  it('抹掉已知机密（含 JSON 转义形式）和 sk- 样式 key', () => {
    const key = '-----BEGIN KEY-----\nabc\n-----END KEY-----'
    const s = scrubText(`a ${FAKE_PW} b sk-abcdefghijklmnopqrstu c ${JSON.stringify({ k: key })}`, [FAKE_PW, key, 'ab'])
    expect(s).not.toContain(FAKE_PW)
    expect(s).not.toContain('sk-abcdefghijklmnopqrstu')
    expect(s).not.toContain('BEGIN KEY')
    expect(s).toContain(' b ')   // 短串（<6）不替换，避免误伤
  })
  it('旧日志审计行里的命令原文替换掉（含转义引号），其余字段保留', () => {
    const line = `INFO [main][audit] cmd ${JSON.stringify({ terminalId: 't1', command: 'mysql -p"S3cret!" -e "select 1"', decision: 'exec_allowed', exitCode: 0 })}`
    const s = scrubText(line, [])
    expect(s).not.toContain('S3cret')
    expect(s).toContain('"command":"[已省略]"')
    expect(s).toContain('"decision":"exec_allowed","exitCode":0')
  })
  it('群机器人 Webhook 地址只留域名', () => {
    const s = scrubText('a https://oapi.dingtalk.com/robot/send?access_token=TOK1 b "https://open.feishu.cn/open-apis/bot/v2/hook/TOK2" c https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=TOK3', [])
    expect(s).not.toMatch(/TOK\d/)
    expect(s).toContain(`https://oapi.dingtalk.com/${REDACTED} b`)
  })
})

describe('buildDiagnostics', () => {
  it('打包内容：脱敏配置 + 最近 N 次日志 + 统计；假 key 不出现，敏感数据不带', async () => {
    const root = mkdtempSync(join(tmpdir(), 'lingshell-diag-'))
    const config = join(root, 'config'), logs = join(root, 'logs'), sessions = join(root, 'sessions'), recordings = join(root, 'recordings')
    for (const d of [config, logs, sessions, recordings]) mkdirSync(d)
    mkdirSync(join(recordings, '2026-01-04'))
    writeFileSync(join(recordings, '2026-01-04', 'a.cast'), '{"version":2}\n[0.1,"i","sudo-密码录像XYZ"]\n')
    writeFileSync(join(config, 'settings.json'), JSON.stringify({ provider: 'deepseek', apiKeyPlain: FAKE_KEY, system: { localNotes: '本机' } }))
    writeFileSync(join(config, 'hosts.json'), JSON.stringify([{ id: 'h', label: 'web', host: 'a', port: 22, username: 'u', authType: 'password', passwordCipher: 'ZZZ' }]))
    writeFileSync(join(config, 'api.json'), JSON.stringify({ token: 'api-token-should-not-leak' }))
    writeFileSync(join(config, 'sessions.json'), JSON.stringify([{ id: 's1', title: '机密会话标题' }, { id: 's2' }]))
    writeFileSync(join(config, 'audit.jsonl'), '{"command":"cat /etc/shadow"}\n{"command":"ls"}\n')
    writeFileSync(join(config, 'command-history.json'), JSON.stringify({ local: [{ command: 'mysql -pXXX' }], h: [{}, {}] }))
    writeFileSync(join(sessions, 'x.jsonl'), '对话正文XYZ')
    for (const run of ['2026-01-01_00-00-00', '2026-01-02_00-00-00', '2026-01-03_00-00-00', '2026-01-04_00-00-00']) {
      mkdirSync(join(logs, run))
      writeFileSync(join(logs, run, 'main.log'), `start ${run}\n` + 'x'.repeat(100) + ` key=${FAKE_KEY} END`)   // key 落在保留的末尾里
    }
    mkdirSync(join(logs, 'sessions'))   // 会话日志目录：不占「最近 N 次运行」名额，内容不进包
    writeFileSync(join(logs, 'sessions', 'main.log'), '会话日志XYZ')
    const files = buildDiagnostics({ root, config, logs, sessions, recordings, env: { appVersion: '1.0.0' }, secrets: [FAKE_KEY], logTailBytes: 50 })
    const names = files.map((f) => f.name)
    const all = files.map((f) => f.content).join('\n')

    expect(names).toContain('README.txt')
    expect(names).toContain('config/settings.json')
    expect(names).toContain('config/hosts.json')
    expect(names.filter((n) => n.startsWith('logs/'))).toEqual(['logs/2026-01-02_00-00-00/main.log', 'logs/2026-01-03_00-00-00/main.log', 'logs/2026-01-04_00-00-00/main.log'])
    expect(files.find((f) => f.name.endsWith('04_00-00-00/main.log'))!.content).toMatch(/^\[已截断.*\n.*END$/s)
    for (const leak of [FAKE_KEY, 'ZZZ', 'api-token-should-not-leak', '机密会话标题', '/etc/shadow', 'mysql -pXXX', '对话正文XYZ', '密码录像XYZ', '会话日志XYZ']) expect(all).not.toContain(leak)
    expect(names.some((n) => n.includes('api.json') && !n.startsWith('data-stats'))).toBe(false)
    const stats = JSON.parse(files.find((f) => f.name === 'data-stats.json')!.content)
    expect(stats).toMatchObject({ sessions: 2, auditEntries: 2, commandHistory: { hosts: 2, entries: 3 }, sessionLogsDir: { files: 1 }, recordingsDir: { files: 1 } })
    expect(names.some((n) => n.includes('recordings') || n.endsWith('.cast'))).toBe(false)

    // 打包冒烟：系统 tar 可用时出包
    const out = join(root, `diag.${archiveExt()}`)
    await writeArchive(files, out).catch(() => undefined)
    if (process.platform === 'win32') {   // Win10+ 自带 bsdtar：确认是 zip 且内容齐
      expect(readFileSync(out).subarray(0, 2).toString('latin1')).toBe('PK')
      expect(execFileSync(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe'), ['-tf', out], { encoding: 'utf8' })).toContain('config/hosts.json')
    }
    expect(readdirSync(root).filter((n) => n.startsWith('lingshell-diag-'))).toEqual([])   // 临时目录在系统 tmp，不落这里
  })
})

describe('命名凭据', () => {
  it('credentials.json 白名单脱敏；凭据密码出现在日志里也按原值抹掉（HostStore.knownSecrets）', () => {
    const root = mkdtempSync(join(tmpdir(), 'lingshell-diag-cred-'))
    const config = join(root, 'config'), logs = join(root, 'logs'), sessions = join(root, 'sessions')
    for (const d of [config, logs, sessions]) mkdirSync(d)
    const enc: Encryptor = { available: () => true, encrypt: (s) => `E(${Buffer.from(s).toString('base64')})`, decrypt: (c) => Buffer.from(c.slice(2, -1), 'base64').toString() }
    const hs = new HostStore(config, enc, () => undefined)
    hs.saveCredential({ name: '运维', username: 'ops', authType: 'password', password: 'Cred-Pw-777' })   // 未被任何主机引用也要抹
    mkdirSync(join(logs, '2026-01-01_00-00-00'))
    writeFileSync(join(logs, '2026-01-01_00-00-00', 'main.log'), 'auth failed with Cred-Pw-777 for ops')
    const files = buildDiagnostics({ root, config, logs, sessions, env: {}, secrets: hs.knownSecrets() })
    const all = files.map((f) => f.content).join('\n')
    expect(all).not.toContain('Cred-Pw-777')
    expect(all).not.toContain('E(')
    const cred = JSON.parse(files.find((f) => f.name === 'config/credentials.json')!.content) as Record<string, unknown>[]
    expect(cred[0]).toMatchObject({ name: '运维', username: 'ops', authType: 'password', passwordCipher: REDACTED })
    expect(redactCredentials({})).toBe(REDACTED)
  })
})
