// 「表格查看」的文件入口：选一个文件（本机，或当前那台 SSH 主机上的），读出来交给表格弹窗。
// 左边活动栏和终端区都用它，所以放在 table 这个 feature 里（lib 不许反向依赖 features）。
import { client } from '../../client/index.js'
import { getActiveTerminal } from '../../lib/activeTerminal.js'
import { openTableView } from './TableViewer.js'

const MAX_BYTES = 2_000_000

/** 选文件并按表格看；返回选中的路径（用户取消就是 undefined）。读失败会 reject，调用方负责提示 */
export async function pickAndOpenTable(): Promise<string | undefined> {
  const [p] = await client.attachments.pickFiles().catch(() => [])
  if (!p) return undefined
  const id = getActiveTerminal()?.id
  const term = id ? (await client.terminal.list().catch(() => [])).find((t) => t.id === id) : undefined
  const scope = term?.type === 'ssh' ? { terminalId: term.id } : 'local' as const
  const text = await client.fs.readText(scope, p)
  openTableView({ title: p.split(/[\\/]/).pop() || p, command: p, output: text.length > MAX_BYTES ? text.slice(0, MAX_BYTES) : text })
  return p
}
