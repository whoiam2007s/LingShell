import { DEFAULT_HIGHLIGHT_RULES } from '../terminal/highlight.js'
import type { HighlightRule } from '../terminal/index.js'
import type { TermEncoding } from '../terminal/index.js'
import { tk } from '../i18n/i18n.js'

export type TerminalType = 'local' | 'ssh'
export type TerminalStatus = 'running' | 'disconnected'
export type AuthLevel = 'none' | 'read' | 'write'
// 终端所在系统：本地按 process.platform（win32 本地终端一律 Git Bash）；SSH 连上后静默 uname -s 探测
export type TermOs = 'linux' | 'macos' | 'windows' | 'unknown'

export const osFromPlatform = (p: string): TermOs => p === 'win32' ? 'windows' : p === 'darwin' ? 'macos' : p === 'linux' ? 'linux' : 'unknown'
/** uname -s 输出 → 系统（取最后一个非空行；BSD 等其它一律 unknown） */
export function osFromUname(out: string): TermOs {
  const s = out.trim().split(/\r?\n/).pop()?.trim() ?? ''
  return s === 'Linux' ? 'linux' : s === 'Darwin' ? 'macos' : /^(MINGW|MSYS|CYGWIN)/.test(s) ? 'windows' : 'unknown'
}
// 显示名；unknown → ''
export const osLabel = (os?: TermOs): string => ({ linux: 'Linux', macos: 'macOS', windows: 'Windows · Git Bash', unknown: '' })[os ?? 'unknown']

export interface TerminalInfo {
  id: string
  title: string             // 标签显示名（SSH 用用户起的 label）
  detail?: string           // 副标题/hover 详情（SSH 的 user@host:port）
  type: TerminalType
  status: TerminalStatus
  locked: boolean
  env?: HostEnv             // 来自已保存主机的分级（主进程建终端时补上），UI 显示「生产」徽标
  encoding?: TermEncoding   // 非 UTF-8 时标签显示编码徽标
  hostId?: string           // 已保存主机的 SSH 终端（terminal:list 补上，渲染页重载后接管终端时恢复布局持久化用）
  os?: TermOs               // 快速命令按系统选版本、AI 终端清单标注
  tmux?: string             // 跑在远端 tmux 会话里（断线保持，见 tmux.ts）：会话名，随布局持久化以便重启接回
  notice?: string           // 建连时的一次性提示（如「服务器未安装 tmux，已用普通会话」）
  shell?: string            // 本地终端的非默认 shell（见 localShell.ts）：powershell / cmd / wsl:<发行版>；缺省 = Git Bash
  manualOnly?: boolean      // 仅手动：AI 不能在此终端执行命令（PowerShell / cmd，或哨兵探测没通过的 WSL）
}

export interface SessionInfo {
  id: string
  title: string
  createdAt: string
}

// ── 设置相关 ──────────────────────────────────────────────

// 支持的 provider。deepseek 走官方适配器（每套模型配置一个实例）；其余都是 OpenAI 兼容端点，
// 走 dsh-llm-pi-ai 的 openai-completions 协议（路由换算见 dsh-controller/providers.ts）。
export type ProviderId = 'deepseek' | 'qwen' | 'moonshot' | 'ollama' | 'openai-compatible'

export interface ModelOption {
  id: string        // 传给引擎的模型 id
  label: string     // UI 显示名
  contextWindow?: number   // 上下文窗口（tokens）；缺省用 provider 的 defaultContextWindow
}

export interface ProviderMeta {
  id: ProviderId
  label: string
  defaultBaseUrl: string
  models: ModelOption[]
  needsApiKey: boolean   // 本地 provider（ollama/vllm）可能不需要 key
  freeModel?: boolean    // 模型可自由填写（兼容端点/本地模型名五花八门），models 只作建议
  defaultContextWindow: number
}

// 各 provider 元数据。窗口取官方文档常见值，不准时用户可在设置里覆盖「上下文窗口」
export const PROVIDERS: ProviderMeta[] = [
  {
    id: 'deepseek',
    label: 'DeepSeek',
    defaultBaseUrl: 'https://api.deepseek.com',
    needsApiKey: true,
    defaultContextWindow: 1_000_000,
    models: [
      { id: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro' },
      // 2026-10-17 起该 id 即 V4.1-Flash-1017（官方原地升级，id 与价格不变）；支持图片
      { id: 'deepseek-flash', label: 'DeepSeek V4.1 Flash' },
    ],
  },
  {
    id: 'qwen',
    label: tk('通义千问（DashScope）'),
    defaultBaseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    needsApiKey: true,
    defaultContextWindow: 131_072,
    models: [
      { id: 'qwen-max', label: 'Qwen Max', contextWindow: 32_768 },
      { id: 'qwen-plus', label: 'Qwen Plus', contextWindow: 131_072 },
      { id: 'qwen-turbo', label: 'Qwen Turbo', contextWindow: 1_000_000 },
    ],
  },
  {
    id: 'moonshot',
    label: tk('Kimi（Moonshot）'),
    defaultBaseUrl: 'https://api.moonshot.cn/v1',
    needsApiKey: true,
    defaultContextWindow: 131_072,
    models: [
      { id: 'kimi-k2-0905-preview', label: 'Kimi K2', contextWindow: 262_144 },
      { id: 'kimi-k2-turbo-preview', label: 'Kimi K2 Turbo', contextWindow: 262_144 },
      { id: 'moonshot-v1-128k', label: 'Moonshot v1 128K', contextWindow: 131_072 },
    ],
  },
  {
    id: 'ollama',
    label: tk('Ollama（本地）'),
    defaultBaseUrl: 'http://127.0.0.1:11434/v1',
    needsApiKey: false,
    freeModel: true,
    defaultContextWindow: 32_768,
    models: [{ id: 'qwen3:8b', label: 'qwen3:8b' }],
  },
  {
    id: 'openai-compatible',
    label: tk('OpenAI 兼容端点'),
    defaultBaseUrl: 'https://api.openai.com/v1',
    needsApiKey: true,
    freeModel: true,
    defaultContextWindow: 131_072,
    models: [{ id: 'gpt-4o', label: 'gpt-4o' }],
  },
]

export const providerMeta = (id: string): ProviderMeta => PROVIDERS.find((p) => p.id === id) ?? PROVIDERS[0]

// 模型上下文窗口：用户覆盖 > 预置模型值 > provider 默认值。压缩阈值按它换算
export function contextWindowOf(provider: string, model: string, override?: number): number {
  if (override && override > 0) return override
  const p = providerMeta(provider)
  return p.models.find((m) => m.id === model)?.contextWindow ?? p.defaultContextWindow
}

// 系统级配置（阶段三）：命令历史上限/命令执行超时/上传加密默认值/会话进程池上限
export interface SystemSettings {
  historyLimit: number      // 每主机历史命令上限（10–1000）
  execTimeoutSec: number    // 命令执行超时秒（10–300）
  uploadEncrypt: boolean    // 上传默认开启加密
  // 自动压缩阈值（tokens）：上下文超过即由 dsh 把较早历史摘要成检查点，任务不中断。0=不自动压缩。
  // 按当前模型上下文窗口换算成比例交给压缩插件（超过窗口夹到 95%）；默认 60 万。
  contextLimitTokens: number
  // 会话执行到这么多步、且已压缩过时，弹窗建议用压缩摘要开新会话（只是建议，可忽略）
  contextResetSteps: number
  // 危险命令（rm -rf / mkfs / curl|bash …）即便已有 write 授权也逐次确认。关掉=只认 write 授权。
  confirmDangerous: boolean
  // 发给 AI 前脱敏：工具结果（命令输出/文件内容/终端快照/MCP 结果）里的已知机密与密钥样式换成 [已脱敏]。默认开
  aiRedact: boolean
  // 全局自定义规则：注入每个会话的系统提示词（下一次模型请求即生效）
  customRules: string
  // 本机备注：与 SSH 主机备注同义，AI 操作本地终端时可见
  localNotes: string
  terminalFontSize: number          // 终端字号（10–24）
  terminalTheme: TerminalThemeId    // 终端配色
  // 允许终端录屏（审计）：开启后用户可在终端上手动开始/停止录制（asciicast 存 ~/.lingshell/recordings）。录制期间记下键入的一切（含密码），默认关
  terminalRecording: boolean
  recordingRetentionDays: number    // 录像保留天数，启动时删更早的日期目录；0=不清理
  // 终端关键字高亮（仅显示层着色，不影响录屏/AI 读取的输出）
  terminalHighlight: boolean
  highlightRules: HighlightRule[]
  // 自动记录会话日志：每个终端的输出存纯文本 .log（只记输出不记键入，不回显的密码不会进日志），默认关
  sessionLog: boolean
  sessionLogDir: string             // 日志目录，空=默认 <数据目录>/logs/sessions
  sessionLogRetentionDays: number   // 保留天数，启动时及每天删更早的日期目录；0=不清理
  sessionLogTimestamps: boolean     // 每行加 [HH:mm:ss]
  // 应用锁空闲自动锁定（分钟，按系统空闲时间算）；0 = 只在启动/手动/系统锁屏时锁。启用与否看是否设了主密码（lock.json）
  lockIdleMinutes: number
  // SSH 意外断线后按退避自动重连（远端 exit / 关标签不重连）。默认关：避免网络抖动后悄悄连回生产机
  sshAutoReconnect: boolean
  // 主机状态采集（CPU/内存/磁盘/负载）：只采当前可见的终端，SSH 走独立 exec channel 跑固定只读命令。默认关
  hostStats: boolean
  hostStatsIntervalSec: number      // 采集间隔（5–300 秒）
  hostStatsProd: boolean            // 生产主机也采集（间隔 ×3）；默认不采
  // 终端外观：字体（空 = 内置等宽字体栈）/ 行距 / 光标样式与闪烁 / 回滚行数（改了即时生效）
  terminalFontFamily: string
  terminalLineHeight: number        // 1.0–2.0
  terminalCursorStyle: TerminalCursorStyle
  terminalCursorBlink: boolean
  terminalScrollback: number        // 500–100000
  // 长命令完成通知：用户命令（OSC 133）耗时超过这么多秒、且窗口不在前台或标签不可见时发系统通知；0 = 关
  terminalNotifySec: number
  // 资源管理器「用本地编辑器打开」远程文件用的编辑器：空 = 系统默认程序；可填命令（code）或程序路径（Notepad++）
  externalEditor: string
  transferConcurrency: number       // 传输队列同时进行的任务数（1–5），其余排队
  transferLimitKBps?: number        // 传输限速（每个任务，KB/s）；0 / 缺省 = 不限。改了对进行中的任务即时生效
  // 命令自动补全：在 shell 提示符键入时弹候选（本主机历史 + 快速命令 + 常用片段）。默认关
  terminalAutoComplete: boolean
  // 粘贴安全检查：任何终端粘贴含危险命令或隐藏 / 控制字符时先确认（生产终端多行粘贴确认不受此开关影响）。默认开
  terminalPasteCheck: boolean
  // 终端响铃（\a）提示：off 关 / badge 仅后台标签角标 / notify 角标 + 窗口不在前台时系统通知
  terminalBell: 'off' | 'badge' | 'notify'
  // 作为 ssh:// 链接的打开方式（打包版注册系统协议；点链接 → 确认后连接 / 预填新建连接）。默认关（开了会替换系统里原有的 ssh:// 打开程序，如 PuTTY）
  sshUrlHandler: boolean
  // 用户手动指定的 Git Bash（bash.exe 完整路径，仅 Windows）：空 = 自动探测（见 terminal-core/gitBash.ts）
  bashPath: string
  // 快捷键自定义：只存改过的项（动作 id → 按键串，null = 未设置），默认值见 keybindings.ts 的 KEY_ACTIONS
  keybindings: Record<string, string | null>
  // 用户在终端敲的命令失败（成败标记为红）时，终端底部出「让 AI 排查」横幅。缺省开
  terminalFailHint?: boolean
  // AI 一轮跑完 / 出错且窗口不在前台时发系统通知（用户主动停止的不发）。缺省开
  aiDoneNotify?: boolean
  // 命令放行 / 询问 / 禁止规则（AI 执行终端命令时先按它判定，先匹配先生效），见 commandRules.ts
  commandRules: import('../ai/index.js').CommandRule[]
  // AI 一轮里第一次对某台 Linux SSH 主机做改动前后各拍一次轻量快照，回合末显示「本轮主机变化」（见 hostProfile.ts）。缺省开
  aiChangeSnapshot?: boolean
  // 界面外观（设置 → 通用 → 外观）：主题 / 界面缩放（0.8–1.5，见 appearance.ts 的 UI_ZOOMS）/ 图标大小
  uiTheme?: import('../ui/index.js').UiTheme
  // 主题选「跟随系统」时：系统为深色用哪套（只能是深色类主题）/ 系统为浅色用哪套
  uiThemeDark?: import('../ui/index.js').ThemeId
  uiThemeLight?: import('../ui/index.js').ThemeId
  uiZoom?: number
  iconSize?: import('../ui/index.js').IconSize
  // 即时回放：每个终端在内存里保留最近这么多 MB 输出（0 = 关，见 replay.ts）。缺省 4
  terminalReplayMB?: number
  // 连按两下 Alt 呼出（Quake 模式，仅 Windows，见 desktop/main/app/globalHotkey.ts）。缺省关
  globalHotkey?: boolean
  // AI 预测下一条命令：停在空提示符 800ms 后按最近命令（非生产主机再带最后一条输出尾部）问一次模型，灰色幽灵字显示，→ 接受。缺省关
  terminalPredict?: boolean
  // AI 复核（设置 → AI 与安全）：高风险命令弹授权卡前先让第二个模型审查，见 safety.ts。缺省关
  aiReview?: import('../ai/index.js').AiReviewSettings
  // 界面语言（设置 → 通用 → 外观）：auto = 跟随系统。改了要重启应用（见 i18n.ts）。缺省 auto
  language?: import('../i18n/index.js').UiLanguage
  // 终端里点「文件:行号」用外部编辑器跳到该行的参数模板（{file} {line} {col}）：空 = 按编辑器自动（code -g 等，见 fileLinks.ts）
  editorGotoArgs?: string
}
// auto = 跟随界面主题（见 appearance.ts 的 resolveTerminalTheme）
export type TerminalThemeId = 'auto' | 'dark' | 'light' | 'solarized-dark' | 'dracula' | 'one-dark' | 'monokai' | 'github-light'
  | 'tokyo-night' | 'nord' | 'solarized-light' | 'high-contrast' | 'rose-pine'
export type TerminalCursorStyle = 'block' | 'underline' | 'bar'
export const DEFAULT_SYSTEM_SETTINGS: SystemSettings = {
  historyLimit: 200, execTimeoutSec: 50, uploadEncrypt: true,
  contextLimitTokens: 600000, contextResetSteps: 100, confirmDangerous: true, aiRedact: true,
  customRules: '', localNotes: '',
  terminalFontSize: 13, terminalTheme: 'auto',
  terminalRecording: false, recordingRetentionDays: 30,
  terminalHighlight: true, highlightRules: DEFAULT_HIGHLIGHT_RULES,
  sessionLog: false, sessionLogDir: '', sessionLogRetentionDays: 30, sessionLogTimestamps: false,
  lockIdleMinutes: 10,
  sshAutoReconnect: false,
  hostStats: false, hostStatsIntervalSec: 10, hostStatsProd: false,
  terminalFontFamily: '', terminalLineHeight: 1.3, terminalCursorStyle: 'block', terminalCursorBlink: true, terminalScrollback: 5000,
  terminalNotifySec: 30,
  externalEditor: '',
  transferConcurrency: 2,
  terminalAutoComplete: false,
  terminalPasteCheck: true,
  terminalBell: 'notify',
  sshUrlHandler: false,
  bashPath: '',
  keybindings: {},
  commandRules: [],
  uiTheme: 'dark', uiThemeDark: 'dark', uiThemeLight: 'light', uiZoom: 1, iconSize: 'small',
}

// 用户设置。apiKey 在主进程经 safeStorage 加密存储，跨 IPC 传输时仅在保存方向出现。
export interface AppSettings {
  provider: ProviderId
  model: string
  baseUrl: string
  // 读取时 apiKey 不回传明文，用 hasApiKey 标记是否已配置（避免明文经 IPC 暴露给渲染层）
  apiKey?: string           // 保存时写入当前 provider 的 key 槽（各 provider 分开存，切换不串用）
  hasApiKey?: boolean       // 当前 provider 是否已配 key
  keyedProviders?: ProviderId[]   // 已配 key 的 provider（UI 切换 provider 时显示状态）
  contextWindow?: number    // 上下文窗口覆盖（tokens）；0/缺省 = 按 provider/模型自动
  system?: SystemSettings   // 系统级配置（阶段三）
  // 多模型配置（读取时总有值：老配置自动迁移成「默认」）。上面 provider/model/baseUrl/contextWindow 是默认配置的镜像，
  // 保存时只要带了 modelProfiles 就以它为准（整表替换），没带则保留已存的配置
  modelProfiles?: ModelProfile[]
  defaultProfileId?: string // 新会话 / 一次性调用（自然语言写命令等）用的配置
}

// 一套模型配置。apiKey 只在保存方向出现（有值 = 替换，空 = 保留已存的）；读取时只回 hasApiKey
export interface ModelProfile {
  id: string                // 小写字母数字下划线（引擎路由名 / key 环境变量由它派生）
  name: string
  provider: ProviderId
  model: string
  baseUrl: string
  contextWindow?: number    // 0/缺省 = 按模型自动
  apiKey?: string
  hasApiKey?: boolean
  keyFrom?: string          // 仅保存 / 测试方向：「复制」出的新配置沿用这套已存的 key（同提供商才生效）
  // 接口协议：仅 DeepSeek 可选（缺省 = anthropic），其它提供商固定 openai。按 protocolOf 解读，别直接读
  protocol?: ModelProtocol
  // 支持图片（多模态）：开了才能在对话里附图片。缺省按模型名猜（multimodalDefault）；读取时总有值
  multimodal?: boolean
}
export const MODEL_PROFILE_ID_RE = /^[a-z0-9_]{1,40}$/
// 测试连接的结果：ok=false 时 error 是给人看的原因；warning = 连上了但有需要注意的地方（如模型列表里没有该模型）
// protocolMismatch = 疑似端点不支持所选协议（404/405/格式不对），界面据此给「改用 OpenAI 兼容并重试」
export interface ModelTestResult { ok: boolean; error?: string; warning?: string; ms?: number; protocolMismatch?: boolean }

export const DEFAULT_SETTINGS: AppSettings = {
  provider: 'deepseek',
  model: 'deepseek-v4-pro',
  baseUrl: 'https://api.deepseek.com',
  system: DEFAULT_SYSTEM_SETTINGS,
}

// ── Phase 3：授权 ────────────────────────────────────────
export type TrustLevel = 'autonomous' | 'confirm' | 'readonly'   // 全自主/确认/只读
export type RiskLevel = 'safe' | 'dangerous'
export type PromptReason = 'first_access' | 'elevation' | 'dangerous_command'

// 用户在授权卡上的回答。note：拒绝时告诉 AI 为什么；command：允许前改过的命令（仅 exec_in_terminal）；
// steps：计划卡批准时用户删改后的步骤（仅 propose_plan）
// sudoMinutes：允许时顺带「本主机 N 分钟内允许提权」（需要 root 的命令，见 safety.ts）
export interface ApprovalAnswer { decision: 'allow' | 'deny'; note?: string; command?: string; steps?: PlanStep[]; sudoMinutes?: number }

// 计划模式：propose_plan 的一步。批准后同主机逐字相同的命令免逐条授权（每步一次，本轮有效）
// path 有值 = 这步是 write_file 写该文件（command 只作展示）；否则是 exec_in_terminal 执行 command
export interface PlanStep { terminal_id: string; command: string; purpose?: string; path?: string }
// 计划卡展示用：附主机标识与危险标记（危险步骤卡上标红）
export interface PlanStepView extends PlanStep { hostKey: string; dangerous: boolean }

export type AuthDecision =
  | { kind: 'allow' }
  | { kind: 'prompt'; reason: PromptReason; risk: RiskLevel }
  | { kind: 'deny'; reason: string }

export interface AuthRecord {
  sessionId: string
  terminalId: string
  level: AuthLevel      // none/read/write 已在本文件定义
}

// ── Phase 2：SSH + 主机管理 ──────────────────────────────
// agent = 用系统 ssh-agent / Pageant 里的密钥，不存任何凭据
export type AuthType = 'password' | 'key' | 'agent'
// 检测到的系统 agent。path 直接作 ssh2 的 agent 参数（Windows 命名管道 / unix socket）
export interface SshAgentInfo { kind: 'openssh' | 'pageant' | 'sock'; path: string; label: string }
// 主机分级：prod=生产（写操作逐条确认、危险命令强制确认）；test=测试；缺省=未标注
export type HostEnv = 'prod' | 'test'

// 建立 SSH 连接的参数（主进程内部用；含明文凭据，不回传渲染层）
export interface SshConnectOpts {
  host: string
  port: number
  username: string
  password?: string
  privateKey?: string
  passphrase?: string
  agent?: string             // authType=agent：已解析的系统 agent 路径（见 SshAgentInfo.path）
  readyTimeoutMs?: number
  label?: string             // 主机显示名（错误信息标明哪一跳失败）
  jump?: SshConnectOpts      // 跳板机连接参数（递归：跳板自身也可再经跳板，深度由 HostStore 限制）
  // 无人值守（定时巡检）：首次见到的主机指纹不弹确认，直接 host_key_unknown 失败。作用于整条跳板链
  noHostKeyPrompt?: boolean
  encoding?: TermEncoding    // 终端字节流编码，默认 utf8
  keepaliveSec?: number      // SSH 心跳间隔秒，0 = 关；缺省用调用方默认（终端/转发 15s）
  compress?: boolean         // 协商 zlib 压缩（慢链路有用）
  agentForward?: boolean     // 交互通道请求 agent 转发（需 agent 有值）
  loginCommands?: string     // 登录后自动执行（多行），仅交互终端用
  proxy?: ProxyOpts          // 出站代理（只作用于这一跳的 TCP；有跳板时由跳板那一跳自己的 proxy 决定）
  termType?: string          // 交互终端的 $TERM（pty-req），缺省 xterm-256color
  proxyCommand?: string      // 本地代理命令（同 OpenSSH ProxyCommand，%h %p %r 替换）：子进程的 stdin/stdout 作这一跳的连接。与跳板/出站代理互斥
}

// ── SSH 主机指纹（TOFU，同 OpenSSH known_hosts）──────────
// hostPort：小写 host + ':' + port；fingerprint：OpenSSH 风格 'SHA256:<base64 无填充>'
export interface KnownHost { hostPort: string; keyType: string; fingerprint: string; firstSeen: string }
// 首次连接待确认 / 指纹不符时给 UI 的信息
export interface HostKeyInfo {
  hostPort: string
  label: string              // 该跳显示名
  role: '跳板机' | '目标主机'
  keyType: string
  fingerprint: string        // 本次服务器给出的指纹
  expected?: string          // 指纹不符时：已记录的指纹
}

// 渲染层填写的新连接表单（明文，单向 → 主进程建连/保存）
export interface SshConnectInput {
  host: string
  port: number
  username: string
  authType: AuthType
  password?: string
  privateKey?: string
  passphrase?: string
  jumpHostId?: string        // 经哪台已存主机跳转（ProxyJump）
  encoding?: TermEncoding
  proxy?: 'none' | 'default' | ProxyInput   // 测试连接用表单里的代理；缺省 / 'default' = 全局默认代理
  keyId?: string             // authType=key：用应用密钥（主进程取私钥），此时 privateKey 不填
  credentialId?: string      // 使用凭据：用户名/认证由主进程按凭据解析，表单里的用户名/认证不用
  proxyCommand?: string      // 测试连接用表单里的 ProxyCommand（主机管理页「高级」）
}

// 主机配置（磁盘存储，凭据字段为密文）。仅 config 包内部用。
export interface HostConfig {
  id: string
  label: string
  host: string
  port: number
  username: string
  authType: AuthType
  passwordCipher?: string
  privateKeyCipher?: string
  passphraseCipher?: string
  jumpHostId?: string        // 跳板机：另一台已存主机的 id
  encoding?: TermEncoding    // 缺省 = utf8
  notes?: string
  env?: HostEnv
  group?: string
  persistSession?: boolean   // 断线后保持会话：交互 shell 跑在远端 tmux 里（缺省关）
  loginCommands?: string     // 登录后自动执行的命令（多行，逐行发到交互终端）
  agentForward?: boolean     // SSH agent 转发（缺省关：服务器 root 能借用本机 agent 签名）
  advanced?: SshAdvanced     // 连接高级选项，缺省全用默认
  proxy?: 'none' | ProxyConfig   // 出站代理：缺省 = 用全局默认代理；'none' = 不用代理
  keyId?: string             // authType=key 且用「应用密钥」：密钥 id（私钥在 keys.json，本条不存私钥）
  // 使用凭据（credentials.json）：连接时用户名/认证全取自凭据，本条不存凭据密文；username/authType 是凭据的快照（列表/去重用）
  credentialId?: string
  proxyCommand?: string      // 本地代理命令（ProxyCommand），与 jumpHostId / 单独设置的出站代理互斥（保存时校验）
}

// ── 凭据（Identity）：命名的一组 用户名 + 认证，多台主机共用，改一处全部生效 ──
// 磁盘存储（凭据字段为密文，同主机）
export interface CredentialConfig {
  id: string
  name: string
  username: string
  authType: AuthType
  passwordCipher?: string
  privateKeyCipher?: string
  passphraseCipher?: string
  keyId?: string             // authType=key 用应用密钥
}
// 渲染层展示（无凭据）
export interface CredentialSummary { id: string; name: string; username: string; authType: AuthType; keyId?: string; hasSecret: boolean }
// 表单输入：密码/私钥留空 = 同认证方式沿用旧值；keyId 未传沿用、'' = 改用粘贴私钥
export interface CredentialInput { id?: string; name: string; username: string; authType: AuthType; password?: string; privateKey?: string; passphrase?: string; keyId?: string }

// ── 出站代理（HTTP CONNECT / SOCKS5）──
export type ProxyType = 'http' | 'socks5'
// 连接用（明文，仅主进程）
export interface ProxyOpts { type: ProxyType; host: string; port: number; username?: string; password?: string }
// 磁盘存储（密码为密文）
export interface ProxyConfig { type: ProxyType; host: string; port: number; username?: string; passwordCipher?: string }
// 渲染层展示（无密码）
export interface ProxySummary { type: ProxyType; host: string; port: number; username?: string; hasPassword?: boolean }
// 表单输入：password 未传 / '' = 沿用旧密码（同类型同地址时）
export interface ProxyInput { type: ProxyType; host: string; port: number; username?: string; password?: string }

// ── keyboard-interactive（二次验证 / OTP / 堡垒机）──
export interface SshAuthPromptInfo {
  hostPort: string
  label: string              // 该跳显示名
  role: '跳板机' | '目标主机'
  name: string               // 服务器给的标题（常为空）
  instructions: string       // 服务器给的说明
  prompts: { prompt: string; echo: boolean }[]   // echo=false → 密码框
}

// 连接高级选项：缺省 = 默认值（心跳 15s、连接超时 20s、不压缩）
export interface SshAdvanced {
  keepaliveSec?: number      // 心跳间隔秒，0 = 关
  readyTimeoutSec?: number   // 连接（握手+认证）超时秒
  compress?: boolean
  termType?: string          // 终端类型 $TERM（缺省 xterm-256color；老系统没有 256 色 terminfo 时改 xterm / vt100）
}
export const SSH_ADVANCED_DEFAULTS = { keepaliveSec: 15, readyTimeoutSec: 20, compress: false } as const

// 主机摘要（无凭据，安全传渲染层展示）
export interface HostSummary {
  id: string
  label: string
  host: string
  port: number
  username: string
  authType: AuthType
  jumpHostId?: string
  notes?: string            // 主机备注：用途/服务管理方式/日志路径/注意事项，AI 操作该主机时可见
  env?: HostEnv
  group?: string            // 分组（单层文件夹式，如「生产/数据库」整体作一个组名）
  encoding?: TermEncoding
  persistSession?: boolean
  loginCommands?: string
  agentForward?: boolean
  advanced?: SshAdvanced
  proxy?: 'none' | ProxySummary   // 缺省 = 全局默认代理
  keyId?: string            // 应用密钥 id
  credentialId?: string     // 使用的凭据 id（此时 username/authType 来自凭据）
  proxyCommand?: string     // 本地代理命令（ProxyCommand）
}

// 保存主机的表单输入（明文凭据，单向 → 主进程加密存）
export interface HostInput {
  id?: string
  label: string
  host: string
  port: number
  username: string
  authType: AuthType
  password?: string
  privateKey?: string
  passphrase?: string
  jumpHostId?: string
  // 未传 = 沿用旧值；'' = 清空（IPC 结构化克隆会丢掉值为 undefined 的键，清空只能用空串表达）
  notes?: string
  env?: HostEnv | ''
  group?: string             // 同 notes：未传沿用、'' 清空
  encoding?: TermEncoding    // 未传沿用旧值；'utf8' 即清回默认
  persistSession?: boolean   // 未传沿用旧值
  loginCommands?: string     // 同 notes：未传沿用、'' 清空
  agentForward?: boolean     // 未传沿用旧值
  advanced?: SshAdvanced     // 未传沿用旧值；{} = 全部恢复默认
  proxy?: 'default' | 'none' | ProxyInput   // 未传沿用旧值；'default' = 用全局默认代理
  keyId?: string             // authType=key 时：应用密钥 id；未传沿用旧值，'' = 改用粘贴的私钥
  credentialId?: string      // 使用凭据：未传沿用旧值，'' = 不用凭据（用本条的用户名/认证）
  proxyCommand?: string      // ProxyCommand：未传沿用旧值，'' = 清空
}

// 跳板链最多几级（目标 ← 跳板1 ← 跳板2）。超出/成环在保存与解析时拒绝。
export const MAX_JUMP_DEPTH = 2

// 从 ~/.ssh/config 导入：预览项（不含私钥内容，私钥只在主进程读取/加密）
export interface SshImportItem {
  alias: string              // Host 别名（作主机标签）
  host: string
  port: number
  username: string
  authType: AuthType
  keyFile?: string           // 实际使用的私钥文件路径
  keyStatus: 'ok' | 'encrypted' | 'missing' | 'none'   // encrypted=需稍后填口令；missing=文件读不到；none=无私钥
  jump?: string              // 跳板说明（显示用）
  existingId?: string        // 已存在同 host+port+user 的主机 → 预览默认不勾选
  warnings: string[]
  group?: string             // 会话导入：原软件里的文件夹（作主机分组）
  proxyCommand?: string      // ~/.ssh/config 的 ProxyCommand：导入后连接时会在本机执行（预览里醒目提示）
}
export interface SshImportPreview { path: string; found: boolean; items: SshImportItem[]; warnings: string[] }
export interface SshImportResult { imported: number; warnings: string[] }
// 从其它 SSH 客户端导入会话（只导名称/地址/端口/用户名/分组，密码一律不导入）
export type SessionImportSource = 'xshell' | 'putty' | 'mobaxterm' | 'securecrt'

// ── 应用管理的 SSH 密钥（私钥加密存 keys.json，不回渲染层）──
export type SshKeyGenType = 'ed25519' | 'rsa'
export interface SshKeySummary {
  id: string
  name: string
  type: string               // 显示用：ED25519 / RSA-4096 / ECDSA-256 …
  fingerprint: string        // SHA256:<base64 无填充>
  publicKey: string          // OpenSSH 公钥行（含注释），复制/导出/部署用
  createdAt: string
  hasPassphrase: boolean
}
export interface KeyDeployResult { added: boolean }   // false = authorized_keys 里已有，未重复追加

// 本地端口转发（ssh -L）：127.0.0.1:localPort → (经 SSH 服务器) remoteHost:remotePort
// 动态转发（ssh -D）：bindHost:localPort 起 SOCKS5 代理，目标由客户端指定、经 SSH 服务器连出。bindHost 默认 127.0.0.1，0.0.0.0 = 局域网可用
// 远程转发（ssh -R）：SSH 服务器上 remoteBind:remotePort 监听，连进来的连接经 SSH 回到本机连 localHost:localPort
export type PortForwardInput =
  | { hostId: string; kind?: 'local'; localPort: number; remoteHost: string; remotePort: number }
  | { hostId: string; kind: 'dynamic'; localPort: number; bindHost?: '127.0.0.1' | '0.0.0.0' }
  | { hostId: string; kind: 'remote'; remotePort: number; remoteBind?: '127.0.0.1' | '0.0.0.0'; localHost: string; localPort: number }
// 一条转发的「占用端口」标识：同主机同标识只能有一条（-L/-D 占本地端口，-R 占服务器端口）
export const forwardSlot = (f: PortForwardInput): string => f.kind === 'remote' ? `R:${f.remotePort}` : `L:${f.localPort}`
// 运行状态：SSH 意外断开 → 关监听、按 RECONNECT_DELAYS_SEC 退避重连（retryAt=计划重连时间戳 ms，≤now 表示正在连）；
// 次数用完 / 重新监听时端口被占 → stopped（留在列表里，可立即重试或移除）
export type PortForwardStatus =
  | { state: 'running' }
  | { state: 'reconnecting'; attempt: number; retryAt: number }
  | { state: 'stopped'; reason: string }
export type PortForwardInfo = PortForwardInput & { id: string; hostLabel: string; status: PortForwardStatus }
// 已保存的转发（port-forwards.json）：只能挂在已存主机上（临时连接无凭据可存）；autoStart = 应用启动时自动开启
export interface SavedPortForward { id: string; hostId: string; input: PortForwardInput; autoStart: boolean }

// ── Phase 4：会话/布局持久化 ──────────────────────────
export interface SessionMeta {
  id: string
  title: string
  threadId: string
  createdAt: string
  lastActiveAt: string
  workDir?: string          // 会话绑定的工作目录（绝对路径），注入 system 提示词 + 新本地终端 cwd
  dshId?: string            // dsh 侧会话 id（上下文重置会换新的）；缺省 = id
  modelProfileId?: string   // 会话级模型覆盖（模型配置 id）；缺省 / 配置已删 = 默认配置
}
export interface TerminalLayoutItem {
  kind: 'local' | 'ssh'
  hostId?: string         // ssh 时：保存的主机 id（重连用）
  color?: string          // 用户选的标签色（TabColor 键名）
  title?: string          // 用户重命名的标签名
  tmux?: string           // ssh 且保持会话时：远端 tmux 会话名，重启后接回同一会话
  shell?: string          // local 时：非默认 shell（powershell / cmd / wsl:<发行版>），重启按同一 shell 重开
  cwd?: string            // local 时：上次所在目录（shell 集成上报），重启回到这里；缺省 = 家目录
  baseTitle?: string      // 终端默认标题（本地 1 / 主机名 2）：渲染页重载时按它把布局项对回正确的终端
  pinned?: boolean        // 固定标签（排最前、关闭其他 / 右侧 / 全部时保留）
}
export interface AppLayout {
  terminals: TerminalLayoutItem[]
  activeTerminalIndex?: number   // 当前活动终端在 terminals 中的下标（重启恢复选中态）
  activeSessionId?: string
  chatWidth?: number             // 会话面板宽度(px)，拖动分割线调整，重启恢复
  terminalSplit?: TerminalSplitLayout   // 终端分屏；缺省 = 不分屏
  // 主机面板（见 hostPanel.ts）：收藏 / 最近连接（hostId，新的在前）/ 延迟探测开关（缺省 = 开）/ 工作区
  favoriteHosts?: string[]
  recentHosts?: string[]
  hostProbe?: boolean
  workspaces?: Workspace[]
}
// 工作区：一组终端 + 分屏布局，一键打开（结构同 AppLayout 的终端部分，下标指 terminals）
export interface Workspace {
  id: string
  name: string
  terminals: TerminalLayoutItem[]
  activeTerminalIndex?: number
  terminalSplit?: TerminalSplitLayout
  savedAt: string
}
// 分屏模式：单屏 / 左右 2 / 上下 2 / 三列 / 四宫格
export type SplitMode = 'single' | 'cols2' | 'rows2' | 'cols3' | 'grid4'
// 终端分屏：各窗格显示的终端（terminals 下标，行优先），焦点窗格由 activeTerminalIndex 指出。
// 旧版 {left,right,ratio,vertical} 由 migrateSplit 读时转换
export interface TerminalSplitLayout {
  mode: SplitMode
  panes: number[]
  sizes: number[]                // 各分割线位置 0~1（见 split.ts defaultSizes）
}

// AI 操作终端的审计记录（「执行记录」面板）。decision 形如 exec_allowed / exec_allowed:edited / read_allowed /
// upload_allowed / write_allowed / download_allowed / restored / allow:<原因> / deny:user / deny:user:<用户写的原因> / deny:<网关原因>
// / docker_start|stop|restart（用户在容器视图里操作，见 docker.ts）
export interface AuditEntry {
  at: string               // ISO 时间戳
  sessionId: string
  terminalId: string
  terminalTitle?: string   // 冗余存终端名，终端关闭后仍能显示
  hostKey: string          // 'local' | hostId | 'host:port'
  command?: string
  decision: string
  exitCode?: number
  truncated?: boolean
  // write_file（decision=write_allowed）、用户在资源管理器手动编辑（decision=user_edit，本地文件 terminalId=''）
  // 与还原（decision=restored）：目标文件 + 覆盖前原文件的备份。
  // 有 backupPath 的记录在执行记录里可「还原」
  filePath?: string
  backupPath?: string
  // MCP 工具调用（decision=mcp_call / deny:*）：hostKey 记 'mcp:<服务名>'，command 记工具名 + 截断的参数
  mcpServer?: string
  mcpTool?: string
  // 按回合撤销（见 turnChanges.ts）：AI 一轮里落的记录带所属 dsh 会话 + 轮次（旧记录没有，不进回合汇总）。
  // write_allowed 另记 created（本轮新建）与 afterHash（写入内容的 sha256，撤销前据此判断文件是否已被后续改动覆盖）
  dshId?: string
  turnId?: string
  created?: boolean
  afterHash?: string
  undoOf?: string          // decision=turn_undo：撤销的是哪一轮（turnId）；decision=rollback：回滚的是哪条记录（原记录的 at）
  rule?: string            // 按命令规则放行 / 询问的（见 commandRules.ts），执行记录里注明「按规则：…」
  // exec_in_terminal：AI 给的回滚命令与说明（有 rollback 的记录可「一键回滚」，见 rollback.ts）；callId = 工具调用 id（对话里的工具卡片据此找记录）
  rollback?: string
  rollbackNote?: string
  callId?: string
  via?: 'mobile'           // 授权 / 拒绝来自已配对手机（执行记录标「手机授权」，见 desktop/main/mobile/mobileIpc.ts）
  review?: import('../ai/index.js').AiReviewResult   // AI 复核结果（开了复核且命中范围的命令）
}

// ── MCP 服务（让 AI 调外部工具：监控/数据库/工单…）────────────
// stdio = 本机起子进程（command/args/env/cwd）；http = Streamable HTTP（连不上自动回退旧版 SSE）
export type McpTransport = 'stdio' | 'http'
// 完整配置（含 env/headers 明文，仅主进程内部用，不回传渲染层）
export interface McpServerConfig {
  id: string
  name: string
  enabled: boolean
  transport: McpTransport
  command?: string
  args?: string[]
  cwd?: string
  env?: Record<string, string>
  url?: string
  headers?: Record<string, string>
  autoApprove?: string[]    // 用户标记「免确认」的工具（MCP 原始工具名）；其余每次调用都弹卡
}
// 摘要（安全传渲染层）：env/headers 只给键名，值留在主进程
export interface McpServerSummary extends Omit<McpServerConfig, 'env' | 'headers'> {
  envKeys: string[]
  headerKeys: string[]
}
// 保存/测试的表单：env/headers 的值为 null = 沿用已存的值（UI 拿不到明文）；不在表里的键 = 删除
export interface McpServerInput extends Omit<McpServerConfig, 'id' | 'env' | 'headers'> {
  id?: string
  env?: Record<string, string | null>
  headers?: Record<string, string | null>
}
export interface McpToolInfo { name: string; description?: string; publicName?: string }
export interface McpServerStatus {
  id: string
  name: string
  state: 'disabled' | 'connecting' | 'connected' | 'failed'
  error?: string
  tools: McpToolInfo[]
}

// ── 阶段二：命令历史 + 资源管理器 ──────────────────────
export interface CommandHistoryEntry {
  command: string
  terminalId: string       // 来源终端 id
  terminalTitle: string    // 冗余存终端名，终端关闭后 tag 仍能显示
  hostKey: string          // 'local' | hostId | 'host:port'
  at: string               // ISO 时间戳
  source: 'user' | 'ai'    // 用户手敲 / AI 通过 exec
}

// 资源管理器一层目录项。scope: 'local'（本地 FS）或 { terminalId }（该终端所在主机）
// 远程（SFTP）列目录才带属性：mode = 权限位（& 0o7777），mtime = 秒，owner/group 取自 ls -l 格式的 longname（取不到用 uid/gid）
export interface DirEntry { name: string; path: string; isDir: boolean; mode?: number; size?: number; mtime?: number; owner?: string; group?: string; isLink?: boolean; linkTarget?: string; linkBroken?: boolean }   // isLink：符号链接（isDir 是它指向的东西）；linkBroken：指向的东西不存在
// sudo：资源管理器的「以 root 身份操作」——远程的列目录 / 读写 / 新建 / 改名 / 删除等都经 sudo 在服务器上做
export type FsScope = 'local' | { terminalId: string; sudo?: boolean }
/** sudo 需要密码时错误信息带这个前缀，界面据此弹出密码框 */
export const SUDO_NEED_PW = '[需要sudo密码]'   // i18n-ignore 错误前缀标识，界面按它匹配并去掉
// 关于页「运行环境」+ 备份与诊断页「数据目录」：主进程只读信息（system:appInfo）
export interface AppInfo { version: string; electron: string; chrome: string; node: string; platform: string; arch: string; dataDir: string; logsDir: string }

// ── Skills（设置 → Skills；见 dsh-controller skills.ts）──────────────
export type SkillOrigin = 'imported' | 'created' | 'manual'
export interface SkillInfo {
  name: string            // frontmatter 里的 name（坏文件用目录名）
  dir: string             // skills/ 下的目录名
  description: string
  origin: SkillOrigin     // 导入 / 新建 / 手动放进目录的
  enabled: boolean        // 停用的不注册给 AI
  modelInvocable: boolean // 「AI 可自动调用」
  userInvocable: boolean  // 出现在输入框「+ → Skills」
  files: string[]         // 包内其它文件（相对路径）
  error?: string          // SKILL.md 有问题：显示原因，不注册
}
export interface SkillImportPreview {
  token: string
  name: string
  description: string
  skillMd: string         // SKILL.md 全文（预览，过长截断）
  files: string[]         // 包内全部文件（相对路径）
  conflict: boolean       // 已有同名 skill
  suggestedName: string   // 冲突时建议的新名字
}
export interface SkillInput { name: string; description: string; body: string }

// ── 模型接口协议 ────────────────────────────────────────
// anthropic = Anthropic Messages（{base}/v1/messages，x-api-key）；openai = OpenAI Chat Completions（{base}/chat/completions，Bearer）
export type ModelProtocol = 'anthropic' | 'openai'
// 只有 DeepSeek 可选：缺省 / 非法值 = anthropic（保持 dsh 0.2 升级后的行为）；其它提供商一律 openai
export const protocolOf = (provider: string, protocol?: unknown): ModelProtocol =>
  provider === 'deepseek' && protocol !== 'openai' ? 'anthropic' : 'openai'
export const DEEPSEEK_ANTHROPIC_BASE = 'https://api.deepseek.com/anthropic'
export const DEEPSEEK_OPENAI_BASE = 'https://api.deepseek.com'
/**
 * 实际请求的根地址：去尾斜杠，空 = 提供商默认。DeepSeek 官方地址（含 /v1、/anthropic 写法）按协议自动修正：
 * anthropic → https://api.deepseek.com/anthropic，openai → https://api.deepseek.com；自定义地址原样。
 */
export function endpointBaseOf(s: { provider: string; baseUrl: string; protocol?: unknown }): string {
  const b = (s.baseUrl.trim() || providerMeta(s.provider).defaultBaseUrl).replace(/\/+$/, '')
  if (s.provider !== 'deepseek' || !/^https:\/\/api\.deepseek\.com(\/v1|\/anthropic)?$/i.test(b)) return b
  return protocolOf(s.provider, s.protocol) === 'anthropic' ? DEEPSEEK_ANTHROPIC_BASE : DEEPSEEK_OPENAI_BASE
}
