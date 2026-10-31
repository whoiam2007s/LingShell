import { useCallback, useEffect, useState } from 'react'
import { LockKeyhole, Plus, Copy, Braces, Pencil, Trash2, Loader2, Check } from 'lucide-react'
import { hostGroupNames, secretRef, secretScopeLabel, tr, tk, dateLocale, type HostSummary, type SecretScope, type SecretSummary } from '@lingshell/shared'
import { client } from '../../../client/index.js'
import { ConfirmDialog } from '../../common/index.js'
import { Page, Section, HelpTip, INPUT, BTN2, BackLink } from '../ui.js'
import { Input } from '../../../components/ui/Input.js'
import { Select } from '../../../components/ui/Select.js'
import { Checkbox } from '../../../components/ui/Checkbox.js'
import { PasswordInput } from '../../../components/ui/PasswordInput.js'

// 设置 →「密钥保险箱」：密码 / token 存本机（系统密钥链加密），AI 在命令里写 {{secret:名称}} 引用，执行前才换成真实值。
// 值只进不出：这里只能新建 / 替换，不能查看；「复制值」二次确认后放进剪贴板，30 秒后自动清空
const errText = (e: unknown) => String(e instanceof Error ? e.message : e).replace(/^.*?Error: /, '').replace(/^[a-z_]+: /, '')
/** 说明文字里的引用示例：{{secret:名称}}（名称按界面语言显示） */
const refExample = () => `{{secret:${tr('secret|名称')}}}`
const PRIMARY = 'flex items-center gap-1.5 rounded-md border border-transparent bg-[var(--color-accent)] px-3 py-1.5 text-[12px] font-medium text-[var(--color-bg-base)] transition-colors hover:bg-[var(--color-accent-dim)] disabled:opacity-40'
const ERR_BOX = 'rounded-md bg-[color:color-mix(in_srgb,var(--color-danger)_10%,transparent)] px-2.5 py-1.5 text-[11px] text-[var(--color-danger)]'
const SCOPES: { value: SecretScope; label: string }[] = [
  { value: 'local', label: tk('仅本地终端') },
  { value: 'hosts', label: tk('指定主机') },
  { value: 'group', label: tk('指定分组') },
  { value: 'all', label: tk('全部主机（含本地）') },
]

export function SecretVaultManager() {
  const [list, setList] = useState<SecretSummary[]>([])
  const [hosts, setHosts] = useState<HostSummary[]>([])
  const [editing, setEditing] = useState<SecretSummary | 'new' | null>(null)
  const [copyTarget, setCopyTarget] = useState<SecretSummary | null>(null)
  const [delTarget, setDelTarget] = useState<SecretSummary | null>(null)
  const [error, setError] = useState('')
  const [flash, setFlash] = useState('')
  const refresh = useCallback(() => {
    client.secrets.list().then(setList).catch((e) => setError(errText(e)))
    client.hosts.list().then(setHosts).catch(() => {})
  }, [])
  useEffect(() => { refresh() }, [refresh])
  const note = (s: string) => { setFlash(s); setTimeout(() => setFlash(''), 2500) }
  const label = (id: string) => hosts.find((h) => h.id === id)?.label ?? tr('（已删除的主机 {id}）', { id })

  const copyRef = (s: SecretSummary) => navigator.clipboard?.writeText(secretRef(s.name)).then(() => note(tr('已复制占位符 {ref}', { ref: secretRef(s.name) })), () => setError(tr('复制失败')))
  const copyValue = () => {
    const s = copyTarget
    setCopyTarget(null)
    if (s) client.secrets.copy(s.id).then((sec) => note(tr('已复制「{name}」的值，{n} 秒后自动清空剪贴板', { name: s.name, n: sec }))).catch((e) => setError(errText(e)))
  }
  const doDelete = () => {
    const s = delTarget
    setDelTarget(null)
    if (s) client.secrets.delete(s.id).then(() => { refresh(); note(tr('已删除「{name}」', { name: s.name })) }).catch((e) => setError(errText(e)))
  }

  // 新建 / 编辑：和主机、手册等一样进二级页，顶部「返回密钥列表」
  if (editing) {
    return (
      <Page>
        <BackLink onClick={() => setEditing(null)}>{tr('返回密钥列表')}</BackLink>
        <Section title={editing === 'new' ? tr('新建密钥') : tr('编辑密钥「{name}」', { name: editing.name })}>
          <Editor key={editing === 'new' ? 'new' : editing.id} item={editing === 'new' ? undefined : editing} hosts={hosts}
            onDone={(s, created) => { setEditing(null); refresh(); note(created ? tr('已新建「{name}」', { name: s.name }) : tr('已保存「{name}」', { name: s.name })) }} onCancel={() => setEditing(null)} />
        </Section>
      </Page>
    )
  }

  return (
    <Page>
      <div className="flex items-center gap-2">
        <span className="flex items-center gap-1.5 text-[12px] text-[var(--color-text-muted)]">{tr('AI 只看到占位符，看不到值')}
          <HelpTip>{tr('值经操作系统密钥链加密保存在本机数据目录，界面上不能查看，只能替换；系统密钥链不可用时（部分 Linux）会退化为明文，仅本机用户可读，安装后请确认再存入敏感凭据。AI 在命令里写 {ref}，应用在命令发进终端前一刻才换成真实值；工具结果、授权卡、执行记录、会话日志与录像里都是占位符；发给手机页 / 复核模型 / 配置解释 / 部署评审的内容同样会把值换成占位符。注意：命令执行后，服务器上的进程列表 / shell 历史 / 程序日志仍可能看到真实值，这是正常的 shell 行为', { ref: refExample() })}</HelpTip>
        </span>
        <button onClick={() => { setEditing('new'); setError('') }} className={`ml-auto ${PRIMARY}`}><Plus className="h-3.5 w-3.5" />{tr('新建密钥')}</button>
      </div>
      {error && <div className={ERR_BOX}>{error}</div>}
      {flash && <div className="flex items-center gap-1 text-[11px] text-[var(--color-success)]"><Check className="h-3 w-3" />{flash}</div>}
      {list.length === 0 ? (
        <div className="flex flex-col items-center gap-2.5 rounded-lg border border-dashed border-[var(--color-border-subtle)] py-8 text-[12px] text-[var(--color-text-muted)]">
          {tr('还没有密钥。把数据库密码、API token 存进来，AI 就能用 {ref} 引用而不用知道它', { ref: refExample() })}
          <button onClick={() => setEditing('new')} className={PRIMARY}><Plus className="h-3.5 w-3.5" />{tr('新建密钥')}</button>
        </div>
      ) : (
        <div className="space-y-1.5">
          {list.map((s) => (
            <div key={s.id} data-secret={s.name} className="flex items-center gap-2.5 rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-bg-base)] px-3 py-2">
              <LockKeyhole className="h-4 w-4 shrink-0 text-[var(--color-accent)]" />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5 text-[12.5px]">
                  <span className="truncate font-mono font-medium text-[var(--color-text-primary)]">{s.name}</span>
                  <Tag>{secretScopeLabel(s, label)}</Tag>
                  {!s.hasValue && <Tag danger>{tr('未设置值')}</Tag>}
                </div>
                <div className="truncate text-[11px] text-[var(--color-text-muted)]" title={tr('创建于 {created}\n更新于 {updated}', { created: new Date(s.createdAt).toLocaleString(dateLocale()), updated: new Date(s.updatedAt).toLocaleString(dateLocale()) })}>
                  {s.description || tr('（无说明）')} · {tr('更新于 {t}', { t: new Date(s.updatedAt).toLocaleString(dateLocale()) })}
                </div>
              </div>
              <IconBtn title={tr('复制占位符 {ref}', { ref: secretRef(s.name) })} onClick={() => copyRef(s)}><Braces className="h-3 w-3" /></IconBtn>
              <IconBtn title={tr('复制值（30 秒后自动清空剪贴板）')} onClick={() => setCopyTarget(s)} disabled={!s.hasValue}><Copy className="h-3 w-3" /></IconBtn>
              <IconBtn title={tr('编辑 / 替换值')} onClick={() => { setEditing(s); setError('') }}><Pencil className="h-3 w-3" /></IconBtn>
              <IconBtn title={tr('删除')} danger onClick={() => setDelTarget(s)}><Trash2 className="h-3 w-3" /></IconBtn>
            </div>
          ))}
        </div>
      )}
      <ConfirmDialog open={!!copyTarget} title={tr('复制密钥值')} confirmText={tr('复制')}
        message={tr('将把「{name}」的真实值复制到系统剪贴板，{n} 秒后自动清空（期间其他程序也能读到剪贴板）。确定复制？', { name: copyTarget?.name ?? '', n: 30 })}
        onConfirm={copyValue} onCancel={() => setCopyTarget(null)} />
      <ConfirmDialog open={!!delTarget} title={tr('secret|删除密钥')}
        message={tr('确定删除「{name}」？值会从本机删除且不可恢复；之后引用 {ref} 的命令会被拒绝执行。', { name: delTarget?.name ?? '', ref: delTarget ? secretRef(delTarget.name) : '' })}
        onConfirm={doDelete} onCancel={() => setDelTarget(null)} />
    </Page>
  )
}

function Editor({ item, hosts, onDone, onCancel }: { item?: SecretSummary; hosts: HostSummary[]; onDone: (s: SecretSummary, created: boolean) => void; onCancel: () => void }) {
  const [name, setName] = useState(item?.name ?? '')
  const [description, setDescription] = useState(item?.description ?? '')
  const [scope, setScope] = useState<SecretScope>(item?.scope ?? 'local')
  const [targets, setTargets] = useState<string[]>(item?.targets ?? [])
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  const groups = hostGroupNames(hosts)
  const choices = scope === 'group' ? groups.map((g) => ({ id: g, label: g })) : scope === 'hosts' ? hosts.map((h) => ({ id: h.id, label: tr('{prod}{label}（{addr}）', { prod: h.env === 'prod' ? tr('【生产】') : '', label: h.label, addr: `${h.username}@${h.host}` }) })) : []
  const toggle = (id: string, on: boolean) => setTargets((t) => (on ? [...t, id] : t.filter((x) => x !== id)))
  const go = async () => {
    setBusy(true); setError('')
    try {
      const keep = scope === 'group' || scope === 'hosts' ? targets.filter((t) => choices.some((c) => c.id === t)) : []
      onDone(await client.secrets.save({ ...(item ? { id: item.id } : {}), name: name.trim(), description, scope, targets: keep, ...(value ? { value } : {}) }), !item)
    } catch (e) { setError(errText(e)) } finally { setBusy(false) }
  }
  return (
    <div className="space-y-2.5 px-3.5 py-3">
      <div className="flex gap-2">
        <div className="flex-1"><Label text={tr('field|名称')} tip={tr('AI 用 {ref} 引用。只能用小写字母、数字、- 和 _，建好后不能改名（改名会让已有的引用失效）', { ref: refExample() })}>
          <Input className="font-mono" value={name} onChange={(e) => setName(e.target.value.toLowerCase())} placeholder={tr('如 mysql-root')} disabled={!!item} autoFocus={!item} />
        </Label></div>
        <div className="w-48"><Label text={tr('可用范围')} tip={tr('只有在范围内的终端上，含这个占位符的命令才会执行；否则直接拒绝并告诉 AI 原因')}>
          <Select value={scope} onValueChange={(v) => setScope(v as SecretScope)} options={SCOPES.map((o) => ({ value: o.value, label: tr(o.label) }))} />
        </Label></div>
      </div>
      {(scope === 'group' || scope === 'hosts') && (
        <div className="max-h-[132px] space-y-1 overflow-y-auto rounded-md border border-[var(--color-border-subtle)] px-2.5 py-2">
          {choices.length === 0 ? <div className="text-[11.5px] text-[var(--color-text-muted)]">{scope === 'group' ? tr('还没有分组（在「主机与连接」里给主机设分组）') : tr('还没有已保存的主机')}</div>
            : choices.map((c) => (
              <label key={c.id} className="flex cursor-pointer items-center gap-2 text-[12px] text-[var(--color-text-secondary)]">
                <Checkbox checked={targets.includes(c.id)} onCheckedChange={(v) => toggle(c.id, v)} />{c.label}
              </label>
            ))}
        </div>
      )}
      <Label text={tr('field|说明')} tip={tr('会出现在给 AI 的系统提示里（AI 据此判断该用哪个密钥），不要写值本身')}>
        <Input value={description} onChange={(e) => setDescription(e.target.value)} placeholder={tr('如 生产库 root 密码')} maxLength={200} />
      </Label>
      <Label text={item ? tr('替换值') : tr('值')} tip={item ? tr('留空 = 不改。值不能查看，只能整体替换') : tr('至少 4 个字符。保存后不能再查看')}>
        <PasswordInput className={`${INPUT} w-full`} value={value} onChange={(e) => setValue(e.target.value)} placeholder={item ? (item.hasValue ? tr('留空 = 保持原值') : tr('该密钥还没有值，请填写')) : tr('密码 / token')} autoComplete="off" autoFocus={!!item} />
      </Label>
      {error && <div className={ERR_BOX}>{error}</div>}
      <div className="flex justify-end gap-2">
        <button onClick={onCancel} className={BTN2}>{tr('取消')}</button>
        <button onClick={go} disabled={busy || !name.trim() || (!item && !value)} className={PRIMARY}>{busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}{tr('保存')}</button>
      </div>
    </div>
  )
}

function Label({ text, tip, children }: { text: string; tip?: React.ReactNode; children: React.ReactNode }) {
  return <div><div className="mb-1 flex items-center gap-1.5 text-[12px] text-[var(--color-text-secondary)]"><label>{text}</label>{tip && <HelpTip>{tip}</HelpTip>}</div>{children}</div>
}
function Tag({ children, danger }: { children: React.ReactNode; danger?: boolean }) {
  return <span className={`shrink-0 rounded px-1 text-[10px] leading-4 ${danger ? 'bg-[color:color-mix(in_srgb,var(--color-danger)_15%,transparent)] text-[var(--color-danger)]' : 'bg-[var(--color-bg-hover)] text-[var(--color-text-muted)]'}`}>{children}</span>
}
function IconBtn({ title, onClick, children, danger, disabled }: { title: string; onClick: () => void; children: React.ReactNode; danger?: boolean; disabled?: boolean }) {
  return (
    <button onClick={onClick} title={title} disabled={disabled}
      className={`flex h-6 w-6 shrink-0 items-center justify-center rounded disabled:opacity-30 ${danger ? 'text-[var(--color-text-muted)] hover:bg-[color:color-mix(in_srgb,var(--color-danger)_15%,transparent)] hover:text-[var(--color-danger)]' : 'text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-accent)]'}`}>
      {children}
    </button>
  )
}
