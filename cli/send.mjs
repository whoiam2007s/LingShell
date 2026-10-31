#!/usr/bin/env node
// 往 LingShell「当前打开的会话」发一句话。立刻返回 taskId，不等任务跑完
// （任务可能十几分钟，而调用方那头有硬超时——Claude Code 的 Bash 最大 600s）。
//   node cli/send.mjs "帮我看下 nginx 日志有没有 5xx"
//   → taskId: a1b2c3d4e5f60718    然后用 result.mjs 取结果
// 退出码：0=已提交，1=服务端拒绝，2=调用方错误（app 没跑/参数缺）。
// 任务最长寿命经 LINGSHELL_TTL_MS 调（默认 30 分钟）。
import { loadConfig, call } from './_api.mjs'

const text = process.argv.slice(2).join(' ')
if (!text.trim()) { console.error('用法: node cli/send.mjs "要发送的文本"'); process.exit(2) }

const cfg = loadConfig()
const { status, json } = await call(cfg, 'POST', '/api/send', {
  text,
  ttlMs: Number(process.env.LINGSHELL_TTL_MS) || 1_800_000,
})

if (status !== 202) {
  console.error(`${status} ${json.error ?? ''}`)
  process.exit(1)
}
console.log(`taskId: ${json.taskId}`)
console.log(`取结果: node ${process.argv[1].replace(/send\.mjs$/, 'result.mjs')} ${json.taskId}`)
