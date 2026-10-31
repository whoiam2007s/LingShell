// 冒烟：直接驱动真实的 DshController（不经 Electron），验证接线是通的。
// 要真实 API key，所以不放进 vitest；手动跑：
//   pnpm --filter @lingshell/dsh-controller build   # 先出 dist（src 里的 .js 扩展名裸 node 解析不了）
//   DEEPSEEK_API_KEY=sk-... node --experimental-strip-types packages/dsh-controller/smoke.ts
// 用假的 TerminalManager，所以不碰真终端；模型是真的，工具调用是真的，授权网关是真的。
import { DshController } from './dist/index.js'
import type { AgentEvent, SessionMeta } from '@lingshell/shared'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let failures = 0
const check = (ok: boolean, label: string) => { console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}`); if (!ok) failures++ }

const store = new Map<string, SessionMeta>()
const events: AgentEvent[] = []
const approvals: string[] = []
const ran: string[] = []
let level: 'none' | 'write' = 'none'

const ctrl = new DshController({
  baseDir: mkdtempSync(join(tmpdir(), 'dsh-smoke-')),
  terminals: {
    list: () => [{ id: 'term_1', title: '本地', type: 'local', status: 'running', locked: false }],
    readSnapshot: () => 'SNAP',
    execCapture: async (id, command) => { ran.push(command); return { output: `[${id}] $ ${command}\nOK`, exitCode: 0 } },
  },
  resolveHostKey: () => 'local',
  // 首次访问要弹卡；授权后放行 —— 与 AuthRegistry 同语义的最小实现
  decide: (_s, _h, needed) => (level === 'write' ? { kind: 'allow' } : { kind: 'prompt', reason: 'first_access', risk: 'safe' }),
  grant: () => { level = 'write' },
  audit: () => {},
  requestApproval: async (req) => { approvals.push(`${req.needed}:${req.command ?? ''}`); return 'allow' },
  resolveSettings: () => ({ provider: 'deepseek', model: 'deepseek-flash', apiKey: process.env.DEEPSEEK_API_KEY ?? '', baseUrl: '' }),
  sessionStore: {
    upsert: (m) => { store.set(m.id, m) },
    remove: (id) => { store.delete(id) },
    list: () => [...store.values()],
    touch: () => {},
  },
  contextLimitTokens: () => 600000,
  log: (lv, m, d) => { if (lv !== 'debug') console.log(`    [${lv}] ${m}`, d ? JSON.stringify(d).slice(0, 120) : '') },
})
ctrl.onEvent((e) => events.push(e))

console.log('\n— 建会话 —')
const s = await ctrl.createSession({ title: '冒烟' })
check(!!s.id, `会话已建：${s.id}`)
check(ctrl.listSessions().length === 1, '进程内会话表有它')

// sendTurn 发出即返回（不等整轮），上层靠事件推进 —— 这里照 UI 的真实用法等 turn 结束
const runTurn = (sid: string, text: string) => new Promise<void>((resolve, reject) => {
  const off = ctrl.onEvent((e) => {
    if (!('sessionId' in e) || e.sessionId !== sid) return
    if (e.type === 'agent:turnCompleted') { off(); resolve() }
    if (e.type === 'agent:turnFailed') { off(); reject(new Error(e.error)) }
  })
  setTimeout(() => { off(); reject(new Error('turn 超时')) }, 180_000)
  ctrl.sendTurn(sid, text).catch(reject)
})

console.log('\n— 跑一轮：模型须调 exec_in_terminal，且要先过授权卡 —')
await runTurn(s.id, '用 exec_in_terminal 在 term_1 上执行 `ls -la`，然后一句话告诉我退出码。')

check(approvals.length > 0, `授权卡被弹到我们这：${approvals.join(', ') || '(无)'}`)
check(ran.some((c) => c.includes('ls')), `终端真的执行了：${ran.join(' | ') || '(无)'}`)
check(events.some((e) => e.type === 'agent:turnStarted'), 'relay 发出了 turnStarted')
check(events.some((e) => e.type === 'agent:turnCompleted'), 'relay 发出了 turnCompleted')
check(events.some((e) => e.type === 'agent:itemStarted' && e.kind === 'tool_call'), 'relay 发出了 tool_call')
check(events.some((e) => e.type === 'agent:itemDelta' && e.kind === 'agent_message'), 'relay 发出了流式文本')

const text = events.filter((e) => e.type === 'agent:itemUpdated' && e.kind === 'agent_message').map((e: any) => e.text).join('\n')
check(text.length > 0, `模型最终回复：${text.slice(0, 60).replace(/\n/g, ' ')}…`)

console.log('\n— 会话生命周期 —')
ctrl.renameSession(s.id, '改名了')
check(store.get(s.id)?.title === '改名了', '重命名写回持久化')
await ctrl.closeSession(s.id)
check(ctrl.listSessions().length === 0, 'closeSession 后进程内表已清')
const back = await ctrl.reconnectSession(store.get(s.id)!)
check(back.id === s.id, 'reconnectSession 能把会话拉回来（jsonl 持久化托底）')
await ctrl.stopAll()

console.log(`\n${failures === 0 ? '✅ 控制器冒烟全通过' : `❌ ${failures} 项失败`}`)
process.exit(failures === 0 ? 0 : 1)
