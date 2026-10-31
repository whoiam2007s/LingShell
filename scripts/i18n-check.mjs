#!/usr/bin/env node
// 国际化校验：扫源码里的中文字面量，找出
//   untranslated  中文字面量 / JSX 文字没走 tr()/tk()/trParts()/trx()（行尾或上一行写 i18n-ignore 可豁免）
//   missing       tr('中文') 的键在英文词典里没有
//   placeholder   中英文占位符 {x} 不一致
//   dynamic       tr() 的第一个参数是夹着中文的模板 / 拼接 / 三元：校验不了也提不出词条，改成占位符或分开 tr()
//   toplevel      模块顶层直接调 tr()（import 时就求值，主进程那时还没读语言设置）
//   conflict      同一中文键在不同词典分块里译文不同
// 用法：node scripts/i18n-check.mjs [路径…] [--summary] [--only=untranslated,missing] [--unused]
//   不给路径 = 全部源码。文件开头写 // i18n-ignore-file 整个文件跳过（如纯提示词文件）
import { createRequire } from 'node:module'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const ts = createRequire(path.join(ROOT, 'package.json'))('typescript')
const CJK = /[㐀-鿿＀-￯　-〿]/
const HAN = /[㐀-鿿]/
const args = process.argv.slice(2)
const flags = new Set(args.filter((a) => a.startsWith('--')).map((a) => a.split('=')[0]))
const only = (args.find((a) => a.startsWith('--only=')) ?? '').slice(7).split(',').filter(Boolean)
const targets = args.filter((a) => !a.startsWith('--')).map((a) => path.resolve(a))
const SRC_ROOTS = ['apps/ui/src', 'apps/desktop/src', 'packages/shared/src', 'packages/dsh-controller/src', 'packages/terminal-core/src', 'packages/config/src', 'packages/platform/src', 'packages/auth-registry/src'].map((p) => path.join(ROOT, p))
const LOCALE_DIR = path.join(ROOT, 'packages/shared/src/i18n/locales/en')
const TR = new Set(['tr', 'tk', 'trParts', 'trx'])

const parse = (file) => ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
const strOf = (n) => (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) ? n.text : undefined)
const holes = (s) => [...new Set([...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]))].sort().join(',')

// ── 词典 ──
const dict = new Map()   // zh → { en, chunk }
const issues = []
for (const f of fs.readdirSync(LOCALE_DIR).filter((f) => f.endsWith('.ts') && f !== 'index.ts')) {
  const sf = parse(path.join(LOCALE_DIR, f))
  sf.forEachChild(function visit(n) {
    if (ts.isPropertyAssignment(n)) {
      const zh = ts.isIdentifier(n.name) ? n.name.text : strOf(n.name)
      const en = strOf(n.initializer)
      if (zh === undefined || en === undefined) return
      const prev = dict.get(zh)
      if (prev && prev.en !== en) issues.push({ kind: 'conflict', file: path.join(LOCALE_DIR, f), line: sf.getLineAndCharacterOfPosition(n.getStart()).line + 1, text: `${zh} → "${en}" vs ${prev.chunk}: "${prev.en}"` })
      else dict.set(zh, { en, chunk: f })
      if (holes(zh) !== holes(en)) issues.push({ kind: 'placeholder', file: path.join(LOCALE_DIR, f), line: sf.getLineAndCharacterOfPosition(n.getStart()).line + 1, text: `${zh} → ${en}` })
      return
    }
    ts.forEachChild(n, visit)
  })
}

// ── 源码 ──
const used = new Set()
function walk(d, out) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name)
    if (e.isDirectory()) { if (!['node_modules', 'locales', 'out', 'dist'].includes(e.name)) walk(p, out) }
    else if (/\.(ts|tsx)$/.test(e.name) && !/\.(test|real\.test|gen|d)\.tsx?$/.test(e.name) && !/\.test\./.test(e.name) && !/fixtures?\./.test(e.name)) out.push(p)
  }
  return out
}
const files = SRC_ROOTS.filter((r) => fs.existsSync(r)).flatMap((r) => walk(r, []))
const inScope = (f) => !targets.length || targets.some((t) => f === t || f.startsWith(t + path.sep))

function insideFunction(n) {
  for (let p = n.parent; p; p = p.parent) {
    if (ts.isFunctionLike(p) || ts.isClassStaticBlockDeclaration?.(p)) return true
    if (ts.isPropertyDeclaration(p) && !p.modifiers?.some((m) => m.kind === ts.SyntaxKind.StaticKeyword)) return true   // 实例字段：构造时求值
  }
  return false
}

for (const file of files) {
  const src = fs.readFileSync(file, 'utf8')
  const scoped = inScope(file)
  if (/^\s*\/\/ i18n-ignore-file/m.test(src.slice(0, 2000))) continue
  const sf = parse(file)
  const lines = src.split(/\r?\n/)
  const ignored = (line) => /i18n-ignore/.test(lines[line] ?? '') || /i18n-ignore-next/.test(lines[line - 1] ?? '')
  const at = (n) => sf.getLineAndCharacterOfPosition(n.getStart()).line
  const push = (kind, n, text) => { if (scoped) issues.push({ kind, file, line: at(n) + 1, text }) }

  const visit = (n) => {
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && TR.has(n.expression.text)) {
      const a0 = n.arguments[0]
      const key = a0 && strOf(a0)
      // tr(变量) 是正常用法（常量表里 tk() 标过的值在显示处翻译）；模板 / 拼接 / 三元里夹着中文才报
      if (key === undefined) { if (a0 && !ts.isIdentifier(a0) && !ts.isPropertyAccessExpression(a0) && !ts.isElementAccessExpression(a0) && !ts.isCallExpression(a0) && CJK.test(a0.getText()) && !ignored(at(n))) push('dynamic', n, n.getText().slice(0, 80)) }
      else {
        used.add(key)
        if (CJK.test(key) && !dict.has(key)) push('missing', a0, key)
        if (n.expression.text !== 'tk' && !insideFunction(n) && !ignored(at(n))) push('toplevel', n, key)
      }
      n.arguments.slice(1).forEach(visit)
      return
    }
    // import / export 的模块路径、类型位置的字面量（type X = '只读'）不算
    if (ts.isImportDeclaration(n) || ts.isExportDeclaration(n) || ts.isLiteralTypeNode(n)) return
    const isStr = ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isTemplateHead(n) || ts.isTemplateMiddle(n) || ts.isTemplateTail(n) || ts.isJsxText(n)
    if (isStr && CJK.test(n.text) && !ignored(at(n))) {
      // 对象的键（{ '只读': 1 }）、比较 / switch 里的中文常量多半是匹配用的，仍报出来让人看（加 i18n-ignore）
      push('untranslated', n, n.text.replace(/\s+/g, ' ').trim().slice(0, 80))
    }
    ts.forEachChild(n, visit)
  }
  visit(sf)
}

if (flags.has('--unused') && !targets.length) for (const [zh, d] of dict) if (!used.has(zh)) issues.push({ kind: 'unused', file: path.join(LOCALE_DIR, d.chunk), line: 0, text: zh })

const shown = only.length ? issues.filter((i) => only.includes(i.kind)) : issues
const count = {}
for (const i of shown) count[i.kind] = (count[i.kind] ?? 0) + 1
if (!flags.has('--summary')) for (const i of shown) console.log(`${path.relative(ROOT, i.file).replace(/\\/g, '/')}:${i.line} ${i.kind} ${i.text}`)
if (flags.has('--summary')) {
  const per = {}
  for (const i of shown) { const k = path.relative(ROOT, i.file).replace(/\\/g, '/'); per[k] = (per[k] ?? 0) + 1 }
  for (const [k, v] of Object.entries(per).sort((a, b) => b[1] - a[1]).slice(0, 60)) console.log(String(v).padStart(5), k)
}
console.log(`\ni18n: ${Object.entries(count).map(([k, v]) => `${k}=${v}`).join(' ') || 'ok'}  (dict ${dict.size} keys)`)
process.exit(shown.length ? 1 : 0)
