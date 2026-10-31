// AppClient 的运维：容器 / 进程 / 端口 / systemd / K8s、日志、体检、仪表盘、合规、批量执行、巡检、看门狗、部署评审、证书。主进程注册见 apps/desktop/src/main/ops/register.ts，渲染层实现见 apps/ui/src/client/transports/ipc/ops.ts
import type { BatchTarget, BatchExecResult, Runbook, RunbookInput, InspectionSchedule, ScheduleInput, InspectionRun, DockerMode, DockerListResult, DockerStat, DockerAction, CertState } from '../../ops/index.js'
import type { CompareTarget } from '../../files/index.js'

export interface OpsApi {
  // 批量执行：一台一次调用（并发 / 进度由 UI 调度），走独立 exec channel 不碰交互终端；每台记执行记录 batch_exec。
  // runId 相同的调用可被 cancel 一并中止（关 channel / 断临时连接）
  batch: {
    // tag：分批执行的标注（执行记录 decision 记成 batch_exec:rollout:k / health:k / rollback，见 rollout.ts）
    exec(runId: string, target: BatchTarget, command: string, timeoutMs: number, tag?: import('../../ops/index.js').BatchTag): Promise<BatchExecResult>
    cancel(runId: string): Promise<void>
  }
  // 运维手册：多步清单，运行时由 AI 按步骤执行
  runbooks: {
    list(): Promise<Runbook[]>
    save(input: RunbookInput): Promise<Runbook>
    delete(id: string): Promise<void>
  }
  // 定时巡检：仅在应用运行时执行
  schedules: {
    list(): Promise<InspectionSchedule[]>
    save(input: ScheduleInput): Promise<InspectionSchedule>
    delete(id: string): Promise<void>
    runNow(id: string): Promise<void>                 // 立即跑一次（入队即返回）
    listRuns(): Promise<InspectionRun[]>              // 运行记录，新在前
  }
  // 容器视图（SSH Linux/macOS 终端走独立 exec channel；本地终端 = 本机 docker）；mode='sudo' 即 sudo -n docker（只在免密 sudo 可用时由用户选）。
  // ref = 容器 id/名称（取自 list 结果，主进程再校验字符集）。action 记执行记录 docker_<action>；compose* = Compose 项目页签
  docker: {
    list(terminalId: string, mode: DockerMode): Promise<DockerListResult>
    stats(terminalId: string, mode: DockerMode): Promise<Record<string, DockerStat>>
    logs(terminalId: string, mode: DockerMode, ref: string): Promise<string>
    action(terminalId: string, mode: DockerMode, action: DockerAction, ref: string, name: string): Promise<void>
    // 同主机新开一个终端标签并敲入 docker logs -f / docker exec -it / docker compose logs -f（新终端经 terminal:created 事件加进标签）
    openTerminal(terminalId: string, mode: DockerMode, kind: 'follow' | 'exec' | 'composeLogs', ref: string): Promise<void>
    composeList(terminalId: string, mode: DockerMode): Promise<import('../../ops/index.js').ComposeProject[]>
    composeLogs(terminalId: string, mode: DockerMode, name: string): Promise<string>
    composeAction(terminalId: string, mode: DockerMode, action: import('../../ops/index.js').ComposeAction, project: import('../../ops/index.js').ComposeProject): Promise<void>
  }
  // 进程管理器（仅 SSH 非 Windows 终端，见 desktop/main/ops/processes.ts）：走独立 exec channel 跑 ps；
  // signal 发 TERM / KILL / HUP，command 只用于执行记录（process_kill）
  processes: {
    list(terminalId: string): Promise<import('../../ops/index.js').ProcList>
    signal(terminalId: string, pid: number, signal: import('../../ops/index.js').ProcSignal, command: string): Promise<void>
  }
  // 日志实时查看（见 desktop/main/ops/logTail.ts）：start 开一条独立 exec channel 跑 tail -F / journalctl -f，返回 id；
  // poll 取走新行（界面约 300ms 一次，30 秒不取主进程自动关）；stop 关通道。只读，不记执行记录
  logs: {
    start(terminalId: string, src: import('../../ops/index.js').LogSource): Promise<string>
    poll(id: string): Promise<import('../../ops/index.js').LogPoll>
    stop(id: string): Promise<void>
  }
  // 监听端口视图（见 desktop/main/ops/portsIpc.ts）：list 经独立 exec channel 跑 ss / netstat；forward 建临时本地转发
  // （本地端口默认同号、被占用自动 +1，不写主机配置，终端关闭即停）；forwards 列本终端的临时转发；stop 停一条
  ports: {
    list(terminalId: string): Promise<import('../../ops/index.js').PortList>
    forwards(terminalId: string): Promise<import('../types.js').PortForwardInfo[]>
    forward(terminalId: string, addr: string, port: number): Promise<import('../types.js').PortForwardInfo>
    stop(terminalId: string, forwardId: string): Promise<void>
  }
  // 自然语言看门狗（设置 → 定时巡检，见 desktop/main/ops/watchdog.ts）：只在应用运行时检查。
  // generate 一次性调用模型把条件写成只读检查脚本（readonly = 是否通过只读校验）；save 前主进程再校验，含写操作拒绝保存
  watchdogs: {
    list(): Promise<import('../../ops/index.js').Watchdog[]>
    states(): Promise<import('../../ops/index.js').WatchdogState[]>
    save(input: import('../../ops/index.js').WatchdogInput): Promise<import('../../ops/index.js').Watchdog>
    delete(id: string): Promise<void>
    checkNow(id: string): Promise<import('../../ops/index.js').WatchdogState>
    generate(condition: string, os?: import('../types.js').TermOs): Promise<{ script: string; explain: string; readonly: boolean }>
    checkScript(script: string): Promise<boolean>
    // 全局暂停（托盘 / 悬浮球菜单也能切）：暂停时到点不检查，「立即检查」照常
    paused(): Promise<boolean>
    setPaused(paused: boolean): Promise<boolean>
  }
  // 主机体检 / 配置漂移（见 desktop/main/ops/hostCheck.ts）：run 跑一次只读采集并存档；history 列本主机的档案（体检 + 变更快照，新的在前）；
  // fileDiff 比较两次档案里缓存的配置文件内容（sha256 缺省 = 空）；fetchFile 拉远端当前内容和某次缓存（base）比较。
  // hostChanges.list 列本会话各轮的「本轮主机变化」报告（只有有变化的轮）
  hostCheck: {
    run(terminalId: string): Promise<import('../../ops/index.js').HostProfile>
    history(terminalId: string): Promise<{ hostKey: string; items: import('../../ops/index.js').ProfileMeta[] }>
    get(terminalId: string, id: string): Promise<import('../../ops/index.js').HostProfile>
    fileDiff(hostKey: string, path: string, from?: string, to?: string): Promise<{ diff: string }>
    fetchFile(terminalId: string, path: string, base?: string): Promise<{ sha256: string; diff: string; noBase?: boolean }>
  }
  hostChanges: {
    list(sessionId: string): Promise<import('../../ops/index.js').TurnHostReport[]>
  }
  // systemd 服务视图（见 desktop/main/ops/systemdIpc.ts）：独立 exec channel 跑 systemctl；action 非 root 时 sudo -n，记执行记录
  // （失败抛错，错误文本含 stderr 原文）；status = systemctl status -n 30 原文
  systemd: {
    list(terminalId: string): Promise<import('../../ops/index.js').SvcList>
    status(terminalId: string, service: string): Promise<string>
    action(terminalId: string, service: string, action: import('../../ops/index.js').SvcAction): Promise<string>
  }
  // 主机仪表盘（见 desktop/main/ops/hostDashboard.ts）：open / close 开关仪表盘期间的采样（close 断开未连接主机的临时连接）；
  // setSampling 对未连接主机开 / 关采样；snapshot 拉各主机最近 60 个点 + 体检问题数
  dashboard: {
    open(): Promise<import('../../ops/index.js').DashSnapshot>
    close(): Promise<void>
    snapshot(): Promise<import('../../ops/index.js').DashSnapshot>
    setSampling(hostIds: string[], on: boolean): Promise<void>
    setInterval(sec: number): Promise<void>
  }
  // 定时任务视图（见 desktop/main/ops/opsViewsIpc.ts）：list 读 crontab（当前用户 / root / /etc/crontab / cron.d）+ systemd timer；
  // generate 一次性调用模型把自然语言写成 cron 任务（不落盘）；add / remove / toggle 只改当前用户的 crontab：先确认读取后没被改过，
  // 备份原 crontab 到 ~/.lingshell/backups 再写回，记执行记录（返回备份路径）
  cron: {
    list(terminalId: string): Promise<import('../../ops/index.js').CronList>
    generate(terminalId: string, description: string): Promise<import('../../ops/index.js').CronGen>
    add(terminalId: string, entry: { schedule: string; command: string; note?: string }): Promise<{ backup?: string }>
    remove(terminalId: string, line: number, raw: string): Promise<{ backup?: string }>
    toggle(terminalId: string, line: number, raw: string, disable: boolean): Promise<{ backup?: string }>
  }
  // 防火墙规则（只读）：firewalld / ufw / nftables / iptables 有哪个读哪个，附 ss -ltnup
  firewall: {
    list(terminalId: string): Promise<import('../../ops/index.js').FwList>
  }
  // 服务拓扑：ss 监听 + 已建立连接 + docker 网络 → 节点与有向边
  topology: {
    get(terminalId: string): Promise<import('../../ops/index.js').Topology>
  }
  // 配置文件解释：一次性模型调用，按（类型 + 内容）哈希缓存在数据目录；force = 忽略缓存重新解释
  configExplain: {
    run(path: string, text: string, force?: boolean): Promise<import('../../ops/index.js').ExplainResult>
  }
  // 趋势预测（见 desktop/main/ops/trendIpc.ts）：各主机磁盘约几天写满（体检档案 + 仪表盘采样）、证书剩几天
  trend: {
    get(hostKeys: string[]): Promise<Record<string, import('../../ops/index.js').HostTrend>>
  }
  // 部署评审（见 shared/ops/deployReview.ts、desktop/main/ops/deployReviewIpc.ts）：导入 / 产物返回 undefined = 用户取消了选择
  deployReview: {
    list(): Promise<import('../../ops/index.js').DeployReviewSummary[]>
    get(id: string): Promise<import('../../ops/index.js').DeployReview>
    create(): Promise<import('../../ops/index.js').DeployReview>
    delete(id: string): Promise<void>
    update(id: string, patch: import('../../ops/index.js').DeployReviewPatch): Promise<import('../../ops/index.js').DeployReview>
    importDoc(id: string): Promise<import('../../ops/index.js').DeployReview | undefined>
    pasteDoc(id: string, name: string, text: string): Promise<import('../../ops/index.js').DeployReview>
    addArtifacts(id: string): Promise<import('../../ops/index.js').DeployReview | undefined>
    removeArtifact(id: string, name: string): Promise<import('../../ops/index.js').DeployReview>
    analyze(id: string): Promise<import('../../ops/index.js').DeployReview>
    probe(id: string): Promise<import('../../ops/index.js').DeployReview>
    toRunbook(id: string): Promise<string>
    exportPdf(html: string, defaultName: string): Promise<string | undefined>
  }
  // 基线合规检查（见 desktop/main/ops/complianceIpc.ts）：run 当前 SSH 终端所在主机；batch 已保存主机并行跑；setDisabled 设置里关掉的条目
  compliance: {
    config(): Promise<{ disabled: string[] }>
    setDisabled(ids: string[]): Promise<{ disabled: string[] }>
    run(terminalId: string): Promise<import('../../ops/index.js').ComplianceHostRow>
    batch(hostIds: string[]): Promise<import('../../ops/index.js').ComplianceHostRow[]>
  }
  // 多主机日志（见 desktop/main/ops/logMulti.ts）：start/poll/stop 实时合流（每台一条 tail 通道，按时间归并）；
  // search 历史检索（当前文件 + 轮转 + .gz / journalctl，只读），一台一次调用，结果在界面按时间归并
  logMulti: {
    start(targets: import('../../ops/index.js').MultiLogTarget[], src: import('../../ops/index.js').LogSource): Promise<string>
    poll(id: string): Promise<import('../../ops/index.js').MultiLogPoll>
    stop(id: string): Promise<void>
    search(target: import('../../files/index.js').CompareTarget, q: import('../../ops/index.js').LogSearchQuery): Promise<import('../../ops/index.js').LogSearchHostResult & { error?: string }>
  }
  // 连通性探测（见 desktop/main/ops/connProbe.ts）：一个源一次调用（本机用 Node，远端跑只读脚本）；runId 相同的可被 cancel 一并中止
  probe: {
    run(runId: string, source: import('../../files/index.js').CompareTarget, targets: import('../../terminal/index.js').ProbeTarget[], checks: import('../../terminal/index.js').ProbeCheck[]): Promise<import('../../terminal/index.js').ProbeSourceResult>
    cancel(runId: string): Promise<void>
  }
  // Kubernetes 视图（见 desktop/main/k8sIpc.ts）：独立通道跑 kubectl（读操作 -o json）；ctx 只加在本视图的命令上（--context），不改 kubeconfig 默认上下文。
  // ns 为 '' = 全部命名空间；restart 记执行记录；forward 只用于 SSH 终端（远端后台 port-forward + 临时 SSH 本地转发）
  k8s: {
    probe(terminalId: string): Promise<import('../../ops/index.js').K8sProbe>
    namespaces(terminalId: string, ctx?: string): Promise<string[]>
    list(terminalId: string, ctx: string | undefined, ns: string, res: import('../../ops/index.js').K8sResource): Promise<import('../../ops/index.js').K8sList>
    text(terminalId: string, ctx: string | undefined, ns: string, kind: import('../../ops/index.js').K8sKind, name: string, what: 'describe' | 'yaml'): Promise<string>
    logs(terminalId: string, ctx: string | undefined, ns: string, pod: string, opts: import('../../ops/index.js').K8sLogOpts): Promise<string>
    restart(terminalId: string, ctx: string | undefined, ns: string, kind: import('../../ops/index.js').K8sRestartKind, name: string): Promise<string>
    health(terminalId: string, ctx: string | undefined, ns: string): Promise<import('../../ops/index.js').K8sHealth>
    openTerminal(terminalId: string, ctx: string | undefined, ns: string, what: 'exec' | 'logs' | 'portForward', p: { kind?: import('../../ops/index.js').K8sFwdKind; name: string; container?: string; port?: number }): Promise<void>
    forward(terminalId: string, ctx: string | undefined, ns: string, kind: import('../../ops/index.js').K8sFwdKind, name: string, port: number): Promise<import('../../ops/index.js').K8sForward>
    forwards(terminalId: string): Promise<import('../../ops/index.js').K8sForward[]>
    stopForward(terminalId: string, id: string): Promise<void>
  }
  // 磁盘空间分析（只读，见 desktop/main/ops/diskUsageIpc.ts）：scope = 'local'（Git Bash）或 SSH 终端；common / deleted 只支持 Linux
  diskUsage: {
    level(scope: import('../types.js').FsScope, dir: string): Promise<import('../../ops/index.js').DiskLevel>
    bigFiles(scope: import('../types.js').FsScope, dir: string): Promise<import('../../ops/index.js').DiskBigFiles>
    common(scope: import('../types.js').FsScope): Promise<import('../../ops/index.js').DiskCommon>
    deleted(scope: import('../types.js').FsScope): Promise<import('../../ops/index.js').DiskDeleted>
  }
  // 配置按键对比：读一端文件（本机 / 主机 / 在线终端，只读，≤1MB）
  configDiff: {
    read(target: CompareTarget, path: string): Promise<{ text: string }>
  }
  // 证书与域名巡检（设置 → 定时巡检，见 desktop/main/ops/certCheck.ts）：都返回最新状态；check 不带 ids = 全部（并按到期分级提醒）
  certs: {
    list(): Promise<CertState>
    save(input: import('../../ops/index.js').CertTargetInput): Promise<CertState>
    delete(id: string): Promise<CertState>
    check(ids?: string[]): Promise<CertState>
    setConfig(patch: Partial<import('../../ops/index.js').CertConfig>): Promise<CertState>
    discover(hostId: string): Promise<string[]>
  }
}
