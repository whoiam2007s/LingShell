import { useEffect, useState, useCallback } from 'react'
import { Zap, Pencil, Trash2, Plus } from 'lucide-react'
import { checkAutoReplyPattern, tr, type AutoReplyInput, type AutoReplySummary, type HostSummary } from '@lingshell/shared'
import { client } from '../../../client/index.js'
import { ConfirmDialog } from '../../common/index.js'
import { Switch } from '../../../components/ui/Switch.js'
import { Checkbox } from '../../../components/ui/Checkbox.js'
import { FoldSection, type Fold } from '../../../components/sshParts.js'
import { Row, INPUT, BTN2 } from '../ui.js'
import { Sel } from '../../../components/ui/form.js'
import { SecretOrText } from '../../../components/ui/PasswordInput.js'

const btnPrimary = 'rounded-md bg-[var(--color-accent)] px-3 py-1.5 text-[12px] font-medium text-[var(--color-bg-base)] transition-colors hover:bg-[var(--color-accent-dim)] disabled:opacity-40'
const iconBtn = 'flex h-6 w-6 items-center justify-center rounded text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-accent)]'
const chk = 'flex items-center gap-1.5 text-[12px] text-[var(--color-text-secondary)]'
const errText = (e: unknown) => String((e as Error)?.message ?? e).replace(/^Error invoking remote method '[^']+': Error:\s*/, '')

type Form = AutoReplyInput & { hasResponse?: boolean }
const EMPTY: Form = { name: '', pattern: '', regex: false, secret: false, response: '', appendEnter: true, scope: 'all', allowProd: false, enabled: true }
// 摘要 → 表单；toggle 也用它（密钥应答不带 response = 保持）
const toInput = (r: AutoReplySummary): Form => ({ id: r.id, name: r.name, pattern: r.pattern, regex: r.regex, secret: r.secret, response: r.secret ? '' : r.response ?? '', appendEnter: r.appendEnter, scope: r.scope, allowProd: r.allowProd, enabled: r.enabled, hasResponse: r.hasResponse })

// 主机与连接页里的「自动应答」（Xshell 触发器）：终端停在匹配的提示上时自动发送应答。
// 密钥应答（如 sudo 密码）只进不出：输入框为密码框，编辑时留空 = 不变
export function AutoReplyManager({ hosts, fold }: { hosts: HostSummary[]; fold: Fold }) {
  const [list, setList] = useState<AutoReplySummary[]>([])
  const [form, setForm] = useState<Form | null>(null)
  const [del, setDel] = useState<AutoReplySummary | null>(null)
  const [err, setErr] = useState('')

  const refresh = useCallback(() => { client.autoReplies.list().then(setList).catch(() => {}) }, [])
  useEffect(() => { refresh() }, [refresh])

  const save = (f: Form) => {
    const { hasResponse: _h, ...input } = f
    client.autoReplies.save(input).then(() => { setForm(null); setErr(''); refresh() }).catch((e) => setErr(errText(e)))
  }
  const scopeText = (r: AutoReplySummary) => r.scope === 'all' ? tr('所有终端')
    : r.scope.map((id) => id === 'local' ? tr('本地') : hosts.find((h) => h.id === id)?.label ?? tr('（已删除主机）')).join(tr('、')) || tr('未选主机')

  const editor = form && (() => {
    const patErr = form.pattern ? checkAutoReplyPattern(form.pattern, form.regex) : undefined
    const picked = form.scope === 'all' ? [] : form.scope
    const togglePick = (id: string) => setForm({ ...form, scope: picked.includes(id) ? picked.filter((x) => x !== id) : [...picked, id] })
    return (
      <div className="divide-y divide-[var(--color-border-subtle)] rounded-md border border-[var(--color-border-default)] bg-[var(--color-bg-panel)]">
        <Row label={tr('名称')} wide><input className={`${INPUT} w-full`} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder={tr('如：sudo 密码')} /></Row>
        <Row label={tr('匹配提示')} wide tip={tr('只匹配光标所在的最后一行，不区分大小写。普通文本 = 包含即命中')}>
          <input className={`${INPUT} w-full`} value={form.pattern} onChange={(e) => setForm({ ...form, pattern: e.target.value })} placeholder={form.regex ? tr('正则，如 password for \\w+:') : tr('包含此文本即命中，如 [sudo] password for')} />
          {patErr && <div className="text-[11px] text-[var(--color-danger)]">{tr(patErr)}</div>}
        </Row>
        <Row label={tr('正则表达式')}><Switch checked={form.regex} onCheckedChange={(v) => setForm({ ...form, regex: v })} aria-label={tr('正则表达式')} /></Row>
        <Row label={tr('应答内容')} wide>
          <SecretOrText secret={!!form.secret} className={`${INPUT} w-full`} value={form.response ?? ''} onChange={(e) => setForm({ ...form, response: e.target.value })}
            placeholder={form.secret ? (form.hasResponse ? tr('已设置，留空保持不变') : tr('输入密码等密钥')) : tr('留空 + 补回车 = 只按回车')} />
        </Row>
        <Row label={tr('密钥')} hint={tr('加密存储、不回显')} tip={tr('加密存储、界面不回显；仅用于不回显的提示（如密码）。编辑时留空 = 保持不变')}>
          <Switch checked={form.secret} onCheckedChange={(v) => setForm({ ...form, secret: v, response: '' })} aria-label={tr('密钥')} />
        </Row>
        <Row label={tr('应答后补回车')}><Switch checked={form.appendEnter} onCheckedChange={(v) => setForm({ ...form, appendEnter: v })} aria-label={tr('应答后补回车')} /></Row>
        <Row label={tr('作用范围')} wide={form.scope !== 'all'}>
          <div className={form.scope !== 'all' ? 'space-y-2' : 'w-40'}>
            <Sel value={form.scope === 'all' ? 'all' : 'hosts'} onChange={(v) => setForm({ ...form, scope: v === 'all' ? 'all' : [] })}>
              <option value="all">{tr('所有终端')}</option>
              <option value="hosts">{tr('指定主机')}</option>
            </Sel>
            {form.scope !== 'all' && (
              <div className="flex max-h-28 flex-wrap gap-x-4 gap-y-1 overflow-y-auto">
                {[{ id: 'local', label: tr('本地终端') }, ...hosts].map((h) => (
                  <label key={h.id} className={chk}><Checkbox checked={picked.includes(h.id)} onCheckedChange={() => togglePick(h.id)} />{h.label}</label>
                ))}
              </div>
            )}
          </div>
        </Row>
        <Row label={tr('生产主机也触发')} hint={tr('默认不触发')}><Switch checked={form.allowProd} onCheckedChange={(v) => setForm({ ...form, allowProd: v })} aria-label={tr('生产主机也触发')} /></Row>
        <Row label={tr('启用')}><Switch checked={form.enabled} onCheckedChange={(v) => setForm({ ...form, enabled: v })} aria-label={tr('启用')} /></Row>
        <div className="flex items-center gap-3 px-3.5 py-2.5">
          {err && <span className="text-[12px] text-[var(--color-danger)]">{err}</span>}
          <button onClick={() => { setForm(null); setErr('') }} className={`ml-auto ${BTN2}`}>{tr('取消')}</button>
          <button onClick={() => save(form)} disabled={!form.name.trim() || !form.pattern.trim() || !!patErr} className={btnPrimary}>{tr('保存')}</button>
        </div>
      </div>
    )
  })()

  return (
    <FoldSection title={tr('自动应答')} {...fold}
      tip={tr('类似 Xshell 触发器：终端停在匹配的提示上时自动发送应答。AI 执行命令期间绝不触发；生产主机默认不触发；同一规则 1 分钟内超过 3 次即在该终端停用')}
      actions={!form && <button onClick={() => setForm({ ...EMPTY })} className={`flex items-center gap-1 ${BTN2}`}><Plus className="h-3.5 w-3.5" />{tr('添加规则')}</button>}>
      <div className="space-y-1.5 px-3.5 py-3">
        {editor ?? (list.length === 0 ? (
          <div className="py-3 text-center text-[12px] text-[var(--color-text-muted)]">{tr('暂无规则')}</div>
        ) : list.map((r) => (
          <div key={r.id} className="flex items-center gap-2 rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-bg-panel)] px-3 py-2 text-[12px]">
            <Zap className="h-3.5 w-3.5 shrink-0 text-[var(--color-accent)]" />
            <span className="shrink-0 font-medium text-[var(--color-text-primary)]">{r.name}</span>
            <span className="min-w-0 flex-1 truncate text-[11px] text-[var(--color-text-muted)]" title={r.pattern}>
              {r.regex ? '/' + r.pattern + '/' : r.pattern} → {r.secret ? (r.hasResponse ? '••••••' : tr('（未设置密钥）')) : r.response ? r.response : ''}{r.appendEnter ? ' ⏎' : ''} · {scopeText(r)}{r.allowProd ? tr(' · 含生产') : ''}
            </span>
            <Switch checked={r.enabled} onCheckedChange={(v) => save({ ...toInput(r), enabled: v })} title={r.enabled ? tr('已启用') : tr('已停用')} />
            <button onClick={() => setForm(toInput(r))} title={tr('编辑')} className={iconBtn}><Pencil className="h-3 w-3" /></button>
            <button onClick={() => setDel(r)} title={tr('删除')} className="flex h-6 w-6 items-center justify-center rounded text-[var(--color-text-muted)] hover:bg-[color:color-mix(in_srgb,var(--color-danger)_15%,transparent)] hover:text-[var(--color-danger)]"><Trash2 className="h-3 w-3" /></button>
          </div>
        )))}
        {err && !form && <div className="text-[12px] text-[var(--color-danger)]">{err}</div>}
      </div>
      <ConfirmDialog open={!!del} title={tr('删除自动应答')} message={tr('确定删除规则 {name}？', { name: del?.name ?? '' })}
        onConfirm={() => { if (del) client.autoReplies.delete(del.id).then(refresh).catch(() => {}); setDel(null) }} onCancel={() => setDel(null)} />
    </FoldSection>
  )
}
