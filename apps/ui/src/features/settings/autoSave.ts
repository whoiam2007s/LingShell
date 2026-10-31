// 设置页「修改即自动保存」的纯逻辑：防抖 + 串行保存 + 校验拦截 + 立即落盘（flush）+ 失败重试。
// 不依赖 React / DOM，便于单测；React 外壳见 useAutoSave.ts。
import { tr } from '@lingshell/shared'
export type AutoSaveStatus = 'idle' | 'pending' | 'saving' | 'saved' | 'error' | 'invalid'
export interface AutoSaveState { status: AutoSaveStatus; error?: string }

export interface AutoSaverOptions {
  save: () => Promise<void>
  /** 返回错误文案 = 当前值不合法：不保存，等改合法后再存 */
  validate?: () => string | null | undefined
  /** 防抖到点时返回 true 就先不存，等 flush（如密码框还在输入，免得存进半截 Key） */
  defer?: () => boolean
  onState: (s: AutoSaveState) => void
}

/** 文本 / 数字输入用长防抖，开关 / 下拉等一次到位的用短防抖 */
export const DELAY_TEXT = 800
export const DELAY_QUICK = 300

/** 去掉 Electron IPC 包的前缀和主进程错误码前缀，只留中文原因 */
export const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e))
  .replace(/^Error invoking remote method '[^']+': (Error: )?/, '').replace(/^[a-z_]+: /, '')

export function createAutoSaver(o: AutoSaverOptions) {
  let timer: ReturnType<typeof setTimeout> | null = null
  let dirty = false
  let running: Promise<void> | null = null
  let again = false
  const clear = () => { if (timer) { clearTimeout(timer); timer = null } }
  const invalid = () => { const e = o.validate?.(); if (e) { o.onState({ status: 'invalid', error: e }); return true } return false }

  const run = (): Promise<void> => {
    clear()
    if (!dirty) return running ?? Promise.resolve()
    if (invalid()) return Promise.resolve()
    if (running) { again = true; return running }   // 上一次还没存完：存完再按最新值存一次
    dirty = false
    o.onState({ status: 'saving' })
    running = o.save().then(
      () => { o.onState({ status: 'saved' }) },
      (e: unknown) => { dirty = true; o.onState({ status: 'error', error: errorText(e) }) },
    ).finally(() => {
      running = null
      if (again) { again = false; void run() }
    })
    return running
  }

  return {
    /** 值变了：标脏并（重新）开始防抖计时 */
    schedule(delay = DELAY_TEXT) {
      dirty = true
      clear()
      if (invalid()) return
      o.onState({ status: 'pending' })
      timer = setTimeout(() => { timer = null; if (!o.defer?.()) void run() }, delay)
    },
    /** 有未落盘的改动就立即保存（关弹窗 / 切页 / 关窗口 / 失焦时调） */
    flush: run,
    /** 失败后重试 */
    retry: () => { dirty = true; return run() },
    dispose: clear,
    get dirty() { return dirty },
  }
}
export type AutoSaver = ReturnType<typeof createAutoSaver>

// ── 各页共用的纯规则 ──

/** 只改了开关这类一次到位的值用短防抖，其它（文本、数字、规则列表）用长防抖 */
export const delayOf = (p: object) => (Object.values(p).every((v) => typeof v === 'boolean') ? DELAY_QUICK : DELAY_TEXT)

/** 本页改过的字段盖到最新的 system 上：别处（其它页、外观、Git Bash 路径、AI 记本机备注）同时改的字段不被本页加载时的旧值覆盖 */
export function mergeSystem<T extends object>(latest: T, page: T, dirty: Iterable<keyof T>): T {
  const out = { ...latest }
  for (const k of dirty) out[k] = page[k]
  return out
}

/** 网络代理：开着时地址必填、端口 1–65535 */
export function proxyError(on: boolean, d: { host: string; port: string }): string | null {
  const port = Number(d.port)
  return on && (!d.host.trim() || !(Number.isInteger(port) && port >= 1 && port <= 65535)) ? tr('请填代理地址和 1–65535 的端口') : null
}

/** 模型配置：模型必填；换了提供商（原来有 Key）却还没填新 Key 时先不存，免得把原 Key 丢掉 */
export function profileError(f: { model: string; provider: string; savedProvider?: string; hasApiKey?: boolean; keyFrom?: string; apiKey?: string }, needsApiKey: boolean): string | null {
  if (!f.model.trim()) return tr('模型不能为空')
  if (f.savedProvider && f.provider !== f.savedProvider && (f.hasApiKey || f.keyFrom) && !f.apiKey && needsApiKey) return tr('换了提供商，填入新的 API Key 后自动保存')
  return null
}
