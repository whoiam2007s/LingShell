import { useCallback, useEffect, useState } from 'react'
import { KeyRound, Plus, FileInput, Copy, Download, Upload, Trash2, Loader2, Check, FileKey } from 'lucide-react'
import { tr, dateLocale, type HostSummary, type SshKeyGenType, type SshKeySummary } from '@lingshell/shared'
import { client } from '../../../client/index.js'
import { ConfirmDialog } from '../../common/index.js'
import { Page, HelpTip } from '../ui.js'
import { Select } from '../../../components/ui/Select.js'
import { PasswordInput } from '../../../components/ui/PasswordInput.js'

// 设置 →「SSH 密钥」（工具栏 → 生成 / 导入面板 → 密钥卡片，卡片下展开部署面板）：应用管理的密钥（生成 / 导入 / 复制·导出公钥 / 删除）+ 部署公钥到已保存主机并可切换该主机为密钥认证。
// 私钥只在主进程（系统密钥链加密），这里只见公钥与指纹
const errText = (e: unknown) => String(e instanceof Error ? e.message : e).replace(/^.*?Error: /, '').replace(/^[a-z_]+: /, '')
const INPUT = 'w-full rounded-md border border-[var(--color-border-default)] bg-[var(--color-bg-panel)] px-2.5 py-1.5 text-[12.5px] leading-[18px] text-[var(--color-text-primary)] outline-none placeholder:text-[var(--color-text-muted)] focus:border-[color:color-mix(in_srgb,var(--color-accent)_60%,transparent)]'
const BTN = 'flex items-center gap-1 rounded-md border border-[var(--color-border-default)] px-3 py-1.5 text-[12px] text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-bg-hover)] disabled:opacity-40'
const PRIMARY = 'flex items-center gap-1.5 rounded-md border border-transparent bg-[var(--color-accent)] px-4 py-1.5 text-[12px] font-medium text-[var(--color-bg-base)] transition-colors hover:bg-[var(--color-accent-dim)] disabled:opacity-40'
const ERR_BOX = 'rounded-md bg-[color:color-mix(in_srgb,var(--color-danger)_10%,transparent)] px-2.5 py-1.5 text-[11px] text-[var(--color-danger)]'

export function KeyManager() {
  const [keys, setKeys] = useState<SshKeySummary[]>([])
  const [hosts, setHosts] = useState<HostSummary[]>([])
  const [panel, setPanel] = useState<'none' | 'generate' | 'import'>('none')
  const [picked, setPicked] = useState<{ fileName: string; needPassphrase: boolean } | null>(null)
  const [deployId, setDeployId] = useState<string | undefined>()
  const [delTarget, setDelTarget] = useState<SshKeySummary | null>(null)
  const [error, setError] = useState('')
  const [flash, setFlash] = useState('')

  const refresh = useCallback(() => {
    client.keys.list().then(setKeys).catch(() => {})
    client.hosts.list().then(setHosts).catch(() => {})
  }, [])
  useEffect(() => { refresh() }, [refresh])
  const note = (s: string) => { setFlash(s); setTimeout(() => setFlash(''), 2000) }

  const startImport = async () => {
    setError('')
    try {
      const p = await client.keys.pickImport()
      if (p) { setPicked(p); setPanel('import') }
    } catch (e) { setError(errText(e)) }
  }
  const copy = (k: SshKeySummary) => navigator.clipboard?.writeText(k.publicKey).then(() => note(tr('已复制「{name}」的公钥', { name: k.name })), () => setError(tr('复制失败')))
  const doExport = (k: SshKeySummary, which: 'public' | 'private') => {
    setError('')
    client.keys.export(k.id, which).then((p) => { if (p) note(tr('已导出到 {path}', { path: p })) }).catch((e) => setError(errText(e)))
  }
  const doDelete = () => {
    if (delTarget) client.keys.delete(delTarget.id).then(refresh).catch((e) => setError(errText(e)))
    setDelTarget(null)
  }

  const toggleGenerate = () => { setPanel(panel === 'generate' ? 'none' : 'generate'); setError('') }
  return (
    <Page>
      {/* 顶部工具栏：主操作「生成密钥」靠右 */}
      <div className="flex items-center gap-2">
        <span className="flex items-center gap-1.5 text-[12px] text-[var(--color-text-muted)]">{tr('应用管理的密钥')}
          <HelpTip>{tr('私钥（及口令）经操作系统密钥链加密保存在本机数据目录，不以明文落盘、不发给 AI；界面上只显示公钥与指纹。主机要用这把密钥：在「主机与连接」编辑主机，认证方式选「私钥」、私钥来源选这把应用密钥；或用「部署公钥到服务器」一步完成')}</HelpTip>
        </span>
        <button onClick={startImport} className={`ml-auto ${BTN}`}><FileInput className="h-3.5 w-3.5" />{tr('导入私钥')}</button>
        <button onClick={toggleGenerate} className={PRIMARY.replace('px-4', 'px-3')}><Plus className="h-3.5 w-3.5" />{tr('生成密钥')}</button>
      </div>
      {panel === 'generate' && <GeneratePanel onDone={(k) => { setPanel('none'); refresh(); note(tr('已生成「{name}」', { name: k.name })) }} onCancel={() => setPanel('none')} />}
      {panel === 'import' && picked && <ImportPanel picked={picked} onDone={(k) => { setPanel('none'); setPicked(null); refresh(); note(tr('已导入「{name}」', { name: k.name })) }} onCancel={() => { setPanel('none'); setPicked(null) }} />}
      {error && <div className={ERR_BOX}>{error}</div>}
      {flash && <div className="flex items-center gap-1 text-[11px] text-[var(--color-success)]"><Check className="h-3 w-3" />{flash}</div>}
      {keys.length === 0 ? (
        panel === 'none' && <div className="flex flex-col items-center gap-2.5 rounded-lg border border-dashed border-[var(--color-border-subtle)] py-8 text-[12px] text-[var(--color-text-muted)]">
          {tr('还没有密钥')}
          <button onClick={toggleGenerate} className={PRIMARY.replace('px-4', 'px-3')}><Plus className="h-3.5 w-3.5" />{tr('生成密钥')}</button>
        </div>
      ) : (
        <div className="space-y-1.5">
          {keys.map((k) => (
            <div key={k.id} className="rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-bg-base)]">
              <div className="flex items-center gap-2.5 px-3 py-2">
                <KeyRound className="h-4 w-4 shrink-0 text-[var(--color-accent)]" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5 text-[12.5px]">
                    <span className="truncate font-medium text-[var(--color-text-primary)]">{k.name}</span>
                    <Tag>{k.type}</Tag>
                    {k.hasPassphrase && <Tag>{tr('有口令')}</Tag>}
                  </div>
                  <div className="truncate font-mono text-[11px] text-[var(--color-text-muted)]" title={`${k.fingerprint}\n${tr('创建于 {t}', { t: new Date(k.createdAt).toLocaleString(dateLocale()) })}`}>{k.fingerprint} · {new Date(k.createdAt).toLocaleDateString(dateLocale())}</div>
                </div>
                <IconBtn title={tr('复制公钥')} onClick={() => copy(k)}><Copy className="h-3 w-3" /></IconBtn>
                <IconBtn title={tr('导出公钥')} onClick={() => doExport(k, 'public')}><Download className="h-3 w-3" /></IconBtn>
                <IconBtn title={tr('导出私钥')} onClick={() => doExport(k, 'private')}><FileKey className="h-3 w-3" /></IconBtn>
                <IconBtn title={tr('删除')} danger onClick={() => setDelTarget(k)}><Trash2 className="h-3 w-3" /></IconBtn>
                <button title={tr('部署公钥到服务器')} onClick={() => setDeployId(deployId === k.id ? undefined : k.id)}
                  className={`flex shrink-0 items-center gap-1 rounded-md border px-2 py-1 text-[11.5px] transition-colors hover:bg-[var(--color-bg-hover)] ${deployId === k.id ? 'border-[color:color-mix(in_srgb,var(--color-accent)_50%,transparent)] text-[var(--color-accent)]' : 'border-[var(--color-border-default)] text-[var(--color-text-secondary)]'}`}>
                  <Upload className="h-3 w-3" />{tr('verb|部署')}
                </button>
              </div>
              {deployId === k.id && <DeployPanel k={k} hosts={hosts} onHostsChanged={refresh} />}
            </div>
          ))}
        </div>
      )}
      <ConfirmDialog open={!!delTarget} title={tr('sshkey|删除密钥')} message={tr('确定删除密钥「{name}」？私钥会从本机删除且不可恢复（服务器上的 authorized_keys 不会改动）。', { name: delTarget?.name ?? '' })} onConfirm={doDelete} onCancel={() => setDelTarget(null)} />
    </Page>
  )
}

function GeneratePanel({ onDone, onCancel }: { onDone: (k: SshKeySummary) => void; onCancel: () => void }) {
  const [name, setName] = useState('')
  const [type, setType] = useState<SshKeyGenType>('ed25519')
  const [pp, setPp] = useState(''), [pp2, setPp2] = useState('')
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  const mismatch = pp !== pp2
  const go = async () => {
    setBusy(true); setError('')
    try { onDone(await client.keys.generate(name.trim(), type, pp || undefined)) }
    catch (e) { setError(errText(e)) }
    finally { setBusy(false) }
  }
  return (
    <Box>
      <div className="flex gap-2">
        <div className="flex-1"><Label text={tr('field|名称')}><input className={INPUT} value={name} onChange={(e) => setName(e.target.value)} placeholder={tr('如 my-laptop')} autoFocus /></Label></div>
        <div className="w-44"><Label text={tr('类型')}>
          <Select value={type} onValueChange={(v) => setType(v as SshKeyGenType)}>
            <option value="ed25519">{tr('ED25519（推荐）')}</option>
            <option value="rsa">{tr('RSA 4096（兼容老服务器）')}</option>
          </Select>
        </Label></div>
      </div>
      <div className="flex gap-2">
        <div className="flex-1"><Label text={tr('口令')} tip={tr('可选。口令会随密钥加密保存（本应用连接时自动使用）；导出的私钥带这个口令')}><PasswordInput className={INPUT} value={pp} onChange={(e) => setPp(e.target.value)} placeholder={tr('留空 = 无口令')} /></Label></div>
        <div className="flex-1"><Label text={tr('确认口令')}><PasswordInput className={INPUT} value={pp2} onChange={(e) => setPp2(e.target.value)} /></Label></div>
      </div>
      {mismatch && pp2 && <div className={ERR_BOX}>{tr('两次口令不一致')}</div>}
      {error && <div className={ERR_BOX}>{error}</div>}
      <div className="flex justify-end gap-2">
        <button onClick={onCancel} className={BTN}>{tr('取消')}</button>
        <button onClick={go} disabled={busy || !name.trim() || mismatch} className={PRIMARY}>{busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}{busy ? tr('生成中…') : tr('生成')}</button>
      </div>
    </Box>
  )
}

function ImportPanel({ picked, onDone, onCancel }: { picked: { fileName: string; needPassphrase: boolean }; onDone: (k: SshKeySummary) => void; onCancel: () => void }) {
  const [name, setName] = useState(picked.fileName.replace(/\.(ppk|pem|key)$/i, ''))
  const [pp, setPp] = useState('')
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  const go = async () => {
    setBusy(true); setError('')
    try { onDone(await client.keys.importPicked(name.trim(), pp || undefined)) }
    catch (e) { setError(errText(e)) }
    finally { setBusy(false) }
  }
  return (
    <Box>
      <div className="flex items-center gap-1.5 text-[11px] text-[var(--color-text-muted)]">{tr('文件：{name}', { name: picked.fileName })}<HelpTip>{tr('支持 OpenSSH / PEM / PuTTY .ppk 格式')}</HelpTip></div>
      <div className="flex gap-2">
        <div className="flex-1"><Label text={tr('field|名称')}><input className={INPUT} value={name} onChange={(e) => setName(e.target.value)} autoFocus /></Label></div>
        {picked.needPassphrase && <div className="flex-1"><Label text={tr('私钥口令')}><PasswordInput className={INPUT} value={pp} onChange={(e) => setPp(e.target.value)} /></Label></div>}
      </div>
      {error && <div className={ERR_BOX}>{error}</div>}
      <div className="flex justify-end gap-2">
        <button onClick={onCancel} className={BTN}>{tr('取消')}</button>
        <button onClick={go} disabled={busy || !name.trim() || (picked.needPassphrase && !pp)} className={PRIMARY}>{busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}{tr('导入')}</button>
      </div>
    </Box>
  )
}

// 部署公钥：选一台已保存主机（用它现有的认证连上）→ 幂等追加到 ~/.ssh/authorized_keys → 可选切换该主机为这把密钥（先测试连接）
function DeployPanel({ k, hosts, onHostsChanged }: { k: SshKeySummary; hosts: HostSummary[]; onHostsChanged: () => void }) {
  const [hostId, setHostId] = useState('')
  const [busy, setBusy] = useState<'' | 'deploy' | 'switch'>('')
  const [confirmProd, setConfirmProd] = useState(false)
  const [done, setDone] = useState<{ added: boolean } | null>(null)
  const [switched, setSwitched] = useState(false)
  const [error, setError] = useState('')
  const host = hosts.find((h) => h.id === hostId)
  const pickHost = (id: string) => { setHostId(id); setDone(null); setSwitched(false); setError('') }
  const deploy = async () => {
    setConfirmProd(false); setBusy('deploy'); setError(''); setDone(null); setSwitched(false)
    try { setDone(await client.keys.deploy(k.id, hostId)) }
    catch (e) { setError(errText(e)) }
    finally { setBusy('') }
  }
  const useKey = async () => {
    setBusy('switch'); setError('')
    try { await client.keys.useForHost(k.id, hostId); setSwitched(true); onHostsChanged() }
    catch (e) { setError(errText(e)) }
    finally { setBusy('') }
  }
  const already = host?.authType === 'key' && host.keyId === k.id
  return (
    <div className="space-y-2 border-t border-[var(--color-border-subtle)] px-3 py-2.5 text-[12px]">
      <div className="flex items-center gap-2">
        <span className="flex shrink-0 items-center gap-1.5 text-[var(--color-text-secondary)]">{tr('部署到')}
          <HelpTip>{tr('用该主机现有的认证连上，执行：建 ~/.ssh（700）、authorized_keys（600），已有这把公钥则不重复追加。会记入执行记录。部署后可一键把该主机切换为此密钥认证（先测试连接）')}</HelpTip>
        </span>
        <Select value={hostId} onValueChange={pickHost} placeholder={tr('选择要部署到的已保存主机…')}
          options={hosts.map((h) => ({ value: h.id, label: tr('{prod}{label}（{addr}）', { prod: h.env === 'prod' ? tr('【生产】') : '', label: h.label, addr: `${h.username}@${h.host}:${h.port}` }) }))} />
        <button disabled={!hostId || !!busy} onClick={() => (host?.env === 'prod' ? setConfirmProd(true) : deploy())} className={`shrink-0 ${PRIMARY}`}>
          {busy === 'deploy' && <Loader2 className="h-3.5 w-3.5 animate-spin" />}{tr('verb|部署')}
        </button>
      </div>
      {error && <div className={ERR_BOX}>{error}</div>}
      {done && (
        <div className="space-y-1.5">
          <div className="flex items-center gap-1 text-[var(--color-success)]"><Check className="h-3.5 w-3.5" />{done.added ? tr('已追加到 ~/.ssh/authorized_keys') : tr('authorized_keys 里已有这把公钥，未重复追加')}</div>
          {already || switched ? <div className="text-[11px] text-[var(--color-success)]">{tr('该主机已使用这把密钥认证')}</div> : (
            <button onClick={useKey} disabled={!!busy} className={BTN}>
              {busy === 'switch' && <Loader2 className="h-3.5 w-3.5 animate-spin" />}{tr('切换该主机为此密钥认证')}
            </button>
          )}
        </div>
      )}
      <ConfirmDialog open={confirmProd} title={tr('部署公钥到生产主机')} confirmText={tr('确认部署')}
        message={tr('「{host}」是生产主机。将修改服务器上 {user} 用户的 ~/.ssh/authorized_keys（追加公钥「{key}」），之后持有这把私钥即可登录。确定继续？', { host: host?.label ?? '', user: host?.username ?? '', key: k.name })}
        onConfirm={deploy} onCancel={() => setConfirmProd(false)} />
    </div>
  )
}

function Box({ children }: { children: React.ReactNode }) {
  return <div className="space-y-2.5 rounded-md border border-[var(--color-border-default)] bg-[var(--color-bg-base)] p-3">{children}</div>
}
function Label({ text, tip, children }: { text: string; tip?: React.ReactNode; children: React.ReactNode }) {
  return <div><div className="mb-1 flex items-center gap-1.5 text-[12px] text-[var(--color-text-secondary)]"><label>{text}</label>{tip && <HelpTip>{tip}</HelpTip>}</div>{children}</div>
}
function Tag({ children }: { children: React.ReactNode }) {
  return <span className="shrink-0 rounded bg-[var(--color-bg-hover)] px-1 text-[10px] leading-4 text-[var(--color-text-muted)]">{children}</span>
}
function IconBtn({ title, onClick, children, active, danger }: { title: string; onClick: () => void; children: React.ReactNode; active?: boolean; danger?: boolean }) {
  return (
    <button onClick={onClick} title={title}
      className={`flex h-6 w-6 shrink-0 items-center justify-center rounded ${danger ? 'text-[var(--color-text-muted)] hover:bg-[color:color-mix(in_srgb,var(--color-danger)_15%,transparent)] hover:text-[var(--color-danger)]' : `hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-accent)] ${active ? 'text-[var(--color-accent)]' : 'text-[var(--color-text-muted)]'}`}`}>
      {children}
    </button>
  )
}
