#!/usr/bin/env node
// 取 send.mjs 提交的那个任务的结果。长轮询：任务没跑完就挂着等，到点返回 running，再调一次即可。
//   node cli/result.mjs a1b2c3d4e5f60718          等最多 240 秒
//   node cli/result.mjs a1b2c3d4e5f60718 60       等最多 60 秒
// stdout 是 AI 的最终回复。退出码：0=完成，1=失败/超时，2=调用方错误，3=还在跑（再调一次本命令）。
// 默认 240 秒是为了安全落在调用方的超时预算内（Claude Code 的 Bash 最大 600s）。
import { loadConfig, call } from './_api.mjs'

const taskId = process.argv[2]
if (!taskId) { console.error('用法: node cli/result.mjs <taskId> [等待秒数]'); process.exit(2) }
const waitMs = (Number(process.argv[3]) || 240) * 1000

const cfg = loadConfig()
const { status, json } = await call(cfg, 'GET', `/api/result?taskId=${encodeURIComponent(taskId)}&waitMs=${waitMs}`)

if (status !== 200) {
  console.error(`${status} ${json.error ?? ''}`)
  process.exit(status === 404 ? 2 : 1)
}
if (json.status === 'running') {
  console.error(`还在跑（已等 ${waitMs / 1000}s）——再调一次本命令继续等`)
  process.exit(3)
}
console.log(json.summary || '(本轮没有文本回复)')
if (json.status !== 'completed') {
  console.error(`status=${json.status}${json.error ? ` error=${json.error}` : ''}`)
  process.exit(1)
}
