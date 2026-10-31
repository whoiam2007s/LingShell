// 设置 → Skills：本地 Skill 库的增删改 / 启停 / 导入（文件夹、.zip、.skill）/ 打开目录。
// 库本身在 dsh-controller（LocalSkills，<数据目录>/skills/）；这里只做 IPC 与系统对话框。
// 库里一有改动 LocalSkills 就通知控制器失效 skill 目录，下一步模型请求即生效，不用重启。
import { mkdir } from 'node:fs/promises'
import { LocalSkills, type SkillImportPreview, type SkillInfo } from '@lingshell/dsh-controller'
import { tr, tk, type SkillInput } from '@lingshell/shared'

export interface SkillsIpcDeps {
  handle(channel: string, fn: (e: unknown, ...args: unknown[]) => unknown): void
  root: string                                                 // <数据目录>/skills
  attach(lib: LocalSkills): void                               // 接到 DshController（ctx.skills provider）
  pickPath(kind: 'folder' | 'file'): Promise<string | undefined>
  openPath(p: string): Promise<string>                         // shell.openPath：成功返回 ''
  log?: (level: 'info' | 'warn', msg: string, data?: unknown) => void
}

const str = (v: unknown, what: string): string => { if (typeof v !== 'string' || !v) throw new Error(tr('非法的{what}', { what: tr(what) })); return v }

export function registerSkills(d: SkillsIpcDeps): LocalSkills {
  const lib = new LocalSkills(d.root, d.log)
  lib.watch()   // 用户在目录里手动改了文件也能及时生效
  d.attach(lib)
  d.handle('skills:list', (): Promise<SkillInfo[]> => lib.list())
  d.handle('skills:read', (_e, name) => lib.read(str(name, tk('arg| skill 名'))))
  d.handle('skills:save', (_e, input, old) => {
    const i = input as SkillInput
    if (!i || typeof i.name !== 'string' || typeof i.description !== 'string' || typeof i.body !== 'string') throw new Error(tr('非法的 skill'))
    return lib.save(i, typeof old === 'string' && old ? old : undefined)
  })
  d.handle('skills:remove', (_e, name) => lib.remove(str(name, tk('arg| skill 名'))))
  d.handle('skills:setFlags', (_e, name, flags) => {
    const f = (flags ?? {}) as { enabled?: unknown; modelInvocable?: unknown }
    const pick = (v: unknown) => (typeof v === 'boolean' ? v : undefined)
    return lib.setFlags(str(name, tk('arg| skill 名')), { enabled: pick(f.enabled), modelInvocable: pick(f.modelInvocable) })
  })
  // 选文件夹 / 选 .zip、.skill 包 → 暂存校验，返回预览；取消返回 null
  d.handle('skills:pickImport', async (_e, kind): Promise<SkillImportPreview | null> => {
    const p = await d.pickPath(kind === 'file' ? 'file' : 'folder')
    return p ? lib.inspectImport(p) : null
  })
  d.handle('skills:inspect', (_e, p) => lib.inspectImport(str(p, tk('arg|路径'))))   // 拖拽 / 已知路径
  d.handle('skills:commitImport', (_e, token, opts) => {
    const o = (opts ?? {}) as { overwrite?: unknown; rename?: unknown }
    return lib.commitImport(str(token, tk('arg|导入')), { overwrite: o.overwrite === true, rename: typeof o.rename === 'string' && o.rename ? o.rename : undefined })
  })
  d.handle('skills:cancelImport', (_e, token) => lib.cancelImport(str(token, tk('arg|导入'))))
  d.handle('skills:openDir', async () => {
    await mkdir(d.root, { recursive: true })
    const err = await d.openPath(d.root)
    if (err) throw new Error(err)
  })
  return lib
}
