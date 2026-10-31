import { describe, it, expect, vi, afterEach } from 'vitest'
import { createAutoSaver, delayOf, errorText, mergeSystem, profileError, proxyError, DELAY_QUICK, DELAY_TEXT, type AutoSaveState } from './autoSave.js'

const setup = (o: { validate?: () => string | null; defer?: () => boolean; fail?: () => boolean } = {}) => {
  const states: AutoSaveState['status'][] = []
  let value = 0
  const saved: number[] = []
  let gate: (() => void) | null = null   // 非空 = 保存挂起，手动放行
  let hold = false
  const s = createAutoSaver({
    save: () => {
      const v = value
      if (hold) return new Promise<void>((r) => { gate = () => { saved.push(v); r() } })
      if (o.fail?.()) return Promise.reject(new Error("Error invoking remote method 'settings:save': Error: disk_full: 磁盘满了"))
      saved.push(v); return Promise.resolve()
    },
    validate: o.validate, defer: o.defer,
    onState: (st) => states.push(st.status),
  })
  return { s, states, saved, change: (v: number, d?: number) => { value = v; s.schedule(d) }, hold: (h: boolean) => { hold = h }, release: () => { const g = gate; gate = null; g?.() } }
}

describe('createAutoSaver 防抖自动保存', () => {
  afterEach(() => vi.useRealTimers())

  it('连续改动只在最后一次之后防抖到点存一次，存最新值', async () => {
    vi.useFakeTimers()
    const t = setup()
    t.change(1); await vi.advanceTimersByTimeAsync(500)
    t.change(2); await vi.advanceTimersByTimeAsync(500)
    t.change(3)
    expect(t.saved).toEqual([])
    await vi.advanceTimersByTimeAsync(DELAY_TEXT)
    expect(t.saved).toEqual([3])
    expect(t.states.at(-1)).toBe('saved')
    expect(t.s.dirty).toBe(false)
  })

  it('flush：防抖没到点也立即存（关弹窗 / 切页）；没改动时 flush 不存', async () => {
    vi.useFakeTimers()
    const t = setup()
    await t.s.flush()
    expect(t.saved).toEqual([])
    t.change(7)
    await t.s.flush()
    expect(t.saved).toEqual([7])
    await vi.advanceTimersByTimeAsync(DELAY_TEXT * 2)
    expect(t.saved).toEqual([7])   // 计时器已清，不重复存
  })

  it('校验不过：不存、状态 invalid；flush 也不存；改合法后再存', async () => {
    vi.useFakeTimers()
    let bad = true
    const t = setup({ validate: () => (bad ? '正则不合法' : null) })
    t.change(1)
    expect(t.states.at(-1)).toBe('invalid')
    await vi.advanceTimersByTimeAsync(DELAY_TEXT)
    await t.s.flush()
    expect(t.saved).toEqual([])
    bad = false
    t.change(2)
    await vi.advanceTimersByTimeAsync(DELAY_TEXT)
    expect(t.saved).toEqual([2])
  })

  it('defer（密码框还在输入）：到点先不存，等 flush（失焦）再存', async () => {
    vi.useFakeTimers()
    let typing = true
    const t = setup({ defer: () => typing })
    t.change(5)
    await vi.advanceTimersByTimeAsync(DELAY_TEXT * 3)
    expect(t.saved).toEqual([])
    expect(t.s.dirty).toBe(true)
    typing = false
    await t.s.flush()
    expect(t.saved).toEqual([5])
  })

  it('保存进行中又改：不并发，存完再按最新值补存一次', async () => {
    vi.useFakeTimers()
    const t = setup()
    t.hold(true)
    t.change(1)
    const p = t.s.flush()
    t.change(2)
    void t.s.flush()   // 存着呢：只记下要补存
    t.hold(false)
    t.release(); await p
    await vi.advanceTimersByTimeAsync(0)
    expect(t.saved).toEqual([1, 2])
  })

  it('保存失败：状态 error 带去掉前缀的原因，保持待存；retry 成功', async () => {
    vi.useFakeTimers()
    let fail = true
    const t = setup({ fail: () => fail })
    const errs: string[] = []
    const s = createAutoSaver({ save: () => (fail ? Promise.reject(new Error("Error invoking remote method 'x': Error: proxy_invalid: 端口不对")) : Promise.resolve()), onState: (st) => { if (st.error) errs.push(st.error) } })
    s.schedule(); await s.flush()
    expect(errs).toEqual(['端口不对'])
    expect(s.dirty).toBe(true)
    t.change(1); await t.s.flush()
    expect(t.states.at(-1)).toBe('error')
    fail = false
    await t.s.retry()
    expect(t.saved).toEqual([1])
    expect(t.states.at(-1)).toBe('saved')
  })
})

describe('自动保存的纯规则', () => {
  it('delayOf：只改开关用短防抖，含文本 / 数字 / 列表用长防抖', () => {
    expect(delayOf({ sessionLog: true })).toBe(DELAY_QUICK)
    expect(delayOf({ externalEditor: 'code' })).toBe(DELAY_TEXT)
    expect(delayOf({ historyLimit: 100 })).toBe(DELAY_TEXT)
    expect(delayOf({ commandRules: [] })).toBe(DELAY_TEXT)
  })
  it('mergeSystem：只把本页改过的字段盖到最新值上', () => {
    const latest = { a: 1, b: 'new-from-elsewhere', c: true }
    const page = { a: 2, b: 'stale', c: false }
    expect(mergeSystem(latest, page, ['a', 'c'])).toEqual({ a: 2, b: 'new-from-elsewhere', c: false })
  })
  it('proxyError：开着时地址必填、端口 1–65535；关着不校验', () => {
    expect(proxyError(true, { host: '', port: '1080' })).toBeTruthy()
    expect(proxyError(true, { host: 'p', port: '70000' })).toBeTruthy()
    expect(proxyError(true, { host: 'p', port: '1080' })).toBeNull()
    expect(proxyError(false, { host: '', port: '' })).toBeNull()
  })
  it('profileError：模型必填；换了提供商没填新 Key 先不存', () => {
    const base = { model: 'm', provider: 'qwen', savedProvider: 'deepseek', hasApiKey: true }
    expect(profileError({ ...base, model: ' ' }, true)).toBe('模型不能为空')
    expect(profileError(base, true)).toMatch(/API Key/)
    expect(profileError({ ...base, apiKey: 'sk-x' }, true)).toBeNull()
    expect(profileError(base, false)).toBeNull()   // 换成不需要 Key 的（如 Ollama）
    expect(profileError({ ...base, provider: 'deepseek' }, true)).toBeNull()
  })
  it('errorText：去掉 IPC 与错误码前缀', () => {
    expect(errorText(new Error("Error invoking remote method 'settings:save': Error: disk_full: 磁盘满了"))).toBe('磁盘满了')
    expect(errorText('普通错误')).toBe('普通错误')
  })
})
