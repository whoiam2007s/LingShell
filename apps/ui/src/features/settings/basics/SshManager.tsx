import { useEffect, useRef, useState, useCallback } from 'react'
import { Server, Pencil, Trash2, Plus, ArrowLeft, ArrowRightLeft, FileInput, IdCard, ListChecks, ChevronDown } from 'lucide-react'
import { tr, type CredentialSummary, type HostSummary } from '@lingshell/shared'
import { client } from '../../../client/index.js'
import { ConfirmDialog } from '../../common/index.js'
import { NewConnectionForm, ProdBadge, HostGroups, FoldSection, emptySshForm, jumpText, hostOptionsOf, hostOptionsInput, type SshForm } from '../../../components/sshParts.js'
import { Page, BTN2 } from '../ui.js'
import { Select } from '../../../components/ui/Select.js'
import { PortForwardPanel } from './PortForwardPanel.js'
import { SshImportDialog } from './SshImportDialog.js'
import { KnownHostsPanel } from './KnownHostsPanel.js'
import { AutoReplyManager } from './AutoReplyManager.js'
import { CredentialManager, BulkCredentialDialog } from './CredentialManager.js'
import { HostBatchDialog, BatchUndoBar } from './HostBatchEdit.js'

const PRIMARY_BTN = 'flex shrink-0 items-center gap-1 rounded-md border border-transparent bg-[var(--color-accent)] px-3 py-1.5 text-[12px] font-medium text-[var(--color-bg-base)] transition-colors hover:bg-[var(--color-accent-dim)] disabled:opacity-40'
const ICON_BTN = 'flex h-6 w-6 items-center justify-center rounded text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-accent)]'

// 各分组折叠状态记在 localStorage：默认展开主机与凭据，其余折叠
type FoldKey = 'hosts' | 'creds' | 'forward' | 'autoReply' | 'knownHosts'
const FOLD_KEY = 'lingshell.settings.sshFolds'
const FOLD_DEFAULT: Record<FoldKey, boolean> = { hosts: true, creds: true, forward: false, autoReply: false, knownHosts: false }
function useFolds() {
  const [open, setOpen] = useState<Record<FoldKey, boolean>>(() => {
    try { return { ...FOLD_DEFAULT, ...JSON.parse(localStorage.getItem(FOLD_KEY) ?? '{}') } } catch { return FOLD_DEFAULT }
  })
  const set = (k: FoldKey, v: boolean) => setOpen((o) => { const n = { ...o, [k]: v }; try { localStorage.setItem(FOLD_KEY, JSON.stringify(n)) } catch { /* 忽略 */ } return n })
  return { open, set, fold: (k: FoldKey) => ({ open: open[k], onToggle: () => set(k, !open[k]) }) }
}

// 设置 →「主机与连接」：主机增删改 + 凭据 / 端口转发 / 自动应答 / 已信任指纹。编辑走 hosts.save({id,...})（凭据留空保留旧值）。
export function SshManager({ newHostSeq }: { newHostSeq?: number }) {
  const [hosts, setHosts] = useState<HostSummary[]>([])
  const [mode, setMode] = useState<'list' | 'form'>('list')
  const [editId, setEditId] = useState<string | undefined>(undefined)
  const [form, setForm] = useState<SshForm>(emptySshForm)
  const [delTarget, setDelTarget] = useState<HostSummary | null>(null)
  const [fwdHostId, setFwdHostId] = useState<string | undefined>(undefined)   // 端口转发分组当前选中的主机
  const [listError, setListError] = useState('')
  const [importOpen, setImportOpen] = useState(false)
  const [bulkOpen, setBulkOpen] = useState(false)
  const [creds, setCreds] = useState<CredentialSummary[]>([])   // 列表里显示「凭据：xxx」
  const [batchOpen, setBatchOpen] = useState(false)
  const [version, setVersion] = useState(0)   // 主机列表每刷新一次 +1：「撤销上次批量修改」条跟着重查
  const folds = useFolds()
  const rulesBase = useRef('')   // 编辑前的主机规则（没改就不写 rules.json）
  const rulesSeq = useRef(0)     // 连续打开不同主机时，只认最后一次的规则返回
  const [rulesReady, setRulesReady] = useState(true)   // 编辑主机时规则读完没有（没读完不写规则，避免把原规则清空）

  const refresh = useCallback(() => {
    setVersion((v) => v + 1)
    client.hosts.list().then(setHosts).catch(() => {})
    client.credentials.list().then(setCreds).catch(() => {})
  }, [])
  useEffect(() => { refresh() }, [refresh])

  const openNew = () => { rulesSeq.current++; setRulesReady(true); setEditId(undefined); rulesBase.current = ''; setForm(emptySshForm); setMode('form') }
  // 从主机面板「+」进来：设置打开到本页时直接进入新建表单（seq 每次点击都变）
  useEffect(() => { if (newHostSeq) openNew() }, [newHostSeq])
  const openEdit = (h: HostSummary) => {
    setEditId(h.id)
    setForm({ ...emptySshForm, label: h.label, host: h.host, port: h.port, username: h.username, authType: h.authType, saveAs: true, jumpHostId: h.jumpHostId ?? '', notes: h.notes ?? '', env: h.env ?? '', group: h.group ?? '', encoding: h.encoding ?? 'utf8', persistSession: !!h.persistSession, ...hostOptionsOf(h), keyId: h.keyId ?? '', credentialId: h.credentialId ?? '' })
    setMode('form')
    // 主机规则单独存（rules.json），读到后补进表单。记序号：A 的返回晚于打开 B 时丢掉，不能覆盖 B 的表单
    const seq = ++rulesSeq.current
    setRulesReady(false); rulesBase.current = ''
    client.safety.rules().then((r) => { if (seq !== rulesSeq.current) return; rulesBase.current = r.hosts[h.id] ?? ''; setForm((f) => ({ ...f, rules: rulesBase.current })); setRulesReady(true) })
      .catch(() => { if (seq === rulesSeq.current) setRulesReady(true) })
  }
  const setF = (patch: Partial<SshForm>) => setForm((f) => ({ ...f, ...patch }))
  // 主机卡片上的「端口转发」：展开端口转发分组并选中这台主机
  const openForward = (id: string) => {
    setFwdHostId(id); folds.set('forward', true)
    setTimeout(() => document.getElementById('ssh-forward-section')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50)
  }

  const saveHost = async () => {
    const saved = await client.hosts.save({
      id: editId, label: form.label, host: form.host, port: form.port, username: form.username, authType: form.authType,
      password: form.authType === 'password' ? form.password : undefined,
      privateKey: form.authType === 'key' ? form.privateKey : undefined,
      passphrase: form.authType === 'key' ? form.passphrase : undefined,
      jumpHostId: form.jumpHostId || undefined,
      notes: form.notes, env: form.env, group: form.group, encoding: form.encoding, persistSession: form.persistSession,
      ...hostOptionsInput(form),
      ...(form.authType === 'key' ? { keyId: form.keyId ?? '' } : {}),   // '' = 改用粘贴的私钥
      credentialId: form.credentialId ?? '',   // '' = 不用凭据
    })
    // 规则没读回来就不写（否则会拿空串把原规则删掉）；本次保存只改主机本身
    if (rulesReady && (form.rules ?? '').trim() !== (editId ? rulesBase.current : '').trim()) await client.safety.setHostRules(saved.id, form.rules ?? '')
    setMode('list'); refresh()
  }
  const doDelete = () => {
    setListError('')
    // 被别的主机用作跳板时主进程拒删，显示原因
    if (delTarget) client.hosts.delete(delTarget.id).then(refresh).catch((e) => setListError(String(e instanceof Error ? e.message : e).replace(/^.*host_in_use_as_jump: /, '')))
    setDelTarget(null)
  }

  if (mode === 'form') {
    return (
      <div>
        {/* 返回按钮 sticky 顶部固定：滚动容器是 SettingsModal 的 p-4 区(-m-4 抵消其内边距铺满宽)，表单长时"返回"不随滚 */}
        <div className="sticky -top-4 z-10 -mx-4 -mt-4 mb-4 flex items-center gap-2 border-b border-[var(--color-border-subtle)] bg-[var(--color-bg-panel)] px-4 py-2.5">
          <button onClick={() => setMode('list')} className="flex items-center gap-1 text-[12px] text-[var(--color-text-secondary)] hover:text-[var(--color-accent)]"><ArrowLeft className="h-3.5 w-3.5" />{tr('返回主机列表')}</button>
          <span className="ml-2 text-[13px] font-semibold text-[var(--color-text-primary)]">{editId ? tr('编辑主机') : tr('新建主机')}</span>
          {editId && !rulesReady && <span className="text-[11px] text-[var(--color-text-muted)]">{tr('规则读取中…（本次保存不会改主机规则）')}</span>}
        </div>
        <Page><NewConnectionForm form={form} setForm={setF} editId={editId} onConnected={saveHost} hostOptions /></Page>
      </div>
    )
  }

  const fwdHost = hosts.find((h) => h.id === fwdHostId) ?? hosts[0]
  return (
    <Page>
      {/* 顶部工具栏：主操作「新建主机」靠右，其余收进「更多」 */}
      <div className="flex items-center gap-2">
        <span className="text-[12px] text-[var(--color-text-muted)]">{hosts.length ? tr('共 {n} 台主机', { n: hosts.length }) : ''}</span>
        <MoreMenu items={[
          { icon: <FileInput className="h-3.5 w-3.5" />, label: tr('导入主机'), onClick: () => setImportOpen(true) },
          { icon: <ListChecks className="h-3.5 w-3.5" />, label: tr('批量修改'), onClick: () => setBatchOpen(true), disabled: !hosts.length },
          { icon: <IdCard className="h-3.5 w-3.5" />, label: tr('批量设置凭据'), onClick: () => setBulkOpen(true), disabled: !hosts.length },
        ]} />
        <button onClick={openNew} className={PRIMARY_BTN}><Plus className="h-3.5 w-3.5" />{tr('新建主机')}</button>
      </div>
      <BatchUndoBar version={version} onDone={refresh} />
      <FoldSection title={tr('主机')} {...folds.fold('hosts')}>
        <div className="space-y-1.5 px-3.5 py-3">
          {listError && <div className="rounded-md bg-[color:color-mix(in_srgb,var(--color-danger)_10%,transparent)] px-2.5 py-1.5 text-[11px] text-[var(--color-danger)]">{listError}</div>}
          {hosts.length === 0 ? (
            <div className="flex flex-col items-center gap-2.5 py-6 text-[12px] text-[var(--color-text-muted)]">
              {tr('暂无已保存主机')}
              <button onClick={openNew} className={PRIMARY_BTN}><Plus className="h-3.5 w-3.5" />{tr('新建主机')}</button>
            </div>
          ) : (
            <HostGroups hosts={hosts} className="space-y-1.5" render={(h) => (
              <div key={h.id} className="group flex items-center gap-2.5 rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-bg-panel)] px-3 py-2 transition-colors hover:border-[var(--color-border-default)]">
                <Server className="h-4 w-4 shrink-0 text-[var(--color-accent)]" />
                <button onClick={() => openEdit(h)} className="min-w-0 flex-1 text-left" title={tr('编辑')}>
                  <div className="flex items-center gap-1.5 text-[12.5px]">
                    <span className="truncate font-medium text-[var(--color-text-primary)]">{h.label}</span>
                    {h.env === 'prod' && <ProdBadge />}
                  </div>
                  <div className="truncate text-[11px] text-[var(--color-text-muted)]" title={h.notes}>
                    {h.username}@{h.host}:{h.port}{h.credentialId ? tr(' · 凭据：{name}', { name: creds.find((c) => c.id === h.credentialId)?.name ?? tr('（已删除）') }) : ''}{jumpText(h, hosts)}{h.proxyCommand ? tr(' · 经 ProxyCommand') : ''}{h.notes ? ` · ${h.notes.split('\n')[0]}` : ''}
                  </div>
                </button>
                <button onClick={() => openForward(h.id)} title={tr('端口转发')} className={ICON_BTN}><ArrowRightLeft className="h-3.5 w-3.5" /></button>
                <button onClick={() => openEdit(h)} title={tr('编辑')} className={ICON_BTN}><Pencil className="h-3.5 w-3.5" /></button>
                <button onClick={() => setDelTarget(h)} title={tr('删除')} className="flex h-6 w-6 items-center justify-center rounded text-[var(--color-text-muted)] hover:bg-[color:color-mix(in_srgb,var(--color-danger)_15%,transparent)] hover:text-[var(--color-danger)]"><Trash2 className="h-3.5 w-3.5" /></button>
              </div>
            )} />
          )}
        </div>
      </FoldSection>
      <CredentialManager hosts={hosts} onChanged={refresh} fold={folds.fold('creds')} />
      <FoldSection id="ssh-forward-section" title={tr('端口转发')} {...folds.fold('forward')}
        tip={tr('本地转发：本机 127.0.0.1:端口 → 经主机 → 远端地址:端口；远程转发：服务器上监听端口 → 经 SSH 回到本机地址:端口；动态转发：本机 SOCKS5 代理经主机连出。保存的转发可一键启动、设为应用启动时自动开启')}
        actions={fwdHost && (
          <Select size="sm" value={fwdHost.id} onValueChange={setFwdHostId} title={tr('选择主机')} className="w-auto max-w-[240px]"
            options={hosts.map((h) => ({ value: h.id, label: tr('{name}（{host}）', { name: h.label, host: h.host }) }))} />
        )}>
        {fwdHost ? <PortForwardPanel key={fwdHost.id} host={fwdHost} /> : <div className="px-3.5 py-4 text-center text-[12px] text-[var(--color-text-muted)]">{tr('先新建主机')}</div>}
      </FoldSection>
      <AutoReplyManager hosts={hosts} fold={folds.fold('autoReply')} />
      <KnownHostsPanel hosts={hosts} fold={folds.fold('knownHosts')} />
      {importOpen && <SshImportDialog onClose={() => setImportOpen(false)} onImported={refresh} />}
      {batchOpen && <HostBatchDialog hosts={hosts} onClose={() => setBatchOpen(false)} onDone={refresh} />}
      {bulkOpen && <BulkCredentialDialog hosts={hosts} onClose={() => setBulkOpen(false)} onDone={refresh} />}
      <ConfirmDialog open={!!delTarget} title={tr('删除主机')} message={tr('确定删除主机 {name}？此操作不可恢复。', { name: delTarget?.label ?? '' })} onConfirm={doDelete} onCancel={() => setDelTarget(null)} />
    </Page>
  )
}

// 「更多」下拉菜单：点外面 / 选中一项后关闭
function MoreMenu({ items }: { items: { icon: React.ReactNode; label: string; onClick: () => void; disabled?: boolean }[] }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const off = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', off)
    return () => document.removeEventListener('mousedown', off)
  }, [open])
  return (
    <div ref={ref} className="relative ml-auto">
      <button onClick={() => setOpen(!open)} aria-haspopup="menu" aria-expanded={open} className={`flex items-center gap-1 ${BTN2}`}>{tr('更多')}<ChevronDown className="h-3.5 w-3.5" /></button>
      {open && (
        <div role="menu" className="absolute right-0 top-full z-20 mt-1 min-w-[150px] rounded-md border border-[var(--color-border-default)] bg-[var(--color-bg-raised)] py-1 shadow-lg">
          {items.map((it) => (
            <button key={it.label} role="menuitem" disabled={it.disabled} onClick={() => { setOpen(false); it.onClick() }}
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text-primary)] disabled:opacity-40">
              {it.icon}{it.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
