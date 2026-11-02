// 设置页标题：值是中文原文（= 翻译键，帮助 / 命令面板 / 仪表盘都用它），显示时 tr()
//
// 为什么单独一个文件：设置弹窗是低频面板（四十多行 import、十几个子面板），已改成懒加载。
// 而 TITLES 被命令面板等启动路径使用，若继续留在 SettingsModal.tsx 里，
// 那几个字符串就会把整个设置模块重新拖进首屏，懒加载等于白做。
import { tk } from '@lingshell/shared'

export type SettingsTab = 'model' | 'ssh' | 'terminal' | 'ai' | 'general' | 'templates' | 'runbooks' | 'schedules' | 'mcp' | 'keys' | 'network' | 'recordings' | 'about' | 'maintenance' | 'shortcuts' | 'skills' | 'secrets' | 'mobile' | 'compliance'

export const TITLES: Record<SettingsTab, string> = {
  model: tk('模型设置'), ssh: tk('主机与连接'), terminal: tk('终端'), ai: tk('AI 与安全'), general: tk('通用'),
  templates: tk('常用任务模板'), runbooks: tk('运维手册'), schedules: tk('定时巡检'), mcp: tk('MCP 服务'),
  keys: tk('SSH 密钥'), network: tk('网络代理'), recordings: tk('终端录像'), about: tk('关于'),
  maintenance: tk('备份与诊断'),
  shortcuts: tk('快捷键'),
  skills: 'Skills',
  secrets: tk('密钥保险箱'),
  mobile: tk('手机访问'),
  compliance: tk('合规基线'),
}
