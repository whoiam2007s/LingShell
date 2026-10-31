import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { AppSettings, ModelProfile, ModelProtocol, ProviderId, SystemSettings, UsagePrices, ModelPrice } from '@lingshell/shared'
import { DEFAULT_SETTINGS, DEFAULT_SYSTEM_SETTINGS, migrateAppearance, tr, PROVIDERS, MODEL_PROFILE_ID_RE, providerMeta, protocolOf, multimodalDefault, canonicalModel } from '@lingshell/shared'
import { readJson, writeJson } from './jsonFile.js'

// 加密器接口：由调用方注入（desktop 注入 Electron safeStorage 实现）。
// 这样 config 包保持平台无关，未来 SaaS 服务端可注入别的实现（如 KMS）。
export interface Encryptor {
  encrypt(plain: string): string   // 返回密文（base64）
  decrypt(cipher: string): string  // 还原明文
  available(): boolean             // 加密是否可用（safeStorage 在某些 Linux 无后端时不可用）
}

// 一个 key 槽：可用加密时存密文，否则降级明文（文件本身在 userData，权限受限）
export interface KeySlot { apiKeyCipher?: string; apiKeyPlain?: string }

// 一套模型配置（磁盘形态）：key 按配置单独存
export interface PersistedProfile extends KeySlot {
  id: string; name: string; provider: ProviderId; model: string; baseUrl: string; contextWindow?: number
  protocol?: ModelProtocol   // 只有 DeepSeek 落盘；缺省按 protocolOf 解读（DeepSeek = anthropic，其它 = openai）
  multimodal?: boolean       // 支持图片；缺省按模型名猜（multimodalOf）
}

// 磁盘上存储的结构。apiKey 字段存的是密文（base64），不是明文。
// 老版本：单套 provider/model/baseUrl + key 按 provider 分槽（deepseek 在顶层，其余在 keys[provider]）。
// 现在：profiles 存多套配置，顶层 provider/model/baseUrl/contextWindow 只是默认配置的镜像（便于降级时还能读）。
// 老配置读的时候按 profilesOf 迁移（id 固定，未保存前反复读也一致），下次 save 落成新结构并去掉旧 key 槽。
export interface PersistedSettings extends KeySlot {
  provider: string
  model: string
  baseUrl: string
  keys?: Record<string, KeySlot>
  contextWindow?: number
  system?: SystemSettings   // 系统设置（明文；非敏感）
  usagePrices?: UsagePrices // 用量统计的模型单价（用量统计页单独读写，save 不动它）
  profiles?: PersistedProfile[]
  defaultProfileId?: string
}

// 主进程内部用：解密后的完整配置（含明文 key），不经 IPC
export interface ResolvedProfile { id: string; name: string; provider: ProviderId; model: string; baseUrl: string; contextWindow?: number; protocol: ModelProtocol; multimodal: boolean; apiKey: string }

// 「支持图片」：用户设过就按设置，没设过按模型名猜（已知视觉模型默认开）
export const multimodalOf = (x: { provider: string; model: string; multimodal?: unknown }): boolean =>
  typeof x.multimodal === 'boolean' ? x.multimodal : multimodalDefault(x.provider, x.model)

const slotOf = (p: PersistedSettings, provider: string): KeySlot | undefined =>
  provider === 'deepseek' ? p : p.keys?.[provider]
const hasKey = (s?: KeySlot) => !!(s?.apiKeyCipher || s?.apiKeyPlain)
const pickSlot = (s?: KeySlot): KeySlot => ({ apiKeyCipher: s?.apiKeyCipher, apiKeyPlain: s?.apiKeyPlain })
const isProvider = (v: unknown): v is ProviderId => PROVIDERS.some((x) => x.id === v)
export const newProfileId = () => `mp_${randomUUID().replace(/-/g, '').slice(0, 10)}`

/**
 * 取配置列表（含老配置迁移）。纯函数：
 *  - 已有 profiles → 原样（默认 id 不存在时取第一个）；
 *  - 老配置 → 当前那套成「默认」（id=default，带当前 provider 的 key）；其它 provider 已存的 key 各迁成一套
 *    （id=legacy_<provider>，名称=提供商名，模型 / 地址取该提供商默认值），key 不丢；
 *  - 什么都没有 → 一套空 key 的「默认」。
 */
export function profilesOf(p: PersistedSettings | null): { profiles: PersistedProfile[]; defaultProfileId: string } {
  // 文件 / 导入包里可能混入坏配置（缺 model、provider 不认识、不是对象）：跳过它们，
  // 不能让一条坏记录把 settings.get() 抛错、整个设置页永远「加载中」
  const clean = Array.isArray(p?.profiles) ? p!.profiles.map(sanitizeProfile).filter((x): x is PersistedProfile => !!x) : []
  if (clean.length) {
    const def = clean.some((x) => x.id === p!.defaultProfileId) ? p!.defaultProfileId! : clean[0].id
    // 官方已下线的 DeepSeek 旧模型 id 读出时换成新 id（文件不动，下次保存时落盘）
    return { profiles: clean.map((x) => withCanonicalModel(x)), defaultProfileId: def }
  }
  const base = p ?? { ...DEFAULT_SETTINGS }
  const provider: ProviderId = isProvider(base.provider) ? base.provider : 'deepseek'
  const profiles: PersistedProfile[] = [{
    id: 'default', name: tr('默认'), provider, model: canonicalModel(provider, base.model, base.baseUrl), baseUrl: base.baseUrl,
    ...(base.contextWindow ? { contextWindow: base.contextWindow } : {}),
    ...(p ? pickSlot(slotOf(p, provider)) : {}),
  }]
  if (p) {
    for (const meta of PROVIDERS) {
      const slot = slotOf(p, meta.id)
      if (meta.id === provider || !hasKey(slot)) continue
      profiles.push({ id: `legacy_${meta.id.replace(/-/g, '_')}`, name: meta.label, provider: meta.id, model: meta.models[0].id, baseUrl: meta.defaultBaseUrl, ...pickSlot(slot) })
    }
  }
  return { profiles, defaultProfileId: 'default' }
}

/** system 合并默认值：只接受字段类型与默认值一致的项（老配置 / 导入包里的坏字段不会带崩页面） */
export function sanitizeSystem(v: unknown): SystemSettings {
  const out: SystemSettings = { ...DEFAULT_SYSTEM_SETTINGS }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return out
  const src = v as Record<string, unknown>
  const dst = out as unknown as Record<string, unknown>
  for (const k of Object.keys(DEFAULT_SYSTEM_SETTINGS) as (keyof SystemSettings)[]) {
    const val = src[k as string]
    if (val === undefined || val === null) continue
    const d = DEFAULT_SYSTEM_SETTINGS[k]
    if (Array.isArray(d)) { if (Array.isArray(val)) dst[k as string] = val }
    else if (d !== null && typeof d === 'object') {
      if (typeof val === 'object' && !Array.isArray(val)) dst[k as string] = val
    } else if (typeof val === typeof d) dst[k as string] = val
  }
  // 默认结构里没有、但其它模块会读的扩展字段（如 system.webhooks）：原样保留
  for (const [k, val] of Object.entries(src)) if (!(k in DEFAULT_SYSTEM_SETTINGS) && val !== undefined) dst[k] = val
  return out
}

/** 一条磁盘 / 导入配置 → 可用的 PersistedProfile；缺字段补默认值，认不出的丢弃 */
export function sanitizeProfile(x: unknown): PersistedProfile | undefined {
  if (!x || typeof x !== 'object') return undefined
  const p = x as Partial<PersistedProfile>
  if (typeof p.id !== 'string' || !MODEL_PROFILE_ID_RE.test(p.id) || !isProvider(p.provider)) return undefined
  const meta = providerMeta(p.provider)
  const model = typeof p.model === 'string' && p.model.trim() ? p.model : meta.models[0].id
  const baseUrl = typeof p.baseUrl === 'string' ? p.baseUrl : meta.defaultBaseUrl
  const name = typeof p.name === 'string' && p.name.trim() ? p.name : meta.label
  const slot = pickSlot(p)
  return {
    id: p.id, name, provider: p.provider, model: canonicalModel(p.provider, model, baseUrl), baseUrl,
    ...(typeof p.contextWindow === 'number' && Number.isFinite(p.contextWindow) ? { contextWindow: p.contextWindow } : {}),
    ...(p.protocol ? { protocol: p.protocol } : {}),
    ...(typeof p.multimodal === 'boolean' ? { multimodal: p.multimodal } : {}),
    ...(slot.apiKeyCipher || slot.apiKeyPlain ? slot : {}),
  }
}

function withCanonicalModel<T extends { provider: string; model: string; baseUrl: string }>(x: T): T {
  const model = canonicalModel(x.provider, x.model, x.baseUrl)
  return model === x.model ? x : { ...x, model }
}

const view = (x: PersistedProfile): ModelProfile => ({
  id: x.id, name: x.name, provider: x.provider, model: x.model, baseUrl: x.baseUrl, contextWindow: x.contextWindow ?? 0, hasApiKey: hasKey(x),
  protocol: protocolOf(x.provider, x.protocol), multimodal: multimodalOf(x),
})

export class SettingsStore {
  private filePath: string

  constructor(private dir: string, private enc: Encryptor) {
    this.filePath = join(dir, 'settings.json')
  }

  /** 读取设置。不回传明文 key：每套配置只标 hasApiKey；顶层字段是默认配置的镜像。 */
  get(): AppSettings {
    const p = this.read()
    const { profiles, defaultProfileId } = profilesOf(p)
    const d = profiles.find((x) => x.id === defaultProfileId)!
    return {
      provider: d.provider,
      model: d.model,
      baseUrl: d.baseUrl,
      hasApiKey: hasKey(d),
      keyedProviders: PROVIDERS.map((x) => x.id).filter((id) => profiles.some((pr) => pr.provider === id && hasKey(pr))),
      contextWindow: d.contextWindow ?? 0,
      // 合并而非整体回落：老配置里的 system 缺新字段时补默认值，否则 UI 会渲染出 undefined 的开关/输入框。
      // 类型不对（数组 / 字符串 / 坏对象）的字段丢弃，避免 commandRules.map 这类渲染崩溃
      system: sanitizeSystem(migrateAppearance(p?.system)),
      modelProfiles: profiles.map(view),
      defaultProfileId,
    }
  }

  private keyOf(s?: KeySlot): string {
    if (s?.apiKeyCipher && this.enc.available()) {
      try { return this.enc.decrypt(s.apiKeyCipher) } catch { return '' }
    }
    return s?.apiKeyPlain ?? ''
  }

  /**
   * 解密并返回某套配置（缺省 / 找不到 = 默认配置）的明文（仅主进程内部使用：注入引擎适配器读取的环境变量）。
   * 不经 IPC 暴露给渲染层。
   */
  resolveProfile(id?: string): ResolvedProfile {
    const { profiles, defaultProfileId } = profilesOf(this.read())
    const x = profiles.find((pr) => pr.id === id) ?? profiles.find((pr) => pr.id === defaultProfileId)!
    return { id: x.id, name: x.name, provider: x.provider, model: x.model, baseUrl: x.baseUrl, contextWindow: x.contextWindow, protocol: protocolOf(x.provider, x.protocol), multimodal: multimodalOf(x), apiKey: this.keyOf(x) }
  }

  /** 默认配置的明文 key（兼容旧调用） */
  getApiKey(): string { return this.resolveProfile().apiKey }

  /** 某套配置已存的明文 key（测试连接时表单没填 key 用；不存在为空串） */
  getProfileKey(id: string): string {
    return this.keyOf(profilesOf(this.read()).profiles.find((x) => x.id === id))
  }

  /** 所有配置的明文 key（诊断包抹日志 / 发给 AI 前脱敏的已知机密）；解不开的跳过 */
  allApiKeys(): string[] {
    return profilesOf(this.read()).profiles.map((x) => this.keyOf(x)).filter(Boolean)
  }

  private seal(key: string): KeySlot {
    return this.enc.available() ? { apiKeyCipher: this.enc.encrypt(key), apiKeyPlain: undefined } : { apiKeyPlain: key, apiKeyCipher: undefined }
  }

  /**
   * 保存设置。
   * - 带 modelProfiles：整表替换。每套 apiKey 有值则加密存进它自己的槽；为空保留同 id 已存的 key——
   *   但换了提供商的不保留（不把 A 家的 key 发到 B 家端点）。
   * - 不带（系统设置页等）：配置不动；顶层带了 provider/model 的按旧接口改默认配置（换提供商同样丢 key）。
   */
  save(settings: AppSettings): void {
    const prev = this.read()
    const cur = profilesOf(prev)
    let profiles: PersistedProfile[]
    let defaultProfileId = cur.defaultProfileId
    if (settings.modelProfiles) {
      profiles = this.normalize(settings.modelProfiles, cur.profiles)
      if (!profiles.length) throw new Error(tr('至少保留一个模型配置'))
      const want = settings.defaultProfileId ?? defaultProfileId
      defaultProfileId = profiles.some((x) => x.id === want) ? want : profiles[0].id
    } else {
      profiles = cur.profiles.map((x) => ({ ...x }))
      const d = profiles.find((x) => x.id === defaultProfileId)!
      if (settings.provider && isProvider(settings.provider)) {
        if (settings.provider !== d.provider) { Object.assign(d, pickSlot(undefined)); delete d.protocol }
        Object.assign(d, { provider: settings.provider, model: settings.model ?? d.model, baseUrl: settings.baseUrl ?? d.baseUrl })
      }
      if (settings.contextWindow !== undefined) d.contextWindow = settings.contextWindow || undefined
      if (settings.apiKey) Object.assign(d, this.seal(settings.apiKey))
    }
    const d = profiles.find((x) => x.id === defaultProfileId)!
    const next: PersistedSettings = {
      provider: d.provider, model: d.model, baseUrl: d.baseUrl, contextWindow: d.contextWindow,
      profiles, defaultProfileId,
      // system 传了用新的，没传保留旧值（避免只改模型设置时抹掉 system，反之亦然）
      system: settings.system ?? prev?.system,
      usagePrices: prev?.usagePrices,
    }
    this.write(next)
  }

  // 规整渲染层传来的配置表：id 非法 / 重复的换新 id；名称、模型为空补默认；key 规则见 save
  private normalize(input: ModelProfile[], prev: PersistedProfile[]): PersistedProfile[] {
    const seen = new Set<string>()
    return input.map((x) => {
      let id = typeof x.id === 'string' && MODEL_PROFILE_ID_RE.test(x.id) && !seen.has(x.id) ? x.id : newProfileId()
      while (seen.has(id)) id = newProfileId()
      seen.add(id)
      const provider: ProviderId = isProvider(x.provider) ? x.provider : 'openai-compatible'
      const meta = providerMeta(provider)
      const model = canonicalModel(provider, String(x.model ?? '').trim() || meta.models[0].id, String(x.baseUrl ?? ''))
      const cw = Number(x.contextWindow)
      // 没填新 key：沿用同 id 的；复制出的新配置沿用来源配置的（keyFrom）
      const old = prev.find((o) => o.id === id) ?? (x.keyFrom ? prev.find((o) => o.id === x.keyFrom) : undefined)
      const slot = x.apiKey ? this.seal(x.apiKey) : old && old.provider === provider ? pickSlot(old) : {}
      return {
        id, name: String(x.name ?? '').trim().slice(0, 60) || model, provider, model,
        baseUrl: String(x.baseUrl ?? '').trim() || meta.defaultBaseUrl,
        ...(Number.isFinite(cw) && cw > 0 ? { contextWindow: Math.floor(cw) } : {}),
        // 协议只对 DeepSeek 有意义：非法 / 缺省规整成 anthropic；其它提供商不落盘
        ...(provider === 'deepseek' ? { protocol: protocolOf(provider, x.protocol) } : {}),
        ...(typeof x.multimodal === 'boolean' ? { multimodal: x.multimodal } : {}),
        ...slot,
      }
    })
  }

  /** 模型单价（默认空表） */
  getUsagePrices(): UsagePrices {
    const p = this.read()?.usagePrices
    return { currency: p?.currency === 'USD' ? 'USD' : 'CNY', models: Array.isArray(p?.models) ? p.models : [] }
  }

  /** 保存单价：去掉 provider/model 为空的行，同 provider+model 后者覆盖前者，负数/非数字视为未填 */
  saveUsagePrices(prices: UsagePrices): UsagePrices {
    const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined)
    const models = new Map<string, ModelPrice>()
    for (const m of prices.models ?? []) {
      const provider = String(m.provider ?? '').trim(), model = String(m.model ?? '').trim()
      if (provider && model) models.set(`${provider}\n${model}`, { provider, model, input: num(m.input), cacheRead: num(m.cacheRead), output: num(m.output) })
    }
    const next: UsagePrices = { currency: prices.currency === 'USD' ? 'USD' : 'CNY', models: [...models.values()] }
    const prev = this.read() ?? { provider: DEFAULT_SETTINGS.provider, model: DEFAULT_SETTINGS.model, baseUrl: DEFAULT_SETTINGS.baseUrl }
    this.write({ ...prev, usagePrices: next })
    return next
  }

  private read(): PersistedSettings | null {
    return readJson<PersistedSettings>(this.filePath) ?? null
  }

  private write(p: PersistedSettings): void { writeJson(this.filePath, p) }
}
