// 看门狗检查脚本的只读校验：在 readonlyCommand.ts（单条命令只读白名单）之上，放行脚本常用的控制结构。
// 思路：把控制结构「改写」成白名单能判的形式，命令本身一条不少地交给 isReadOnlyCommand 判：
//  - 关键字 if/then/else/elif/fi/while/until/do/done/{/}/!、( ) 只影响流程，去掉；for NAME in … → echo …
//  - [ … ] / [[ … ]] → test …；exit / return → true
//  - 只有赋值的语句 NAME=值 → echo 值（后面再跟命令的 NAME=x cmd 一律拒：能改环境影响命令行为）
//  - $(( 算术 )) → 0；$( 命令替换 ) 内部递归校验后换成占位；${VAR…} → 占位
// 保守优先：认不出的写法交给 isReadOnlyCommand，它会拒。
import { isReadOnlyCommand } from './readonlyCommand.js'

const KEYWORDS = new Set(['if', 'then', 'else', 'elif', 'fi', 'while', 'until', 'do', 'done', '{', '}', '!', '(', ')', 'local'])
const SEP = new Set([';', '|', '&', '\n', '(', ')'])

/** 读一个「词」（引号内整段算一个词），返回词的原文与结束位置 */
function readWord(s: string, i: number): [string, number] {
  let j = i, q = ''
  while (j < s.length) {
    const c = s[j]
    if (q) { if (c === q) q = ''; j++; continue }
    if (c === "'" || c === '"') { q = c; j++; continue }
    if (/\s/.test(c) || SEP.has(c)) break
    j++
  }
  return [s.slice(i, j), j]
}

/** 改写控制结构；遇到「赋值后跟命令」返回 undefined（拒） */
function rewrite(s: string): string | undefined {
  let out = '', i = 0, atStart = true, assignOnly = false
  while (i < s.length) {
    const c = s[i]
    if (c === "'" || c === '"') {   // 引号段原样复制
      const end = s.indexOf(c, i + 1)
      if (end < 0) return undefined
      out += s.slice(i, end + 1); i = end + 1; atStart = false; continue
    }
    if (c === '\n' || c === ';' || c === '|' || (c === '&' && s[i + 1] === '&')) {
      const n = c === '&' || (c === '|' && s[i + 1] === '|') ? 2 : 1
      out += s.slice(i, i + n); i += n; atStart = true; assignOnly = false; continue
    }
    if (c === '(' || c === ')') { out += ';'; i++; atStart = true; assignOnly = false; continue }
    if (/\s/.test(c)) { out += c; i++; continue }
    const [w, j] = readWord(s, i)
    if (!w) { out += c; i++; continue }   // 单个 & 等：留给白名单判（会拒）
    if (assignOnly) return undefined      // NAME=x 后面又跟了词 → 带环境前缀的命令，拒
    if (atStart) {
      if (KEYWORDS.has(w)) { i = j; continue }
      if (w === 'for') {   // for NAME in a b → echo a b
        const m = /^for\s+[A-Za-z_]\w*\s+in\b/.exec(s.slice(i))
        if (!m) return undefined
        out += 'echo'; i += m[0].length; atStart = false; continue
      }
      if (w === '[' || w === '[[') { out += 'test'; i = j; atStart = false; continue }
      if (w === 'exit' || w === 'return') { out += 'true'; i = j; atStart = false; continue }
      const a = /^([A-Za-z_]\w*)=/.exec(w)
      if (a && /^(PATH|IFS|ENV|BASH_ENV|PS4|SHELLOPTS|BASHOPTS|LD_\w*)$/.test(a[1])) return undefined   // 改命令查找 / 解析方式的变量
      if (a) { out += `echo ${w.slice(a[0].length)}`; i = j; assignOnly = true; atStart = false; continue }
      atStart = false
    } else if (w === ']' || w === ']]') { i = j; continue }
    out += w; i = j
  }
  return out
}

/** 去掉 $(( )) 与 $( )（内部递归校验）、${ }；有不认识的就返回 undefined */
function flatten(s: string, depth: number): string | undefined {
  if (depth > 5 || s.includes('`') || /<</.test(s)) return undefined
  let cur = s
  for (let guard = 0; guard < 50; guard++) {
    const arith = /\$\(\(([^()]*)\)\)/.exec(cur)
    if (arith) { cur = cur.slice(0, arith.index) + '0' + cur.slice(arith.index + arith[0].length); continue }
    const sub = /\$\(([^()]*)\)/.exec(cur)
    if (sub) {
      if (!isReadOnlyScript(sub[1], depth + 1)) return undefined
      cur = cur.slice(0, sub.index) + 'x' + cur.slice(sub.index + sub[0].length); continue
    }
    break
  }
  if (cur.includes('$(')) return undefined
  return cur.replace(/\$\{[A-Za-z_]\w*(?:[:#%/^,-][^{}$`]*)?\}/g, 'x')
}

/** 脚本是否只读（可多行）。空脚本不算 */
export function isReadOnlyScript(script: string, depth = 0): boolean {
  if (!script.trim()) return false
  const flat = flatten(script.replace(/\r/g, '').replace(/^\s*#.*$/gm, ''), depth)   // 整行注释去掉
  if (flat === undefined) return false
  const r = rewrite(flat)
  if (r === undefined) return false
  return !r.trim().replace(/[\s;|&]/g, '') || isReadOnlyCommand(r)
}
