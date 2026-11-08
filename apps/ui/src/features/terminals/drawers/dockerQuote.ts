// 容器 → 上下文 chip：chip 上只显示容器名，随消息发给 AI 的是面板里已经取到的全部事实（含容器 id）。
// 只拼「面板上真实显示过的东西」——不在这里额外跑 docker inspect/ps（那要授权、也会变慢）。
import { tr } from '@lingshell/shared'

/** 日志尾部最多带多少字符（整段日志可能几百 KB，全塞进消息里没意义） */
export const LOG_TAIL_CHARS = 6000

export interface DockerQuoteInput {
  /** 「本机」或「服务器 X 上」 */
  where: string
  name: string
  /** 容器 id（面板里有，排障时很有用） */
  id?: string
  /** 日志页拿不到镜像 / 状态时可以不传，文案里就不提这一行 */
  image?: string
  status?: string
  state?: string
  ports?: string
  created?: string
  stat?: { cpu: string; mem: string }
  logs?: string
}

/** chip 的名字 + 随消息发出去的全文 */
export interface ChipQuote { name: string; text: string }

/** 取日志尾部并标注截断（尾部才是出错的地方） */
export function tailLogs(text: string, limit = LOG_TAIL_CHARS): string {
  const t = text.trim()
  if (t.length <= limit) return t
  return tr('…（前面省略，只保留最后 {n} 字）', { n: limit }) + '\n' + t.slice(-limit)
}

/** 容器：chip 名 = 容器名 */
export function dockerChip(i: DockerQuoteInput): ChipQuote {
  const lines = [
    tr('【容器】'),
    tr('主机：{where}', { where: i.where }),
    tr('容器：{name}', { name: i.name }),
  ]
  if (i.id) lines.push(tr('容器 id：{id}', { id: i.id }))
  if (i.image) lines.push(tr('镜像：{image}', { image: i.image }))
  if (i.status) lines.push(tr('状态：{status}', { status: i.status }))
  if (i.state) lines.push(tr('状态码：{state}', { state: i.state }))
  if (i.ports) lines.push(tr('端口：{ports}', { ports: i.ports }))
  if (i.stat) lines.push(tr('资源：CPU {cpu} · 内存 {mem}', { cpu: i.stat.cpu, mem: i.stat.mem }))
  if (i.created) lines.push(tr('创建：{time}', { time: i.created }))
  if (i.logs && i.logs.trim()) {
    lines.push('', tr('最近日志（尾部）：'), '```', tailLogs(i.logs), '```')
  }
  lines.push('', tr('说明：这是容器面板里的信息，不是命令输出。'))
  return { name: i.name, text: lines.join('\n') }
}
