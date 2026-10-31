import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SettingsStore, type Encryptor } from './SettingsStore.js'
import { DEFAULT_SYSTEM_SETTINGS } from '@lingshell/shared'

// 简单的可逆 mock 加密器（base64 反转），仅测试用
const mockEnc: Encryptor = {
  available: () => true,
  encrypt: (plain) => Buffer.from(plain).toString('base64'),
  decrypt: (cipher) => Buffer.from(cipher, 'base64').toString('utf8'),
}

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'lingshell-cfg-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

describe('SettingsStore', () => {
  it('returns defaults with hasApiKey=false when nothing saved', () => {
    const s = new SettingsStore(dir, mockEnc)
    const got = s.get()
    expect(got.provider).toBe('deepseek')
    expect(got.hasApiKey).toBe(false)
  })

  it('saves settings and reports hasApiKey but never returns plaintext key via get()', () => {
    const s = new SettingsStore(dir, mockEnc)
    s.save({ provider: 'deepseek', model: 'deepseek-v4-pro', baseUrl: 'https://x', apiKey: 'secret-123' })
    const got = s.get()
    expect(got.model).toBe('deepseek-v4-pro')
    expect(got.hasApiKey).toBe(true)
    // get() 不回传明文
    expect((got as any).apiKey).toBeUndefined()
    // 内部 getApiKey() 能解密拿到明文
    expect(s.getApiKey()).toBe('secret-123')
  })

  it('preserves existing key when saving without a new apiKey', () => {
    const s = new SettingsStore(dir, mockEnc)
    s.save({ provider: 'deepseek', model: 'm1', baseUrl: 'u1', apiKey: 'keepme' })
    // 再次保存，只改 model，不传 key
    s.save({ provider: 'deepseek', model: 'm2', baseUrl: 'u2' })
    expect(s.get().model).toBe('m2')
    expect(s.getApiKey()).toBe('keepme')   // key 仍在
  })

  it('旧接口改默认配置换了 provider：不沿用别家的 key', () => {
    const s = new SettingsStore(dir, mockEnc)
    s.save({ provider: 'deepseek', model: 'm', baseUrl: 'u', apiKey: 'ds-key' })
    s.save({ provider: 'qwen', model: 'qwen-max', baseUrl: 'q' })
    expect(s.get().hasApiKey).toBe(false)
    expect(s.getApiKey()).toBe('')
    s.save({ provider: 'qwen', model: 'qwen-max', baseUrl: 'q', apiKey: 'qw-key' })
    expect(s.getApiKey()).toBe('qw-key')
    // 磁盘上也是密文
    expect(readFileSync(join(dir, 'settings.json'), 'utf8')).not.toContain('qw-key')
  })

  it('contextWindow 未传时保留旧值（系统设置页保存不抹掉它）', () => {
    const s = new SettingsStore(dir, mockEnc)
    s.save({ provider: 'ollama', model: 'x', baseUrl: 'u', contextWindow: 8192 })
    s.save({ provider: 'ollama', model: 'x', baseUrl: 'u' })
    expect(s.get().contextWindow).toBe(8192)
  })

  it('falls back to plaintext when encryption unavailable', () => {
    const noEnc: Encryptor = { available: () => false, encrypt: () => { throw new Error('no') }, decrypt: () => { throw new Error('no') } }
    const s = new SettingsStore(dir, noEnc)
    s.save({ provider: 'deepseek', model: 'm', baseUrl: 'u', apiKey: 'plainkey' })
    expect(s.get().hasApiKey).toBe(true)
    expect(s.getApiKey()).toBe('plainkey')
  })

  it('save/get 保留 system 子对象', () => {
    const s = new SettingsStore(dir, mockEnc)
    s.save({ provider: 'deepseek', model: 'm', baseUrl: 'u', system: { historyLimit: 500, execTimeoutSec: 120, uploadEncrypt: false, contextLimitTokens: 100000, contextResetSteps: 80, confirmDangerous: false, aiRedact: false, customRules: 'r', localNotes: 'n', terminalFontSize: 16, terminalTheme: 'light', terminalRecording: true, recordingRetentionDays: 7, terminalHighlight: false, highlightRules: [], sessionLog: true, sessionLogDir: 'D:/logs', sessionLogRetentionDays: 7, sessionLogTimestamps: true, lockIdleMinutes: 5, sshAutoReconnect: true, hostStats: true, hostStatsIntervalSec: 30, hostStatsProd: true, terminalFontFamily: 'Fira Code', terminalLineHeight: 1.5, terminalCursorStyle: 'bar', terminalCursorBlink: false, terminalScrollback: 20000, terminalNotifySec: 0, externalEditor: 'code', transferConcurrency: 3, terminalAutoComplete: true, terminalPasteCheck: false, terminalBell: 'badge', sshUrlHandler: true, bashPath: 'D:\\Git\\bin\\bash.exe', keybindings: { 'tab.new': 'Ctrl+Alt+T' }, commandRules: [{ id: 'c1', match: 'prefix', pattern: 'ls', action: 'allow', scope: 'all' }] } })
    expect(s.get().system).toEqual({ historyLimit: 500, execTimeoutSec: 120, uploadEncrypt: false, contextLimitTokens: 100000, contextResetSteps: 80, confirmDangerous: false, aiRedact: false, customRules: 'r', localNotes: 'n', terminalFontSize: 16, terminalTheme: 'light', terminalRecording: true, recordingRetentionDays: 7, terminalHighlight: false, highlightRules: [], sessionLog: true, sessionLogDir: 'D:/logs', sessionLogRetentionDays: 7, sessionLogTimestamps: true, lockIdleMinutes: 5, sshAutoReconnect: true, hostStats: true, hostStatsIntervalSec: 30, hostStatsProd: true, terminalFontFamily: 'Fira Code', terminalLineHeight: 1.5, terminalCursorStyle: 'bar', terminalCursorBlink: false, terminalScrollback: 20000, terminalNotifySec: 0, externalEditor: 'code', transferConcurrency: 3, terminalAutoComplete: true, terminalPasteCheck: false, terminalBell: 'badge', sshUrlHandler: true, bashPath: 'D:\\Git\\bin\\bash.exe', keybindings: { 'tab.new': 'Ctrl+Alt+T' }, commandRules: [{ id: 'c1', match: 'prefix', pattern: 'ls', action: 'allow', scope: 'all' }], uiTheme: 'dark', uiThemeDark: 'dark', uiThemeLight: 'light', uiZoom: 1, iconSize: 'small' })
  })

  it('get 无 system 时回落 DEFAULT_SYSTEM_SETTINGS', () => {
    const s = new SettingsStore(dir, mockEnc)
    s.save({ provider: 'deepseek', model: 'm', baseUrl: 'u' })   // 不带 system
    expect(s.get().system).toEqual(DEFAULT_SYSTEM_SETTINGS)
  })

  it('原子写：不残留 .tmp', () => {
    const s = new SettingsStore(dir, mockEnc)
    s.save({ provider: 'deepseek', model: 'm', baseUrl: 'u', apiKey: 'k' })
    expect(readdirSync(dir)).toEqual(['settings.json'])
  })

  it('老配置迁移：当前那套成「默认」，其它 provider 已存的 key 各迁成一套；未保存前反复读 id 稳定', () => {
    const k = (v: string) => mockEnc.encrypt(v)
    writeFileSync(join(dir, 'settings.json'), JSON.stringify({
      provider: 'qwen', model: 'qwen-plus', baseUrl: 'https://q', contextWindow: 65536,
      apiKeyCipher: k('ds-old'), keys: { qwen: { apiKeyCipher: k('qw-old') }, 'openai-compatible': { apiKeyPlain: 'oa-plain' } },
    }), 'utf8')
    const s = new SettingsStore(dir, mockEnc)
    const got = s.get()
    expect(got.defaultProfileId).toBe('default')
    expect(got.modelProfiles).toEqual([
      { id: 'default', name: '默认', provider: 'qwen', model: 'qwen-plus', baseUrl: 'https://q', contextWindow: 65536, hasApiKey: true, protocol: 'openai', multimodal: false },
      { id: 'legacy_deepseek', name: 'DeepSeek', provider: 'deepseek', model: 'deepseek-v4-pro', baseUrl: 'https://api.deepseek.com', contextWindow: 0, hasApiKey: true, protocol: 'anthropic', multimodal: false },
      // 支持图片没设过：按模型名猜（gpt-4o 是视觉模型）
      { id: 'legacy_openai_compatible', name: 'OpenAI 兼容端点', provider: 'openai-compatible', model: 'gpt-4o', baseUrl: 'https://api.openai.com/v1', contextWindow: 0, hasApiKey: true, protocol: 'openai', multimodal: true },
    ])
    expect(s.get().modelProfiles).toEqual(got.modelProfiles)
    expect(s.resolveProfile().apiKey).toBe('qw-old')
    expect(s.resolveProfile('legacy_deepseek').apiKey).toBe('ds-old')
    expect(s.allApiKeys().sort()).toEqual(['ds-old', 'oa-plain', 'qw-old'])
    // 保存一次（如系统设置页）落成新结构：旧 key 槽去掉，key 跟着配置走、仍是密文
    s.save({ provider: 'qwen', model: 'qwen-plus', baseUrl: 'https://q', system: DEFAULT_SYSTEM_SETTINGS })
    const raw = JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8'))
    expect(raw.keys).toBeUndefined()
    expect(raw.apiKeyCipher).toBeUndefined()
    expect(raw.profiles.map((x: { id: string }) => x.id)).toEqual(['default', 'legacy_deepseek', 'legacy_openai_compatible'])
    expect(JSON.stringify(raw)).not.toContain('qw-old')
    expect(s.resolveProfile('legacy_deepseek').apiKey).toBe('ds-old')
  })

  it('支持图片：显式设置的按设置存取，没设过的按模型名猜，非布尔值不落盘', () => {
    const s = new SettingsStore(dir, mockEnc)
    s.save({ provider: 'qwen', model: 'qwen-max', baseUrl: '', modelProfiles: [
      { id: 'a', name: 'A', provider: 'qwen', model: 'qwen-max', baseUrl: '', multimodal: true },
      { id: 'b', name: 'B', provider: 'qwen', model: 'qwen-vl-max', baseUrl: '' },
      { id: 'c', name: 'C', provider: 'qwen', model: 'qwen-vl-max', baseUrl: '', multimodal: 'yes' as unknown as boolean },
    ], defaultProfileId: 'a' })
    expect(s.get().modelProfiles?.map((x) => x.multimodal)).toEqual([true, true, true])
    expect(s.resolveProfile('a').multimodal).toBe(true)
    const raw = JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8'))
    expect(raw.profiles.map((x: { multimodal?: unknown }) => x.multimodal)).toEqual([true, undefined, undefined])
  })

  it('多配置：每套 key 单独加密存；留空保留、换提供商不保留；get 不回明文；默认配置决定顶层镜像', () => {
    const s = new SettingsStore(dir, mockEnc)
    s.save({ ...s.get(), modelProfiles: [
      { id: 'a', name: 'A', provider: 'deepseek', model: 'deepseek-v4-pro', baseUrl: '', apiKey: 'key-a' },
      { id: 'b', name: 'B', provider: 'qwen', model: 'qwen-max', baseUrl: 'https://q', apiKey: 'key-b', contextWindow: 4096 },
    ], defaultProfileId: 'b' })
    let got = s.get()
    expect(got.provider).toBe('qwen')
    expect(got.contextWindow).toBe(4096)
    expect(got.modelProfiles!.map((x) => [x.id, x.hasApiKey, x.baseUrl])).toEqual([['a', true, 'https://api.deepseek.com'], ['b', true, 'https://q']])
    expect(JSON.stringify(got)).not.toContain('key-')
    expect(readFileSync(join(dir, 'settings.json'), 'utf8')).not.toContain('key-')
    expect(s.resolveProfile('a').apiKey).toBe('key-a')
    expect(s.resolveProfile('nope').id).toBe('b')   // 找不到 → 默认配置
    // 再存：a 不填 key → 保留；b 换成 moonshot → key 丢掉；新增一套非法 id → 换成新 id
    s.save({ modelProfiles: [
      { id: 'a', name: 'A2', provider: 'deepseek', model: 'deepseek-flash', baseUrl: 'https://x' },
      { id: 'b', name: 'B', provider: 'moonshot', model: 'kimi-k2-0905-preview', baseUrl: 'https://m' },
      { id: 'Bad Id!', name: '', provider: 'ollama', model: '', baseUrl: '' },
    ], defaultProfileId: 'a' } as never)
    got = s.get()
    expect(s.resolveProfile('a').apiKey).toBe('key-a')
    expect(s.resolveProfile('b').apiKey).toBe('')
    const c = got.modelProfiles![2]
    expect(c.id).toMatch(/^mp_[a-z0-9]{10}$/)
    expect(c).toMatchObject({ name: 'qwen3:8b', model: 'qwen3:8b', baseUrl: 'http://127.0.0.1:11434/v1', hasApiKey: false })
    expect(got.model).toBe('deepseek-flash')
    // 复制：新配置经 keyFrom 沿用来源的 key（同提供商）；提供商不同不沿用
    s.save({ ...s.get(), modelProfiles: [...s.get().modelProfiles!, { id: 'a_copy', name: 'A 副本', provider: 'deepseek', model: 'deepseek-v4-pro', baseUrl: '', keyFrom: 'a' }, { id: 'a_x', name: 'x', provider: 'qwen', model: 'qwen-max', baseUrl: '', keyFrom: 'a' }] })
    expect(s.resolveProfile('a_copy').apiKey).toBe('key-a')
    expect(s.resolveProfile('a_x').apiKey).toBe('')
    s.save({ ...s.get(), modelProfiles: s.get().modelProfiles!.slice(0, 3) })
    // 不带 modelProfiles 的保存（系统设置页）不动配置
    s.save({ provider: 'deepseek', model: 'deepseek-flash', baseUrl: 'https://x', system: DEFAULT_SYSTEM_SETTINGS })
    expect(s.get().modelProfiles).toHaveLength(3)
    expect(() => s.save({ ...s.get(), modelProfiles: [] })).toThrow()
  })

  it('接口协议：已存配置缺省 → DeepSeek 视为 anthropic、其它 openai；DeepSeek 可存 openai；非法值规整；其它提供商不落盘', () => {
    // 升级前已有的配置（没有 protocol 字段）
    writeFileSync(join(dir, 'settings.json'), JSON.stringify({
      provider: 'deepseek', model: 'deepseek-v4-pro', baseUrl: '', defaultProfileId: 'a',
      profiles: [{ id: 'a', name: 'A', provider: 'deepseek', model: 'deepseek-v4-pro', baseUrl: '' }, { id: 'b', name: 'B', provider: 'qwen', model: 'qwen-max', baseUrl: '' }],
    }), 'utf8')
    const s = new SettingsStore(dir, mockEnc)
    expect(s.get().modelProfiles!.map((x) => [x.id, x.protocol])).toEqual([['a', 'anthropic'], ['b', 'openai']])
    expect(s.resolveProfile('a').protocol).toBe('anthropic')
    s.save({ modelProfiles: [
      { id: 'a', name: 'A', provider: 'deepseek', model: 'deepseek-v4-pro', baseUrl: '', protocol: 'openai' },
      { id: 'b', name: 'B', provider: 'qwen', model: 'qwen-max', baseUrl: '', protocol: 'anthropic' },
      { id: 'c', name: 'C', provider: 'deepseek', model: 'deepseek-v4-pro', baseUrl: '', protocol: 'bogus' as never },
    ], defaultProfileId: 'a' } as never)
    expect(s.get().modelProfiles!.map((x) => [x.id, x.protocol])).toEqual([['a', 'openai'], ['b', 'openai'], ['c', 'anthropic']])
    expect(s.resolveProfile('a').protocol).toBe('openai')
    const raw = JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8'))
    expect(raw.profiles.map((x: { protocol?: string }) => x.protocol)).toEqual(['openai', undefined, 'anthropic'])
  })

  it('坏配置记录 / 坏 system 字段：过滤、补默认，不把设置页读崩', () => {
    writeFileSync(join(dir, 'settings.json'), JSON.stringify({
      provider: 'deepseek', model: 'x', baseUrl: '',
      profiles: [
        null,
        { id: 'bad id', provider: 'deepseek', model: 'm', baseUrl: '' },
        { id: 'mp_a', provider: 'ollama', model: '', baseUrl: '', apiKeyPlain: 'k' },
        { id: 'mp_b', provider: 'nope', model: 'm', baseUrl: '' },
      ],
      system: { commandRules: 'oops', terminalFontSize: 'big', uiZoom: 1.2, terminalRecording: 'yes' },
    }))
    const s = new SettingsStore(dir, mockEnc)
    const g = s.get()
    expect(g.modelProfiles!.map((p) => p.id)).toEqual(['mp_a'])
    expect(g.modelProfiles![0].model).toBeTruthy()          // 缺 model 补该提供商默认型号
    expect(g.hasApiKey).toBe(true)
    const sys = g.system!
    expect(sys.commandRules).toEqual(DEFAULT_SYSTEM_SETTINGS.commandRules)   // 非数组丢弃
    expect(sys.terminalFontSize).toBe(DEFAULT_SYSTEM_SETTINGS.terminalFontSize)
    expect(sys.terminalRecording).toBe(DEFAULT_SYSTEM_SETTINGS.terminalRecording)
    expect(sys.uiZoom).toBe(1.2)                              // 类型正确的新字段保留
    expect(() => s.resolveProfile()).not.toThrow()
  })

  it('settings.json 损坏 → 备份原文件再回落默认，后续 save 不覆盖备份', () => {
    writeFileSync(join(dir, 'settings.json'), '{"apiKeyCipher":"abc', 'utf8')
    const s = new SettingsStore(dir, mockEnc)
    expect(s.get().hasApiKey).toBe(false)
    s.save({ provider: 'deepseek', model: 'm', baseUrl: 'u' })
    const backups = readdirSync(dir).filter((f) => f.startsWith('settings.json.corrupt-'))
    expect(backups).toHaveLength(1)
    expect(readFileSync(join(dir, backups[0]), 'utf8')).toBe('{"apiKeyCipher":"abc')
  })
})

describe('DeepSeek 已下线模型 id', () => {
  it('官方地址上的旧 id 读出即换新（key 不丢）；自建网关原样；保存时落盘', () => {
    writeFileSync(join(dir, 'settings.json'), JSON.stringify({
      provider: 'deepseek', model: 'deepseek-chat', baseUrl: 'https://api.deepseek.com', defaultProfileId: 'a',
      profiles: [
        { id: 'a', name: 'A', provider: 'deepseek', model: 'deepseek-chat', baseUrl: 'https://api.deepseek.com', apiKeyPlain: 'k-a' },
        { id: 'b', name: 'B', provider: 'deepseek', model: 'deepseek-v4-flash-vision-exp', baseUrl: '' },
        { id: 'c', name: 'C', provider: 'deepseek', model: 'deepseek-reasoner', baseUrl: 'http://gw.local/ds' },
        { id: 'd', name: 'D', provider: 'openai-compatible', model: 'deepseek-chat', baseUrl: 'https://api.deepseek.com/v1' },
      ],
    }))
    const s = new SettingsStore(dir, mockEnc)
    expect(s.get().modelProfiles!.map((x) => x.model)).toEqual(['deepseek-flash', 'deepseek-flash', 'deepseek-reasoner', 'deepseek-chat'])
    expect(s.get().modelProfiles![1].multimodal).toBe(true)   // 新 id 是视觉模型
    expect(s.resolveProfile('a')).toMatchObject({ model: 'deepseek-flash', apiKey: 'k-a' })
    expect(readFileSync(join(dir, 'settings.json'), 'utf8')).toContain('deepseek-chat')   // 只读不改文件
    s.save({ ...s.get(), modelProfiles: s.get().modelProfiles })
    expect(JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8')).profiles[0].model).toBe('deepseek-flash')
    expect(s.getProfileKey('a')).toBe('k-a')
  })
})
