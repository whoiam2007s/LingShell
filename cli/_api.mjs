// send.mjs / result.mjs 共用：读连接信息 + 发请求。
// 端口和 token 由 app 启动时写在 ~/.lingshell/config/api.json。
import { readFileSync } from 'node:fs'
import { request } from 'node:http'
import { homedir } from 'node:os'
import { join } from 'node:path'

export function loadConfig() {
  // 与应用同一套数据根目录规则（apps/desktop appContext：LINGSHELL_DATA_DIR 可覆盖）
  const file = join(process.env.LINGSHELL_DATA_DIR || join(homedir(), '.lingshell'), 'config', 'api.json')
  try { return JSON.parse(readFileSync(file, 'utf8')) }
  catch { console.error(`读不到 ${file}——LingShell 没在运行？`); process.exit(2) }
}

// 用 node:http 而不是 fetch：Node 内置 fetch(undici) 有 300s 的 headersTimeout，
// 而长轮询会挂几分钟一个字节都不发，用 fetch 会被客户端自己掐断。
export async function call(cfg, method, path, body) {
  const payload = body === undefined ? '' : JSON.stringify(body)
  const res = await new Promise((resolve, reject) => {
    const req = request({
      host: '127.0.0.1', port: cfg.port, path, method,
      headers: {
        authorization: `Bearer ${cfg.token}`,
        ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}),
      },
    }, (r) => {
      let b = ''
      r.setEncoding('utf8')
      r.on('data', (c) => { b += c })
      r.on('end', () => resolve({ status: r.statusCode, body: b }))
    })
    req.setTimeout(0)   // 显式关掉空闲超时：长轮询期间没有任何字节往返
    req.on('error', reject)
    req.end(payload)
  }).catch((e) => { console.error(`连不上 lingshell: ${e.message}`); process.exit(2) })

  let json
  try { json = JSON.parse(res.body) } catch { console.error(`响应不是 JSON: ${res.body}`); process.exit(1) }
  return { status: res.status, json }
}
