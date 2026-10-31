#!/usr/bin/env node
// 从开着 --inspect 的开发实例主进程读出 invoke 通道的注册顺序，写到 scripts/structure/invoke-channels-order.txt。
// 只在改了主进程注册顺序（services.ts / ipc.ts / 各领域 register.ts 的先后）时需要，用来逐个比对；不收 Electron 自己注册的通道。
//
// 用法：先用 --inspect=<端口> 启动开发实例（electron-vite dev -- 或在 launch 脚本里加 --inspect 9229），然后
//       node scripts/dump-ipc-order.mjs [inspector 端口，缺省 9229] [--check]   --check：只比对不写
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const rel = (p) => path.relative(ROOT, p).split(path.sep).join('/')
const OUT = path.join(ROOT, 'scripts/structure/invoke-channels-order.txt')
const port = process.argv.slice(2).find((a) => /^\d+$/.test(a)) ?? '9229'
const CHECK = process.argv.includes('--check')
const list = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json(), () => null)
if (!list?.[0]) { console.error(`连不上 127.0.0.1:${port} 的 inspector：先用 --inspect=${port} 启动开发实例`); process.exit(1) }
const ws = new WebSocket(list[0].webSocketDebuggerUrl)
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j })
const res = await new Promise((r) => {
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id === 1) r(m) }
  ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { returnByValue: true, expression: "JSON.stringify([...process.mainModule.require('electron').ipcMain._invokeHandlers.keys()])" } }))
})
ws.close()   // 主进程退出时会等调试器断开，用完就断
const v = res.result?.result?.value
if (!v) { console.error('读不到 ipcMain._invokeHandlers：', JSON.stringify(res).slice(0, 300)); process.exit(1) }
const channels = JSON.parse(v).filter((c) => c.includes(':'))   // Electron 内部通道没有冒号
const text = channels.join('\n') + '\n'
const cur = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8').split('\r\n').join('\n') : ''
if (CHECK) {
  if (cur === text) { console.log(`注册顺序与 ${rel(OUT)} 一致（${channels.length} 个）`); process.exit(0) }
  const a = cur.trim().split('\n'), k = a.findIndex((c, i) => c !== channels[i])
  console.log(`注册顺序不同：第 ${k + 1} 个，文件里是 ${a[k]}，运行时是 ${channels[k]}`)
  process.exit(1)
}
fs.writeFileSync(OUT, text)
console.log(`已写 ${rel(OUT)}（${channels.length} 个通道）`)
