import { useEffect, useState, useCallback } from 'react'
import { FileText, Pencil, Trash2, Plus } from 'lucide-react'
import { tr, type PromptTemplate } from '@lingshell/shared'
import { client } from '../../../client/index.js'
import { ConfirmDialog } from '../../common/index.js'
import { Page, Section, Row, SaveBar, INPUT, BTN1, BackLink, EmptyState, ICON_BTN, ICON_DEL, ITEM, LIST, Toolbar, errText, taCls } from '../ui.js'

// 占位符语法原样显示（{{主机}} 是定时巡检认的变量名，不翻译）
const PH = { a: '{{名字}}', b: '{{主机}}', c: '{{服务名}}' }   // i18n-ignore 占位符语法

// 设置弹窗内的「常用任务模板」页：增删改。内置模板首次写入后与自建的一样可改可删。
export function TemplateManager() {
  const [list, setList] = useState<PromptTemplate[] | null>(null)
  const [form, setForm] = useState<{ id?: string; name: string; prompt: string } | null>(null)
  const [delTarget, setDelTarget] = useState<PromptTemplate | null>(null)
  const [err, setErr] = useState('')

  const refresh = useCallback(() => { client.templates.list().then(setList).catch(() => setList([])) }, [])
  useEffect(() => { refresh() }, [refresh])

  const save = async () => {
    if (!form) return
    try { await client.templates.save(form); setForm(null); setErr(''); refresh() }
    catch (e) { setErr(errText(e)) }
  }
  const doDelete = () => { if (delTarget) client.templates.delete(delTarget.id).then(refresh); setDelTarget(null) }
  const create = () => { setForm({ name: '', prompt: '' }); setErr('') }

  if (form) {
    return (
      <Page>
        <BackLink onClick={() => { setForm(null); setErr('') }}>{tr('返回模板列表')}</BackLink>
        <Section title={form.id ? tr('编辑模板') : tr('新建模板')}>
          <Row label={tr('名称')}><input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder={tr('如：检查磁盘与内存')} className={`w-72 ${INPUT}`} /></Row>
          <Row label={tr('内容')} hint={tr('发给 AI 的任务描述，可带 {{占位符}}')} wide
            tip={tr('占位符写成 {a}（如 {b}、{c}），选用模板时会让你逐个填写；定时巡检里的 {b} 自动替换为目标主机名。', PH)}>
            <textarea value={form.prompt} onChange={(e) => setForm({ ...form, prompt: e.target.value })} rows={8} className={taCls} placeholder={tr('如：检查 {h} 的磁盘、内存占用，列出异常项', { h: PH.b })} />
          </Row>
        </Section>
        <SaveBar onSave={save} disabled={!form.name.trim() || !form.prompt.trim()} msg={err ? { ok: false, text: err } : null} />
      </Page>
    )
  }

  return (
    <Page>
      <Toolbar hint={tr('在输入框左下角「常用任务」中选用')} tip={tr('模板是常用的任务描述，选用后填进输入框发给 AI。内置模板和自建的一样可改可删。')}>
        <button onClick={create} className={BTN1}><Plus className="h-3.5 w-3.5" />{tr('新建模板')}</button>
      </Toolbar>
      {!list ? null : list.length === 0 ? (
        <EmptyState text={tr('暂无模板')} action={<button onClick={create} className={BTN1}><Plus className="h-3.5 w-3.5" />{tr('新建模板')}</button>} />
      ) : (
        <div className={LIST}>
          {list.map((t) => (
            <div key={t.id} className={ITEM}>
              <FileText className="h-3.5 w-3.5 shrink-0 text-[var(--color-accent)]" />
              <span className="shrink-0 font-medium text-[var(--color-text-primary)]">{tr(t.name)}</span>
              <span className="min-w-0 flex-1 truncate text-[11px] text-[var(--color-text-muted)]" title={tr(t.prompt)}>{tr(t.prompt)}</span>
              <button onClick={() => { setForm({ ...t }); setErr('') }} title={tr('编辑')} className={ICON_BTN}><Pencil className="h-3 w-3" /></button>
              <button onClick={() => setDelTarget(t)} title={tr('删除')} className={ICON_DEL}><Trash2 className="h-3 w-3" /></button>
            </div>
          ))}
        </div>
      )}
      <ConfirmDialog open={!!delTarget} title={tr('删除模板')} message={tr('确定删除模板 {name}？', { name: tr(delTarget?.name ?? '') })} onConfirm={doDelete} onCancel={() => setDelTarget(null)} />
    </Page>
  )
}
