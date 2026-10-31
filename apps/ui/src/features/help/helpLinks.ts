// 帮助正文里的「入口」自动变成可点链接：不用逐句改文案，新章节写对按钮名就自动有链接。
// 两类：① 「设置 → 页名」（页名取设置弹窗真实标题）② 「功能名」（下面词表里有的按钮 / 功能）。纯函数，便于测试。
// 英文帮助（helpContent.en.ts）对应写法：Settings → 页名、"功能名"
import type { PaletteCmd } from '../../lib/paletteBus.js'
import type { SettingsTab } from '../settings/index.js'

export type HelpAction =
  | { kind: 'settings'; tab: SettingsTab }
  | { kind: 'palette'; cmd: PaletteCmd }             // 终端区动作（与命令面板同一通道）
  | { kind: 'drawer'; drawer: 'history' | 'auth' }   // 会话区抽屉
  | { kind: 'explorer' }                             // 有终端时开终端侧，否则开本地（同命令面板）
  | { kind: 'openPalette' }
  | { kind: 'usage' }                                // 用量统计弹窗（标题栏图标按钮）

export type HelpPiece = string | { text: string; action: HelpAction }

// 「…」/ "…" 里的功能名 → 动作（写帮助时按钮名要与界面一致，这里才对得上）。键是匹配正文用的原文，不显示，不走 tr()
const NAMED_LIST: [string[], HelpAction][] = [
  [['比对多台主机的文件', 'Compare files across hosts'], { kind: 'palette', cmd: { type: 'compareFiles' } }],   // i18n-ignore 匹配键
  [['比对多台主机的文件（只读）', 'Compare files across hosts (read-only)'], { kind: 'palette', cmd: { type: 'compareFiles' } }],   // i18n-ignore 匹配键
  [['批量执行', 'Batch run'], { kind: 'palette', cmd: { type: 'batchExec' } }],   // i18n-ignore 匹配键
  [['容器视图', 'Containers'], { kind: 'palette', cmd: { type: 'termDrawer', drawer: 'docker' } }],   // i18n-ignore 匹配键
  [['容器视图（Docker）', 'Containers (Docker)'], { kind: 'palette', cmd: { type: 'termDrawer', drawer: 'docker' } }],   // i18n-ignore 匹配键
  [['命令历史', 'Command history'], { kind: 'palette', cmd: { type: 'termDrawer', drawer: 'history' } }],   // i18n-ignore 匹配键
  [['服务（systemd）', 'Services (systemd)'], { kind: 'palette', cmd: { type: 'termDrawer', drawer: 'systemd' } }],   // i18n-ignore 匹配键
  [['新建 SSH 连接…', 'New SSH connection…'], { kind: 'palette', cmd: { type: 'newSsh' } }],   // i18n-ignore 匹配键
  [['本地终端', 'Local terminal'], { kind: 'palette', cmd: { type: 'newLocal' } }],   // i18n-ignore 匹配键
  [['资源管理器', 'Explorer'], { kind: 'explorer' }],   // i18n-ignore 匹配键
  [['执行记录', 'Execution log'], { kind: 'drawer', drawer: 'auth' }],   // i18n-ignore 匹配键
  [['会话授权', 'Session permissions'], { kind: 'drawer', drawer: 'auth' }],   // i18n-ignore 匹配键
  [['历史会话', 'Session history'], { kind: 'drawer', drawer: 'history' }],   // i18n-ignore 匹配键
  [['命令面板', 'Command palette'], { kind: 'openPalette' }],   // i18n-ignore 匹配键
  [['用量统计', 'Usage'], { kind: 'usage' }],   // i18n-ignore 匹配键
  [['主机体检', 'Host health check'], { kind: 'palette', cmd: { type: 'termDrawer', drawer: 'hostcheck' } }],   // i18n-ignore 匹配键
  [['定时任务', 'Scheduled tasks'], { kind: 'palette', cmd: { type: 'termDrawer', drawer: 'cron' } }],   // i18n-ignore 匹配键
  [['防火墙', 'Firewall'], { kind: 'palette', cmd: { type: 'termDrawer', drawer: 'firewall' } }],   // i18n-ignore 匹配键
  [['服务拓扑', 'Service topology'], { kind: 'palette', cmd: { type: 'termDrawer', drawer: 'topology' } }],   // i18n-ignore 匹配键
  [['多主机日志', 'Multi-host logs'], { kind: 'palette', cmd: { type: 'multiLog', mode: 'follow' } }],   // i18n-ignore 匹配键
  [['日志历史检索', 'Log history search'], { kind: 'palette', cmd: { type: 'multiLog', mode: 'search' } }],   // i18n-ignore 匹配键
  [['连通性探测', 'Connectivity probe'], { kind: 'palette', cmd: { type: 'connProbe' } }],   // i18n-ignore 匹配键
  [['数据库快查', 'Database quick query'], { kind: 'palette', cmd: { type: 'termDrawer', drawer: 'database' } }],   // i18n-ignore 匹配键
  [['Kubernetes 视图', 'Kubernetes view'], { kind: 'palette', cmd: { type: 'termDrawer', drawer: 'k8s' } }],   // i18n-ignore 匹配键
]
const NAMED: Record<string, HelpAction> = Object.fromEntries(NAMED_LIST.flatMap(([names, a]) => names.map((n) => [n, a])))

const SETTINGS_ARROW = /^(?:设置|Settings)\s*→\s*/   // i18n-ignore 匹配正文
const QUOTES: Record<string, string> = { '「': '」', '"': '"' }   // i18n-ignore 匹配正文的引号

/** 把一段（不含代码样式的）文字切成普通文本和链接。titles = 设置页 tab → 标题（可给多个别名，如英文界面的译名 + 帮助里的写法） */
export function linkify(text: string, titles: Record<SettingsTab, string | string[]>): HelpPiece[] {
  const byTitle = (Object.entries(titles) as [SettingsTab, string | string[]][])
    .flatMap(([tab, t]) => (Array.isArray(t) ? t : [t]).map((x): [SettingsTab, string] => [tab, x]))
    .sort((a, b) => b[1].length - a[1].length)
  const out: HelpPiece[] = []
  let buf = '', i = 0
  const flush = () => { if (buf) { out.push(buf); buf = '' } }
  while (i < text.length) {
    const rest = text.slice(i)
    // ① 设置 → 页名（「设置 → AI 与安全 → 应用锁」只链到页名，后面照常显示）
    const m = SETTINGS_ARROW.exec(rest)
    if (m) {
      const after = rest.slice(m[0].length)
      const hit = byTitle.find(([, t]) => after.startsWith(t))
      if (hit) { flush(); out.push({ text: m[0] + hit[1], action: { kind: 'settings', tab: hit[0] } }); i += m[0].length + hit[1].length; continue }
    }
    // ② 「功能名」/ "功能名"：词表里的功能，或恰好是某个设置页标题
    const close = QUOTES[rest[0]]
    if (close) {
      const end = rest.indexOf(close, 1)
      const name = end > 0 ? rest.slice(1, end) : ''
      const action = NAMED[name] ?? (() => { const t = byTitle.find(([, x]) => x === name); return t && ({ kind: 'settings', tab: t[0] } as HelpAction) })()
      if (action) { flush(); out.push({ text: rest.slice(0, end + 1), action }); i += end + 1; continue }
    }
    buf += text[i++]
  }
  flush()
  return out
}
