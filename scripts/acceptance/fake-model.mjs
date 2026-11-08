// 真机验收用的假模型服务（OpenAI 兼容，只要流式 /chat/completions）。
//
// 为什么需要它：验收要跑真安装包，但不能拿真 API key 去烧钱，也不能指望真模型每次都按剧本调工具。
// 这里按用户消息里的标签回工具调用，让真应用的 agent 走出完整链路：
//   [[write:<路径>]]   → 先调 list_terminals 拿到终端 id，再调 write_file（内容取自 CONTENT）
//   [[exec:<命令>]]    → 先调 list_terminals，再调 exec_in_terminal
// 拒绝 / 放行由应用侧的授权卡决定，不归模型管。
//
// 启动：node scripts/acceptance/fake-model.mjs [端口]
// 端点：GET /v1/models（应用会探测）、POST /v1/chat/completions（SSE）
import { createServer } from 'node:http'

const PORT = Number(process.argv[2] || process.env.PORT || 8787)
const CONTENT = 'hello from acceptance'

const tagOf = (msgs) => {
  // 找最后一条带标签的用户消息
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i]
    if (m.role !== 'user') continue
    const text = typeof m.content === 'string' ? m.content : JSON.stringify(m.content)
    const hit = /\[\[(write|exec):([^[\]]+?)\]\]/.exec(text)
    if (hit) return { at: i, kind: hit[1], arg: hit[2] }
  }
  return null
}

const toolNames = (msgs) => {
  const out = []
  for (const m of msgs) {
    const calls = m.tool_calls ?? m.toolCalls ?? []
    for (const c of calls) out.push(c.function?.name ?? c.name)
  }
  return out
}

const terminalIdOf = (msgs) => {
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].role !== 'tool') continue
    const raw = typeof msgs[i].content === 'string' ? msgs[i].content : JSON.stringify(msgs[i].content)
    try {
      const parsed = JSON.parse(raw)
      const arr = Array.isArray(parsed) ? parsed : parsed.terminals ?? parsed.result ?? []
      const list = Array.isArray(arr) ? arr : []
      const local = list.find((t) => t?.type === 'local') ?? list[0]
      if (local?.id) return String(local.id)
    } catch {
      const m = /"id"\s*:\s*"([^"]+)"/.exec(raw)
      if (m) return m[1]
    }
  }
  return null
}

const server = createServer((req, res) => {
  if (req.method === 'GET' && req.url?.startsWith('/v1/models')) {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ object: 'list', data: [{ id: 'fake-model', object: 'model', owned_by: 'acceptance' }] }))
    return
  }
  if (req.method !== 'POST' || !req.url?.includes('/chat/completions')) {
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end('{"error":"not found"}')
    return
  }
  let raw = ''
  req.on('data', (c) => { raw += c })
  req.on('end', () => {
    let body = {}
    try { body = JSON.parse(raw || '{}') } catch { /* 空 body 也照常回话 */ }
    const msgs = body.messages ?? []
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
    const chunk = (delta, finish = null) => res.write(`data: ${JSON.stringify({
      id: 'acc-1', object: 'chat.completion.chunk', created: 1, model: body.model ?? 'fake-model',
      choices: [{ index: 0, delta, finish_reason: finish }],
    })}\n\n`)
    const callTool = (name, args) => {
      chunk({ role: 'assistant', content: null, tool_calls: [{ index: 0, id: `call_${Date.now()}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] })
      chunk({}, 'tool_calls')
      res.end('data: [DONE]\n\n')
    }
    const say = (text) => {
      chunk({ role: 'assistant', content: text })
      chunk({}, 'stop')
      res.end('data: [DONE]\n\n')
    }

    const tag = tagOf(msgs)
    if (!tag) return say('好的。')
    const after = msgs.slice(tag.at + 1)
    const done = toolNames(after)
    // 这个标签对应的目标工具已经调过 → 收尾
    if (done.includes('write_file') || done.includes('exec_in_terminal')) return say('好了')

    // 还不知道终端 id → 先列终端
    const tid = terminalIdOf(after)
    if (!tid) return callTool('list_terminals', {})

    if (tag.kind === 'write') return callTool('write_file', { terminal_id: tid, path: tag.arg, content: CONTENT })
    return callTool('exec_in_terminal', { terminal_id: tid, command: tag.arg, explain: '验收', rollback: 'true', rollback_note: '验收脚本，无实际变更' })
  })
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[fake-model] listening on http://127.0.0.1:${PORT}/v1`)
})
