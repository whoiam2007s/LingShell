import { useEffect, useState } from 'react'
import { Server, X } from 'lucide-react'
import { tr, type HostSummary, type TerminalInfo } from '@lingshell/shared'
import { client } from '../../../client/index.js'
import { emptySshForm, type SshForm, SavedHostList, NewConnectionForm } from '../../../components/sshParts.js'
import { hopRole } from './AuthPromptDialog.js'

// 下次打开时直接进「新建连接」并预填（ssh:// 链接不匹配已存主机时用；只填地址/端口/用户名，不带密码）
let prefill: Partial<SshForm> | undefined
export function setSshConnectPrefill(p: Partial<SshForm>): void { prefill = p }

export function SshConnectDialog({ open, onClose, onConnected }: { open: boolean; onClose: () => void; onConnected: (info: TerminalInfo, hostId?: string) => void }) {
  const [mode, setMode] = useState<'saved' | 'new'>('saved')
  const [hosts, setHosts] = useState<HostSummary[]>([])
  const [connecting, setConnecting] = useState(false)
  const [error, setError] = useState('')
  const [form, setForm] = useState<SshForm>(emptySshForm)

  // 每次打开：拉主机列表 + 重置表单/状态（避免残留上次的内容）
  useEffect(() => {
    if (!open) return
    client.hosts.list().then(setHosts).catch(() => {})
    const p = prefill
    prefill = undefined
    setMode(p ? 'new' : 'saved'); setError(''); setConnecting(false)
    setForm(p ? { ...emptySshForm, ...p } : emptySshForm)
  }, [open])
  if (!open) return null

  const setF = (patch: Partial<SshForm>) => setForm((f) => ({ ...f, ...patch }))

  const connectInput = () => ({
    host: form.host, port: form.port, username: form.username, authType: form.authType,
    password: form.authType === 'password' ? form.password : undefined,
    privateKey: form.authType === 'key' ? form.privateKey : undefined,
    passphrase: form.authType === 'key' ? form.passphrase : undefined,
    jumpHostId: form.jumpHostId || undefined,
    encoding: form.encoding,
    ...(form.authType === 'key' && form.keyId ? { keyId: form.keyId } : {}),   // 应用密钥
    ...(form.credentialId ? { credentialId: form.credentialId } : {}),   // 使用凭据（主进程按凭据解析用户名/认证）
  })

  const connectSaved = async (hostId: string) => {
    setConnecting(true); setError('')
    try { const info = await client.terminal.createSsh({ hostId }); onConnected(info, hostId); onClose() }
    catch (e) { setError(sshErrorText(errMsg(e))) }
    finally { setConnecting(false) }
  }

  const connectNew = async () => {
    const info = await client.terminal.createSsh({
      connect: connectInput(),
      saveAs: form.saveAs ? (form.label || `${form.username}@${form.host}`) : undefined,
      ...(form.saveAs ? { notes: form.notes, env: form.env || undefined, group: form.group, persistSession: form.persistSession } : {}),
    })
    onConnected(info, info.hostId); onClose()
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="flex h-[520px] w-[440px] flex-col rounded-lg border border-[var(--color-border-default)] bg-[var(--color-bg-panel)] p-4" onClick={(e) => e.stopPropagation()}>
        <div className="mb-3 flex shrink-0 items-center justify-between">
          <span className="flex items-center gap-2 text-[14px] font-semibold text-[var(--color-text-primary)]"><Server className="h-4 w-4 text-[var(--color-accent)]" />{tr('SSH 连接')}</span>
          <button onClick={onClose}><X className="h-4 w-4 text-[var(--color-text-muted)]" /></button>
        </div>
        <div className="mb-3 flex shrink-0 items-center gap-1 text-[12px]">
          <button onClick={() => setMode('saved')} className={tabCls(mode === 'saved')}>{tr('已保存主机')}</button>
          <button onClick={() => setMode('new')} className={tabCls(mode === 'new')}>{tr('新建连接')}</button>
        </div>
        {mode === 'saved' && error && <div className="mb-2 shrink-0 rounded bg-[color:color-mix(in_srgb,var(--color-danger)_10%,transparent)] px-2 py-1 text-[12px] text-[var(--color-danger)]">{error}</div>}

        <div className="min-h-0 flex-1 overflow-y-auto pr-0.5">
          {mode === 'saved' ? (
            hosts.length === 0
              ? <div className="text-[12px] text-[var(--color-text-muted)]">{tr('暂无保存的主机，去「新建连接」')}</div>
              : <SavedHostList hosts={hosts} disabled={connecting} onConnect={connectSaved} />
          ) : (
            <NewConnectionForm form={form} setForm={setF} onConnected={connectNew} />
          )}
        </div>
      </div>
    </div>
  )
}

const tabCls = (active: boolean) => `rounded-md px-2.5 py-1 ${active ? 'bg-[color:color-mix(in_srgb,var(--color-accent)_15%,transparent)] text-[var(--color-accent)]' : 'text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)]'}`
function errMsg(e: unknown): string { return e instanceof Error ? e.message : String(e) }
function sshErrorText(code: string): string {
  // 经跳板时错误带「跳板机「X」: / 目标主机「X」: 」前缀（主进程给的中文，按中文匹配），保留它标明哪一跳失败；角色显示时翻译
  const hop = /((跳板机|目标主机)「([^」]*)」): ([\s\S]*)$/.exec(code)   // i18n-ignore 匹配主进程的中文前缀
  if (hop) return tr('{role}「{name}」: {msg}', { role: hopRole(hop[2]), name: hop[3], msg: sshErrorText(hop[4]) })
  if (code.includes('ssh_agent_')) return code.replace(/^.*?ssh_agent_\w+: /, '')
  if (code.includes('ssh_auth_failed')) return code.includes('ssh-agent') ? tr('认证失败：{msg}', { msg: code.replace(/^.*?ssh_auth_failed: /, '') }) : tr('认证失败：检查用户名/密码/私钥')
  if (code.includes('ssh_connect_timeout')) return tr('连接超时：检查主机地址/端口/网络')
  if (code.includes('ssh_unreachable')) return tr('无法连接：主机不可达')
  if (code.includes('ssh_invalid_key')) return tr('私钥无效：检查私钥内容/passphrase')
  return tr('连接失败：{msg}', { msg: code })
}
