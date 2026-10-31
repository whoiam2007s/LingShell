import { useCallback, useEffect, useState } from 'react'
import { IdCard, Plus, Pencil, Trash2, Loader2, X } from 'lucide-react'
import { tr, type AuthType, type CredentialSummary, type HostSummary } from '@lingshell/shared'
import { client } from '../../../client/index.js'
import { ConfirmDialog } from '../../common/index.js'
import { AUTH_LABEL, AppKeySelect, AgentStatus, HostGroups, Inp, FormRow as Row, FoldSection, type Fold } from '../../../components/sshParts.js'
import { HelpTip } from '../ui.js'
import { Select } from '../../../components/ui/Select.js'
import { Checkbox } from '../../../components/ui/Checkbox.js'

// 设置 → 主机与连接 →「凭据」：命名的 用户名 + 认证，多台主机共用（主机认证选「使用凭据：xxx」），改一处全部生效。
// 凭据明文只进不出：编辑时密码/私钥留空 = 不改
const errText = (e: unknown) => String(e instanceof Error ? e.message : e).replace(/^.*?Error: /, '').replace(/^[a-z_]+: /, '')
const BTN = 'flex items-center gap-1 rounded-md border border-[var(--color-border-default)] px-3 py-1.5 text-[12px] text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-bg-hover)] disabled:opacity-40'
const PRIMARY = 'flex items-center gap-1.5 rounded-md border border-transparent bg-[var(--color-accent)] px-4 py-1.5 text-[12px] font-medium text-[var(--color-bg-base)] transition-colors hover:bg-[var(--color-accent-dim)] disabled:opacity-40'
const ERR_BOX = 'rounded-md bg-[color:color-mix(in_srgb,var(--color-danger)_10%,transparent)] px-2.5 py-1.5 text-[11px] text-[var(--color-danger)]'

interface Draft { id?: string; name: string; username: string; authType: AuthType; password: string; privateKey: string; passphrase: string; keyId: string }
const emptyDraft: Draft = { name: '', username: '', authType: 'password', password: '', privateKey: '', passphrase: '', keyId: '' }

export function CredentialManager({ hosts, onChanged, fold }: { hosts: HostSummary[]; onChanged: () => void; fold: Fold }) {
  const [creds, setCreds] = useState<CredentialSummary[]>([])
  const [draft, setDraft] = useState<Draft | null>(null)
  const [delTarget, setDelTarget] = useState<CredentialSummary | null>(null)
  const [error, setError] = useState('')
  const refresh = useCallback(() => { client.credentials.list().then(setCreds).catch(() => {}) }, [])
  useEffect(() => { refresh() }, [refresh])
  const usersOf = (id: string) => hosts.filter((h) => h.credentialId === id)

  const doDelete = () => {
    setError('')
    if (delTarget) client.credentials.delete(delTarget.id).then(() => { refresh(); onChanged() }).catch((e) => setError(errText(e)))
    setDelTarget(null)
  }

  const newCred = () => { setDraft(emptyDraft); setError('') }
  return (
    <FoldSection title={tr('凭据')} {...fold}
      tip={tr('多台主机共用一个账号（用户名 + 密码 / 私钥 / agent）：改一处密码，引用它的主机全部生效。编辑主机时认证方式选「使用凭据：…」；也可用顶部「更多 → 批量设置凭据」一次给多台主机设置。凭据的密码 / 私钥只进不出，编辑时留空 = 不改')}
      actions={<button onClick={newCred} className={BTN}><Plus className="h-3.5 w-3.5" />{tr('新建凭据')}</button>}>
    <div className="space-y-2 px-3.5 py-3">
      {draft && !draft.id && <CredentialForm draft={draft} onCancel={() => setDraft(null)} onSaved={() => { setDraft(null); refresh(); onChanged() }} />}
      {error && <div className={ERR_BOX}>{error}</div>}
      {creds.length === 0 && !draft ? (
        <div className="flex flex-col items-center gap-2.5 py-4 text-[12px] text-[var(--color-text-muted)]">
          {tr('还没有凭据')}
          <button onClick={newCred} className={BTN}><Plus className="h-3.5 w-3.5" />{tr('新建凭据')}</button>
        </div>
      ) : (
        <div className="space-y-1.5">
          {creds.map((c) => {
            const users = usersOf(c.id)
            return (
              <div key={c.id}>
                <div className="flex items-center gap-2 rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-bg-panel)] px-3 py-2 text-[12px]">
                  <IdCard className="h-3.5 w-3.5 shrink-0 text-[var(--color-accent)]" />
                  <span className="shrink-0 font-medium text-[var(--color-text-primary)]">{c.name}</span>
                  <span className="min-w-0 flex-1 truncate text-[11px] text-[var(--color-text-muted)]" title={users.map((h) => h.label).join(tr('、'))}>
                    {c.username} · {tr(AUTH_LABEL[c.authType])}{c.hasSecret ? '' : tr('（未填）')} · {users.length ? tr('{n} 台主机在用', { n: users.length }) : tr('未被引用')}
                  </span>
                  <button onClick={() => { setDraft({ ...emptyDraft, id: c.id, name: c.name, username: c.username, authType: c.authType, keyId: c.keyId ?? '' }); setError('') }} title={tr('编辑')} className="flex h-6 w-6 items-center justify-center rounded text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-accent)]"><Pencil className="h-3 w-3" /></button>
                  <button onClick={() => (users.length ? setError(tr('「{name}」正在被以下主机使用：{hosts}。请先把这些主机改用其它认证再删除', { name: c.name, hosts: users.map((h) => h.label).join(tr('、')) })) : setDelTarget(c))} title={tr('删除')} className="flex h-6 w-6 items-center justify-center rounded text-[var(--color-text-muted)] hover:bg-[color:color-mix(in_srgb,var(--color-danger)_15%,transparent)] hover:text-[var(--color-danger)]"><Trash2 className="h-3 w-3" /></button>
                </div>
                {draft?.id === c.id && <div className="ml-5 mt-1"><CredentialForm draft={draft} onCancel={() => setDraft(null)} onSaved={() => { setDraft(null); refresh(); onChanged() }} /></div>}
              </div>
            )
          })}
        </div>
      )}
      <ConfirmDialog open={!!delTarget} title={tr('删除凭据')} message={tr('确定删除凭据「{name}」？保存的密码/私钥会一并删除。', { name: delTarget?.name ?? '' })} onConfirm={doDelete} onCancel={() => setDelTarget(null)} />
    </div>
    </FoldSection>
  )
}

function CredentialForm({ draft, onCancel, onSaved }: { draft: Draft; onCancel: () => void; onSaved: () => void }) {
  const [d, setD] = useState<Draft>(draft)
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  const set = (p: Partial<Draft>) => { setD((x) => ({ ...x, ...p })); setError('') }
  const edit = !!d.id
  const save = async () => {
    setBusy(true); setError('')
    try {
      await client.credentials.save({
        ...(d.id ? { id: d.id } : {}), name: d.name, username: d.username, authType: d.authType,
        ...(d.authType === 'password' && d.password ? { password: d.password } : {}),
        ...(d.authType === 'key' ? { keyId: d.keyId, ...(!d.keyId && d.privateKey ? { privateKey: d.privateKey } : {}), ...(!d.keyId && d.passphrase ? { passphrase: d.passphrase } : {}) } : {}),
      })
      onSaved()
    } catch (e) { setError(errText(e)) }
    finally { setBusy(false) }
  }
  return (
    <div className="space-y-2.5 rounded-md border border-[var(--color-border-default)] bg-[var(--color-bg-panel)] p-3">
      <div className="flex gap-2">
        <div className="flex-1"><Row label={tr('名称')}><Inp value={d.name} onChange={(v) => set({ name: v })} placeholder={tr('如 运维 root')} /></Row></div>
        <div className="flex-1"><Row label={tr('用户名')}><Inp value={d.username} onChange={(v) => set({ username: v })} placeholder="root" /></Row></div>
      </div>
      <Row label={tr('认证方式')}>
        <Select value={d.authType} onValueChange={(v) => set({ authType: v as AuthType })}>
          <option value="password">{tr('密码')}</option>
          <option value="key">{tr('私钥')}</option>
          <option value="agent">ssh-agent / Pageant</option>
        </Select>
      </Row>
      {d.authType === 'agent' ? <AgentStatus /> : d.authType === 'password' ? (
        <Row label={tr('密码')} hint={edit ? tr('留空不改') : undefined}><Inp type="password" value={d.password} onChange={(v) => set({ password: v })} /></Row>
      ) : (
        <>
          <AppKeySelect value={d.keyId} onChange={(keyId) => set({ keyId })} />
          {!d.keyId && <>
            <Row label={tr('私钥')} hint={edit ? tr('留空不改') : undefined}>
              <textarea value={d.privateKey} onChange={(e) => set({ privateKey: e.target.value })} rows={3}
                className="w-full resize-none rounded-md border border-[var(--color-border-default)] bg-[var(--color-bg-panel)] px-2.5 py-1.5 font-mono text-[12px] text-[var(--color-text-primary)] outline-none" />
            </Row>
            <Row label={tr('私钥口令')} hint={tr('可选')}><Inp type="password" value={d.passphrase} onChange={(v) => set({ passphrase: v })} /></Row>
          </>}
        </>
      )}
      {error && <div className={ERR_BOX}>{error}</div>}
      <div className="flex justify-end gap-2">
        <button onClick={onCancel} className={BTN}>{tr('取消')}</button>
        <button onClick={save} disabled={busy || !d.name.trim() || !d.username.trim()} className={PRIMARY}>{busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}{tr('保存')}</button>
      </div>
    </div>
  )
}

// 主机列表「批量设置凭据」：勾选主机 → 选凭据 → 应用（这些主机原来自己存的密码/私钥会清掉）
export function BulkCredentialDialog({ hosts, onClose, onDone }: { hosts: HostSummary[]; onClose: () => void; onDone: () => void }) {
  const [creds, setCreds] = useState<CredentialSummary[]>([])
  const [credId, setCredId] = useState('')
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  useEffect(() => { client.credentials.list().then((cs) => { setCreds(cs); setCredId((x) => x || cs[0]?.id || '') }).catch(() => {}) }, [])
  const toggle = (id: string) => setPicked((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n })
  const apply = async () => {
    setBusy(true); setError('')
    try { await client.credentials.assign([...picked], credId); onDone(); onClose() }
    catch (e) { setError(errText(e)) }
    finally { setBusy(false) }
  }
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="flex max-h-[80vh] w-[480px] flex-col gap-3 rounded-lg border border-[var(--color-border-default)] bg-[var(--color-bg-panel)] p-4" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <span className="text-[14px] font-semibold text-[var(--color-text-primary)]">{tr('批量设置凭据')}</span>
          <button onClick={onClose}><X className="h-4 w-4 text-[var(--color-text-muted)]" /></button>
        </div>
        {creds.length === 0 ? <div className="text-[12px] text-[var(--color-text-muted)]">{tr('还没有凭据，请先在「凭据」里新建')}</div> : (
          <>
            <Row label={tr('使用凭据')}>
              <Select value={credId} onValueChange={setCredId}
                options={creds.map((c) => ({ value: c.id, label: tr('{name}（{user} · {auth}）', { name: c.name, user: c.username, auth: tr(AUTH_LABEL[c.authType]) }) }))} />
            </Row>
            <div className="flex items-center text-[12px] text-[var(--color-text-secondary)]">
              {tr('勾选主机（已选 {n} 台）', { n: picked.size })}
              <button onClick={() => setPicked(picked.size === hosts.length ? new Set() : new Set(hosts.map((h) => h.id)))} className="ml-auto text-[11px] hover:text-[var(--color-accent)]">{picked.size === hosts.length ? tr('全不选') : tr('全选')}</button>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto">
              <HostGroups hosts={hosts} render={(h) => (
                <label key={h.id} className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1 text-[12px] hover:bg-[var(--color-bg-hover)]">
                  <Checkbox checked={picked.has(h.id)} onCheckedChange={() => toggle(h.id)} />
                  <span className="shrink-0 text-[var(--color-text-primary)]">{h.label}</span>
                  <span className="min-w-0 flex-1 truncate text-[11px] text-[var(--color-text-muted)]">{h.username}@{h.host}:{h.port}{h.credentialId ? tr(' · 凭据：{name}', { name: creds.find((c) => c.id === h.credentialId)?.name ?? '?' }) : ''}</span>
                </label>
              )} />
            </div>
            <div className="flex items-center gap-1.5 text-[11px] text-[var(--color-warn)]">{tr('主机原来单独保存的密码 / 私钥会被清除')}<HelpTip>{tr('应用后这些主机的用户名与认证都改用该凭据，主机原来单独保存的密码 / 私钥会被清除')}</HelpTip></div>
          </>
        )}
        {error && <div className={ERR_BOX}>{error}</div>}
        <div className="flex justify-end gap-2">
          <button onClick={onClose} className={BTN}>{tr('取消')}</button>
          <button onClick={apply} disabled={busy || !credId || picked.size === 0} className={PRIMARY}>{busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}{tr('btn|应用')}</button>
        </div>
      </div>
    </div>
  )
}
