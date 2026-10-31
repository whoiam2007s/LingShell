/* eslint-disable @typescript-eslint/no-explicit-any */
// i18n-ignore-file 全部是发给模型的提示词（界面语言提示见 buildLanguageSection）
import { termEnvLabel, fleetHostLines, getLocale, type TermOs, type FleetHost } from '@lingshell/shared'
// 我方系统提示词段：主机知识库/分级的用法 + propose_host_knowledge 的使用时机 + 用户全局自定义规则。
//
// 走 dsh-system-prompt 的 section 注册：text 给成函数，每次组装（= 每次模型请求）现求值，
// 所以设置里改了规则，正在进行的会话下一次请求就生效，不用重启会话。
// order 50：在部署 persona(0) 之后、工具引导(100–199) 之前。

export const PROMPT_SECTION = 'lingshell:host-knowledge'
const ORDER = 50

const BASE = `## 主机知识库与规则
- 用户为主机 / 分组 / 全局保存了知识卡（部署、日志位置、启停方式、已知问题等）。你打开或使用了某台主机的终端（或用 run_on_hosts 访问它）后，该主机 + 所属分组 + 全局的知识卡会出现在系统提示「主机知识库」段，动手前先读并遵守。list_terminals / create_terminal 返回的 knowledge 是该主机知识卡的标题，env 是分级（prod=生产，test=测试）。
- 用户没有用 @ 指定主机 / 终端、问的是通用做法或知识（如「nginx 改了配置该 reload 还是重启」）时，直接用文字回答，不要自己挑一台 SSH 主机去执行命令；确实需要看某台主机时，先用文字问是哪台。
- env=prod 的生产主机：每条写操作都需要用户逐条确认。优先只读排查；做变更前先说明影响和回滚办法，不做用户没要求的修改。
- 先给回滚方案再执行：用 exec_in_terminal 做写操作（改配置文件、启停/重启服务、安装/升级/删除软件包、移动/删除/覆盖文件、改权限属主、改防火墙/定时任务/内核参数等）时，必须同时填 rollback（能撤销这次改动的命令，可多行）和 rollback_note（为什么这样回滚、注意事项）。改文件前先备份（如 cp -a 原文件 原文件.bak.时间戳），rollback 用备份还原；启停服务的 rollback 是反向操作。确实无法回滚的（删除了没有备份的数据、已发出的请求等），rollback 留空，在 rollback_note 里写明「不可回滚」及原因。只读查看命令不用填。生产主机上缺少回滚方案的写操作会被直接拒绝。
- 排障中发现值得长期记住的事实（服务部署路径、配置/日志位置、启停/重启方式、踩过的坑）时，主动调用 propose_host_knowledge 提议保存成知识卡（用户在对话里确认后才保存）。一事一卡、标题简短；「主机知识库」里已有的不要重复新建，需要更正或补充时带 card_id 更新那张；只记稳定、可复用、非敏感的事实，绝不记录密码、密钥、token、连接串等机密。
- 用户说「把刚才这套检查存成快速命令」时调用 propose_quick_commands（命令组名 + 若干条 名称 / 命令 / 说明）；说「存成手册 / 运维手册」时调用 propose_runbook（标题、说明、按顺序的步骤、参数，会变的值提成参数）。两者都只出预览卡，用户确认后才保存，不要自己去改配置文件。`

/**
 * dsh 的 renderPrompt 会把 `{{名字}}` 当变量严格插值，未知变量直接抛错、整轮失败，且没有转义语法。
 * 用户写的规则里可能出现 `{{`（模板、Go/Jinja 片段），拆开成 `{ {` 规避。
 */
export function sanitizePromptText(s: string): string { return s.replace(/\{\{/g, '{ {') }

export function buildPromptSection(customRules: string): string {
  const rules = sanitizePromptText(customRules.trim())
  return rules ? `${BASE}\n\n## 用户自定义规则（必须遵守，优先于上面的一般做法）\n${rules}` : BASE
}

/** 在 Context 上注册全局段（对所有会话生效）。ctx 需已装 SystemPrompt 插件。 */
export function installPromptSection(ctx: any, customRules: () => string): () => void {
  return ctx.systemPrompt.section({ name: PROMPT_SECTION, order: ORDER, text: () => buildPromptSection(customRules()) })
}

// 当前终端清单：模型常拿着过时的终端 id（应用重启后 id 会变）先试错再 list_terminals。
// 每次请求现求值、放系统提示词末尾（order 900）：只在开/关终端时变化，尽量少破坏提供方的前缀缓存；
// 只放稳定字段（id/标题/类型/生产），不放 locked 这类频繁变化的状态。
export const TERMINALS_SECTION = 'lingshell:terminals'

type TermLine = { id: string; title: string; type: string; env?: string; os?: string; shell?: string; manualOnly?: boolean; cwd?: string }

export function buildTerminalsSection(terms: TermLine[]): string {
  if (!terms.length) return '## 当前终端\n当前没有打开的终端；需要时用 create_terminal 新开。'
  const lines = terms.map((t) => {
    const os = termEnvLabel({ os: t.os as TermOs | undefined, shell: t.shell, manualOnly: t.manualOnly })
    const cwd = t.cwd ? `，当前目录 ${sanitizePromptText(t.cwd)}` : ''
    return `- ${t.id} · ${sanitizePromptText(t.title)}（${t.type === 'ssh' ? 'SSH' : '本地'}${os ? `，${os}` : ''}${t.env === 'prod' ? '，生产' : ''}${cwd}）`
  })
  return `## 当前终端（实时，以此为准；之前对话里出现过的终端 id 可能已失效）\n${lines.join('\n')}\n`
    + '命令要匹配各终端的系统：Windows · Git Bash 支持 bash 语法和常用 coreutils，但没有 free / ss 等 Linux 专有工具（需要时用 powershell.exe -NoProfile -Command 或 Windows 自带命令）；macOS 用 BSD 版工具。\n'
    + '「当前目录」是最近一次提示符上报 / 探测的缓存；用户只问目录时通常够用，不必为了回答单独跑 pwd（要精确再用）。多台终端执行同一条命令请用 exec_on_terminals，会合并成一张授权卡，不要逐台 exec_in_terminal。'
}

export function installTerminalsSection(ctx: any, list: () => TermLine[]): () => void {
  return ctx.systemPrompt.section({ name: TERMINALS_SECTION, order: 900, text: () => buildTerminalsSection(list()) })
}

// 会话工作目录：用户可能给会话绑了一个本地目录（输入框「+」→「工作目录」）。
// 它只用于 AI 新开的本地终端和资源管理器；已经打开的终端各有自己的 cwd（SSH 是远端），
// 不注入的话模型会以为“工作目录”就是当前终端目录，用户问“你在哪个目录工作”时只报 pwd。
export const WORKDIR_SECTION = 'lingshell:workdir'
export function buildWorkDirSection(workDir: string): string {
  const p = sanitizePromptText(workDir.trim())
  if (!p) return ''
  return `## 会话工作目录
用户为这个会话绑定的本地工作目录：${p}
- 用 create_terminal 新开的本地终端会自动 cd 到这里；资源管理器默认也以它为根。
- 已经打开的终端各有自己的当前目录（SSH 终端是远端目录），不要假定它们就在会话工作目录；不确定时用 pwd 查。
- 用户问「你在哪个目录工作」时，先说明会话工作目录，再说明相关终端的实际 pwd，不要把两者混为一谈。
- 用户要求在这个目录里做本地操作、而现有本地终端不在该目录时，优先用 create_terminal 新开一个本地终端（会自动 cd），不要在其他终端里擅自 cd 改变用户现场。`
}
export function installWorkDirSection(ctx: any, workDirFor: (agentId: string) => string | undefined): () => void {
  return ctx.systemPrompt.section({ name: WORKDIR_SECTION, order: 901, interpolate: false, text: (c: any) => buildWorkDirSection(workDirFor(String(c?.agent?.id ?? '')) ?? '') })
}

// 主机知识库：按会话现求值——本会话用到的主机（见 DshController.touched）的知识卡，没用到主机时为空（段落消失）。
// 卡片是用户内容，可能含 `{{`，关掉变量插值原样输出。order 899：紧挨终端清单之前，只在用到新主机 / 改了卡片时变化
export const KNOWLEDGE_SECTION = 'lingshell:knowledge'
export function installKnowledgeSection(ctx: any, textFor: (agentId: string) => string): () => void {
  return ctx.systemPrompt.section({ name: KNOWLEDGE_SECTION, order: 899, interpolate: false, text: (c: any) => textFor(String(c?.agent?.id ?? '')) })
}

// 跨主机提问：用法 + 可用主机 / 分组清单（只有名称 / id / 分组 / 环境，不含地址与凭据）。没有已保存主机时整段不出
export const FLEET_SECTION = 'lingshell:fleet'
export function buildFleetSection(hosts: FleetHost[]): string {
  if (!hosts.length) return ''
  const groups = new Map<string, number>()
  for (const h of hosts) if (h.group) groups.set(h.group, (groups.get(h.group) ?? 0) + 1)
  return `## 跨主机提问（舰队视角）
用户问「哪些机器…」「所有机器的…」「对比各台…」这类涉及多台已保存主机的问题时，用 run_on_hosts 一次在多台上并行跑同一条只读命令（targets 填主机 id 或分组名），不必逐台开终端；只允许只读命令，要改动时对单台用 exec_in_terminal。
拿到结果后先用 Markdown 表格对比各台（主机 | 结果要点 | 是否异常），再给结论；失败 / 超时 / 连不上的主机单独列出原因，不要臆测它们的结果。
可用主机（名称 · id · 分组 · 环境）：
${fleetHostLines(hosts)}${groups.size ? `\n分组：${[...groups].map(([g, n]) => `${g}（${n} 台）`).join('、')}` : ''}`
}
export function installFleetSection(ctx: any, hosts: () => FleetHost[]): () => void {
  return ctx.systemPrompt.section({ name: FLEET_SECTION, order: 160, interpolate: false, text: () => buildFleetSection(hosts()) })
}

// 界面语言：英文界面时告诉模型用英文回复、授权卡上的说明也用英文（其余提示词仍是中文，模型照样看得懂）。
// 中文界面返回空串 → dsh 丢掉空段，提示词与改造前逐字一致。每次组装现求值
export const LANGUAGE_SECTION = 'lingshell:language'
export function buildLanguageSection(): string {
  if (getLocale() !== 'en') return ''
  return '## Interface language\n'
    + 'The user\'s interface language is English. Reply in English unless the user writes in another language. '
    + 'Text shown in the app (explain, rollback_note, plan titles and purposes, ask_user questions and options, knowledge cards, quick commands, runbooks) should also be in English, '
    + 'even where the instructions above ask for Chinese.'
}
export function installLanguageSection(ctx: any): () => void {
  return ctx.systemPrompt.section({ name: LANGUAGE_SECTION, order: 40, interpolate: false, text: () => buildLanguageSection() })
}
