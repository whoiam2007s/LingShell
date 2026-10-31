// AppClient 的终端：本地 / SSH 终端、主机与密钥、端口转发、主机指纹、命令历史、录像、会话日志、自动应答、快速命令。主进程注册见 apps/desktop/src/main/terminal/register.ts，渲染层实现见 apps/ui/src/client/transports/ipc/terminal.ts
import type { TerminalInfo, SshConnectInput, HostSummary, HostInput, SshImportPreview, SshImportResult, SshAgentInfo, KnownHost, PortForwardInfo, PortForwardInput, SavedPortForward, CommandHistoryEntry, ProxySummary, ProxyInput, HostEnv } from '../types.js'
import type { TmuxSessionInfo, QuickCommandsData, AutoReplySummary, AutoReplyInput, RecordingInfo, ProbeResult } from '../../terminal/index.js'

// 新建 SSH 连接的入参：saveAs 有值时存为主机，notes/env/group 一并存
// tmuxSession：接回指定的保留会话（布局恢复 / 右键菜单接回）；仅对开了「保持会话」的主机生效
export type SshCreateOpts = { hostId: string; tmuxSession?: string } | { connect: SshConnectInput; saveAs?: string; notes?: string; env?: HostEnv; group?: string; persistSession?: boolean }

export interface TerminalApi {
  terminal: {
    list(): Promise<TerminalInfo[]>
    createLocal(opts?: { cwd?: string; shell?: string }): Promise<TerminalInfo>   // shell：见 localShell.ts，缺省 Git Bash
    // noHistory：不进命令历史（UI 判断光标停在密码 / 口令提示上时传）
    write(terminalId: string, data: string, opts?: { noHistory?: boolean }): Promise<void>
    // tmux 终端：kill = 结束远端会话 / keep = 留在服务器 / 缺省 = 空闲才结束（有任务在跑就留着）
    close(terminalId: string, tmux?: 'kill' | 'keep'): Promise<void>
    tmuxJobs(terminalId: string): Promise<string[] | null>   // tmux 会话里正在跑的非 shell 命令（关标签前确认用）；null = 查询失败，不确定
    snapshot(terminalId: string, lines?: number): Promise<string>   // 最近输出快照（剥 ANSI），渲染页重载后回填滚动区
    tmuxSessions(terminalId: string): Promise<TmuxSessionInfo[]>   // 同主机上保留着、当前没打开的 lingshell- 会话
    interrupt(terminalId: string): Promise<void>      // Phase 3：打断（发 Ctrl-C，绕过 locked）
    resize(terminalId: string, cols: number, rows: number): Promise<void>   // xterm fit 后同步 PTY 尺寸
    reconnect(terminalId: string): Promise<void>      // Phase 5：SSH 原地重连
    pwd(terminalId: string): Promise<string>          // 取终端当前工作目录（execCapture pwd），失败返回空串
    duplicate(terminalId: string): Promise<TerminalInfo>   // 复制会话：SSH 同主机同参数 / 本地同 cwd 再开一个
    // SSH 终端：用已存主机(hostId) 或 新连接(connect，可选 saveAs 存为主机)
    createSsh(opts: SshCreateOpts): Promise<TerminalInfo>
    // 测试 SSH 连接：只验证能否连上，不开终端。返回 {ok} 或 {ok:false, error}
    testSsh(connect: SshConnectInput, hostId?: string): Promise<{ ok: boolean; error?: string }>
    // 主机状态：告诉主进程当前可见的终端（整份替换），只采这些；结果经 terminal:hostStats 事件推送
    watchStats(terminalIds: string[]): Promise<void>
  }
  hosts: {
    list(): Promise<HostSummary[]>
    save(input: HostInput): Promise<HostSummary>
    delete(id: string): Promise<void>
    // 往主机备注末尾追加一段（hostKey='local' 写本机备注）。AI 提议卡片「保存到主机备注」用
    appendNote(hostKey: string, text: string): Promise<void>
    // 解析 ~/.ssh/config 出预览（不写入）；importSshConfig 按勾选的别名导入
    sshConfigPreview(): Promise<SshImportPreview>
    importSshConfig(aliases: string[]): Promise<SshImportResult>
    // 检测系统 ssh-agent/Pageant（表单选 agent 认证时显示）；null = 未检测到
    detectAgent(): Promise<SshAgentInfo | null>
    // 从 Xshell/PuTTY/MobaXterm/SecureCRT 导入：pick=true 弹框选文件/目录（取消返回 undefined），否则读默认位置。
    // 解析结果留在主进程，importSessions 按勾选的 alias 导入（跳过已存在的同一目标）
    sessionImportPreview(source: import('../types.js').SessionImportSource, pick?: boolean): Promise<SshImportPreview | undefined>
    importSessions(aliases: string[]): Promise<SshImportResult>
  }
  // SSH 主机指纹（TOFU）：首连确认、指纹不符后确认换钥、管理/删除、从 ~/.ssh/known_hosts 导入
  knownHosts: {
    list(): Promise<KnownHost[]>
    decide(requestId: string, trust: boolean): Promise<void>
    acceptChanged(hostPort: string): Promise<void>      // 用最近一次不符时服务器给出的新指纹替换记录
    remove(hostPort: string): Promise<void>
    importOpenSsh(): Promise<number>                    // 返回新导入条数（只导明文条目，跳过哈希条目）
  }
  // 端口转发（本地 -L / 动态 -D；用户手动启停，不给 AI）。断线自动退避重连；saved = 已保存的转发
  portForward: {
    list(): Promise<PortForwardInfo[]>
    start(input: PortForwardInput): Promise<PortForwardInfo>
    stop(id: string): Promise<void>                       // 停止并移出列表，不再重连
    retry(id: string): Promise<void>                      // 重连中/已停止 → 立即重连一次
    listSaved(): Promise<SavedPortForward[]>
    save(input: PortForwardInput): Promise<SavedPortForward>   // 仅已存主机；同主机同本地端口覆盖
    setAutoStart(id: string, on: boolean): Promise<void>
    deleteSaved(id: string): Promise<void>
  }
  // 命令历史（按 hostKey 分组）。hostKey 由 UI 传：'local' | hostId | 'host:port'
  history: {
    list(hostKey: string): Promise<CommandHistoryEntry[]>
    delete(hostKey: string, index: number): Promise<void>
    clear(hostKey: string): Promise<void>
    // 命令补全用：按终端取所属主机的历史（hostKey 由主进程定）；删该主机这条命令的全部记录
    forTerminal(terminalId: string): Promise<{ hostKey: string; entries: CommandHistoryEntry[] }>
    deleteCommand(terminalId: string, command: string): Promise<void>
  }
  // 快速命令栏：整份读写（含命令组、当前组、显示开关）
  quickCommands: {
    get(): Promise<QuickCommandsData>
    save(data: QuickCommandsData): Promise<QuickCommandsData>
  }
  // 自动应答（触发器）：密钥应答只进不出
  autoReplies: {
    list(): Promise<AutoReplySummary[]>
    save(input: AutoReplyInput): Promise<AutoReplySummary>
    delete(id: string): Promise<void>
  }
  // 终端录像（asciicast）：id 即 YYYY-MM-DD/<文件名>.cast
  recordings: {
    list(): Promise<RecordingInfo[]>               // 新在前
    read(id: string): Promise<string>              // 整份 .cast 文本（回放用）
    openFolder(id?: string): Promise<void>         // 在文件管理器里定位该录像；不传 = 打开录像根目录
    delete(id: string): Promise<void>              // 删单个录像（正在录的不允许）
    // 手动开始 / 停止某终端的录像（需系统设置里启用录屏功能）；active = 正在录的终端 id
    start(terminalId: string): Promise<void>
    stop(terminalId: string): Promise<void>
    active(): Promise<string[]>
  }
  // 会话日志（纯文本 .log，系统设置里开启后自动记录）
  sessionLogs: {
    openFolder(dir?: string): Promise<void>        // 打开日志目录；dir 空 = 已保存设置里的目录（再空 = 默认目录）
    openTerminal(terminalId: string): Promise<void> // 用系统程序打开该终端当前的日志文件（未在记录则抛错）
  }
  // SSH keyboard-interactive 应答：answers=null 即取消（连接失败）
  sshAuth: {
    answer(requestId: string, answers: string[] | null): Promise<void>
  }
  // 全局默认出站代理（设置 → 网络）；主机可在「高级」里覆盖或选「不使用代理」。null = 不设
  proxy: {
    get(): Promise<ProxySummary | null>
    save(p: ProxyInput | null): Promise<ProxySummary | null>
  }
  // 主机面板：延迟探测（TCP 连 SSH 端口计时，不认证；经跳板的不测）、复制主机（连凭据一起复制，凭据不经渲染层）
  hostPanel: {
    probe(hostIds: string[]): Promise<Record<string, ProbeResult>>
    duplicate(hostId: string): Promise<HostSummary>
  }
  // 应用管理的 SSH 密钥（见 desktop/main/terminal/sshKeys.ts）：私钥只在主进程，渲染层只拿公钥/指纹
  keys: {
    list(): Promise<import('../types.js').SshKeySummary[]>
    generate(name: string, type: import('../types.js').SshKeyGenType, passphrase?: string): Promise<import('../types.js').SshKeySummary>
    // 弹框选私钥文件（路径留在主进程），返回文件名与是否需要口令；取消 undefined
    pickImport(): Promise<{ fileName: string; needPassphrase: boolean } | undefined>
    importPicked(name: string, passphrase?: string): Promise<import('../types.js').SshKeySummary>
    delete(id: string): Promise<void>
    // 弹保存框导出（公钥 .pub / 私钥，私钥有口令时导出的也带口令），返回路径；取消 undefined
    export(id: string, which: 'public' | 'private'): Promise<string | undefined>
    // 经该主机现有认证连上，exec 通道幂等追加到 ~/.ssh/authorized_keys；记执行记录
    deploy(id: string, hostId: string): Promise<import('../types.js').KeyDeployResult>
    // 先用该密钥测试连接，通过才把主机认证切换为这把密钥
    useForHost(id: string, hostId: string): Promise<void>
  }
  // 新建本地终端可选的 shell（Windows：Git Bash / PowerShell / cmd / WSL 发行版；其它系统只有默认 shell）
  localShells: {
    list(): Promise<import('../../terminal/index.js').LocalShellOption[]>
  }
  // 命名凭据（设置 → SSH 连接管理 →「凭据」，见 desktop/main/terminal/credentialsIpc.ts）：凭据明文只进不出。
  // delete 被主机引用时拒绝（报错列出主机）；assign 批量让主机使用该凭据，返回改了几台
  credentials: {
    list(): Promise<import('../types.js').CredentialSummary[]>
    save(input: import('../types.js').CredentialInput): Promise<import('../types.js').CredentialSummary>
    delete(id: string): Promise<void>
    assign(hostIds: string[], id: string): Promise<number>
  }
  // 批量修改主机（设置 → SSH 连接管理 →「批量修改」，见 desktop/main/terminal/hostBatchIpc.ts）：preview 只算不写；
  // apply 先备份 hosts.json 再改，返回改了几台；undo 撤销上次批量修改（只还原那次改过的字段），返回还原了几台
  hostBatch: {
    preview(ids: string[], patch: import('../../ops/index.js').HostBatchPatch): Promise<import('../../ops/index.js').HostBatchItem[]>
    apply(ids: string[], patch: import('../../ops/index.js').HostBatchPatch): Promise<number>
    last(): Promise<import('../../ops/index.js').HostBatchUndoInfo | null>
    undo(): Promise<number>
  }
  // Git Bash 探测（Windows，见 desktop/main/terminal/gitBashIpc.ts）：status 当前结果；redetect 重新检测；
  // pick 选 bash.exe → 校验 → 存进设置（取消返回 null，校验不过抛错）；clear 清掉手动指定，回到自动探测
  gitBash: {
    status(): Promise<import('../../terminal/index.js').GitBashStatus>
    redetect(): Promise<import('../../terminal/index.js').GitBashStatus>
    pick(): Promise<import('../../terminal/index.js').GitBashStatus | null>
    clear(): Promise<import('../../terminal/index.js').GitBashStatus>
  }
}
