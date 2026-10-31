import { useEffect, useRef, useState } from 'react'
import { Plus, Folder, ClipboardList, BookOpen, ChevronRight, Settings2, Sparkles, FileText, FolderOpen, Paperclip } from 'lucide-react'
import { tr, type PromptTemplate, type Runbook, type SkillInfo } from '@lingshell/shared'
import { client } from '../../client/index.js'

type Sub = 'context' | 'templates' | 'runbooks' | 'skills' | null

// 「Skills」二级菜单：列出启用且可由用户调用的 skill，选中后作为本轮显式调用（输入框上方显示标签）
export interface SkillMenuProps { onPick: (name: string) => void; onManage?: () => void }
// 「添加上下文」▸ 文件 / 目录（图片也是文件：选到图片自动显示为图片 tag，模型支持图片时按图片发送）
export interface AttachMenuProps { multimodal: boolean; onFiles: () => void; onDirs: () => void }

// 输入框前的「+」：一级菜单 工作目录 / 添加上下文 ▸ / Skills ▸ / 常用任务 ▸ / 运维手册 ▸（切换模型在对话头部的模型标签）。
// 二级菜单只负责「选哪个」，选中后交给原来的 TemplatePicker / RunbookPicker（经 onTemplate / onRunbook → preset）去填参数、选终端。
export function InputActionsMenu({ workDir, canChat, hasSession, onPickWorkDir, onTemplate, onRunbook, onManageTemplates, onManageRunbooks, skills, attach }: {
  workDir?: string; canChat: boolean; hasSession: boolean
  onPickWorkDir?: () => void; onTemplate: (id: string) => void; onRunbook: (id: string) => void
  onManageTemplates?: () => void; onManageRunbooks?: () => void
  skills?: SkillMenuProps
  attach?: AttachMenuProps
}) {
  const [open, setOpen] = useState(false)
  const [sub, setSub] = useState<Sub>(null)
  const [tpls, setTpls] = useState<PromptTemplate[]>([])
  const [rbs, setRbs] = useState<Runbook[]>([])
  const [sks, setSks] = useState<SkillInfo[]>([])
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) { setSub(null); return }
    client.templates.list().then(setTpls).catch(() => {})
    client.runbooks.list().then(setRbs).catch(() => {})
    if (skills) client.skills.list().then((l) => setSks(l.filter((s) => s.enabled && s.userInvocable && !s.error))).catch(() => {})
    const onDown = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false) }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); setOpen(false) } }
    document.addEventListener('mousedown', onDown); document.addEventListener('keydown', onKey, true)
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey, true) }
  }, [open])

  const close = () => setOpen(false)
  const ROW = 'flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[12.5px] transition-colors hover:bg-[var(--color-bg-hover)] disabled:pointer-events-none disabled:opacity-40'
  const subRow = (id: Exclude<Sub, null>, icon: React.ReactNode, label: string, count: number | string) => (
    <button disabled={!canChat} onMouseEnter={() => setSub(id)} onClick={() => setSub(sub === id ? null : id)} aria-expanded={sub === id}
      className={`${ROW} ${sub === id ? 'bg-[var(--color-bg-hover)]' : ''}`}>
      {icon}<span className="flex-1 text-[var(--color-text-primary)]">{label}</span>
      <span className="max-w-[110px] truncate text-[11px] text-[var(--color-text-muted)]">{count}</span><ChevronRight className="h-3.5 w-3.5 shrink-0 text-[var(--color-text-muted)]" />
    </button>
  )
  const manage = (label: string, f?: () => void) => f && (
    <button onClick={() => { close(); f() }}
      className="mt-1 flex w-full items-center gap-1.5 border-t border-[var(--color-border-subtle)] px-2.5 pb-1 pt-2 text-[11.5px] text-[var(--color-text-secondary)] hover:text-[var(--color-accent)]">
      <Settings2 className="h-3.5 w-3.5" />{label}
    </button>
  )

  return (
    <div ref={ref} className="relative shrink-0">
      <button onClick={() => setOpen((o) => !o)} title={tr('更多：工作目录 / 添加上下文 / Skills / 常用任务 / 运维手册')} aria-expanded={open}
        className={`flex h-7 w-7 items-center justify-center rounded-md transition-colors hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-accent)] ${open ? 'bg-[var(--color-bg-hover)] text-[var(--color-accent)]' : 'text-[var(--color-text-muted)]'}`}>
        <Plus className={`h-4 w-4 transition-transform ${open ? 'rotate-45' : ''}`} />
      </button>
      {open && (
        <div className="absolute bottom-full left-0 z-20 mb-2 flex items-end gap-1 animate-fade-in">
          {/* 一级 */}
          <div className="w-[230px] rounded-lg border border-[var(--color-border-default)] bg-[var(--color-bg-panel)] p-1.5 shadow-2xl">
            {hasSession && (
              <button onMouseEnter={() => setSub(null)} onClick={() => { close(); onPickWorkDir?.() }} className={ROW} title={workDir ? tr('{dir}（点击更换）', { dir: workDir }) : tr('绑定工作目录')}>
                <Folder className={`h-4 w-4 shrink-0 ${workDir ? 'text-[var(--color-accent)]' : 'text-[var(--color-text-muted)]'}`} />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="text-[var(--color-text-primary)]">{tr('工作目录')}</span>
                  <span className="truncate text-[11px] text-[var(--color-text-muted)]">{workDir || tr('未绑定，点击选择')}</span>
                </span>
              </button>
            )}
            {attach && subRow('context', <Paperclip className="h-4 w-4 shrink-0 text-[var(--color-text-muted)]" />, tr('添加上下文'), '')}
            {skills && subRow('skills', <Sparkles className="h-4 w-4 shrink-0 text-[var(--color-text-muted)]" />, 'Skills', sks.length)}
            {subRow('templates', <ClipboardList className="h-4 w-4 shrink-0 text-[var(--color-text-muted)]" />, tr('常用任务'), tpls.length)}
            {subRow('runbooks', <BookOpen className="h-4 w-4 shrink-0 text-[var(--color-text-muted)]" />, tr('运维手册'), rbs.length)}
          </div>
          {/* 二级 */}
          {sub === 'context' && attach && (
            <div data-context-menu className="w-[200px] rounded-lg border border-[var(--color-border-default)] bg-[var(--color-bg-panel)] p-1.5 shadow-2xl">
              <button onClick={() => { close(); attach.onFiles() }} className={ROW} title={tr('附上本机文件（可多选）。普通文件只附路径，AI 需要时用本地终端读取；图片（png / jpg / gif / webp / bmp / svg）显示为图片，模型支持图片时作为图片发送，否则只附路径')}>
                <FileText className="h-4 w-4 shrink-0 text-[var(--color-text-muted)]" /><span className="text-[var(--color-text-primary)]">{tr('文件')}</span>
              </button>
              <button onClick={() => { close(); attach.onDirs() }} className={ROW} title={tr('附上本机目录的路径（不上传内容）')}>
                <FolderOpen className="h-4 w-4 shrink-0 text-[var(--color-text-muted)]" /><span className="text-[var(--color-text-primary)]">{tr('目录')}</span>
              </button>
            </div>
          )}
          {sub === 'skills' && skills && (
            <div data-skills-menu className="w-[300px] rounded-lg border border-[var(--color-border-default)] bg-[var(--color-bg-panel)] p-1.5 shadow-2xl">
              <div className="max-h-[260px] overflow-y-auto">
                {sks.length ? sks.map((s) => (
                  <button key={s.name} onClick={() => { close(); skills.onPick(s.name) }} title={s.description} className={`${ROW} flex-col !items-start gap-0.5`}>
                    <span className="font-mono text-[var(--color-text-primary)]">{s.name}</span>
                    <span className="w-full truncate text-[11px] text-[var(--color-text-muted)]">{s.description}</span>
                  </button>
                )) : <div className="px-2.5 py-3 text-center text-[12px] text-[var(--color-text-muted)]">{tr('暂无 Skill，可在设置里导入或新建')}</div>}
              </div>
              {manage(tr('管理 Skills…'), skills.onManage)}
            </div>
          )}
          {(sub === 'templates' || sub === 'runbooks') && (
            <div className="w-[300px] rounded-lg border border-[var(--color-border-default)] bg-[var(--color-bg-panel)] p-1.5 shadow-2xl">
              <div className="max-h-[260px] overflow-y-auto">
                {sub === 'templates' && (tpls.length ? tpls.map((t) => (
                  <button key={t.id} onClick={() => { close(); onTemplate(t.id) }} title={t.prompt} className={`${ROW} flex-col !items-start gap-0.5`}>
                    <span className="text-[var(--color-text-primary)]">{t.name}</span>
                    <span className="w-full truncate text-[11px] text-[var(--color-text-muted)]">{t.prompt}</span>
                  </button>
                )) : <div className="px-2.5 py-3 text-center text-[12px] text-[var(--color-text-muted)]">{tr('暂无模板')}</div>)}
                {sub === 'runbooks' && (rbs.length ? rbs.map((r) => (
                  <button key={r.id} onClick={() => { close(); onRunbook(r.id) }} title={r.steps.map((s, i) => `${i + 1}. ${s.title}`).join('\n')} className={`${ROW} flex-col !items-start gap-0.5`}>
                    <span className="text-[var(--color-text-primary)]">{r.name}<span className="ml-1.5 text-[11px] text-[var(--color-text-muted)]">{tr('{n} 步', { n: r.steps.length })}</span></span>
                    {r.description && <span className="w-full truncate text-[11px] text-[var(--color-text-muted)]">{r.description}</span>}
                  </button>
                )) : <div className="px-2.5 py-3 text-center text-[12px] text-[var(--color-text-muted)]">{tr('暂无手册，可在执行记录里「保存为手册」')}</div>)}
              </div>
              {sub === 'templates' ? manage(tr('管理模板…'), onManageTemplates) : manage(tr('管理手册…'), onManageRunbooks)}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
