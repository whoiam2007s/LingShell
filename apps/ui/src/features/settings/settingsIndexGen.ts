// 设置项索引（命令面板搜设置用）：从设置页源码里抽 <Section title> 和 <Row label hint tip>，按页面归类。
// 生成结果在 settingsIndex.gen.ts，由 settingsIndex.test.ts 用文件快照守着：加了设置项没更新索引测试会失败，
// 跑 `npx vitest run src/features/settings/settingsIndex.test.ts -u` 重新生成。
export interface SettingEntry { tab: string; label: string; section?: string; hint?: string; tip?: string; kind: 'row' | 'section' }

// 各页面的入口文件名（与 SettingsModal 里的渲染对应）；页面里 import 的 settings 目录下组件也算这一页
export const TAB_ROOTS: Record<string, string> = {
  model: 'ModelSettings', ssh: 'SshManager', terminal: 'TerminalSettings', ai: 'AiSecuritySettings', general: 'GeneralSettings',
  keys: 'KeyManager', mcp: 'McpPanel', templates: 'TemplateManager', runbooks: 'RunbookManager', schedules: 'ScheduleManager',
  shortcuts: 'ShortcutSettings', recordings: 'RecordingsPanel', network: 'NetworkSettings', maintenance: 'MaintenancePanel',
  skills: 'SkillsPanel', secrets: 'SecretVaultManager', mobile: 'MobileAccessSettings', compliance: 'ComplianceSettings', about: 'AboutPanel',
}
// 「新建 / 编辑一条记录」的表单（名称、地址这类字段不算设置项，搜出来也定位不到）
export const SKIP_FILES = new Set(['CredentialManager', 'McpPanel', 'WebhookManager', 'WatchdogManager', 'AutoReplyManager', 'CertManager', 'TemplateManager', 'ScheduleManager', 'RunbookManager', 'SshImportDialog', 'HostBatchEdit', 'SkillsPanel'])

/** 从 i 处的 '<' 开始找到这个标签的结束 '>'（跳过 {…} 表达式和引号里的 >） */
function tagEnd(src: string, i: number): number {
  let depth = 0, q = ''
  for (let k = i + 1; k < src.length; k++) {
    const c = src[k]
    if (q) { if (c === q && src[k - 1] !== '\\') q = ''; continue }
    if (c === '"' || c === "'" || c === '`') q = c
    else if (c === '{') depth++
    else if (c === '}') depth--
    else if (c === '>' && depth === 0) return k
  }
  return src.length
}
// tr() / trx() 里的字符串字面量 → 运行时的值（\n 当空格，\\ \' \" 去掉转义），和运行时的翻译键一致
const unesc = (s: string) => s.replace(/\\n/g, ' ').replace(/\\(['"\\])/g, '$1')
// 组件里的文字：{tr('x')} 取 x
const inner = (s: string) => s.replace(/\{\s*tr\(\s*(['"])((?:(?!\1)[^\\]|\\.)*)\1\s*\)\s*\}/g, (_m, _q, x: string) => unesc(x))
/** name={trx('…{k}…', { k: <code>x</code>, br: <br /> })}：把占位符换回组件里的文字（自闭合组件换成空格），
 *  得到和改造前 JSX 片段一样的纯文字；不是这种写法返回 null，带第三个参数（变量）的不进索引 */
function trxAttr(tag: string, name: string): string | undefined | null {
  const m = new RegExp(`\\b${name}=\\{\\s*trx\\(\\s*(['"])((?:(?!\\1)[^\\\\]|\\\\.)*)\\1\\s*,\\s*\\{`).exec(tag)
  if (!m) return null
  // 找到 parts 对象的结束 }（跳过引号）
  const start = m.index + m[0].length
  let depth = 1, q = '', k = start
  for (; k < tag.length && depth; k++) {
    const c = tag[k]
    if (q) { if (c === q && tag[k - 1] !== '\\') q = ''; continue }
    if (c === '"' || c === "'" || c === '`') q = c
    else if (c === '{') depth++
    else if (c === '}') depth--
  }
  if (/^\s*,/.test(tag.slice(k))) return undefined
  const parts: Record<string, string> = {}
  for (const p of tag.slice(start, k - 1).matchAll(/(\w+)\s*:\s*<(\w+)\b[^>]*?(?:\/>|>([\s\S]*?)<\/\2>)/g)) parts[p[1]] = p[3] === undefined ? ' ' : ` ${inner(p[3])} `
  const text = unesc(m[2]).replace(/\{(\w+)\}/g, (s, key: string) => parts[key] ?? s).replace(/\s+/g, ' ').trim()
  return text || undefined
}
/** 属性值：name="x" / name={'x'} / name={"x"} / name={`x`}（模板里没有 ${} 的）/ name={tr('x')}；JSX 片段取其中的纯文字。
 *  索引里存中文原文（= 翻译键），命令面板显示时再 tr() */
function attr(tag: string, name: string): string | undefined {
  const x = trxAttr(tag, name)
  if (x !== null) return x
  const t = new RegExp(`\\b${name}=\\{\\s*tr\\(\\s*(['"])((?:(?!\\1)[^\\\\]|\\\\.)*)\\1\\s*(,[^)]*)?\\)\\s*\\}`).exec(tag)
  if (t) return t[3] ? undefined : unesc(t[2])   // 带参数的（含占位符）同模板字符串，不进索引
  const m = new RegExp(`\\b${name}=(?:"([^"]*)"|\\{\\s*(['"\`])((?:(?!\\2)[^\\\\]|\\\\.)*)\\2\\s*\\}|\\{\\s*<>([\\s\\S]*?)</>\\s*\\})`).exec(tag)
  if (!m) return undefined
  if (m[1] !== undefined) return m[1]
  if (m[3] !== undefined) return m[2] === '`' && m[3].includes('${') ? undefined : m[3].replace(/\\n/g, ' ')
  // <>{tr('主句')}{条件 && <>…</>}</>：取开头那句（后面按条件拼的补充说明不进索引）
  const lead = /^\s*\{\s*tr\(\s*(['"])((?:(?!\1)[^\\]|\\.)*)\1\s*\)\s*\}/.exec(m[4])
  if (lead) return unesc(lead[2])
  const text = m[4].replace(/<[^>]*>/g, ' ').replace(/\{[^}]*\}/g, ' ').replace(/\s+/g, ' ').trim()
  return text || undefined
}

/** 一个文件里的设置项（按出现顺序；row 记最近的上一个 Section 标题） */
export function extract(src: string): Omit<SettingEntry, 'tab'>[] {
  const out: Omit<SettingEntry, 'tab'>[] = []
  let section: string | undefined
  const re = /<(Row|Section)\b/g
  for (let m; (m = re.exec(src)); ) {
    const tag = src.slice(m.index, tagEnd(src, m.index) + 1)
    if (m[1] === 'Section') {
      section = attr(tag, 'title')
      if (section) out.push({ kind: 'section', label: section, ...(attr(tag, 'tip') ? { tip: attr(tag, 'tip') } : {}) })
      continue
    }
    const label = attr(tag, 'label')
    if (!label) continue
    const hint = attr(tag, 'hint'), tip = attr(tag, 'tip')
    out.push({ kind: 'row', label, ...(section ? { section } : {}), ...(hint ? { hint } : {}), ...(tip ? { tip } : {}) })
  }
  return out
}

const base = (f: string) => f.slice(f.lastIndexOf('/') + 1)
/** 相对 import → settings 目录下的路径（不带扩展名）；出了 settings 目录返回 undefined */
function resolveRel(from: string, spec: string): string | undefined {
  const parts = from.split('/').slice(0, -1)
  for (const s of spec.replace(/\.js$/, '').split('/')) {
    if (s === '..') { if (!parts.length) return undefined; parts.pop() } else if (s !== '.') parts.push(s)
  }
  return parts.join('/')
}

/** files：settings 目录下的路径（不带 .tsx，如 ssh/SshManager）→ 源码。页面入口按 import 递归带上 settings 里的组件 */
export function buildIndex(files: Record<string, string>): SettingEntry[] {
  const out: SettingEntry[] = []
  const seen = new Set<string>()
  const roots = new Set(Object.values(TAB_ROOTS))
  const byName = new Map(Object.keys(files).map((f) => [base(f), f]))
  for (const [tab, root] of Object.entries(TAB_ROOTS)) {
    const stack = [byName.get(root) ?? root]
    while (stack.length) {
      const f = stack.shift()!
      if (seen.has(f) || !(f in files)) continue
      seen.add(f)
      if (!SKIP_FILES.has(base(f))) for (const e of extract(files[f])) out.push({ tab, ...e })
      // 别的页面的入口文件不跟进去（页面之间会互相 import 公用的 hook，设置项不能算到别页）
      for (const m of files[f].matchAll(/from '(\.{1,2}\/[A-Za-z./]+)\.js'/g)) {
        const dep = resolveRel(f, m[1])
        if (dep && !roots.has(base(dep))) stack.push(dep)
      }
    }
  }
  return out
}

export function renderIndex(entries: SettingEntry[]): string {
  return `// 自动生成（settingsIndexGen.ts），不要手改：npx vitest run src/features/settings/settingsIndex.test.ts -u\nimport type { SettingEntry } from './settingsIndexGen.js'\n\nexport const SETTINGS_INDEX: SettingEntry[] = ${JSON.stringify(entries, null, 1)}\n`   // i18n-ignore 生成文件的注释头
}
