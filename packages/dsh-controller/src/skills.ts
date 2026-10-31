// 本地 Skill 库：<数据目录>/skills/<name>/SKILL.md（+ 同目录资源文件），实现 dsh-skill 的 provider 契约（list / get）。
//
// 为什么不用官方的 dsh-skill-filesystem：它还会扫项目里的 .dsh/.agents 和 ~/.dsh、~/.agents（与本应用无关的目录），
// 启停 / 「AI 可自动调用」只能改 SKILL.md 本身；这里把这两个开关记在应用自己的状态文件（skills/.skills.json），
// 不改用户导入的文件，也不多带 chokidar / yaml 依赖。
// skill 正文只是提示词，这里只读写文件，不执行包里的任何东西。
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, watch, type FSWatcher } from 'node:fs'
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile, rename as mv } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, extname, join, relative, resolve, sep } from 'node:path'
import { randomUUID } from 'node:crypto'
import { buildSkillMd, isSkillName, parseSkillMd, type SkillMeta } from './skillFile.js'

import { tr, type SkillInfo, type SkillImportPreview, type SkillOrigin, type SkillInput } from '@lingshell/shared'
export type { SkillInfo, SkillImportPreview }

interface State { [name: string]: { enabled?: boolean; modelInvocable?: boolean; origin?: SkillOrigin } }

// 导入包的上限：防误导入整个大目录 / zip 炸弹
const MAX_FILES = 500
const MAX_BYTES = 50 * 1024 * 1024
const STATE_FILE = '.skills.json'
export const SKILL_PROVIDER = 'lingshell'

const isHidden = (n: string) => n.startsWith('.') || n === '__MACOSX'

/** 列目录下全部文件（相对路径，/ 分隔）；遇到符号链接 / 超限直接报错 */
async function walk(root: string, limits = true): Promise<string[]> {
  const out: string[] = []
  let bytes = 0
  const go = async (dir: string) => {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      if (isHidden(e.name)) continue   // .git / __MACOSX 之类不算包内容，也不拷
      const p = join(dir, e.name)
      const st = await lstat(p)
      if (st.isSymbolicLink()) throw new Error(tr('包内含符号链接（{path}），已拒绝', { path: relative(root, p) }))
      if (st.isDirectory()) { await go(p); continue }
      if (!st.isFile()) continue
      out.push(relative(root, p).split(sep).join('/'))
      bytes += st.size
      if (limits && (out.length > MAX_FILES || bytes > MAX_BYTES)) throw new Error(tr('包太大（超过 {files} 个文件或 {mb}MB）', { files: MAX_FILES, mb: MAX_BYTES / 1024 / 1024 }))
    }
  }
  await go(root)
  return out.sort()
}

/** zip 内条目路径是否安全：不许绝对路径、盘符、.. 段 */
export function unsafeEntry(p: string): boolean {
  const s = p.replace(/\\/g, '/')
  return s.startsWith('/') || /^[a-zA-Z]:/.test(s) || s.split('/').some((seg) => seg === '..')
}

const run = (cmd: string, args: string[]) => new Promise<string>((res, rej) =>
  execFile(cmd, args, { maxBuffer: 16 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => (err ? rej(new Error(String(stderr || err.message).trim())) : res(String(stdout)))))

// Windows 自带的 bsdtar（System32\tar.exe）能解 zip；macOS 的 tar 也是 bsdtar；Linux 的 GNU tar 不认 zip，退回 unzip
function tarBin(): string {
  if (process.platform !== 'win32') return 'tar'
  const sys = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe')
  return existsSync(sys) ? sys : 'tar'
}

/** 解压 .zip / .skill 到 dest：先列条目查路径穿越，再解压 */
export async function extractArchive(file: string, dest: string): Promise<void> {
  let list: string[]
  let viaUnzip = false
  try { list = (await run(tarBin(), ['-tf', file])).split(/\r?\n/).filter(Boolean) }
  catch (e) {
    if (process.platform === 'win32') throw new Error(tr('无法读取压缩包：{error}', { error: (e as Error).message }))
    list = (await run('unzip', ['-Z1', file])).split(/\r?\n/).filter(Boolean)
    viaUnzip = true
  }
  const bad = list.find(unsafeEntry)
  if (bad) throw new Error(tr('压缩包里有越界路径「{path}」，已拒绝', { path: bad }))
  if (list.length > MAX_FILES * 2) throw new Error(tr('压缩包文件太多'))
  if (viaUnzip) await run('unzip', ['-q', '-o', file, '-d', dest])
  else await run(tarBin(), ['-xf', file, '-C', dest])
}

export class LocalSkills {
  private listeners = new Set<() => void>()
  private staged = new Map<string, { dir: string; root: string; meta: SkillMeta }>()
  private watcher?: FSWatcher
  private debounce?: ReturnType<typeof setTimeout>

  constructor(readonly root: string, private log?: (level: 'info' | 'warn', msg: string, data?: unknown) => void) {}

  /** 目录里的文件被外部改了（用户在「打开 Skills 目录」里手动编辑）也通知一下；失败不影响使用 */
  watch(): void {
    if (this.watcher) return
    try {
      mkdirSync(this.root, { recursive: true })
      this.watcher = watch(this.root, { recursive: true }, () => {
        clearTimeout(this.debounce)
        this.debounce = setTimeout(() => this.changed(), 300)
      })
      this.watcher.on('error', () => { this.watcher?.close(); this.watcher = undefined })
    } catch (e) { this.log?.('warn', 'skills watch failed', { err: String(e) }) }
  }
  close(): void { this.watcher?.close(); this.watcher = undefined; clearTimeout(this.debounce) }

  onChange(cb: () => void): () => void { this.listeners.add(cb); return () => this.listeners.delete(cb) }
  private changed(): void { for (const cb of this.listeners) { try { cb() } catch { /* 监听者自己的错不影响别人 */ } } }

  private async state(): Promise<State> {
    try { return JSON.parse(await readFile(join(this.root, STATE_FILE), 'utf8')) as State } catch { return {} }
  }
  private async saveState(s: State): Promise<void> {
    await mkdir(this.root, { recursive: true })
    await writeFile(join(this.root, STATE_FILE), JSON.stringify(s, null, 2))
  }

  /** 全部 skill（含坏的，坏的带 error） */
  async list(): Promise<SkillInfo[]> {
    let dirs: string[] = []
    try { dirs = (await readdir(this.root, { withFileTypes: true })).filter((d) => d.isDirectory() && !isHidden(d.name)).map((d) => d.name).sort() }
    catch { return [] }
    const st = await this.state()
    const seen = new Set<string>()
    const out: SkillInfo[] = []
    for (const dir of dirs) {
      const base: Omit<SkillInfo, 'name' | 'description' | 'enabled' | 'modelInvocable' | 'userInvocable'> = { dir, origin: 'manual', files: [] }
      try {
        const files = (await walk(join(this.root, dir), false)).filter((f) => f !== 'SKILL.md')
        const p = parseSkillMd(await readFile(join(this.root, dir, 'SKILL.md'), 'utf8'))
        if (!p.ok) { out.push({ ...base, name: dir, description: '', enabled: false, modelInvocable: false, userInvocable: false, files, error: p.error }); continue }
        const { meta } = p
        const s = st[meta.name] ?? {}
        const dup = seen.has(meta.name)
        seen.add(meta.name)
        out.push({
          ...base, files, name: meta.name, description: meta.description, origin: s.origin ?? 'manual',
          enabled: !dup && s.enabled !== false,
          modelInvocable: s.modelInvocable ?? !meta.disableModelInvocation,
          userInvocable: meta.userInvocable !== false,
          ...(dup ? { error: tr('与另一个目录里的 skill 重名（{name}），未启用', { name: meta.name }) } : {}),
        })
      } catch (e) {
        const msg = (e as NodeJS.ErrnoException).code === 'ENOENT' ? tr('目录里没有 SKILL.md') : (e as Error).message
        out.push({ ...base, name: dir, description: '', enabled: false, modelInvocable: false, userInvocable: false, error: msg })
      }
    }
    return out
  }

  private async dirOf(name: string): Promise<string> {
    const s = (await this.list()).find((x) => x.name === name)
    if (!s) throw new Error(tr('skill 不存在：{name}', { name }))
    return join(this.root, s.dir)
  }

  /** 编辑用：解析后的字段 + 正文 */
  async read(name: string): Promise<{ name: string; description: string; body: string }> {
    const p = parseSkillMd(await readFile(join(await this.dirOf(name), 'SKILL.md'), 'utf8'))
    if (!p.ok) throw new Error(p.error)
    return { name: p.meta.name, description: p.meta.description, body: p.body }
  }

  /** 新建（old 缺省）或修改。改名 = 目录跟着改名；frontmatter 里其它键原样保留 */
  async save(input: SkillInput, old?: string): Promise<void> {
    const name = input.name.trim()
    if (!isSkillName(name)) throw new Error(tr('名称只能用小写字母、数字和连字符（如 nginx-check），最长 64 字符'))
    if (!input.description.trim()) throw new Error(tr('请填写描述（AI 靠它判断什么时候用这个 skill）'))
    const all = await this.list()
    if (name !== old && all.some((s) => s.name === name || s.dir === name)) throw new Error(tr('已有同名 skill：{name}', { name }))
    const st = await this.state()
    if (old) {
      const dir = await this.dirOf(old)
      const prev = parseSkillMd(await readFile(join(dir, 'SKILL.md'), 'utf8'))
      const meta: SkillMeta = prev.ok ? { ...prev.meta, name, description: input.description.trim() } : { name, description: input.description.trim() }
      await writeFile(join(dir, 'SKILL.md'), buildSkillMd(meta, input.body, prev.ok ? prev.extra : []))
      if (name !== old) {
        await mv(dir, join(this.root, name))
        st[name] = st[old] ?? {}
        delete st[old]
        await this.saveState(st)
      }
    } else {
      const dir = join(this.root, name)
      await mkdir(dir, { recursive: true })
      await writeFile(join(dir, 'SKILL.md'), buildSkillMd({ name, description: input.description.trim() }, input.body))
      st[name] = { origin: 'created' }
      await this.saveState(st)
    }
    this.changed()
  }

  async remove(name: string): Promise<void> {
    const dir = await this.dirOf(name)
    if (!resolve(dir).startsWith(resolve(this.root) + sep)) throw new Error(tr('路径不对，已拒绝删除'))
    await rm(dir, { recursive: true, force: true })
    const st = await this.state()
    delete st[name]
    await this.saveState(st)
    this.changed()
  }

  async setFlags(name: string, flags: { enabled?: boolean; modelInvocable?: boolean }): Promise<void> {
    await this.dirOf(name)
    const st = await this.state()
    st[name] = { ...st[name], ...flags }
    await this.saveState(st)
    this.changed()
  }

  // ── 导入：先暂存 + 校验 + 预览，用户确认后再落到 skills 目录 ──
  async inspectImport(src: string): Promise<SkillImportPreview> {
    const s = await stat(src)
    const dir = await mkdtemp(join(tmpdir(), 'lingshell-skill-'))
    try {
      const staging = join(dir, 'pkg')
      await mkdir(staging)
      if (s.isDirectory()) {
        await walk(src)   // 先查符号链接 / 大小，再拷
        await cp(src, staging, { recursive: true, filter: (p) => !isHidden(basename(p)) || p === src })
      } else {
        const ext = extname(src).toLowerCase()
        if (ext !== '.zip' && ext !== '.skill') throw new Error(tr('只支持文件夹、.zip 或 .skill 包'))
        // 压缩包本身也设上限：解压后的大小是另一道检查，但超大压缩包（zip 炸弹）不能先落满临时目录
        if (s.size > MAX_BYTES) throw new Error(tr('压缩包超过 {mb}MB，已拒绝', { mb: MAX_BYTES / 1024 / 1024 }))
        await extractArchive(src, staging)
      }
      await walk(staging)   // 解压后再查一遍：符号链接 / 超限
      // SKILL.md 在包根，或在唯一的一层子目录里（常见的「zip 里包了一层文件夹」）
      let root = staging
      if (!existsSync(join(root, 'SKILL.md'))) {
        const subs = (await readdir(staging, { withFileTypes: true })).filter((d) => !isHidden(d.name))
        if (subs.length === 1 && subs[0].isDirectory() && existsSync(join(staging, subs[0].name, 'SKILL.md'))) root = join(staging, subs[0].name)
        else throw new Error(tr('包里没有 SKILL.md（应在包根目录，或唯一的一层子目录里）'))
      }
      const real = await realpath(root)
      if (!real.startsWith(await realpath(staging))) throw new Error(tr('包路径越界，已拒绝'))
      const text = await readFile(join(root, 'SKILL.md'), 'utf8')
      const p = parseSkillMd(text)
      if (!p.ok) throw new Error(p.error)
      const token = randomUUID()
      this.staged.set(token, { dir, root, meta: p.meta })
      const names = new Set((await this.list()).flatMap((x) => [x.name, x.dir]))
      let suggestedName = p.meta.name
      for (let i = 2; names.has(suggestedName); i++) suggestedName = `${p.meta.name}-${i}`
      return {
        token, name: p.meta.name, description: p.meta.description,
        skillMd: text.length > 20_000 ? `${text.slice(0, 20_000)}\n${tr('…（已截断）')}` : text,
        files: await walk(root), conflict: names.has(p.meta.name), suggestedName,
      }
    } catch (e) {
      await rm(dir, { recursive: true, force: true }).catch(() => {})
      throw e
    }
  }

  /** 确认导入。重名时 overwrite=true 覆盖，或给 rename 改名导入 */
  async commitImport(token: string, opts: { overwrite?: boolean; rename?: string } = {}): Promise<string> {
    const st = this.staged.get(token)
    if (!st) throw new Error(tr('导入已过期，请重新选择'))
    const name = (opts.rename ?? st.meta.name).trim()
    if (!isSkillName(name)) throw new Error(tr('名称只能用小写字母、数字和连字符（如 nginx-check），最长 64 字符'))
    const existing = (await this.list()).find((x) => x.name === name || x.dir === name)
    if (existing && !opts.overwrite) throw new Error(tr('已有同名 skill：{name}', { name }))
    if (existing) await rm(join(this.root, existing.dir), { recursive: true, force: true })
    await mkdir(this.root, { recursive: true })
    const dest = join(this.root, name)
    await cp(st.root, dest, { recursive: true, filter: (p) => p === st.root || !isHidden(basename(p)) })
    if (name !== st.meta.name) {
      const p = parseSkillMd(await readFile(join(dest, 'SKILL.md'), 'utf8'))
      if (p.ok) await writeFile(join(dest, 'SKILL.md'), buildSkillMd({ ...p.meta, name }, p.body, p.extra))
    }
    const state = await this.state()
    state[name] = { origin: 'imported' }
    await this.saveState(state)
    await this.cancelImport(token)
    this.changed()
    return name
  }

  async cancelImport(token: string): Promise<void> {
    const st = this.staged.get(token)
    this.staged.delete(token)
    if (st) await rm(st.dir, { recursive: true, force: true }).catch(() => {})
  }

  // ── dsh-skill provider 契约 ──
  provider() {
    return {
      name: SKILL_PROVIDER,
      list: async () => (await this.list()).filter((s) => s.enabled && !s.error).map((s) => {
        const dir = join(this.root, s.dir)
        return {
          name: s.name, description: s.description, source: 'custom', provider: SKILL_PROVIDER, rank: 300,
          invocation: { modelInvocable: s.modelInvocable, userInvocable: s.userInvocable },
          path: join(dir, 'SKILL.md'), resourceBase: { kind: 'directory' as const, path: dir }, locator: dir,
        }
      }),
      // 每次加载都重读文件：正文改了不用通知，下次调用就是新内容
      get: async (c: { name: string; locator: unknown; invocation: { modelInvocable: boolean; userInvocable: boolean } }) => {
        const dir = String(c.locator)
        let text: string
        try { text = await readFile(join(dir, 'SKILL.md'), 'utf8') } catch { return undefined }
        const p = parseSkillMd(text)
        if (!p.ok) return undefined
        return {
          name: p.meta.name, description: p.meta.description, ...(p.meta.whenToUse ? { whenToUse: p.meta.whenToUse } : {}),
          invocation: c.invocation, source: 'custom', provider: SKILL_PROVIDER,
          path: join(dir, 'SKILL.md'), resourceBase: { kind: 'directory' as const, path: dir }, content: p.body,
        }
      },
    }
  }
}
