// 容器 → 对话：把容器面板里已经取到的事实拼成一段给人看的引用文本。
// 只拼「面板上真实显示过的东西」——不在这里额外跑 docker inspect/ps（那要授权、也会变慢）。
import { tr } from '@lingshell/shared'

/** 日志尾部最多带多少字符（整段日志可能几百 KB，全塞进输入框没意义） */
export const LOG_TAIL_CHARS = 6000

export interface DockerQuoteInput {
  /** 「本机」或「服务器 X 上」 */
  where: string
  name: string
  /** 日志页拿不到镜像 / 状态时可以不传，文案里就不提这一行 */
  image?: string
  status?: string
  state?: string
  ports?: string
  created?: string
  stat?: { cpu: string; mem: string }
  logs?: string
}

/** 取日志尾部并标注截断（尾部才是出错的地方） */
export function tailLogs(text: string, limit = LOG_TAIL_CHARS): string {
  const t = text.trim()
  if (t.length <= limit) return t
  return tr('…（前面省略，只保留最后 {n} 字）', { n: limit }) + '\n' + t.slice(-limit)
}

export function dockerQuote(i: DockerQuoteInput): string {
  const lines = [
    tr('容器「{name}」的状态看着不对，帮我判断原因和下一步该怎么查。', { name: i.name }),
    '',
    tr('（下面是我从「容器」面板复制的信息，不是命令输出）'),
    tr('主机：{where}', { where: i.where }),
    tr('容器：{name}', { name: i.name }),
  ]
  if (i.image) lines.push(tr('镜像：{image}', { image: i.image }))
  if (i.status) lines.push(tr('状态：{status}', { status: i.status }))
  if (i.state) lines.push(tr('状态码：{state}', { state: i.state }))
  if (i.ports) lines.push(tr('端口：{ports}', { ports: i.ports }))
  if (i.stat) lines.push(tr('资源：CPU {cpu} · 内存 {mem}', { cpu: i.stat.cpu, mem: i.stat.mem }))
  if (i.created) lines.push(tr('创建：{time}', { time: i.created }))
  if (i.logs && i.logs.trim()) {
    lines.push('', tr('最近日志（尾部）：'), '```', tailLogs(i.logs), '```')
  }
  lines.push('', tr('请按「最可能的原因 → 怎么验证 → 修复命令」回答，命令写成我复制就能跑的形式。'))
  return lines.join('\n')
}
