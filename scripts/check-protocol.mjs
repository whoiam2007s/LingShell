#!/usr/bin/env node
// 协议三方一致（纯静态，不启动应用）：主进程注册的 IPC 通道 ↔ protocol/client 的 AppClient ↔ transports/ipc 的实现。
//  1. 领域对齐：packages/shared/src/protocol/client/<领域>.ts、apps/ui/src/client/transports/ipc/<领域>.ts、
//     apps/desktop/src/main/<领域>/ 三边是同一组领域；AppClient extends 全部领域接口，自身只有 on
//  2. ipc/<领域>.ts 正好实现该领域接口的命名空间和方法（不多不少）
//  3. 实现里 invoke 的通道名都是字面量，且主进程有注册（*.handle('通道', …)），注册在同名领域目录下；
//     主进程注册的通道都有 AppClient 方法用到（apps/desktop/src/main/index.ts 里给 preload 直接用的除外），且不重复注册
//  4. HttpTransport 覆盖全部命名空间
//  5. scripts/structure/client-methods.txt、invoke-channels.txt 与代码一致
//
// 用法：node scripts/check-protocol.mjs          有问题时退出码 1
//       node scripts/check-protocol.mjs --write  重新生成第 5 条的两个清单
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const ts = createRequire(path.join(ROOT, 'package.json'))('typescript')
const WRITE = process.argv.includes('--write')
const PROTO = path.join(ROOT, 'packages/shared/src/protocol/client')
const IPC = path.join(ROOT, 'apps/ui/src/client/transports/ipc')
const HTTP = path.join(ROOT, 'apps/ui/src/client/transports/HttpTransport.ts')
const MAIN = path.join(ROOT, 'apps/desktop/src/main')
const DOCS = path.join(ROOT, 'scripts/structure')
const rel = (f) => path.relative(ROOT, f).split(path.sep).join('/')
const parse = (f) => ts.createSourceFile(f, fs.readFileSync(f, 'utf8'), ts.ScriptTarget.Latest, true)
const tsFiles = (d) => fs.readdirSync(d).filter((f) => f.endsWith('.ts') && !f.endsWith('.d.ts') && !/\.test\.ts$/.test(f))
const errors = []
const err = (m) => errors.push(m)

// ── protocol/client：领域 → { api, 命名空间 → 方法[] } ──
const proto = new Map()
for (const f of tsFiles(PROTO).filter((f) => f !== 'index.ts')) {
  const d = f.replace(/\.ts$/, '')
  const sf = parse(path.join(PROTO, f))
  const ifaces = sf.statements.filter((s) => ts.isInterfaceDeclaration(s) && s.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword))
  if (ifaces.length !== 1) { err(`${rel(sf.fileName)}：应正好导出一个领域接口，实际 ${ifaces.length} 个`); continue }
  const ns = new Map()
  for (const m of ifaces[0].members) {
    if (!ts.isPropertySignature(m) || !m.type || !ts.isTypeLiteralNode(m.type)) { err(`${rel(sf.fileName)}：${m.name?.getText(sf)} 不是命名空间（{ 方法… }）`); continue }
    ns.set(m.name.getText(sf), m.type.members.map((x) => x.name.getText(sf)))
  }
  proto.set(d, { api: ifaces[0].name.text, ns })
}
const nsDomain = new Map()
for (const [d, { ns }] of proto) for (const n of ns.keys()) { if (nsDomain.has(n)) err(`命名空间 ${n} 同时出现在 protocol/client/${nsDomain.get(n)}.ts 和 ${d}.ts`); nsDomain.set(n, d) }
{
  const sf = parse(path.join(PROTO, 'index.ts'))
  const ac = sf.statements.find((s) => ts.isInterfaceDeclaration(s) && s.name.text === 'AppClient')
  if (!ac) err('protocol/client/index.ts 里找不到 AppClient')
  else {
    const ext = new Set((ac.heritageClauses ?? []).flatMap((h) => h.types.map((t) => t.expression.getText(sf))))
    for (const [d, { api }] of proto) if (!ext.has(api)) err(`AppClient 没有 extends ${api}（protocol/client/${d}.ts）`)
    for (const m of ac.members) if (m.name?.getText(sf) !== 'on') err(`AppClient 自身成员只留 on（事件订阅）；${m.name?.getText(sf)} 要放到 protocol/client/<领域>.ts`)
  }
}

// ── transports/ipc：领域 → 命名空间 → { 方法 → 通道[] } ──
const strip = (n) => { while (n && (ts.isAsExpression(n) || ts.isParenthesizedExpression(n) || ts.isSatisfiesExpression(n) || ts.isTypeAssertionExpression(n))) n = n.expression; return n }
const isFn = (n) => { n = strip(n); return !!n && (ts.isArrowFunction(n) || ts.isFunctionExpression(n)) }
const ipc = new Map()
const methods = []   // [ns.method, channels]
for (const f of tsFiles(IPC)) {
  const d = f.replace(/\.ts$/, '')
  const sf = parse(path.join(IPC, f))
  const nsMap = new Map()
  const visit = (n) => {
    if (ts.isPropertyAssignment(n)) {
      const obj = strip(n.initializer)
      if (obj && ts.isObjectLiteralExpression(obj) && obj.properties.some((m) => (ts.isPropertyAssignment(m) && isFn(m.initializer)) || ts.isMethodDeclaration(m))) {
        const ns = n.name.getText(sf), ms = new Map()
        for (const m of obj.properties) {
          const name = m.name?.getText(sf)
          const chs = []
          const v = (x) => {
            if (ts.isCallExpression(x) && x.expression.getText(sf) === 'window.electronAPI.invoke') {
              const a = x.arguments[0]
              if (a && ts.isStringLiteral(a)) chs.push(a.text)
              else err(`${rel(sf.fileName)}：${ns}.${name} 的通道名不是字符串字面量（${a?.getText(sf)}）`)
            }
            ts.forEachChild(x, v)
          }
          v(m)
          ms.set(name, chs)
          methods.push([`${ns}.${name}`, chs])
        }
        nsMap.set(ns, ms)
        return
      }
    }
    ts.forEachChild(n, visit)
  }
  visit(sf)
  ipc.set(d, nsMap)
}

// ── 主进程：通道 → 注册位置 ──
const reg = new Map()
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : e.name.endsWith('.ts') && !/\.test\.ts$|\.d\.ts$/.test(e.name) ? [path.join(d, e.name)] : []))
const mainDomains = new Set(fs.readdirSync(MAIN, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name))
for (const f of walk(MAIN)) {
  const sf = parse(f)
  const r = path.relative(MAIN, f).split(path.sep)
  const dom = r.length > 1 ? r[0] : '(root)'
  const v = (n) => {
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === 'handle' && n.arguments[0] && ts.isStringLiteral(n.arguments[0])) {
      const c = n.arguments[0].text
      const at = `${rel(f)}:${sf.getLineAndCharacterOfPosition(n.getStart()).line + 1}`
      if (reg.has(c)) err(`通道 ${c} 注册了两次：${reg.get(c).at} 和 ${at}（Electron 会在第二次注册时抛错）`)
      else reg.set(c, { dom, at })
    }
    ts.forEachChild(n, v)
  }
  v(sf)
}

// ── 比对 ──
const protoDomains = [...proto.keys()].sort(), ipcDomains = [...ipc.keys()].sort()
if (protoDomains.join() !== ipcDomains.join()) err(`领域不一致：protocol/client 有 ${protoDomains.join(' ')}；transports/ipc 有 ${ipcDomains.join(' ')}`)
for (const d of protoDomains) if (!mainDomains.has(d)) err(`protocol/client/${d}.ts 在主进程没有对应的 apps/desktop/src/main/${d}/`)
for (const [d, { ns }] of proto) {
  const impl = ipc.get(d) ?? new Map()
  for (const [n, ms] of ns) {
    const im = impl.get(n)
    if (!im) { err(`${n}（protocol/client/${d}.ts）在 transports/ipc/${d}.ts 里没有实现${[...ipc].some(([, m]) => m.has(n)) ? '（写到别的领域文件里了）' : ''}`); continue }
    for (const m of ms) if (!im.has(m)) err(`${n}.${m} 在 transports/ipc/${d}.ts 里没有实现`)
    for (const m of im.keys()) if (!ms.includes(m)) err(`transports/ipc/${d}.ts 的 ${n}.${m} 在 AppClient 里没有声明`)
  }
  for (const n of impl.keys()) if (!ns.has(n)) err(`transports/ipc/${d}.ts 的命名空间 ${n} 不属于 protocol/client/${d}.ts`)
}
const used = new Set()
for (const [d, nsMap] of ipc) for (const [n, ms] of nsMap) for (const [m, chs] of ms) for (const c of chs) {
  used.add(c)
  const r = reg.get(c)
  if (!r) { err(`${n}.${m}（transports/ipc/${d}.ts）用的通道 ${c} 主进程没有注册`); continue }
  const nd = nsDomain.get(n)
  if (nd && r.dom !== nd) err(`${n}.${m} 的通道 ${c} 注册在 ${r.at}（${r.dom}），命名空间却在 protocol/client/${nd}.ts：两边领域要一致`)
}
for (const [c, r] of reg) if (!used.has(c) && r.dom !== '(root)') err(`通道 ${c}（${r.at}）没有 AppClient 方法用到：删掉，或在 protocol/client 和 transports/ipc 里补上`)
{
  const sf = parse(HTTP)
  const cls = sf.statements.find((s) => ts.isClassDeclaration(s))
  const have = new Set(cls?.members.map((m) => m.name?.getText(sf)).filter(Boolean))
  for (const n of nsDomain.keys()) if (!have.has(n)) err(`HttpTransport 缺命名空间 ${n}`)
  if (!have.has('on')) err('HttpTransport 缺 on')
}

// ── 清单文件 ──
const lists = {
  'client-methods.txt': methods.map(([k, chs]) => `${k} → ${chs.join(',')}`).sort(),
  'invoke-channels.txt': [...reg.keys()].sort(),
}
for (const [f, lines] of Object.entries(lists)) {
  const p = path.join(DOCS, f), want = lines.join('\n') + '\n'
  const have = fs.existsSync(p) ? fs.readFileSync(p, 'utf8').split('\r\n').join('\n') : ''
  if (WRITE) { if (have !== want) { fs.writeFileSync(p, want); console.log(`已更新 ${rel(p)}`) } }
  else if (have !== want) err(`${rel(p)} 和代码不一致：跑 node scripts/check-protocol.mjs --write 重新生成`)
}
// 运行时注册顺序快照（需要启动应用才能导出，只提示不报错）
const order = path.join(DOCS, 'invoke-channels-order.txt')
if (fs.existsSync(order)) {
  const o = new Set(fs.readFileSync(order, 'utf8').split(/\r?\n/).filter(Boolean))
  if (o.size !== reg.size || [...reg.keys()].some((c) => !o.has(c))) console.log(`提示：${rel(order)} 的通道集合已过期，需要时用 scripts/dump-ipc-order.mjs 从开发实例重新导出`)
}

const nsCount = [...proto.values()].reduce((a, p) => a + p.ns.size, 0)
console.log(`protocol: ${proto.size} 个领域，${nsCount} 个命名空间，${methods.length} 个方法；主进程注册 ${reg.size} 个通道（其中 ${[...reg.values()].filter((r) => r.dom === '(root)').length} 个在 index.ts 给 preload 直接用），${errors.length} 个问题`)
for (const e of errors) console.log(`  ${e}`)
process.exit(errors.length ? 1 : 0)
