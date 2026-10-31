import { useState } from 'react'
import { CONFIG_SECTIONS, tk, tr, type ConfigImportOpts, type ConfigImportReport, type ConfigPreview, type ConfigSection, type MergeMode } from '@lingshell/shared'
import { client } from '../../../client/index.js'
import { loadTermPrefs } from '../../../lib/termPrefs.js'
import { notifyModelProfilesChanged } from '../../../lib/modelProfiles.js'
import { Section, Row, INPUT, BTN2 } from '../ui.js'
import { cn } from '../../../lib/cn.js'
import { Checkbox } from '../../../components/ui/Checkbox.js'
import { setKeybindingOverrides } from '../../../lib/keybindings.js'
import { reloadLook } from '../../../lib/appearance.js'
import { PasswordInput } from '../../../components/ui/PasswordInput.js'
import { trx } from '../../../lib/trx.js'

// 主进程报错形如「wrong_password: 密码不正确…」，前缀错误码给程序判断用，不给用户看
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e)).replace(/^Error invoking remote method '[^']+': (Error: )?/, '').replace(/^[a-z_]+:\s*/, '')
const MERGEABLE = new Set<ConfigSection>(['hosts', 'templates', 'quickCommands', 'schedules', 'webhooks', 'autoReplies', 'knowledge', 'secrets'])
type Choice = MergeMode | 'skip'
// 「系统设置」页已拆成 终端 / AI 与安全 / 通用 三页，这一节对外叫「应用设置」
const SECTIONS = CONFIG_SECTIONS.map((s) => (s.id === 'system' ? { ...s, label: tk('应用设置（终端 / AI 与安全 / 通用）') } : s))
// 节名去掉括号里的补充说明（补充说明放 title / 问号里）；中文是全角括号，英文译文是半角括号
const NOTE = /\s*[（(](.*)[）)]$/
const short = (label: string) => tr(label).replace(NOTE, '')
const noteOf = (label: string) => tr(label).match(NOTE)?.[1]

const exportTip = () => tr('换电脑、重装、备份用，导出为 .lingshell-config.json。永不导出：执行记录（审计）、命令历史、会话与对话、布局、本地 API token、终端录像、日志。')
const importTip = () => tr('选择之前导出的 .lingshell-config.json，逐项选择不导入 / 合并 / 覆盖；整体替换应用设置或模型设置时需再点一次确认。')
const pwTip = () => trx('设了导出密码：主机密码 / 私钥、API Key 等凭据用此密码加密后随文件导出，导入时需输入同一密码。{br}不设密码：不导出任何凭据（告警机器人也不导出、自动应答的密钥应答不导出、密钥保险箱只导出名称 / 说明 / 范围），主机导入后需重新填写密码 / 私钥。', { br: <br /> })

// 分段按钮：三选一类的导入方式（不导入 / 合并 / 覆盖）
function Segmented({ value, options, onChange }: { value: Choice; options: [Choice, string][]; onChange: (v: Choice) => void }) {
  return (
    <div role="radiogroup" className="flex rounded-md border border-[var(--color-border-default)] p-0.5">
      {options.map(([v, label]) => (
        <button key={v} role="radio" aria-checked={value === v} onClick={() => onChange(v)}
          className={cn('rounded px-2.5 py-1 text-[12px] transition-colors', value === v ? 'bg-[color:color-mix(in_srgb,var(--color-accent)_18%,transparent)] text-[var(--color-accent)]' : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)]')}>
          {label}
        </button>
      ))}
    </div>
  )
}

type Msg = { ok: boolean; text: string; at: 'export' | 'import' }

// 配置导出 / 导入（换电脑、重装、备份），分成两个分组。凭据只在设了导出密码时随文件走（密码加密），否则主机导入后需重填凭据
export function ConfigBackup() {
  const [sections, setSections] = useState<Set<ConfigSection>>(new Set(CONFIG_SECTIONS.map((s) => s.id)))
  const [pw, setPw] = useState(''), [pw2, setPw2] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<Msg | null>(null)
  // 导入
  const [picked, setPicked] = useState<{ fileName: string; preview: ConfigPreview } | null>(null)
  const [choice, setChoice] = useState<Partial<Record<ConfigSection, Choice>>>({})
  const [impPw, setImpPw] = useState('')
  const [confirmReplace, setConfirmReplace] = useState(false)
  const [report, setReport] = useState<ConfigImportReport | null>(null)

  const toggle = (id: ConfigSection) => { const n = new Set(sections); if (n.has(id)) n.delete(id); else n.add(id); setSections(n) }
  // 提示显示在发起操作的那个分组里
  const run = (at: Msg['at'], f: () => Promise<string | void>) => async () => {
    setBusy(true); setMsg(null)
    try { const ok = await f(); if (ok) setMsg({ ok: true, text: ok, at }) } catch (e) { setMsg({ ok: false, text: errText(e), at }) } finally { setBusy(false) }
  }

  const doExport = run('export', async () => {
    if (pw !== pw2) throw new Error(tr('两次输入的导出密码不一致'))
    if (pw && pw.length < 6) throw new Error(tr('导出密码至少 6 位'))
    const p = await client.configBackup.export({ sections: [...sections], password: pw || undefined })
    if (!p) return
    setPw(''); setPw2('')
    return pw ? tr('已导出（含加密凭据）：{path}', { path: p }) : tr('已导出（不含凭据）：{path}', { path: p })
  })

  const pick = run('import', async () => {
    const r = await client.configBackup.pickImport()
    if (!r) return
    setPicked(r); setReport(null); setImpPw(''); setConfirmReplace(false)
    // 默认：可合并的节合并、指纹合并；设置类默认不导入（要用户主动选）
    setChoice(Object.fromEntries(Object.keys(r.preview.counts).map((k) => [k, MERGEABLE.has(k as ConfigSection) || k === 'knownHosts' ? 'merge' : 'skip'])))
  })

  const replacing = choice.system === 'overwrite' || choice.model === 'overwrite'
  const doImport = run('import', async () => {
    if (!picked) return
    // 没输密码也能导入非加密的节（模板 / 快捷命令等）；凭据部分会跳过，在导入报告里给出提示
    if (replacing && !confirmReplace) { setConfirmReplace(true); return }
    const on = (k: ConfigSection) => choice[k] && choice[k] !== 'skip'
    const opts: ConfigImportOpts = {
      password: impPw || undefined,
      hosts: on('hosts') ? choice.hosts as MergeMode : undefined,
      templates: on('templates') ? choice.templates as MergeMode : undefined,
      quickCommands: on('quickCommands') ? choice.quickCommands as MergeMode : undefined,
      schedules: on('schedules') ? choice.schedules as MergeMode : undefined,
      webhooks: on('webhooks') ? choice.webhooks as MergeMode : undefined,
      autoReplies: on('autoReplies') ? choice.autoReplies as MergeMode : undefined,
      knowledge: on('knowledge') ? choice.knowledge as MergeMode : undefined,
      secrets: on('secrets') ? choice.secrets as MergeMode : undefined,
      knownHosts: on('knownHosts'), system: on('system'), model: on('model'),
    }
    const r = await client.configBackup.import(opts)
    setReport(r); setConfirmReplace(false)
    if (r.system) {
      loadTermPrefs()                        // 终端外观 / 高亮 / 提醒 / 自动重连等全部字段立即生效（以前只刷新了 4 个）
      const s = (await client.settings.get()).system
      setKeybindingOverrides(s?.keybindings)   // 导入的自定义快捷键立即生效
      void reloadLook()                        // 导入的界面外观同理
    }
    if (r.model) notifyModelProfilesChanged()  // 对话区的模型菜单 / 标签立即换成导入的配置
    return tr('导入完成')
  })
  const msgOf = (at: Msg['at']) => msg?.at === at && <span className={cn('block truncate', msg.ok ? 'text-[var(--color-success)]' : 'text-[var(--color-danger)]')} title={msg.text}>{msg.text}</span>

  // 每节可选的导入方式与说明
  const optsOf = (id: ConfigSection): { options: [Choice, string][]; tip?: string } => {
    const skip: [Choice, string] = ['skip', tr('不导入')]
    if (MERGEABLE.has(id)) {
      const tip = id === 'hosts' ? tr('合并：同地址 + 端口 + 用户的保留本机；覆盖：同地址 + 端口 + 用户的用文件里的替换。其余都新增。')
        : id === 'knowledge' ? tr('合并：同卡片（同一张）的保留本机；覆盖：同卡片（同一张）的用文件里的替换。其余都新增。')
        : tr('合并：同名称的保留本机；覆盖：同名称的用文件里的替换。其余都新增。')
      return { options: [skip, ['merge', tr('合并')], ['overwrite', tr('覆盖')]], tip }
    }
    if (id === 'knownHosts') return { options: [skip, ['merge', tr('合并')]], tip: tr('合并：新增文件里的指纹；同一主机指纹不同时保留本机记录，不替换。') }
    return { options: [skip, ['overwrite', tr('替换')]], tip: tr('替换：用文件内容整体替换本机的这一类设置。') }
  }

  return (
    <>
    <Section title={tr('配置导出')} tip={exportTip()}>
      <Row label={tr('导出内容')} hint={tr('勾选要导出的部分')} wide>
        <div className="grid grid-cols-3 gap-x-3 gap-y-1.5">
          {SECTIONS.map((s) => (
            <label key={s.id} title={tr(s.label)} className="flex items-center gap-1.5 text-[12px] text-[var(--color-text-secondary)]">
              <Checkbox checked={sections.has(s.id)} onCheckedChange={() => toggle(s.id)} />{short(s.label)}
            </label>
          ))}
        </div>
      </Row>
      <Row label={tr('导出密码')} hint={tr('可选，设了才导出凭据')} tip={pwTip()}>
        <PasswordInput value={pw} onChange={(e) => setPw(e.target.value)} placeholder={tr('导出密码')} className={`w-36 ${INPUT}`} />
        <PasswordInput value={pw2} onChange={(e) => setPw2(e.target.value)} placeholder={tr('再输一次')} className={`w-36 ${INPUT}`} />
      </Row>
      <Row label={tr('导出到文件')} hint={msgOf('export') || (pw ? tr('凭据将用导出密码加密') : tr('不含凭据'))}>
        <button onClick={doExport} disabled={busy || !sections.size} className={BTN2}>{tr('导出配置')}</button>
      </Row>
    </Section>

    <Section title={tr('配置导入')} tip={importTip()}>
      <Row label={tr('从文件导入')} hint={picked ? <span className="block truncate" title={picked.fileName}>{tr('{file}（{version} 版于 {time} 导出）', { file: picked.fileName, version: picked.preview.appVersion, time: picked.preview.exportedAt.slice(0, 16).replace('T', ' ') })}</span> : tr('选择 .lingshell-config.json')}>
        <button onClick={pick} disabled={busy} className={BTN2}>{picked ? tr('重新选择') : tr('导入配置')}</button>
      </Row>
      {picked && <>
        {SECTIONS.filter((s) => picked.preview.counts[s.id] !== undefined).map((s) => {
          const o = optsOf(s.id)
          const note = noteOf(s.label)
          return (
            <Row key={s.id} label={short(s.label)} tip={note ? tr('{note}。{tip}', { note, tip: o.tip ?? '' }) : o.tip} hint={MERGEABLE.has(s.id) || s.id === 'knownHosts' ? tr('{n} 条', { n: picked.preview.counts[s.id] ?? 0 }) : undefined}>
              <Segmented value={choice[s.id] ?? 'skip'} options={o.options} onChange={(v) => { setChoice({ ...choice, [s.id]: v }); setConfirmReplace(false) }} />
            </Row>
          )
        })}
        {picked.preview.hasSecrets
          ? <Row label={tr('导入密码')} hint={tr('文件含加密凭据')}><PasswordInput value={impPw} onChange={(e) => setImpPw(e.target.value)} placeholder={tr('导出时设置的密码')} className={`w-56 ${INPUT}`} /></Row>
          : picked.preview.credentialsOmitted > 0 && <Row label={tr('凭据')} hint={tr('文件不含凭据：{n} 台主机导入后需重填', { n: picked.preview.credentialsOmitted })} />}
        {picked.preview.proxyCommands && choice.hosts && choice.hosts !== 'skip' && (
          <Row danger label={tr('将执行本地命令')} hint={tr('{n} 台主机带 ProxyCommand，来源不明请勿导入主机', { n: picked.preview.proxyCommands.length })} wide
            tip={tr('这些主机导入后，每次连接都会在本机执行下面的命令。不认识的文件来源请不要导入主机。')}>
            <div className="space-y-0.5 rounded bg-[color:color-mix(in_srgb,var(--color-danger)_12%,transparent)] px-2 py-1.5 text-[11px] text-[var(--color-danger)]">
              {picked.preview.proxyCommands.map((p, i) => <div key={i} className="break-all font-mono">{tr('{label}：{command}', { label: p.label, command: p.command })}</div>)}
            </div>
          </Row>
        )}
        <div className="flex items-center gap-3 px-3.5 py-2.5">
          {confirmReplace && <span className="text-[12px] text-[var(--color-danger)]">{tr('将替换本机的{what}，再点一次确认', { what: [choice.system === 'overwrite' && tr('应用设置'), choice.model === 'overwrite' && tr('模型设置')].filter(Boolean).join(tr('、')) })}</span>}
          <button onClick={doImport} disabled={busy || Object.values(choice).every((v) => !v || v === 'skip')}
            className="ml-auto rounded-md bg-[var(--color-accent)] px-3 py-1.5 text-[12px] font-medium text-[var(--color-bg-base)] transition-colors hover:bg-[var(--color-accent-dim)] disabled:opacity-40">
            {confirmReplace ? tr('确认替换并导入') : tr('开始导入')}
          </button>
        </div>
      </>}
      {(report || msg?.at === 'import') && (
        <div className="space-y-1 px-3.5 py-2.5 text-[11.5px]">
          {report && <ImportReport r={report} />}
          {msgOf('import')}
        </div>
      )}
    </Section>
    </>
  )
}

function ImportReport({ r }: { r: ConfigImportReport }) {
  const c = (x: { added: number; updated: number; skipped: number }) => tr('新增 {added}，覆盖 {updated}，跳过 {skipped}', { added: x.added, updated: x.updated, skipped: x.skipped })
  const sep = tr('、')
  const line = (name: string, x: { added: number; updated: number; skipped: number }) => tr('{name}：{counts}', { name, counts: c(x) })
  return (
    <div className="space-y-0.5 text-[var(--color-text-secondary)]">
      {r.hosts && <div>{line(tr('主机'), r.hosts)}{r.hosts.needCredentials.length > 0 && <span className="text-[var(--color-warn)]">{tr('；需重填凭据：{names}', { names: r.hosts.needCredentials.join(sep) })}</span>}</div>}
      {r.knownHosts && <div>{tr('指纹：新增 {added}，相同 {same}', { added: r.knownHosts.added, same: r.knownHosts.same })}{r.knownHosts.conflicts.length > 0 && tr('，冲突（保留本机记录）：')}</div>}
      {r.knownHosts?.conflicts.map((x) => <div key={x.hostPort} className="pl-3 text-[var(--color-danger)]">{tr('{host}：本机 {existing} / 文件 {incoming}', { host: x.hostPort, existing: x.existing, incoming: x.incoming })}</div>)}
      {r.templates && <div>{line(tr('模板'), r.templates)}</div>}
      {r.quickCommands && <div>{line(tr('快速命令组'), r.quickCommands)}</div>}
      {r.schedules && <div>{line(tr('定时巡检'), r.schedules)}{r.schedules.droppedTargets > 0 && tr('；{n} 个目标主机在本机找不到已去掉', { n: r.schedules.droppedTargets })}</div>}
      {r.webhooks && <div>{line(tr('告警机器人'), r.webhooks)}</div>}
      {r.autoReplies && <div>{line(tr('自动应答'), r.autoReplies)}{r.autoReplies.needResponse.length > 0 && <span className="text-[var(--color-warn)]">{tr('；密钥应答未随文件导出、已停用待重填：{names}', { names: r.autoReplies.needResponse.join(sep) })}</span>}</div>}
      {r.knowledge && <div>{line(tr('知识库'), r.knowledge)}{r.knowledge.dropped > 0 && tr('；{n} 张主机卡的主机在本机找不到已丢弃（可同时导入主机）', { n: r.knowledge.dropped })}</div>}
      {r.secrets && <div>{line(tr('密钥保险箱'), r.secrets)}{r.secrets.needValue.length > 0 && <span className="text-[var(--color-warning)]">{tr('；值未随文件导出、需在「密钥保险箱」里替换值：{names}', { names: r.secrets.needValue.join(sep) })}</span>}</div>}
      {r.system && <div>{tr('应用设置：已替换')}</div>}
      {r.model && <div>{r.apiKeys ? tr('模型设置：已替换，导入 API Key {n} 个（新建会话生效）', { n: r.apiKeys }) : tr('模型设置：已替换（新建会话生效）')}</div>}
    </div>
  )
}
