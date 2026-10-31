import { useEffect, useState, type ReactNode } from 'react'
import { Server, Plug, Loader2, Check, ChevronDown, ChevronRight, Search } from 'lucide-react'
import { filterHosts, groupHosts, hostGroupNames, SSH_ADVANCED_DEFAULTS, DEFAULT_TERM_TYPE, TERM_TYPES, cleanTermType, type HostInput, type HostSummary, type AuthType, type HostEnv, type SshAgentInfo, type SshKeySummary, type TermEncoding, TERM_ENCODINGS, ENCODING_LABEL, type ProxyType, type ProxySummary, type ProxyInput, type CredentialSummary, tk, tr } from '@lingshell/shared'
import { trx } from '../lib/trx.js'
import { client } from '../client/index.js'
import { Switch } from './ui/Switch.js'
import { Select } from './ui/Select.js'
import { Combobox } from './ui/Combobox.js'
import { HelpTip, Section } from './ui/form.js'
import { cn } from '../lib/cn.js'
import { PasswordInput } from './ui/PasswordInput.js'

export interface SshForm {
  label: string; host: string; port: number; username: string
  authType: AuthType; password: string; privateKey: string; passphrase: string; saveAs: boolean
  jumpHostId: string   // 跳板机（已存主机 id），'' = 直连
  notes: string; env: HostEnv | ''; group: string
  encoding: TermEncoding   // 字符编码，老服务器 GBK
  persistSession: boolean  // 断线后保持会话（tmux）
  loginCommands: string    // 登录后自动执行（多行）
  agentForward: boolean
  keepaliveSec: string; readyTimeoutSec: string; compress: boolean   // 高级（秒数按输入框原文存，保存时转数字；不合法 = 默认）
  termType: string         // 终端类型 $TERM（高级；不在预设里 = 自定义）
  proxyMode: 'default' | 'none' | 'custom'   // 出站代理：跟随全局默认 / 不使用 / 本机单独设置
  proxy: ProxyDraft
  keyId?: string           // 私钥认证用「应用密钥」时的密钥 id；空 = 粘贴私钥
  credentialId?: string    // 使用凭据（设置 → 主机与连接 →「凭据」）；空 = 本主机单独填写用户名/认证
  proxyCommand: string     // 高级：ProxyCommand（空 = 不用）
  rules?: string           // 主机规则（只在设置页主机编辑里显示；存 rules.json，不在 HostInput 里）
}
// 代理表单（端口按输入框原文；密码留空 = 沿用已存的）
export interface ProxyDraft { type: ProxyType; host: string; port: string; username: string; password: string; saved?: boolean }
export const emptyProxy: ProxyDraft = { type: 'socks5', host: '', port: '1080', username: '', password: '' }
export const proxyDraftOf = (p: ProxySummary): ProxyDraft => ({ type: p.type, host: p.host, port: String(p.port), username: p.username ?? '', password: '', saved: p.hasPassword })
export const proxyInputOf = (d: ProxyDraft): ProxyInput => ({ type: d.type, host: d.host.trim(), port: Number(d.port), username: d.username.trim() || undefined, password: d.password || undefined })
const D = SSH_ADVANCED_DEFAULTS
// 显示处 tr(AUTH_LABEL[x])
export const AUTH_LABEL: Record<AuthType, string> = { password: tk('密码'), key: tk('私钥'), agent: 'ssh-agent / Pageant' }
export const emptySshForm: SshForm = {
  label: '', host: '', port: 22, username: '', authType: 'password', password: '', privateKey: '', passphrase: '', saveAs: true, jumpHostId: '', notes: '', env: '', group: '', encoding: 'utf8', persistSession: false,
  loginCommands: '', agentForward: false, keepaliveSec: String(D.keepaliveSec), readyTimeoutSec: String(D.readyTimeoutSec), compress: false, termType: DEFAULT_TERM_TYPE,
  proxyMode: 'default', proxy: emptyProxy, proxyCommand: '',
}
// 已存主机 → 表单里的主机选项部分（编辑时回填）
export const hostOptionsOf = (h: HostSummary): Pick<SshForm, 'loginCommands' | 'agentForward' | 'keepaliveSec' | 'readyTimeoutSec' | 'compress' | 'termType' | 'proxyMode' | 'proxy' | 'proxyCommand'> => ({
  proxyCommand: h.proxyCommand ?? '',
  loginCommands: h.loginCommands ?? '', agentForward: !!h.agentForward,
  keepaliveSec: String(h.advanced?.keepaliveSec ?? D.keepaliveSec), readyTimeoutSec: String(h.advanced?.readyTimeoutSec ?? D.readyTimeoutSec), compress: !!h.advanced?.compress,
  termType: h.advanced?.termType ?? DEFAULT_TERM_TYPE,
  proxyMode: !h.proxy ? 'default' : h.proxy === 'none' ? 'none' : 'custom',
  proxy: h.proxy && h.proxy !== 'none' ? proxyDraftOf(h.proxy) : emptyProxy,
})
// 表单 → 保存主机的主机选项部分（'' / {} 表示清空 / 恢复默认；超出范围的秒数由主进程丢弃 = 默认）
// 秒数输入：空 / 非数字 = 用默认（不能把空串变成 0，否则心跳被悄悄关掉）
const secOr = (s: string, d: number) => { const t = s.trim(); if (!t) return d; const n = Number(t); return Number.isFinite(n) ? n : d }
export const hostOptionsInput = (f: SshForm): Pick<HostInput, 'loginCommands' | 'agentForward' | 'advanced' | 'proxy' | 'proxyCommand'> => ({
  loginCommands: f.loginCommands, agentForward: f.agentForward, proxyCommand: f.proxyCommand.trim(),
  advanced: { keepaliveSec: secOr(f.keepaliveSec, D.keepaliveSec), readyTimeoutSec: secOr(f.readyTimeoutSec, D.readyTimeoutSec), compress: f.compress, termType: f.termType },
  proxy: f.proxyMode === 'custom' ? proxyInputOf(f.proxy) : f.proxyMode,
})

// 主机列表通用外壳：搜索框 + 按分组折叠（未分组在最后；全都未分组时不显示组头）。搜索时忽略折叠全部展开。
export function HostGroups({ hosts, render, className = 'space-y-1' }: {
  hosts: HostSummary[]; render: (h: HostSummary) => ReactNode; className?: string
}) {
  const [q, setQ] = useState('')
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const groups = groupHosts(filterHosts(hosts, q))
  const headers = groups.length > 1 || (groups[0] && groups[0].group !== '')
  const toggle = (g: string) => setCollapsed((s) => { const n = new Set(s); if (n.has(g)) n.delete(g); else n.add(g); return n })
  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-1.5 rounded-md border border-[var(--color-border-default)] bg-[var(--color-bg-base)] px-2 py-1 focus-within:border-[color:color-mix(in_srgb,var(--color-accent)_60%,transparent)]">
        <Search className="h-3 w-3 shrink-0 text-[var(--color-text-muted)]" />
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={tr('搜索标签/地址/用户/分组/备注')}
          className="min-w-0 flex-1 bg-transparent text-[12px] text-[var(--color-text-primary)] outline-none placeholder:text-[var(--color-text-muted)]" />
      </div>
      {groups.length === 0 && <div className="px-2 py-1 text-[11px] text-[var(--color-text-muted)]">{tr('无匹配主机')}</div>}
      {groups.map(({ group, hosts: gs }) => {
        const open = !!q || !collapsed.has(group)
        return (
          <div key={group}>
            {headers && (
              <button onClick={() => toggle(group)} className="flex w-full items-center gap-1 px-1 py-0.5 text-left text-[11px] text-[var(--color-text-secondary)] hover:text-[var(--color-accent)]">
                {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                <span className="truncate">{group || tr('未分组')}</span>
                <span className="text-[var(--color-text-muted)]">({gs.length})</span>
              </button>
            )}
            {open && <div className={className}>{gs.map(render)}</div>}
          </div>
        )
      })}
    </div>
  )
}

// 生产主机徽标：终端标签 / 主机列表通用
export function ProdBadge() {
  return <span title={tr('生产主机：AI 的每条写操作都需确认')} className="shrink-0 rounded bg-[color:color-mix(in_srgb,var(--color-danger)_15%,transparent)] px-1 text-[10px] font-medium leading-4 text-[var(--color-danger)]">{tr('badge|生产')}</span>
}

// 非 UTF-8 终端的编码徽标（如 GBK）
export function EncodingBadge({ enc }: { enc: TermEncoding }) {
  return <span title={tr('字符编码 {enc}', { enc: ENCODING_LABEL[enc] })} className="shrink-0 rounded bg-[color:color-mix(in_srgb,var(--color-accent)_15%,transparent)] px-1 text-[10px] font-medium leading-4 text-[var(--color-accent)]">{ENCODING_LABEL[enc]}</span>
}

// 已保存主机列表：点击某行直接连接（用 hostId）。供终端 +号菜单 / SSH 弹窗复用。
export function SavedHostList({ hosts, disabled, onConnect }: {
  hosts: HostSummary[]; disabled?: boolean; onConnect: (hostId: string) => void
}) {
  if (hosts.length === 0) return <div className="px-2 py-2 text-[11px] text-[var(--color-text-muted)]">{tr('（无已保存主机）')}</div>
  return (
    <HostGroups hosts={hosts} render={(h) => (
        <button key={h.id} disabled={disabled} onClick={() => onConnect(h.id)}
          title={`${h.label} — ${h.username}@${h.host}:${h.port}`}
          className="group flex w-full items-center gap-2 rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-bg-base)] px-2.5 py-1.5 text-left text-[12px] transition-colors hover:border-[color:color-mix(in_srgb,var(--color-accent)_50%,transparent)] disabled:opacity-50">
          <Server className="h-3.5 w-3.5 shrink-0 text-[var(--color-accent)]" />
          <span className="shrink-0 max-w-[45%] truncate text-[var(--color-text-primary)]">{h.label}</span>
          {h.env === 'prod' && <ProdBadge />}
          <span className="min-w-0 flex-1 truncate text-[var(--color-text-muted)]">{h.username}@{h.host}:{h.port}{jumpText(h, hosts)}</span>
          <Plug className="h-3.5 w-3.5 shrink-0 text-[var(--color-success)] opacity-0 group-hover:opacity-100" />
        </button>
    )} />
  )
}

// 「 · 经 X 跳转」后缀（无跳板返回空串）
export function jumpText(h: HostSummary, hosts: HostSummary[]): string {
  if (!h.jumpHostId) return ''
  return tr(' · 经 {name} 跳转', { name: hosts.find((x) => x.id === h.jumpHostId)?.label ?? '?' })
}

/** 折叠状态（父级持有，如记在 localStorage） */
export type Fold = { open: boolean; onToggle: () => void }
/** 可折叠分组卡片（样式同 settings/ui 的 Section）：标题点击展开 / 收起，操作按钮只在展开时显示 */
export function FoldSection({ title, tip, actions, open, onToggle, children, id }: {
  title: string; tip?: ReactNode; actions?: ReactNode; open: boolean; onToggle: () => void; children: ReactNode; id?: string
}) {
  return (
    <section id={id} className="rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-bg-base)]">
      <div className={cn('flex min-h-[36px] items-center gap-1.5 px-3.5 py-1.5', open && 'border-b border-[var(--color-border-subtle)]')}>
        <button type="button" onClick={onToggle} aria-expanded={open} className="flex items-center gap-1 text-[12px] font-semibold text-[var(--color-text-primary)] hover:text-[var(--color-accent)]">
          {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}{title}
        </button>
        {tip && <HelpTip>{tip}</HelpTip>}
        {open && actions && <div className="ml-auto flex items-center gap-2">{actions}</div>}
      </div>
      {open && <div className="divide-y divide-[var(--color-border-subtle)]">{children}</div>}
    </section>
  )
}

// 表单分组：设置页（card）用 Section 卡片，新建连接对话框里平铺
function Group({ card, title, children }: { card?: boolean; title: string; children: ReactNode }) {
  if (!card) return <div className="space-y-2.5">{children}</div>
  return <Section title={title}><div className="space-y-2.5 px-3.5 py-3">{children}</div></Section>
}
// 「高级」折叠：设置页是可折叠卡片，对话框里是一个展开按钮 + 左侧竖线
function AdvancedGroup({ card, open, onToggle, children }: { card?: boolean; open: boolean; onToggle: () => void; children: ReactNode }) {
  if (card) return <FoldSection title={tr('高级')} open={open} onToggle={onToggle}><div className="space-y-2.5 px-3.5 py-3">{children}</div></FoldSection>
  return (
    <div className="space-y-2.5">
      <button type="button" onClick={onToggle} className="flex items-center gap-1 text-[12px] text-[var(--color-text-secondary)] hover:text-[var(--color-accent)]">
        {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}{tr('高级')}
      </button>
      {open && <div className="space-y-2.5 border-l border-[var(--color-border-subtle)] pl-3">{children}</div>}
    </div>
  )
}

// 新建/编辑连接表单：测试连接 + 连接/保存。editId 存在=编辑模式。
// onConnected 由父级处理连接/保存后动作。hostOptions：设置页的主机编辑（分组卡片 + 代理 / 登录命令 / agent 转发 / 心跳等，保存时才带上这些字段）
export function NewConnectionForm({ form, setForm, onConnected, editId, hostOptions }: {
  form: SshForm
  setForm: (patch: Partial<SshForm>) => void
  onConnected: (hostId?: string) => Promise<void> | void
  editId?: string
  hostOptions?: boolean
}) {
  const [testing, setTesting] = useState(false)
  const [tested, setTested] = useState(false)
  const [connecting, setConnecting] = useState(false)
  const [error, setError] = useState('')
  const [hosts, setHosts] = useState<HostSummary[]>([])   // 跳板机候选
  const [creds, setCreds] = useState<CredentialSummary[]>([])
  useEffect(() => {
    client.hosts.list().then(setHosts).catch(() => {})
    client.credentials.list().then(setCreds).catch(() => {})
  }, [])
  const cred = form.credentialId ? creds.find((c) => c.id === form.credentialId) : undefined
  const card = !!hostOptions
  // 「高级」有非默认值时默认展开
  const [advOpen, setAdvOpen] = useState(() => !!form.jumpHostId || form.encoding !== 'utf8' || (!!hostOptions && (
    !!form.loginCommands.trim() || form.agentForward || form.compress || form.keepaliveSec !== String(D.keepaliveSec) || form.readyTimeoutSec !== String(D.readyTimeoutSec)
    || form.proxyMode !== 'default' || form.termType !== DEFAULT_TERM_TYPE || !!form.proxyCommand.trim())))

  const connectInput = () => ({
    host: form.host, port: form.port, username: form.username, authType: form.authType,
    password: form.authType === 'password' ? form.password : undefined,
    privateKey: form.authType === 'key' ? form.privateKey : undefined,
    passphrase: form.authType === 'key' ? form.passphrase : undefined,
    jumpHostId: form.jumpHostId || undefined,
    encoding: form.encoding,
    // 测试连接按表单里的代理（只有主机管理页显示代理设置；否则跟随全局默认）
    // 主机管理页把「跟随全局 / 不使用 / 单独设置」都传下去：编辑已存主机测试时才能区分「沿用旧代理」和「改回默认」
    ...(hostOptions ? { proxy: form.proxyMode === 'custom' ? proxyInputOf(form.proxy) : form.proxyMode } : {}),
    ...(hostOptions && form.proxyCommand.trim() ? { proxyCommand: form.proxyCommand.trim() } : {}),
    ...(form.authType === 'key' && form.keyId ? { keyId: form.keyId } : {}),
    ...(form.credentialId ? { credentialId: form.credentialId } : {}),
  })
  // 认证方式下拉：密码/私钥/agent，或「使用凭据：xxx」（值 cred:<id>）。选凭据时用户名/认证方式跟随凭据
  const authValue = form.credentialId ? `cred:${form.credentialId}` : form.authType
  const pickAuth = (v: string) => {
    if (!v.startsWith('cred:')) return setF({ authType: v as AuthType, credentialId: '' })
    const c = creds.find((x) => x.id === v.slice(5))
    if (c) setF({ credentialId: c.id, username: c.username, authType: c.authType })
  }
  const setF = (patch: Partial<SshForm>) => { setForm(patch); setTested(false); setError('') }
  const test = async () => {
    setTesting(true); setError('')
    const r = await client.terminal.testSsh(connectInput(), editId).catch((e) => ({ ok: false, error: String(e) }))
    setTesting(false)
    if (r.ok) setTested(true); else setError(r.error || tr('连接测试失败'))
  }
  const submit = async () => {
    setConnecting(true); setError('')
    try { await onConnected() }
    catch (e) { setError(e instanceof Error ? e.message : String(e)) }
    finally { setConnecting(false) }
  }
  const jumpCandidates = hosts.filter((h) => h.id !== editId)

  return (
    <div className={card ? 'space-y-4' : 'space-y-2.5'}>
      <Group card={card} title={tr('基础')}>
        <FormRow label={tr('名称')}><Inp value={form.label} onChange={(v) => setF({ label: v })} placeholder={tr('给这台主机起个名')} /></FormRow>
        <div className="flex gap-2">
          <div className="flex-1"><FormRow label={tr('主机地址')}><Inp value={form.host} onChange={(v) => setF({ host: v })} placeholder="1.2.3.4" /></FormRow></div>
          <div className="w-20"><FormRow label={tr('端口')}><Inp value={String(form.port)} onChange={(v) => setF({ port: Number(v) || 22 })} /></FormRow></div>
        </div>
        {!form.credentialId && <FormRow label={tr('用户名')}><Inp value={form.username} onChange={(v) => setF({ username: v })} placeholder="root" /></FormRow>}
        <FormRow label={tr('认证方式')} tip={tr('选「使用凭据」时用户名和认证都跟随凭据；改凭据，所有引用它的主机一起生效。凭据在 设置 → 主机与连接 →「凭据」里管理')}>
          <Select value={authValue} onValueChange={pickAuth} className={SELECT_BG}>
            <option value="password">{tr('密码')}</option>
            <option value="key">{tr('私钥')}</option>
            <option value="agent">ssh-agent / Pageant</option>
            {(creds.length > 0 || form.credentialId) && (
              <optgroup label={tr('使用凭据')}>
                {creds.map((c) => <option key={c.id} value={`cred:${c.id}`}>{tr('使用凭据：{name}（{user}）', { name: c.name, user: c.username })}</option>)}
                {form.credentialId && !cred && <option value={authValue}>{tr('使用凭据：（已删除）')}</option>}
              </optgroup>
            )}
          </Select>
        </FormRow>
        {form.credentialId ? (
          <div className="rounded-md bg-[var(--color-bg-panel)] px-2.5 py-1.5 text-[12px] text-[var(--color-text-secondary)]">
            {cred ? <>{trx('用户名 {user} · {auth}', { user: <span className="text-[var(--color-text-primary)]">{cred.username}</span>, auth: tr(AUTH_LABEL[cred.authType]) })}{cred.hasSecret ? '' : tr('（凭据未填密码/私钥）')}<span className="block text-[11px] text-[var(--color-text-muted)]">{tr('在「凭据」里修改')}</span></>
              : <span className="text-[var(--color-danger)]">{tr('该凭据已不存在，请改选认证方式')}</span>}
          </div>
        ) : form.authType === 'agent' ? <AgentStatus /> : form.authType === 'password' ? (
          <FormRow label={tr('密码')} hint={editId ? tr('留空不改') : undefined}><Inp type="password" value={form.password} onChange={(v) => setF({ password: v })} /></FormRow>
        ) : (
          <>
            <AppKeySelect value={form.keyId ?? ''} onChange={(keyId) => setF({ keyId })} />
            {!form.keyId && <>
              <FormRow label={tr('私钥')} hint={editId ? tr('留空不改') : undefined}>
                <textarea value={form.privateKey} onChange={(e) => setF({ privateKey: e.target.value })} rows={3} className={cn(TEXTAREA, 'resize-none font-mono')} />
              </FormRow>
              <FormRow label={tr('私钥口令')} hint={tr('可选')}><Inp type="password" value={form.passphrase} onChange={(v) => setF({ passphrase: v })} /></FormRow>
            </>}
          </>
        )}
        {!editId && <SwitchRow label={tr('保存为主机')} checked={form.saveAs} onChange={(v) => setF({ saveAs: v })} />}
        {/* 分组/分级/备注/保持会话只对已保存主机有意义 */}
        {(editId || form.saveAs) && (
          <>
            <div className="flex gap-2">
              <div className="flex-1">
                <FormRow label={tr('分组')} tip={tr('如 生产 / 数据库；主机列表按分组折叠显示')}>
                  <Combobox value={form.group} onChange={(v) => setF({ group: v })} options={hostGroupNames(hosts)} placeholder={tr('留空 = 未分组')} className="bg-[var(--color-bg-panel)]" />
                </FormRow>
              </div>
              <div className="flex-1">
                <FormRow label={tr('分级')} tip={tr('生产：AI 在这台主机上的每条写操作都需你确认，危险命令强制确认')}>
                  <Select value={form.env} onValueChange={(v) => setF({ env: v as SshForm['env'] })} className={SELECT_BG}>
                    <option value="">{tr('未标注')}</option>
                    <option value="test">{tr('测试')}</option>
                    <option value="prod">{tr('生产')}</option>
                  </Select>
                </FormRow>
              </div>
            </div>
            <FormRow label={tr('备注')} tip={tr('会同步成知识库里该主机的一张「主机备注」卡，AI 用到这台主机时读到。写用途、服务管理方式、日志路径、注意事项等，不要写密码等机密；分条记录请用知识库（主机面板右键 → 知识库）')}>
              <textarea value={form.notes} onChange={(e) => setF({ notes: e.target.value })} rows={card ? 3 : 2}
                placeholder={tr('用途、服务管理方式、日志路径、注意事项…')} className={cn(TEXTAREA, 'resize-y')} />
            </FormRow>
            {hostOptions && (
              <FormRow label={tr('规则')} tip={tr('AI 用到这台主机后注入系统提示、必须遵守的规则（如「只读排查，改配置前先问我」）。叠加顺序：全局 → 分组 → 主机 → 工作目录，越具体的优先；分组规则在主机面板里右键分组设置。不要写密码等机密')}>
                <textarea data-host-rules value={form.rules ?? ''} onChange={(e) => setF({ rules: e.target.value })} rows={card ? 3 : 2}
                  placeholder={tr('例：这台是主库，禁止重启 mysqld；变更前先 mysqldump')} className={cn(TEXTAREA, 'resize-y')} />
              </FormRow>
            )}
            <SwitchRow label={tr('断线后保持会话')} hint={tr('需服务器装有 tmux')} checked={form.persistSession} onChange={(v) => setF({ persistSession: v })}
              tip={tr('终端跑在服务器的 tmux 会话里，断线 / 重启应用后接回，正在跑的任务不中断。需服务器装有 tmux；回滚历史以 tmux 为准（xterm 只有接回后的输出）')} />
          </>
        )}
      </Group>
      <AdvancedGroup card={card} open={advOpen} onToggle={() => setAdvOpen(!advOpen)}>
        {jumpCandidates.length > 0 && (
          <FormRow label={tr('跳板机')} tip={tr('经另一台已保存主机跳转连接（同 ProxyJump）')}>
            <Select value={form.jumpHostId} onValueChange={(v) => setF({ jumpHostId: v })} className={SELECT_BG}>
              <option value="">{tr('直连（不经跳板）')}</option>
              {jumpCandidates.map((h) => <option key={h.id} value={h.id}>{tr('{name}（{detail}）', { name: h.label, detail: `${h.username}@${h.host}:${h.port}` })}</option>)}
            </Select>
          </FormRow>
        )}
        {hostOptions && <HostOptions form={form} setF={setF} />}
        <FormRow label={tr('字符编码')} hint={editId ? tr('改后对新打开的终端生效') : undefined} tip={tr('默认 UTF-8；老服务器中文乱码时选 GBK')}>
          <Select value={form.encoding} onValueChange={(v) => setF({ encoding: v as TermEncoding })} className={SELECT_BG}
            options={TERM_ENCODINGS.map((e) => ({ value: e, label: `${ENCODING_LABEL[e]}${e === 'utf8' ? tr('（默认）') : ''}` }))} />
        </FormRow>
      </AdvancedGroup>
      {error && <div className={DANGER_BOX}>{error}</div>}
      <div className="flex items-center justify-end gap-2 pt-1">
        <button onClick={test} disabled={testing || connecting || !form.host || !form.username}
          className="flex items-center gap-1.5 rounded-md border border-[var(--color-border-default)] px-3 py-1.5 text-[12px] text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-bg-hover)] disabled:opacity-40">
          {testing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : tested ? <Check className="h-3.5 w-3.5 text-[var(--color-success)]" /> : null}
          {testing ? tr('测试中') : tested ? tr('连接正常') : tr('测试连接')}
        </button>
        <button onClick={submit} disabled={connecting || !form.host || !form.username}
          className="flex items-center gap-1.5 rounded-md border border-transparent bg-[var(--color-accent)] px-4 py-1.5 text-[12px] font-medium text-[var(--color-bg-base)] transition-colors hover:bg-[var(--color-accent-dim)] disabled:opacity-40">
          {connecting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
          {editId ? tr('保存') : tr('action|连接')}
        </button>
      </div>
    </div>
  )
}

const WARN_BOX = 'rounded-md bg-[color:color-mix(in_srgb,var(--color-warn)_10%,transparent)] px-2.5 py-1.5 text-[11px] text-[var(--color-warn)]'
const DANGER_BOX = 'rounded-md bg-[color:color-mix(in_srgb,var(--color-danger)_10%,transparent)] px-2.5 py-1.5 text-[11px] text-[var(--color-danger)]'

// 主机选项（「高级」里，按重要性）：出站代理 → ProxyCommand → 登录后自动执行 → agent 转发 → 心跳 / 超时 → 压缩 → 终端类型
function HostOptions({ form, setF }: { form: SshForm; setF: (patch: Partial<SshForm>) => void }) {
  const pc = form.proxyCommand.trim()
  const [customTerm, setCustomTerm] = useState(!(TERM_TYPES as readonly string[]).includes(form.termType))
  const badTerm = customTerm && form.termType.trim() !== DEFAULT_TERM_TYPE && !cleanTermType(form.termType)
  const bad = (v: string, min: number, max: number) => { const n = Number(v); return !(v.trim() && Number.isInteger(n) && n >= min && n <= max) }
  const badKeep = bad(form.keepaliveSec, 0, 3600), badReady = bad(form.readyTimeoutSec, 3, 300)
  const secTip = tr('空闲一会儿就被断开（NAT / 防火墙）时把心跳调小；网络慢连不上时把超时调大。心跳 0–3600、超时 3–300 的整数，不合法的项保存时按默认（{keep} / {ready} 秒）。对这台主机的终端、端口转发、文件传输都生效', { keep: D.keepaliveSec, ready: D.readyTimeoutSec })
  return (
    <>
      <FormRow label={tr('出站代理')} hint={form.proxyMode !== 'none' && form.jumpHostId ? tr('已设跳板机：代理对这台主机不生效') : pc && form.proxyMode === 'default' ? tr('已设 ProxyCommand：全局默认代理不生效') : undefined}
        tip={tr('跟随全局默认 = 用 设置 → 网络代理 里的设置。已设跳板机时这台主机经跳板连接，代理不生效（跳板机自己的代理设置生效）；已设 ProxyCommand 时全局默认代理对这台主机不生效')}>
        <Select value={form.proxyMode} onValueChange={(v) => setF({ proxyMode: v as SshForm['proxyMode'] })} className={SELECT_BG}>
          <option value="default">{tr('跟随全局默认')}</option>
          <option value="none">{tr('不使用代理')}</option>
          <option value="custom">{tr('单独设置')}</option>
        </Select>
      </FormRow>
      {form.proxyMode === 'custom' && <div className="border-l border-[var(--color-border-subtle)] pl-3"><ProxyFields value={form.proxy} onChange={(p) => setF({ proxy: { ...form.proxy, ...p } })} /></div>}
      <FormRow label="ProxyCommand" hint={tr('可选，同 OpenSSH')}
        tip={tr('连接时在本机执行该命令，用它的输入输出作 SSH 连接（cloudflared / aws ssm / tsh / ssh -W %h:%p 跳板 …）。%h 主机、%p 端口、%r 用户名；Windows 经 cmd 执行。不能与跳板机、单独设置的出站代理同时使用')}>
        <Inp value={form.proxyCommand} onChange={(v) => setF({ proxyCommand: v })} placeholder={tr('如 {path}', { path: 'cloudflared access ssh --hostname %h' })} />
      </FormRow>
      {pc && form.jumpHostId && <div className={DANGER_BOX}>{tr('ProxyCommand 与跳板机不能同时使用：请把跳板机改回「直连」或清空 ProxyCommand')}</div>}
      {pc && form.proxyMode === 'custom' && <div className={DANGER_BOX}>{tr('ProxyCommand 与单独设置的代理不能同时使用：请把代理改回「跟随全局默认」或「不使用」')}</div>}
      <FormRow label={tr('登录后自动执行')} hint={tr('每行一条，连上后依次发到终端')}
        tip={tr('每次打开终端和断线重连后都会执行（保持会话的主机只在新建 tmux 会话时执行，接回时不执行）；AI 执行命令不受影响')}>
        <textarea value={form.loginCommands} onChange={(e) => setF({ loginCommands: e.target.value })} rows={3}
          placeholder={tr('如：{cmd}', { cmd: '\ncd /app && source env.sh\nsudo -i' })} className={cn(TEXTAREA, 'resize-y font-mono')} />
      </FormRow>
      {form.env === 'prod' && form.loginCommands.trim() && <div className={WARN_BOX}>{tr('生产主机：每次连接（含自动重连）都会执行，请确认没有修改性操作')}</div>}
      <SwitchRow label={tr('SSH agent 转发')} hint={tr('服务器上用本机 agent 里的密钥')} checked={form.agentForward} onChange={(v) => setF({ agentForward: v })}
        tip={tr('服务器上 git pull / 再 ssh 到别的机器时用本机 ssh-agent / Pageant 里的密钥，不用把私钥放到服务器上。安全风险：连接期间，这台服务器上的 root（或能访问你会话的人）可以借用你本机 agent 里的密钥登录其它机器（拿不到私钥本身）。只对信任的服务器开启')} />
      {form.agentForward && <div className={WARN_BOX}>{tr('有借用密钥的风险，只对信任的服务器开启')}{form.env === 'prod' ? tr('；这是生产主机，请慎重') : ''}</div>}
      <div className="flex gap-2">
        <div className="flex-1"><FormRow label={tr('心跳间隔')} hint={badKeep ? <span className="text-[var(--color-danger)]">{tr('0–3600 的整数，否则按默认')}</span> : tr('秒，0 = 关，默认 {n}', { n: D.keepaliveSec })} tip={secTip}>
          <Inp value={form.keepaliveSec} onChange={(v) => setF({ keepaliveSec: v })} /></FormRow></div>
        <div className="flex-1"><FormRow label={tr('field|连接超时')} hint={badReady ? <span className="text-[var(--color-danger)]">{tr('3–300 的整数，否则按默认')}</span> : tr('秒，默认 {n}', { n: D.readyTimeoutSec })} tip={secTip}>
          <Inp value={form.readyTimeoutSec} onChange={(v) => setF({ readyTimeoutSec: v })} /></FormRow></div>
      </div>
      <SwitchRow label={tr('压缩传输')} tip={tr('慢速链路有用，局域网反而更慢')} checked={form.compress} onChange={(v) => setF({ compress: v })} />
      <FormRow label={tr('终端类型')} hint={badTerm ? <span className="text-[var(--color-danger)]">{tr('只能用字母、数字和 . _ + -，否则按默认')}</span> : tr('$TERM，重新连接后生效')}
        tip={tr('远端 vim / htop 颜色不对或报 unknown terminal 时改成 xterm 或 vt100；不合法时按默认 {term}', { term: DEFAULT_TERM_TYPE })}>
        <div className="flex gap-2">
          <Select value={customTerm ? 'custom' : form.termType} className={SELECT_BG}
            onValueChange={(v) => { setCustomTerm(v === 'custom'); setF({ termType: v === 'custom' ? '' : v }) }}
            options={[...TERM_TYPES.map((t) => ({ value: t, label: `${t}${t === DEFAULT_TERM_TYPE ? tr('（默认）') : ''}` })), { value: 'custom', label: tr('自定义…') }]} />
          {customTerm && <Inp value={form.termType} onChange={(v) => setF({ termType: v })} placeholder={tr('如 {path}', { path: `linux${tr('list|、')}rxvt-unicode-256color` })} />}
        </div>
      </FormRow>
    </>
  )
}

// 私钥来源：粘贴私钥 / 选「SSH 密钥」页里管理的应用密钥（没有应用密钥时不显示）
export function AppKeySelect({ value, onChange }: { value: string; onChange: (keyId: string) => void }) {
  const [keys, setKeys] = useState<SshKeySummary[]>([])
  useEffect(() => { client.keys.list().then(setKeys).catch(() => {}) }, [])
  if (!keys.length && !value) return null
  const cur = keys.find((k) => k.id === value)
  return (
    <FormRow label={tr('私钥来源')} tip={tr('应用密钥在 设置 → SSH 密钥 里生成 / 导入，私钥经系统密钥链加密保存')}
      hint={cur && <span className="block truncate" title={cur.fingerprint}>{cur.fingerprint}{cur.hasPassphrase ? tr(' · 口令已随密钥保存') : ''}</span>}>
      <Select value={value} onValueChange={onChange} className={SELECT_BG}>
        <option value="">{tr('粘贴私钥')}</option>
        {keys.map((k) => <option key={k.id} value={k.id}>{tr('应用密钥：{name}（{type}）', { name: k.name, type: k.type })}</option>)}
        {value && !cur && <option value={value}>{tr('应用密钥（已删除）')}</option>}
      </Select>
    </FormRow>
  )
}

// agent 认证：显示检测到的系统 agent（打开时查一次，可手动重查）
export function AgentStatus() {
  const [agent, setAgent] = useState<SshAgentInfo | null | undefined>()   // undefined = 检测中
  const check = () => { setAgent(undefined); client.hosts.detectAgent().then(setAgent).catch(() => setAgent(null)) }
  useEffect(check, [])
  return (
    <div className="flex items-center gap-2 rounded-md bg-[var(--color-bg-panel)] px-2.5 py-1.5 text-[12px]">
      {agent === undefined ? <span className="text-[var(--color-text-muted)]">{tr('检测 agent 中…')}</span>
        : agent ? <span className="text-[var(--color-success)]">{tr('检测到：{name}', { name: agent.label })}</span>
        : <span className="flex items-center gap-1.5 text-[var(--color-danger)]">{tr('未检测到 agent')}<HelpTip>{tr('启动 OpenSSH Authentication Agent 服务 / Pageant，或设置 SSH_AUTH_SOCK 环境变量后点「重新检测」')}</HelpTip></span>}
      <button onClick={check} className="ml-auto shrink-0 text-[var(--color-text-muted)] hover:text-[var(--color-accent)]">{tr('重新检测')}</button>
    </div>
  )
}

const INPUT_CLS = 'w-full rounded-md border border-[var(--color-border-default)] bg-[var(--color-bg-panel)] px-2.5 py-1.5 text-[12.5px] leading-[18px] text-[var(--color-text-primary)] outline-none placeholder:text-[var(--color-text-muted)] focus:border-[color:color-mix(in_srgb,var(--color-accent)_60%,transparent)]'
/** 本表单输入框是 panel 底色，下拉跟着一致 */
const SELECT_BG = 'bg-[var(--color-bg-panel)]'
const TEXTAREA = `${INPUT_CLS} text-[12px]`

// 代理字段：类型 / 地址 / 端口 / 可选用户名密码。主机「高级」与 设置 → 网络代理 共用
export function ProxyFields({ value, onChange }: { value: ProxyDraft; onChange: (patch: Partial<ProxyDraft>) => void }) {
  const port = Number(value.port)
  const badPort = !(Number.isInteger(port) && port >= 1 && port <= 65535)
  return (
    <div className="space-y-2.5">
      <div className="flex gap-2">
        <div className="w-32"><FormRow label={tr('类型')}>
          <Select value={value.type} onValueChange={(v) => {
            const type = v as ProxyType
            onChange({ type, ...(value.port === (value.type === 'http' ? '8080' : '1080') ? { port: type === 'http' ? '8080' : '1080' } : {}) })   // 端口还是默认值就跟着换
          }} className={SELECT_BG}>
            <option value="socks5">SOCKS5</option>
            <option value="http">HTTP CONNECT</option>
          </Select>
        </FormRow></div>
        <div className="flex-1"><FormRow label={tr('代理地址')}><Inp value={value.host} onChange={(v) => onChange({ host: v })} placeholder="proxy.example.com" /></FormRow></div>
        <div className="w-20"><FormRow label={tr('端口')}><Inp value={value.port} onChange={(v) => onChange({ port: v })} /></FormRow></div>
      </div>
      <div className="flex gap-2">
        <div className="flex-1"><FormRow label={tr('用户名')} hint={tr('可选')}><Inp value={value.username} onChange={(v) => onChange({ username: v })} /></FormRow></div>
        <div className="flex-1"><FormRow label={tr('密码')} hint={value.saved ? tr('留空不改') : tr('可选')}><Inp type="password" value={value.password} onChange={(v) => onChange({ password: v })} /></FormRow></div>
      </div>
      {(!value.host.trim() || badPort) && <span className="block text-[11px] text-[var(--color-danger)]">{tr('请填代理地址和 1–65535 的端口')}</span>}
    </div>
  )
}

/** 表单字段：标签（+ 问号说明）在上，控件在下，可选一句灰字 hint */
export function FormRow({ label, tip, hint, children }: { label: string; tip?: ReactNode; hint?: ReactNode; children: ReactNode }) {
  return (
    <div>
      <div className="mb-1 flex items-center gap-1.5 text-[12px] text-[var(--color-text-secondary)]"><label>{label}</label>{tip && <HelpTip>{tip}</HelpTip>}</div>
      {children}
      {hint && <div className="mt-1 text-[11px] text-[var(--color-text-muted)]">{hint}</div>}
    </div>
  )
}
/** 开关行：左标签（+ 问号说明 / 一句 hint），右 Switch */
export function SwitchRow({ label, tip, hint, checked, onChange, disabled }: { label: string; tip?: ReactNode; hint?: ReactNode; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <div className="flex items-center gap-3">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5 text-[12.5px] text-[var(--color-text-primary)]"><span>{label}</span>{tip && <HelpTip>{tip}</HelpTip>}</div>
        {hint && <div className="mt-0.5 text-[11px] text-[var(--color-text-muted)]">{hint}</div>}
      </div>
      <Switch checked={checked} onCheckedChange={onChange} disabled={disabled} aria-label={label} />
    </div>
  )
}
export function Inp({ value, onChange, type = 'text', placeholder }: { value: string; onChange: (v: string) => void; type?: string; placeholder?: string }) {
  if (type === 'password') return <PasswordInput value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} className={INPUT_CLS} />
  return <input type={type} value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} className={INPUT_CLS} />
}
