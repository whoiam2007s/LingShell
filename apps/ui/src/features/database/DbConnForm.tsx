import { useEffect, useState } from 'react'
import { Loader2, PlugZap, Save } from 'lucide-react'
import { DB_DEFAULT_PORT, DB_KIND_LABEL, tr, type DbConn, type DbKind, type HostSummary, type SecretSummary } from '@lingshell/shared'
import { client } from '../../client/index.js'
import { Input } from '../../components/ui/Input.js'
import { Select } from '../../components/ui/Select.js'
import { HelpTip } from '../../components/ui/form.js'
import { BTN, MUTED, PRIMARY, errText } from '../../components/ui/drawer.js'

type Draft = Omit<DbConn, 'port'> & { port: string }
const LABEL = 'w-[72px] shrink-0 text-right text-[11.5px] text-[var(--color-text-secondary)]'

// 新建 / 编辑数据库连接：主机（命令在哪台机器上执行）、类型、连接方式（本机客户端 / 容器）、地址端口用户库、密码（只能选密钥保险箱里的项）。
// 「测试连接」用表单当前内容（未保存也能测）查版本号
export function DbConnForm({ init, hosts, onSaved, onCancel }: { init: DbConn; hosts: HostSummary[]; onSaved: (list: DbConn[], id: string) => void; onCancel: () => void }) {
  const [f, setF] = useState<Draft>({ ...init, port: init.port ? String(init.port) : '' })
  const [secrets, setSecrets] = useState<SecretSummary[]>([])
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const [busy, setBusy] = useState<'' | 'test' | 'save'>('')
  useEffect(() => { client.secrets.list().then(setSecrets).catch(() => {}) }, [])
  const set = (p: Partial<Draft>) => { setF((x) => ({ ...x, ...p })); setMsg(null) }
  const payload = () => ({ ...f, port: f.port.trim() ? Number(f.port) : undefined })
  const test = () => {
    setBusy('test'); setMsg(null)
    client.db.ping(payload()).then((v) => setMsg({ ok: true, text: tr('连接成功：{v}', { v }) }), (e) => setMsg({ ok: false, text: errText(e) })).finally(() => setBusy(''))
  }
  // 保存中禁用按钮（连点不会重复提交）
  const save = () => {
    if (busy) return
    setBusy('save'); setMsg(null)
    client.db.save(payload()).then((list) => onSaved(list, f.id), (e) => { setMsg({ ok: false, text: errText(e) }); setBusy('') })
  }
  const hostOpts = [{ value: 'local', label: tr('host|本机') }, ...hosts.map((h) => ({ value: h.id, label: `${h.label}${h.env === 'prod' ? tr('（生产）') : ''}` }))]
  const secretOpts = [{ value: '', label: tr('不用密码') }, ...secrets.filter((s) => s.hasValue).map((s) => ({ value: s.name, label: `{{secret:${s.name}}}${s.description ? ` · ${s.description}` : ''}` }))]
  const row = (label: string, el: React.ReactNode, tip?: string) => (
    <div className="flex items-center gap-2">
      <span className={LABEL}>{label}</span>
      <div className="flex min-w-0 flex-1 items-center gap-1.5">{el}{tip && <HelpTip>{tip}</HelpTip>}</div>
    </div>
  )
  return (
    <div data-db-form className="space-y-2 px-3 py-3">
      <div className="text-[12px] font-semibold text-[var(--color-text-primary)]">{init.name ? tr('编辑连接「{name}」', { name: init.name }) : tr('新建数据库连接')}</div>
      {row(tr('名称'), <Input data-db-f="name" size="sm" value={f.name} onChange={(e) => set({ name: e.target.value })} placeholder={tr('如：订单库 / 缓存')} />)}
      {row(tr('主机'), <Select size="sm" value={f.hostKey} onValueChange={(v) => set({ hostKey: v })} options={hostOpts} />, tr('命令在这台机器上执行（调用它上面的 mysql / psql / redis-cli / mongosh 或 docker）。SSH 主机要先打开它的终端，查询经这个 SSH 连接的独立通道执行，不会在终端里刷屏。'))}
      {row(tr('类型'), <Select size="sm" value={f.kind} onValueChange={(v) => set({ kind: v as DbKind })} options={(['mysql', 'postgres', 'redis', 'mongo'] as DbKind[]).map((k) => ({ value: k, label: DB_KIND_LABEL[k] }))} />)}
      {row(tr('连接方式'), <>
        <Select size="sm" className="w-[150px] shrink-0" value={f.via} onValueChange={(v) => set({ via: v as DbConn['via'] })} options={[{ value: 'client', label: tr('本机客户端') }, { value: 'docker', label: tr('Docker 容器') }]} />
        {f.via === 'docker' && <Input data-db-f="container" size="sm" value={f.container ?? ''} onChange={(e) => set({ container: e.target.value })} placeholder={tr('容器名或 ID')} />}
      </>, tr('「本机客户端」= 用这台机器上装的客户端；「Docker 容器」= docker exec 进容器，用容器里的客户端（数据库跑在容器里时选这个，地址一般留空）。'))}
      {row(tr('地址'), <>
        <Input data-db-f="host" size="sm" value={f.host ?? ''} onChange={(e) => set({ host: e.target.value })} placeholder={tr('留空 = 客户端默认（本机）')} />
        <Input data-db-f="port" size="sm" className="w-[84px] shrink-0" value={f.port} onChange={(e) => set({ port: e.target.value.replace(/\D/g, '').slice(0, 5) })} placeholder={String(DB_DEFAULT_PORT[f.kind])} />
      </>)}
      {row(tr('用户'), <Input data-db-f="user" size="sm" value={f.user ?? ''} onChange={(e) => set({ user: e.target.value })} placeholder={f.kind === 'redis' ? tr('留空 = default（Redis 6+ ACL 才需要）') : f.kind === 'postgres' ? tr('如 postgres') : f.kind === 'mongo' ? tr('没开认证可留空；用户在 admin 库认证') : tr('如 root')} />)}
      {row(f.kind === 'redis' ? tr('库序号') : tr('数据库'), <Input data-db-f="database" size="sm" value={f.database ?? ''} onChange={(e) => set({ database: e.target.value })} placeholder={f.kind === 'redis' ? '0' : f.kind === 'mongo' ? tr('默认 test，可在上方「库」里切换') : tr('可留空')} />)}
      {row(tr('密码'), <Select size="sm" value={f.secret ?? ''} onValueChange={(v) => set({ secret: v || undefined })} options={secretOpts} />,
        tr('只能选「设置 → 密钥保险箱」里的一项，这里只存名称。执行时在后台取出明文，经标准输入交给远端读进环境变量（MYSQL_PWD / PGPASSWORD / REDISCLI_AUTH / MONGO_PWD，MongoDB 由脚本从环境变量取来拼连接串，认证库 admin），不出现在命令行、终端、日志和 AI 消息里。密钥的「可用范围」要包含所选主机。'))}
      {msg && <div data-db-form-msg className={`whitespace-pre-wrap break-all rounded px-2 py-1 text-[11.5px] ${msg.ok ? 'text-[var(--color-success)]' : 'text-[var(--color-danger)]'}`}>{msg.text}</div>}
      <div className="flex items-center gap-1.5 pt-1">
        <span className={`text-[10.5px] ${MUTED}`}>{tr('查看和查询都是只读的；会改数据的操作都要单独确认')}</span>
        <span className="ml-auto" />
        <button data-db-test disabled={!!busy} onClick={test} className={`${BTN} text-[var(--color-text-secondary)]`}>{busy === 'test' ? <Loader2 className="h-3 w-3 animate-spin" /> : <PlugZap className="h-3 w-3" />}{busy === 'test' ? tr('测试中') : tr('测试连接')}</button>
        <button onClick={onCancel} className={`${BTN} text-[var(--color-text-secondary)]`}>{tr('取消')}</button>
        <button data-db-save disabled={!!busy} onClick={save} className={PRIMARY}>{busy === 'save' ? <Loader2 className="h-3 w-3 animate-spin" /> : <Save className="h-3 w-3" />}{tr('保存')}</button>
      </div>
    </div>
  )
}
