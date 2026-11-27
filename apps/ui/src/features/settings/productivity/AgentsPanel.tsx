import { useEffect, useState } from 'react'
import { AlertTriangle, Bot, FolderOpen, Pencil, Plus, Trash2 } from 'lucide-react'
import { tk, tr, type AgentInput, type AgentView } from '@lingshell/shared'
import { client } from '../../../client/index.js'
import { ConfirmDialog } from '../../common/index.js'
import { Switch } from '../../../components/ui/Switch.js'
import { Page, Section, Row, INPUT, BTN1, BTN2, ICON_BTN, ICON_DEL, taCls, Toolbar, EmptyState, BackLink, errText } from '../ui.js'
import { ThirdPartyImportButton } from './ThirdPartyImport.js'

const PAGE_TIP = tk('这里只管全局 Agent：本机所有项目的会话都能用。项目内的 Agent 不在这里展示——直接放在 <项目>/.lingshell/agents 或 <项目>/.claude/agents 下，就会在那个项目的会话里自动生效（@ 选人时出现），改文件即刻生效、不用导入。第三方目录（~/.claude/agents、~/.codex/agents）默认不启用，勾选后才生效。')

const ORIGIN: Record<AgentView['origin'], string> = {
  user: tk('我的'), project: tk('项目内'), claude: 'Claude', codex: 'Codex',
}

interface Form extends AgentInput { old?: string; toolsText: string; modelInvocable: boolean }

const empty = (): Form => ({ name: '', description: '', body: '', permission: 'write', toolsText: '', modelInvocable: true })

// 设置弹窗「Agents」页：新建 / 编辑 / 启停 / 删除（外部来源只读，只能停用），并把项目内与 Claude / Codex 的 agents 一并列出来
export function AgentsPanel() {
  const [list, setList] = useState<AgentView[] | null>(null)
  const [form, setForm] = useState<Form | null>(null)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const [del, setDel] = useState<AgentView | null>(null)
  const [saving, setSaving] = useState(false)

  const load = () => client.agents.list().then(setList).catch(() => setList([]))
  useEffect(() => { void load() }, [])

  const set = (p: Partial<Form>) => setForm((f) => (f ? { ...f, ...p } : f))

  // 列表里直接切「模型自主调用」：把当前内容整份写回（md 的 disable-model-invocation 取反）
  const toggleModel = (a: AgentView, on: boolean) => {
    client.agents.save({
      name: a.name, description: a.description, body: a.body,
      ...(a.model ? { model: a.model } : {}), ...(a.permission ? { permission: a.permission } : {}),
      ...(a.version ? { version: a.version } : {}), ...(a.skills?.length ? { skills: a.skills } : {}),
      ...(on ? {} : { disableModelInvocation: true }),
    }, a.id).then(load).catch((e) => setMsg({ ok: false, text: errText(e) }))
  }

  const edit = async (a: AgentView) => {
    // 读完整定义（列表里已带 body，但保持一次显式读取，便于以后列表瘦身）
    const full = await client.agents.read(a.id).catch(() => null)
    const src = full ?? a
    setForm({
      old: src.id, name: src.name, description: src.description, body: src.body,
      ...(src.model ? { model: src.model } : {}), ...(src.permission ? { permission: src.permission } : {}),
      toolsText: (src.tools ?? []).join(', '),
      modelInvocable: src.modelInvocable !== false,
      ...(src.version ? { version: src.version } : {}),
    })
    setMsg(null)
  }

  const save = () => {
    if (!form) return
    const tools = form.toolsText.split(/[,，\s]+/).map((x) => x.trim()).filter(Boolean)
    const input: AgentInput = {
      name: form.name.trim(), description: form.description.trim(), body: form.body,
      ...(form.model?.trim() ? { model: form.model.trim() } : {}),
      ...(tools.length ? { tools } : {}),
      ...(form.version?.trim() ? { version: form.version.trim() } : {}),
      ...(form.modelInvocable ? {} : { disableModelInvocation: true }),
    }
    setSaving(true)
    client.agents.save(input, form.old)
      .then(async () => { setMsg({ ok: true, text: tr('已保存') }); setForm(null); await load() })
      .catch((e) => setMsg({ ok: false, text: errText(e) }))
      .finally(() => setSaving(false))
  }

  const toggle = (a: AgentView, on: boolean) => {
    setList((cur) => (cur ? cur.map((x) => (x.id === a.id ? { ...x, enabled: on } : x)) : cur))
    client.agents.setEnabled(a.id, on).catch(() => { void load() })
  }

  const remove = () => {
    const a = del
    if (!a) return
    client.agents.remove(a.id).then(load).catch((e) => setMsg({ ok: false, text: errText(e) }))
    setDel(null)
  }

  if (form) {
    return (
      <Page>
        <BackLink onClick={() => { setForm(null); setMsg(null) }} actions={<>{msg && <span className="max-w-[240px] truncate text-[11px] text-[var(--color-text-muted)]" title={msg.text}>{msg.text}</span>}<button onClick={save} disabled={saving} className={BTN1}>{tr('保存')}</button></>}>{tr('返回列表')}</BackLink>
        <Section title={form.old ? tr('编辑 Agent') : tr('新建 Agent')}
          tip={tr('保存为 agents/<名称>.md（frontmatter 写 name / description / tools / permission，下面是正文）。')}>
          <Row label={tr('名称')} tip={tr('小写字母、数字和连字符，如 shell-reviewer')}>
            <input value={form.name} onChange={(e) => set({ name: e.target.value })} placeholder="shell-reviewer" className={`w-[260px] font-mono ${INPUT}`} />
          </Row>
          <Row label={tr('描述')} hint={tr('AI 靠它判断什么时候用')} wide tip={tr('会出现在 AI 看到的 Agent 目录里（只有名称和描述）。写清楚做什么、什么情况下用，不超过 200 字。')}>
            <input value={form.description} maxLength={200} onChange={(e) => set({ description: e.target.value })}
              placeholder={tr('做什么、什么时候用')} className={`w-full ${INPUT}`} />
          </Row>
          <Row label={tr('版本号')} tip={tr('可选，写进 md 的 version，列表里显示 v1.0.0')}>
            <input value={form.version ?? ''} onChange={(e) => set({ version: e.target.value })} placeholder="1.0.0" className={`w-[160px] font-mono ${INPUT}`} />
          </Row>
          <Row wide label={tr('系统提示（正文）')} tip={tr('绑定这个 Agent 的会话会把它注入系统提示；写得越具体越稳定')}>
            <textarea value={form.body} onChange={(e) => set({ body: e.target.value })} rows={10} className={taCls}
              placeholder={tr('例如：你是一名资深代码审查员，先看正确性，再看安全性；输出按文件分组，每条写清「位置 + 问题 + 建议改法」。')} />
          </Row>
        </Section>
      </Page>
    )
  }

  const external = list?.filter((a) => a.external && !a.error) ?? []
  return (
    <Page>
      <Toolbar hint={tr('一份系统提示 + 工具白名单；会话里按 @ 或「+ → Agents」切换')} tip={tr(PAGE_TIP)}>
        <ThirdPartyImportButton kind="agent" onImported={() => { void load() }} />
        <button className={BTN2} onClick={() => { void client.agents.openDir().catch(() => {}) }}>
          <FolderOpen className="h-3.5 w-3.5" />{tr('打开目录')}
        </button>
        <button className={BTN1} onClick={() => { setForm(empty()); setMsg(null) }}>
          <Plus className="h-3.5 w-3.5" />{tr('新建 Agent')}
        </button>
      </Toolbar>
      {msg && <div className={`text-[12px] ${msg.ok ? 'text-[var(--color-success)]' : 'text-[var(--color-danger)]'}`}>{msg.text}</div>}
      {list === null ? null : list.length === 0 ? (
        <EmptyState text={tr('还没有 Agent')} action={<button className={BTN1} onClick={() => setForm(empty())}>{tr('新建 Agent')}</button>} />
      ) : (
        <div className="divide-y divide-[var(--color-border-subtle)] overflow-hidden rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-bg-base)]">
          {list.map((a) => (
            <div key={a.id ?? a.file} className="flex items-start gap-2 px-3.5 py-2.5 text-[12.5px]">
              <Bot className="mt-0.5 h-4 w-4 shrink-0 text-[var(--color-text-muted)]" />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <span className="truncate font-mono text-[var(--color-text-primary)]">{a.name || tr('（解析失败）')}</span>
                {a.version ? <span className="shrink-0 text-[10.5px] text-[var(--color-text-muted)]">v{a.version}</span> : null}
                  <span className="rounded bg-[var(--color-bg-hover)] px-1.5 py-0.5 text-[10.5px] text-[var(--color-text-muted)]">{tr(ORIGIN[a.origin] ?? '')}</span>
                  {a.external && <AlertTriangle className="h-3 w-3 text-[var(--color-warn)]" />}
                </div>
                {a.error ? (
                  <div className="mt-0.5 text-[11.5px] text-[var(--color-danger)]">{a.error}</div>
                ) : (
                  <div className="mt-0.5 truncate text-[11.5px] text-[var(--color-text-muted)]">{a.description}</div>
                )}
                {a.tools?.length ? <div className="mt-0.5 truncate font-mono text-[10.5px] text-[var(--color-text-muted)]">{a.tools.join(' · ')}</div> : null}
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <label className="flex items-center gap-1 text-[11px] text-[var(--color-text-muted)]" title={tr('允许模型自主调用')}>
                  <span className="whitespace-nowrap">{tr('AI 可自动调用')}</span><Switch checked={a.modelInvocable !== false} onCheckedChange={(v) => toggleModel(a, v)} />
                </label>
                <label className="flex items-center gap-1 text-[11px] text-[var(--color-text-muted)]">
                  <span className="whitespace-nowrap">{tr('启用')}</span><Switch checked={a.enabled} onCheckedChange={(v) => toggle(a, v)} />
                </label>
                {!a.external && !a.error && (
                  <>
                    <button className={ICON_BTN} title={tr('编辑')} onClick={() => { void edit(a) }}><Pencil className="h-3.5 w-3.5" /></button>
                    <button className={ICON_DEL} title={tr('删除')} onClick={() => setDel(a)}><Trash2 className="h-3.5 w-3.5" /></button>
                  </>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
      {external.length > 0 && (
        <div className="text-[11.5px] leading-relaxed text-[var(--color-text-muted)]">
          {tr('第三方目录里的 Agent 只读、默认不启用；确认内容可信后再打开开关。项目内的 Agent 不在这里显示，它在对应项目的会话里自动生效。')}
        </div>
      )}
      <ConfirmDialog open={!!del} title={tr('删除 Agent')}
        message={tr('确定删除 {name}？只删 agents/{name}.md，不可恢复。', { name: del?.name ?? '' })}
        onConfirm={remove} onCancel={() => setDel(null)} />
    </Page>
  )
}
