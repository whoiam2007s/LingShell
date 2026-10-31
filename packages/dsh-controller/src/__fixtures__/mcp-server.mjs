// 测试用的极简 stdio MCP 服务（官方 SDK 低层 Server，不依赖 zod）。
// echo 原样回显收到的参数（测 explain 有没有被剥掉）；big 回超长文本；img 回图片；fail 回 isError。
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js'

const server = new Server({ name: 'fixture', version: '1.0.0' }, { capabilities: { tools: {} } })
const obj = (properties = {}, required = []) => ({ type: 'object', properties, required })

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    { name: 'echo', description: '回显参数', inputSchema: { $schema: 'http://json-schema.org/draft-07/schema#', ...obj({ text: { type: 'string' } }, ['text']) } },
    { name: 'big', description: '超长输出', inputSchema: obj() },
    { name: 'img', description: '返回图片', inputSchema: obj() },
    { name: 'fail', description: '总是失败', inputSchema: obj() },
  ],
}))

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params
  if (name === 'echo') return { content: [{ type: 'text', text: `echo:${JSON.stringify(args ?? {})}` }] }
  if (name === 'big') return { content: [{ type: 'text', text: 'x'.repeat(30_000) }] }
  if (name === 'img') return { content: [{ type: 'text', text: '截图如下' }, { type: 'image', mimeType: 'image/png', data: 'A'.repeat(2732) }] }
  if (name === 'fail') return { isError: true, content: [{ type: 'text', text: 'boom' }] }
  throw new Error(`unknown tool ${name}`)
})

await server.connect(new StdioServerTransport())
