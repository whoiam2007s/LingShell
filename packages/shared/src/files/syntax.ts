// 文件编辑器的轻量语法高亮：运维常改的几类文件（shell、conf / ini / systemd、nginx、yaml、json、xml、Dockerfile、sql、常见代码）。
// 只分注释 / 字符串 / 数字 / 键 / 关键字 / 段落 / 变量 / 标签几类，按行切，跨行的只有块注释（/* */、<!-- -->）。
// ponytail: 手写正则分词，不引入编辑器依赖；要语法级精度（嵌套 heredoc、模板字符串等）再换 CodeMirror。

export type TokKind = 'comment' | 'string' | 'number' | 'key' | 'keyword' | 'section' | 'variable' | 'tag'
export interface Tok { text: string; kind?: TokKind }
export type SyntaxLang = 'shell' | 'ini' | 'nginx' | 'yaml' | 'json' | 'xml' | 'dockerfile' | 'sql' | 'code' | 'python' | 'plain'

/** 按文件名猜语言（认不出 = plain，不高亮） */
export function syntaxLangOf(path: string): SyntaxLang {
  const name = path.replace(/^.*[\\/]/, '').toLowerCase()
  const ext = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : ''
  if (name === 'dockerfile' || name.startsWith('dockerfile.') || ext === 'dockerfile') return 'dockerfile'
  if (/^(\.bashrc|\.bash_profile|\.profile|\.zshrc|\.bash_aliases|\.bash_logout)$/.test(name) || ['sh', 'bash', 'zsh', 'ksh'].includes(ext)) return 'shell'
  if (name === 'nginx.conf' || /(^|[\\/])nginx[\\/]/.test(path.toLowerCase()) && ext === 'conf') return 'nginx'
  if (['yml', 'yaml'].includes(ext)) return 'yaml'
  if (['json', 'jsonc'].includes(ext)) return 'json'
  if (['xml', 'html', 'htm', 'svg', 'pom', 'xsd', 'plist'].includes(ext)) return 'xml'
  if (ext === 'sql') return 'sql'
  if (ext === 'py') return 'python'
  if (['js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'go', 'java', 'c', 'h', 'cpp', 'cc', 'hpp', 'cs', 'php', 'rs', 'kt', 'scala', 'groovy', 'gradle', 'lua', 'swift'].includes(ext)) return 'code'
  if (['conf', 'cnf', 'ini', 'cfg', 'properties', 'service', 'socket', 'timer', 'mount', 'target', 'env', 'toml', 'desktop', 'repo'].includes(ext) || name === '.env' || name.startsWith('.env.') || name === 'hosts' || name === 'fstab' || name === 'crontab') return 'ini'
  return 'plain'
}

const SHELL_KW = new Set('if then else elif fi for while until do done case esac in function return local export readonly declare unset shift break continue exit set source alias trap eval exec select time'.split(' '))
const CODE_KW = new Set(('break case catch class const continue default defer delete do else enum export extends false final finally for from func function go if implements import in instanceof interface let match new nil null package private protected public return static struct super switch this throw true try type typeof undefined var void while yield async await fn impl mut pub use mod trait where self Self elif except lambda pass raise with as def None True False is not and or print').split(' '))
const SQL_KW = new Set('select from where and or not insert into values update set delete create table index view drop alter add column primary key foreign references join left right inner outer on group by order having limit offset as distinct union all null is like in between exists case when then else end begin commit rollback grant revoke database if default unique auto_increment varchar int integer bigint text datetime timestamp'.split(' '))
const DOCKER_KW = new Set('FROM RUN CMD LABEL MAINTAINER EXPOSE ENV ADD COPY ENTRYPOINT VOLUME USER WORKDIR ARG ONBUILD STOPSIGNAL HEALTHCHECK SHELL AS'.split(' '))

type Rule = [RegExp, TokKind | ((m: string) => TokKind | undefined)]
const STR: Rule[] = [[/^"(?:[^"\\]|\\.)*"?/, 'string'], [/^'(?:[^'\\]|\\.)*'?/, 'string']]
const NUM: Rule = [/^-?\b\d+(?:\.\d+)?(?:[kKmMgGsh%]|ms)?\b/, 'number']
const VAR: Rule = [/^\$(?:\{[^}]*\}|[A-Za-z_][A-Za-z0-9_]*|[0-9@#?$!*-])/, 'variable']
const WORD = /^[A-Za-z_][A-Za-z0-9_-]*/

/** 按规则从左到右切：哪条在当前位置先匹配就用哪条，都不匹配就吃掉一个字符（连续的普通字符合并） */
function scan(line: string, rules: Rule[], word?: (w: string, before: string) => TokKind | undefined): Tok[] {
  const out: Tok[] = []
  const push = (text: string, kind?: TokKind) => {
    const last = out[out.length - 1]
    if (!kind && last && !last.kind) last.text += text
    else out.push(kind ? { text, kind } : { text })
  }
  let i = 0
  outer: while (i < line.length) {
    const rest = line.slice(i)
    for (const [re, k] of rules) {
      const m = re.exec(rest)
      if (m && m[0]) {
        const kind = typeof k === 'function' ? k(m[0]) : k
        // 紧跟在字母 / 路径符号后面的数字是名字的一部分（/404.html、app2、v1.2-rc3），不当数字上色
        push(m[0], kind === 'number' && i > 0 && /[\w./:-]/.test(line[i - 1]) ? undefined : kind); i += m[0].length; continue outer
      }
    }
    const w = WORD.exec(rest)
    if (w) { push(w[0], word?.(w[0], line.slice(0, i))); i += w[0].length; continue }
    push(line[i]); i++
  }
  return out
}

// 行首注释 / 行内「空白 + #」注释（避免把 a#b、URL 里的 # 当注释）
const hashComment = (line: string): number => { const m = /(^|\s)#/.exec(line); return m ? m.index + m[1].length : -1 }
const withComment = (line: string, at: number, body: (s: string) => Tok[]): Tok[] =>
  at < 0 ? body(line) : [...(at > 0 ? body(line.slice(0, at)) : []), { text: line.slice(at), kind: 'comment' }]

export interface SyntaxState { block?: 'c' | 'xml' }
/** 切一行；state 跨行传（块注释没结束时下一行仍是注释） */
export function tokenizeLine(line: string, lang: SyntaxLang, state: SyntaxState = {}): { toks: Tok[]; state: SyntaxState } {
  if (lang === 'plain' || !line) return { toks: line ? [{ text: line }] : [], state }
  // 块注释续行
  if (state.block) {
    const end = state.block === 'c' ? line.indexOf('*/') : line.indexOf('-->')
    if (end < 0) return { toks: [{ text: line, kind: 'comment' }], state }
    const n = end + (state.block === 'c' ? 2 : 3)
    const rest = tokenizeLine(line.slice(n), lang, {})
    return { toks: [{ text: line.slice(0, n), kind: 'comment' }, ...rest.toks], state: rest.state }
  }
  switch (lang) {
    case 'shell': return { toks: withComment(line, hashComment(line), (s) => scan(s, [...STR, VAR, NUM], (w) => (SHELL_KW.has(w) ? 'keyword' : undefined))), state }
    case 'dockerfile': {
      if (/^\s*#/.test(line)) return { toks: [{ text: line, kind: 'comment' }], state }
      return { toks: scan(line, [...STR, VAR, NUM], (w, before) => (DOCKER_KW.has(w) && (!before.trim() || w === 'AS') ? 'keyword' : undefined)), state }
    }
    case 'ini': {
      if (/^\s*[#;]/.test(line)) return { toks: [{ text: line, kind: 'comment' }], state }
      const sec = /^(\s*)(\[[^\]]*\])(.*)$/.exec(line)
      if (sec) return { toks: [...(sec[1] ? [{ text: sec[1] }] : []), { text: sec[2], kind: 'section' }, ...(sec[3] ? [{ text: sec[3] }] : [])], state }
      const kv = /^(\s*)([^=:\s][^=:]*?)(\s*[=:])(.*)$/.exec(line)
      if (kv) return { toks: [...(kv[1] ? [{ text: kv[1] }] : []), { text: kv[2], kind: 'key' }, { text: kv[3] }, ...scan(kv[4], [...STR, VAR, NUM])], state }
      return { toks: scan(line, [...STR, NUM]), state }
    }
    case 'nginx': {
      return { toks: withComment(line, hashComment(line), (s) => {
        const d = /^(\s*)([A-Za-z_][A-Za-z0-9_]*)(.*)$/.exec(s)
        return d ? [...(d[1] ? [{ text: d[1] }] : []), { text: d[2], kind: 'key' as TokKind }, ...scan(d[3], [...STR, VAR, NUM])] : scan(s, [...STR, VAR, NUM])
      }), state }
    }
    case 'yaml': {
      return { toks: withComment(line, hashComment(line), (s) => {
        const kv = /^(\s*(?:-\s+)?)([^\s#'"][^:#]*?|"[^"]*"|'[^']*')(:)(\s|$)(.*)$/.exec(s)
        const val = (v: string) => scan(v, [...STR, NUM, [/^(?:true|false|yes|no|null|~)\b/i, 'keyword'], [/^[&*][A-Za-z0-9_-]+/, 'variable']])
        return kv ? [...(kv[1] ? [{ text: kv[1] }] : []), { text: kv[2], kind: 'key' as TokKind }, { text: kv[3] + kv[4] }, ...val(kv[5])] : val(s)
      }), state }
    }
    case 'json': {
      return { toks: scan(line, [[/^"(?:[^"\\]|\\.)*"(?=\s*:)/, 'key'], STR[0], NUM, [/^(?:true|false|null)\b/, 'keyword'], [/^\/\/.*/, 'comment']]), state }
    }
    case 'xml': {
      const toks: Tok[] = []
      let i = 0
      while (i < line.length) {
        const rest = line.slice(i)
        if (rest.startsWith('<!--')) {
          const end = rest.indexOf('-->')
          if (end < 0) return { toks: [...toks, { text: rest, kind: 'comment' }], state: { block: 'xml' } }
          toks.push({ text: rest.slice(0, end + 3), kind: 'comment' }); i += end + 3; continue
        }
        const tag = /^<\/?[A-Za-z_][\w:.-]*/.exec(rest)
        if (tag) {
          toks.push({ text: tag[0], kind: 'tag' }); i += tag[0].length
          // 属性直到 >
          const close = line.indexOf('>', i)
          const attrs = line.slice(i, close < 0 ? undefined : close)
          toks.push(...scan(attrs, [...STR, [/^[A-Za-z_][\w:.-]*(?==)/, 'key']]))
          i += attrs.length
          if (close >= 0) { toks.push({ text: '>', kind: 'tag' }); i++ }
          continue
        }
        const t = /^[^<]+/.exec(rest)?.[0] ?? rest[0]
        toks.push({ text: t }); i += t.length
      }
      return { toks, state }
    }
    case 'sql': {
      return { toks: scan(line, [[/^--.*/, 'comment'], ...STR, NUM], (w) => (SQL_KW.has(w.toLowerCase()) ? 'keyword' : undefined)), state }
    }
    case 'python': {
      return { toks: scan(line, [[/^#.*/, 'comment'], [/^(?:[rbfu]{0,2})"""[\s\S]*?(?:"""|$)/i, 'string'], ...STR, NUM, [/^@[A-Za-z_][\w.]*/, 'variable']], (w) => (CODE_KW.has(w) ? 'keyword' : undefined)), state }
    }
    case 'code': {
      const toks: Tok[] = []
      let i = 0, st: SyntaxState = state
      // 先找出块注释的起点，前面按规则切，后面递归
      const open = (() => { const m = /\/\*/.exec(line); return m ? m.index : -1 })()
      const body = open < 0 ? line : line.slice(0, open)
      toks.push(...scan(body, [[/^\/\/.*/, 'comment'], ...STR, [/^`(?:[^`\\]|\\.)*`?/, 'string'], NUM, [/^@[A-Za-z_][\w.]*/, 'variable']], (w) => (CODE_KW.has(w) ? 'keyword' : undefined)))
      // 行注释吃掉了 /* 的情况：body 里已有 // 注释，后面整段算注释
      if (open >= 0) {
        if (toks.some((t) => t.kind === 'comment')) { toks.push({ text: line.slice(open), kind: 'comment' }); return { toks, state: st } }
        i = open
        const end = line.indexOf('*/', i + 2)
        if (end < 0) { toks.push({ text: line.slice(i), kind: 'comment' }); st = { block: 'c' } }
        else { toks.push({ text: line.slice(i, end + 2), kind: 'comment' }); const r = tokenizeLine(line.slice(end + 2), lang, {}); toks.push(...r.toks); st = r.state }
      }
      return { toks, state: st }
    }
  }
  return { toks: [{ text: line }], state }
}

export const HIGHLIGHT_MAX = 300 * 1024
/** 整个文本按行切；超过 HIGHLIGHT_MAX 不高亮（编辑大文件时每次按键都重算会卡） */
export function highlightText(text: string, lang: SyntaxLang): Tok[][] {
  const lines = text.split('\n')
  if (lang === 'plain' || text.length > HIGHLIGHT_MAX) return lines.map((l) => (l ? [{ text: l }] : []))
  let st: SyntaxState = {}
  return lines.map((l) => { const r = tokenizeLine(l, lang, st); st = r.state; return r.toks })
}
