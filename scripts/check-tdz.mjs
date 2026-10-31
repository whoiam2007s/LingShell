#!/usr/bin/env node
// 循环依赖里的「模块顶层立即读取」检查（TDZ 风险）。
// ESM 循环本身不出错；出错的是：模块 A 在顶层（不在函数体 / 实例字段里）读了 import 进来的 const / let / class / enum，
// 而声明它的模块 B 和 A 在同一个循环里——按加载顺序，读的时候 B 可能还没执行到那一行，启动即 ReferenceError。
// 只看有值含义的引用（import type 和只当类型用的名字会被编译器删掉，不算）。
//
// 用法：node scripts/check-tdz.mjs [desktop|shared|ui ...]     有风险时退出码 1
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const ts = createRequire(path.join(ROOT, 'package.json'))('typescript')
const norm = (p) => p.split(path.sep).join('/')
const PROJECTS = {
  desktop: { dir: 'apps/desktop', src: 'apps/desktop/src/main' },
  shared: { dir: 'packages/shared', src: 'packages/shared/src' },
  ui: { dir: 'apps/ui', src: 'apps/ui/src' },
}
const only = process.argv.slice(2)
let total = 0

for (const [name, p] of Object.entries(PROJECTS)) {
  if (only.length && !only.includes(name)) continue
  const srcAbs = norm(path.join(ROOT, p.src))
  const cfg = ts.getParsedCommandLineOfConfigFile(path.join(ROOT, p.dir, 'tsconfig.json'), {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => {} })
  const program = ts.createProgram(cfg.fileNames, cfg.options)
  const checker = program.getTypeChecker()
  const inSrc = (f) => norm(f).startsWith(srcAbs + '/')
  const rel = (f) => norm(f).slice(srcAbs.length + 1)
  const resolve = (from, spec) => {
    const r = ts.resolveModuleName(spec, from, cfg.options, ts.sys).resolvedModule
    return r && inSrc(r.resolvedFileName) && !r.isExternalLibraryImport ? norm(r.resolvedFileName) : undefined
  }
  const target = (sym) => { try { return sym && sym.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(sym) : sym } catch { return undefined } }
  const isValue = (sym) => { const t = target(sym); return !t || (t.flags & ts.SymbolFlags.Value) !== 0 }
  const files = program.getSourceFiles().filter((s) => inSrc(s.fileName))

  // 运行时依赖图：有值含义的静态 import / export-from / 仅副作用 import
  const graph = new Map(files.map((s) => [norm(s.fileName), new Set()]))
  for (const sf of files) {
    const from = norm(sf.fileName)
    for (const st of sf.statements) {
      if (!st.moduleSpecifier || !ts.isStringLiteral(st.moduleSpecifier) || !st.moduleSpecifier.text.startsWith('.')) continue
      const to = resolve(from, st.moduleSpecifier.text)
      if (!to) continue
      let runtime = false
      if (ts.isImportDeclaration(st)) {
        const c = st.importClause
        if (!c) runtime = true
        else if (!c.isTypeOnly) {
          if (c.name && isValue(checker.getSymbolAtLocation(c.name))) runtime = true
          if (c.namedBindings && ts.isNamespaceImport(c.namedBindings)) runtime = true
          if (c.namedBindings && ts.isNamedImports(c.namedBindings)) for (const e of c.namedBindings.elements) if (!e.isTypeOnly && isValue(checker.getSymbolAtLocation(e.name))) runtime = true
        }
      } else if (ts.isExportDeclaration(st) && !st.isTypeOnly) {
        if (!st.exportClause || !ts.isNamedExports(st.exportClause)) runtime = true
        else for (const e of st.exportClause.elements) if (!e.isTypeOnly && isValue(checker.getSymbolAtLocation(e.name))) runtime = true
      }
      if (runtime) graph.get(from).add(to)
    }
  }

  // 强连通分量（Tarjan，迭代写法）
  const idx = new Map(), low = new Map(), onStack = new Set(), stack = [], comp = new Map()
  let n = 0, cid = 0
  for (const v0 of graph.keys()) {
    if (idx.has(v0)) continue
    const work = [[v0, [...graph.get(v0)], 0]]
    idx.set(v0, n); low.set(v0, n++); stack.push(v0); onStack.add(v0)
    while (work.length) {
      const top = work.at(-1), [v, succ] = top
      if (top[2] < succ.length) {
        const w = succ[top[2]++]
        if (!idx.has(w)) { idx.set(w, n); low.set(w, n++); stack.push(w); onStack.add(w); work.push([w, [...(graph.get(w) ?? [])], 0]) }
        else if (onStack.has(w)) low.set(v, Math.min(low.get(v), idx.get(w)))
      } else {
        work.pop()
        if (work.length) { const parent = work.at(-1)[0]; low.set(parent, Math.min(low.get(parent), low.get(v))) }
        if (low.get(v) === idx.get(v)) { let w; const id = cid++; do { w = stack.pop(); onStack.delete(w); comp.set(w, id) } while (w !== v) }
      }
    }
  }
  const size = new Map()
  for (const c of comp.values()) size.set(c, (size.get(c) ?? 0) + 1)
  const cycles = [...size.values()].filter((s) => s > 1).sort((a, b) => b - a)

  // 顶层立即读取：不进函数体、类型、import / export 声明、非 static 的类字段
  const risks = []
  const prone = (d) => ts.isVariableDeclaration(d) || ts.isClassDeclaration(d) || ts.isEnumDeclaration(d) || ts.isExportAssignment(d) || ts.isSourceFile(d)
  for (const sf of files) {
    const from = norm(sf.fileName)
    const visit = (node) => {
      if (ts.isFunctionLike(node) || ts.isTypeNode(node) || ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node) || ts.isImportDeclaration(node) || ts.isExportDeclaration(node) || ts.isModuleDeclaration(node)) return
      if (ts.isPropertyDeclaration(node) && !node.modifiers?.some((m) => m.kind === ts.SyntaxKind.StaticKeyword)) return
      if (ts.isIdentifier(node)) {
        const par = node.parent
        if ((ts.isPropertyAccessExpression(par) && par.name === node) || (ts.isPropertyAssignment(par) && par.name === node) || ts.isExportSpecifier(par) || (ts.isVariableDeclaration(par) && par.name === node) || ts.isJsxAttribute(par) || ts.isJsxClosingElement(par)) return
        const sym = checker.getSymbolAtLocation(node)
        const d0 = sym?.declarations?.[0]
        if (!sym || !(sym.flags & ts.SymbolFlags.Alias) || !d0 || !(ts.isImportSpecifier(d0) || ts.isImportClause(d0) || ts.isNamespaceImport(d0))) return
        const t = target(sym), decl = t?.valueDeclaration ?? t?.declarations?.[0]
        if (!decl || !prone(decl)) return
        const df = norm(decl.getSourceFile().fileName)
        if (df !== from && comp.get(df) !== undefined && comp.get(df) === comp.get(from)) {
          risks.push(`${rel(from)}:${sf.getLineAndCharacterOfPosition(node.getStart()).line + 1} 顶层读取 ${node.text}（声明在 ${rel(df)}，同在一个 ${size.get(comp.get(from))} 个文件的循环里）`)
        }
        return
      }
      ts.forEachChild(node, visit)
    }
    for (const st of sf.statements) visit(st)
  }
  total += risks.length
  console.log(`tdz ${name}: ${files.length} 个文件，循环 ${cycles.length} 个${cycles.length ? `（${cycles.join('、')} 个文件）` : ''}，顶层立即读取 ${risks.length} 处`)
  for (const r of risks) console.log(`  ${r}`)
}
if (total) { console.log('把顶层读取挪进函数里，或者把被读的值移到不在循环里的模块（如 lib/）'); process.exit(1) }
