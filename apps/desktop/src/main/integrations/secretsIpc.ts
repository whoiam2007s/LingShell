// 密钥保险箱（设置 → 连接 →「密钥保险箱」）：值经系统密钥链加密存 secrets.json，只进不出（渲染层只拿摘要）。
// 本文件同时是 AI 侧的实现（dsh-controller 的 SecretVault）：exec 类命令里的 {{secret:名称}} 发进终端前才展开成明文，
// 工具结果 / 会话日志 / 录像里的明文换回占位符。撰写栏发送含占位符的内容也走这里（secrets:send）。
import type { SecretStore } from '@lingshell/config'
import type { SecretVault } from '@lingshell/dsh-controller'
import {
  secretRefs, checkSecretRefs, expandSecrets, maskSecrets, maskToolText, buildSecretsPrompt, SecretStreamMasker,
  type SecretInput, type SecretPlain,
  tr,
} from '@lingshell/shared'

export const CLIPBOARD_CLEAR_SEC = 30

export interface SecretsIpcDeps {
  handle(channel: string, fn: (e: unknown, ...args: unknown[]) => unknown): void
  store: Pick<SecretStore, 'list' | 'save' | 'delete' | 'resolve' | 'resolveAll'>
  hostKeyOf(terminalId: string): string | undefined          // 终端 → 'local' | 主机 id | host:port；不存在 undefined
  hosts(): { id: string; label: string; group?: string }[]
  clipboard: { writeText(s: string): void; readText(): string }
  // 撰写栏：wire（已展开，含明文）写进终端；shown（占位符原文）记命令历史 / 录像键入
  write(terminalId: string, wire: string, shown: string): void
  busy?(terminalId: string): boolean
  onChange?(): void
  now?(): number
}

export interface SecretsService extends SecretVault {
  values(): SecretPlain[]
  /** 纯文本回写（会话日志按行用） */
  maskText(text: string): string
  /** 原样展开（不加 shell 引号）：接口调试的 URL / 请求头 / 请求体用；hostKey 决定可用范围，不能用时抛错 */
  expandRaw(hostKey: string, text: string): string
  /** 流式回写（录像按 chunk 用） */
  stream(): SecretStreamMasker
  invalidate(): void
  /** 退出前调用：剪贴板里若还是复制出去的密钥值就清空（定时器随进程结束就没了） */
  clearClipboardIfSecret(): void
}

const str = (v: unknown, what: string): string => { if (typeof v !== 'string' || !v) throw new Error(tr('非法的{what}', { what })); return v }

export function registerSecrets(d: SecretsIpcDeps): SecretsService {
  const now = d.now ?? Date.now
  // 解密结果缓存 5 秒（每个工具结果 / 每段录像输出都要用）；自己改了立即失效，配置导入等外部改动最多 5 秒后生效
  let cache: { at: number; list: SecretPlain[] } | undefined
  const values = () => {
    if (!cache || now() - cache.at > 5000) cache = { at: now(), list: d.store.resolveAll() }
    return cache.list
  }
  const invalidate = () => { cache = undefined; d.onChange?.() }
  // 复制到剪贴板：每个值一个定时器（重复复制同一个值会重置成完整 30 秒，而不是被前一个定时器提前清掉）
  const clearTimers = new Map<string, ReturnType<typeof setTimeout>>()
  const armClear = (v: string) => {
    const prev = clearTimers.get(v)
    if (prev) clearTimeout(prev)
    const t = setTimeout(() => {
      clearTimers.delete(v)
      try { if (d.clipboard.readText() === v) d.clipboard.writeText('') } catch { /* 剪贴板不可用就算了 */ }
    }, CLIPBOARD_CLEAR_SEC * 1000)
    t.unref?.()
    clearTimers.set(v, t)
  }
  const clearClipboardIfSecret = () => {
    for (const [v, t] of clearTimers) {
      clearTimeout(t)
      try { if (d.clipboard.readText() === v) d.clipboard.writeText('') } catch { /* 同上 */ }
    }
    clearTimers.clear()
  }
  const hostLabel = (id: string) => d.hosts().find((h) => h.id === id)?.label ?? id
  const where = (hk: string) => (hk === 'local' ? '本地终端' : hostLabel(hk))   // i18n-ignore 拼进回给模型的工具报错（shared/ui/secretVault.ts）
  const checkFor = (hk: string, command: string) =>
    checkSecretRefs(command, d.store.list(), hk, d.hosts().find((h) => h.id === hk)?.group, where(hk), hostLabel)
  const expandFor = (hk: string, command: string) => {
    const err = checkFor(hk, command)
    if (err) throw new Error(err)
    const map = new Map(values().map((s) => [s.name, s.value]))
    return expandSecrets(command, (n) => {
      const v = map.get(n)
      if (!v) throw new Error(`secret_unreadable: 密钥「${n}」无法解密（系统密钥变化？），请在 设置 → 密钥保险箱 里替换值`)   // i18n-ignore 工具报错回给模型（同 checkSecretRefs）
      return v
    })
  }

  const svc: SecretsService = {
    check: (tid, command) => {
      if (!secretRefs(command).length) return undefined
      const hk = d.hostKeyOf(tid)
      return hk === undefined ? undefined : checkFor(hk, command)
    },
    expand: (tid, command) => {
      const hk = d.hostKeyOf(tid)
      if (hk === undefined) throw new Error(`terminal_not_found: ${tid}`)
      return expandFor(hk, command)
    },
    mask: (text) => maskToolText(text, values()),
    maskText: (text) => maskSecrets(text, values()),
    expandRaw: (hk, text) => {
      if (!secretRefs(text).length) return text
      const err = checkFor(hk, text)
      if (err) throw new Error(err.replace(/^secret_\w+: /, ''))
      const map = new Map(values().map((s) => [s.name, s.value]))
      return text.replace(/\{\{secret:([a-z0-9_-]{1,64})\}\}/g, (_m, n: string) => {
        const v = map.get(n)
        if (!v) throw new Error(tr('密钥「{name}」无法解密（系统密钥变化？），请在 设置 → 密钥保险箱 里替换值', { name: n }))
        return v
      })
    },
    prompt: () => buildSecretsPrompt(d.store.list(), hostLabel),
    stream: () => new SecretStreamMasker(values),
    values,
    invalidate,
    clearClipboardIfSecret,
  }

  d.handle('secrets:list', () => d.store.list())
  d.handle('secrets:save', (_e, input) => {
    if (!input || typeof input !== 'object') throw new Error(tr('secret|非法的密钥'))
    const r = d.store.save(input as SecretInput)
    invalidate()
    return r
  })
  d.handle('secrets:delete', (_e, id) => { d.store.delete(str(id, tr('arg|密钥'))); invalidate() })
  // 复制值到剪贴板（界面已二次确认）：30 秒后剪贴板里还是它就清空
  d.handle('secrets:copy', (_e, id) => {
    const v = d.store.resolve(str(id, tr('arg|密钥')))
    if (!v) throw new Error(`secret_unreadable: ${tr('该密钥没有值或无法解密，请先替换值')}`)
    d.clipboard.writeText(v)
    armClear(v)
    return CLIPBOARD_CLEAR_SEC
  })
  // 撰写栏发送含占位符的内容：逐行展开（先全部校验，有一行不行就整段不发），含密钥的行前加空格（HISTCONTROL=ignorespace 时不进 bash 历史）
  d.handle('secrets:send', (_e, terminalId, data) => {
    const tid = str(terminalId, tr('arg|终端')), text = String(data ?? '')
    const hk = d.hostKeyOf(tid)
    if (hk === undefined) throw new Error(tr('终端不存在'))
    if (d.busy?.(tid)) throw new Error(tr('终端正忙（AI 正在执行命令）'))
    const wire = text.split('\r').map((line) => (secretRefs(line).length ? ` ${expandFor(hk, line)}` : line)).join('\r')
    d.write(tid, wire, text)
  })
  return svc
}
