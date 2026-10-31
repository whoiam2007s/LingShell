import { useEffect, useState, useCallback } from 'react'
import { Bot, Pencil, Trash2, Plus, Send } from 'lucide-react'
import { checkWebhookUrl, detectWebhookType, tk, tr, type WebhookInput, type WebhookSummary, type WebhookType } from '@lingshell/shared'
import { client } from '../../../client/index.js'
import { ConfirmDialog } from '../../common/index.js'
import { Switch } from '../../../components/ui/Switch.js'
import { Sel } from '../../../components/ui/form.js'
import { Section, Row, INPUT, BTN2, BTN1, ICON_BTN, ICON_DEL, ITEM, errText } from '../ui.js'
import { PasswordInput } from '../../../components/ui/PasswordInput.js'

export const WEBHOOK_TYPES: Record<WebhookType, string> = { dingtalk: tk('钉钉'), wecom: tk('企业微信'), feishu: tk('飞书'), generic: tk('通用 JSON') }
// 粘贴地址识别出平台后，名称为空（或仍是自动名）时自动填（填的是当前语言的名字，比较时也按 tr 后的值）
const AUTO_NAME: Partial<Record<WebhookType, string>> = { dingtalk: tk('钉钉告警群'), wecom: tk('企业微信告警群'), feishu: tk('飞书告警群') }
// 密钥框：企微/通用不用密钥，不显示
const SECRET: Partial<Record<WebhookType, { label: string; hint?: string; placeholder: string; note: string }>> = {
  dingtalk: { label: tk('加签密钥'), placeholder: tk('SEC 开头的密钥'), note: tk('选了加签就必须填；选了自定义关键词则关键词要包含「巡检」（消息里都带这两个字）') },
  feishu: { label: tk('签名密钥'), hint: tk('可选'), placeholder: tk('开启「签名校验」时填'), note: tk('开启了签名校验才需要填；设了自定义关键词的话要包含「巡检」') },
}
const GUIDE: Partial<Record<WebhookType, string[]>> = {
  dingtalk: [tk('群设置 → 机器人 → 添加机器人 → 自定义'), tk('安全设置选「加签」并复制密钥（或选「自定义关键词」填 巡检）'), tk('完成后复制 Webhook 地址，粘贴到上面')],
  wecom: [tk('群聊右上角 … → 消息推送（或「群机器人」）→ 添加'), tk('起个名字，创建'), tk('复制 Webhook 地址粘贴到上面（无需密钥）')],
  feishu: [tk('群设置 → 群机器人 → 添加机器人 → 自定义机器人'), tk('可开启「签名校验」并复制密钥'), tk('复制 Webhook 地址，粘贴到上面')],
}

type Form = WebhookInput & { hasSecret?: boolean }

// 定时巡检页里的「告警推送（群机器人）」分组：增删改/启停/发测试消息。URL 与密钥只进不出（编辑时留空 = 不变）
export function WebhookManager({ onChanged }: { onChanged?: () => void }) {
  const [list, setList] = useState<WebhookSummary[]>([])
  const [form, setForm] = useState<Form | null>(null)
  const [del, setDel] = useState<WebhookSummary | null>(null)
  const [err, setErr] = useState('')
  const [test, setTest] = useState<Record<string, string>>({})   // id → 测试结果文案

  const refresh = useCallback(() => { client.webhooks.list().then(setList).catch(() => {}); onChanged?.() }, [onChanged])
  useEffect(() => { client.webhooks.list().then(setList).catch(() => {}) }, [])

  const sendTest = (id: string) => {
    setTest((t) => ({ ...t, [id]: tr('发送中…') }))
    client.webhooks.test(id).then(() => setTest((t) => ({ ...t, [id]: tr('✓ 测试消息已发送，去群里看看') }))).catch((e) => setTest((t) => ({ ...t, [id]: `✗ ${errText(e)}` })))
  }
  // 新建或改了地址/密钥：保存后自动发测试消息，结果显示在列表行内；测试失败不影响保存
  const save = async (f: Form) => {
    const sec = !!SECRET[f.type]
    try {
      const w = await client.webhooks.save({ id: f.id, name: f.name, type: f.type, url: f.url, secret: sec ? f.secret : undefined, clearSecret: sec && f.clearSecret, enabled: f.enabled })
      setForm(null); setErr(''); refresh()
      if (!f.id || f.url?.trim() || (sec && (f.secret || f.clearSecret))) sendTest(w.id)
    } catch (e) { setErr(errText(e)) }
  }
  const toggle = (w: WebhookSummary, enabled: boolean) => { client.webhooks.save({ id: w.id, name: w.name, type: w.type, enabled }).then(refresh).catch((e) => setErr(errText(e))) }
  // 粘贴地址：认出钉钉/企微/飞书就切类型；名称空着就顺手填
  const onUrl = (f: Form, url: string) => {
    const t = detectWebhookType(url.trim())
    const auto = AUTO_NAME[t ?? 'generic']
    if (!t || !auto) return setForm({ ...f, url })
    const name = tr(auto)
    setForm({ ...f, url, type: t, name: !f.name.trim() || Object.values(AUTO_NAME).some((n) => n === f.name || tr(n) === f.name) ? name : f.name })
  }
  // 默认「通用 JSON」：粘贴钉钉 / 企微 / 飞书地址会自动切成对应平台；以前默认钉钉，粘通用地址时类型不会跟着变
  const add = () => { setForm({ name: '', type: 'generic', url: '', enabled: true }); setErr('') }

  const tip = tr('巡检结果为异常、失败或超时时推送到这些群（可按巡检改为每次都推）。机器人只由定时巡检触发；保存新地址后会自动发一条测试消息。')
  const addBtn = <button onClick={add} className={`flex items-center gap-1 ${BTN2}`}><Plus className="h-3.5 w-3.5" />{tr('添加机器人')}</button>

  if (form) {
    const url = form.url?.trim()
    const urlErr = url ? checkWebhookUrl(url) : undefined
    const detectedType = url ? detectWebhookType(url) : undefined
    const detected = url && detectedType === form.type && AUTO_NAME[form.type] ? tr('已识别为 {type}', { type: tr(WEBHOOK_TYPES[form.type]) }) : undefined
    const mismatch = detectedType && detectedType !== form.type && AUTO_NAME[detectedType] ? tr('地址像是 {detected} 的，当前类型是 {type}，请确认', { detected: tr(WEBHOOK_TYPES[detectedType]), type: tr(WEBHOOK_TYPES[form.type]) }) : undefined
    const secret = SECRET[form.type], guide = GUIDE[form.type]
    return (
      <Section title={form.id ? tr('编辑机器人') : tr('添加机器人')} tip={tip}>
        <Row label={tr('Webhook 地址')} wide hint={urlErr ? <span className="text-[var(--color-danger)]">{tr(urlErr)}</span> : detected ? <span className="text-[var(--color-success)]">{detected}</span> : mismatch ? <span className="text-[var(--color-warn)]">{mismatch}</span> : undefined}
          tip={guide ? <><div className="mb-1">{tr('怎么获取地址（{type}）：', { type: tr(WEBHOOK_TYPES[form.type]) })}</div><ol className="list-decimal space-y-0.5 pl-4">{guide.map((s) => <li key={s}>{tr(s)}</li>)}</ol></> : tr('粘贴群机器人地址，能自动识别钉钉 / 企业微信 / 飞书。')}>
          <input value={form.url ?? ''} onChange={(e) => onUrl(form, e.target.value)} placeholder={form.id ? tr('留空保持不变') : tr('粘贴群机器人地址，自动识别平台')} className={`w-full ${INPUT}`} />
        </Row>
        <Row label={tr('类型')}>
          <div className="w-40">
            <Sel value={form.type} onChange={(v) => setForm({ ...form, type: v as WebhookType })}>
              {Object.entries(WEBHOOK_TYPES).map(([k, v]) => <option key={k} value={k}>{tr(v)}</option>)}
            </Sel>
          </div>
        </Row>
        <Row label={tr('名称')}><input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder={tr('如：运维告警群')} className={`w-60 ${INPUT}`} /></Row>
        {secret && (
          <Row label={tr(secret.label)} hint={secret.hint && tr(secret.hint)} tip={tr(secret.note)}>
            <PasswordInput value={form.secret ?? ''} onChange={(e) => setForm({ ...form, secret: e.target.value, clearSecret: false })}
              placeholder={form.hasSecret && !form.clearSecret ? tr('已设置，留空保持不变') : tr(secret.placeholder)} className={`w-60 ${INPUT}`} />
          </Row>
        )}
        {secret && form.hasSecret && !form.secret && (
          <Row label={tr('清除已存的密钥')}><Switch checked={!!form.clearSecret} onCheckedChange={(v) => setForm({ ...form, clearSecret: v })} /></Row>
        )}
        <Row label={tr('启用')}><Switch checked={form.enabled} onCheckedChange={(v) => setForm({ ...form, enabled: v })} /></Row>
        <div className="flex items-center gap-2 px-3.5 py-2.5">
          {err && <span className="min-w-0 truncate text-[12px] text-[var(--color-danger)]" title={err}>{err}</span>}
          <button onClick={() => { setForm(null); setErr('') }} className={`ml-auto ${BTN2}`}>{tr('取消')}</button>
          <button onClick={() => save(form)} disabled={!form.name.trim() || (!form.id && !form.url?.trim()) || !!urlErr} className={BTN1}>{tr('保存')}</button>
        </div>
      </Section>
    )
  }

  return (
    <Section title={tr('告警推送（群机器人）')} tip={tip} actions={addBtn}>
      {list.length === 0 ? (
        <div className="px-3.5 py-5 text-center text-[12px] text-[var(--color-text-muted)]">{tr('未配置。可推送到钉钉 / 企业微信 / 飞书群')}</div>
      ) : list.map((w) => (
        <div key={w.id} className={ITEM}>
          <Bot className="h-3.5 w-3.5 shrink-0 text-[var(--color-accent)]" />
          <span className="shrink-0 font-medium text-[var(--color-text-primary)]">{w.name}</span>
          <span className="shrink-0 text-[11px] text-[var(--color-text-muted)]">{tr(WEBHOOK_TYPES[w.type])}{w.hasSecret ? tr(' · 已加签') : ''}</span>
          <span className={`min-w-0 flex-1 text-[11px] ${test[w.id]?.startsWith('✗') ? 'break-all' : 'truncate'}`} title={test[w.id]} style={{ color: test[w.id]?.startsWith('✗') ? 'var(--color-danger)' : 'var(--color-text-muted)' }}>{test[w.id] ?? w.urlHint}</span>
          <Switch checked={w.enabled} onCheckedChange={(v) => toggle(w, v)} title={w.enabled ? tr('已启用') : tr('已停用')} />
          <button onClick={() => sendTest(w.id)} disabled={test[w.id] === tr('发送中…')} title={tr('发送测试消息')} className={ICON_BTN}><Send className="h-3 w-3" /></button>
          <button onClick={() => { setForm({ id: w.id, name: w.name, type: w.type, enabled: w.enabled, hasSecret: w.hasSecret }); setErr('') }} title={tr('编辑')} className={ICON_BTN}><Pencil className="h-3 w-3" /></button>
          <button onClick={() => setDel(w)} title={tr('删除')} className={ICON_DEL}><Trash2 className="h-3 w-3" /></button>
        </div>
      ))}
      {err && <div className="px-3.5 py-2 text-[12px] text-[var(--color-danger)]">{err}</div>}
      <ConfirmDialog open={!!del} title={tr('删除机器人')} message={tr('确定删除 {name}？引用它的巡检将不再推送到这里。', { name: del?.name ?? '' })}
        onConfirm={() => { if (del) client.webhooks.delete(del.id).then(refresh); setDel(null) }} onCancel={() => setDel(null)} />
    </Section>
  )
}
