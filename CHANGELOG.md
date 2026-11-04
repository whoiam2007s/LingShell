# 更新日志

本项目遵循[语义化版本](https://semver.org/lang/zh-CN/)。版本号在 `apps/desktop/package.json` 与根 `package.json` 中同步维护。

## [0.1.4] - 2026-11-04

新增：

- **点用量标签直接压缩上下文**：聊天头部的「tokens · 上下文 %」标签点一下立即压缩（把较早的对话压成摘要，最近一轮原文逐字保留）。正在跑回合时先等本轮结束再压，不打断工具调用；压缩期间后续消息排队，压完继续。
- **启动冒烟测试**（CI）：Linux 打包作业里用 `xvfb` 真启动打包产物，检查界面是否真的渲染出内容、是否触发 `did-fail-load` 或渲染进程崩溃。类型检查、单测、打包全绿但"启动白屏"的情况，现在能被拦下。

安全：

- **依赖告警清零**：`pnpm audit` 从 **82 条降到 0 条**。
- **Electron 40 → 45**：40 线已停止维护（安全修复只发到 41.10.3+，40.x 不再回补），升到当前受支持的 45 线。迁移处理了 45 的破坏性变更：剪贴板 API 改为异步（`readText`/`writeText`/`read` 返回 Promise，`readBuffer` 移除 —— 资源管理器复制文件的粘贴兜底改走 `ClipboardItem` 原始格式）、`printToPDF` 的 `margins.marginType` 换成英寸数值。`node-pty` 是 N-API 模块，无需按 Electron 版本重编译。
- 其余传递依赖用 overrides 钉到修复版：brace-expansion（三条线）、shell-quote（critical）、postcss、axios、@xmldom/xmldom、joi、nanoid、tar、browserslist、follow-redirects、source-map-js、minimatch 等；`vite` 升到 8.1.6、`vitest` 升到 4.1.12、`electron-builder` 升到 26.18.0、`electron-vite` 升到 6.0.0。

修复：

- **退出时不再抛 `Object has been destroyed`**：终端数据流和定时器在窗口销毁后仍向渲染层发事件，导致退出时弹崩溃框。`send()` 增加销毁检查；冒烟模式改为先正常退出、再兜底强退。
- **文件管理器「添加到对话」静默失效**（0.1.0 起就有）：订阅一直持有首次渲染时的处理函数，那时会话尚未恢复、`sessionId` 为空，导致读出的文件在最后落地时被丢掉 —— 没有报错也没有提示。改为用 ref 取最新的处理函数。
- **`write_file` 参数歧义直接报错**：同时给 `content` 与 `old_text/new_text` 时，之前会静默以 `content` 为准、把整个文件覆盖掉（只剩备份能救）。现在直接报错并说明正确用法。

工程：

- macOS 打包验证不再阻塞 PR（只在 master 推送 / 手动触发时跑）—— 产品上 macOS 只需在首个版本与系统兼容性调整时验证。

## [0.1.3] - 2026-11-03

安全：

- **生产依赖漏洞清零**：`pnpm audit --prod` 从 14 条降到 0 —— js-yaml 4.3.2、zod 4.6.6、undici 6.29.1（`openai` 把它钉成精确版本，需父子覆盖才生效）。
- **Electron 40.8.3 → 40.10.6**：40 线最后一个补丁，修掉 nodeIntegrationInWorker 作用域、window.open 目标限制、离屏渲染 use-after-free、clipboard.readImage 崩溃等漏洞。同一大版本内，无 API 变更。

新增：

- **macOS 打包验证**：CI 每次都会在 `macos-latest` 上构建 DMG 并检查产物（未签名、不发布），macOS 从「从未构建」变成「持续构建验证」。

优化：

- 设置 / 用量 / 授权三个低频面板改为懒加载，前端主包 2152 KB → 1857 KB（-14%）。
- lucide-react 1.65、ssh2 1.17 等常规升级。

文档与工程：

- README 增加在线文档入口；修正 Linux 已验证、Node ≥ 22 等过期描述。
- Dependabot 忽略 Electron / electron-vite / Tailwind / TypeScript 的大版本（见 #19、#20），避免每周重复提无法自动合并的 PR。

## [0.1.2] - 2026-11-01

新增：

- **Linux 版**：正式发布现在会同时产出 AppImage（`LingShell-<版本>-linux-x86_64.AppImage`）与 `latest-linux.yml`，Linux 用户可用自动更新。CI 里也新增了 Linux 打包验证作业，避免以后悄悄坏掉。
- **文档站**：`guide/` 下的功能详解通过 GitHub Pages 发布，带侧栏与全文搜索。

修复：

- Linux 打包的两处阻塞：electron-builder 不接受 `.ico` 图标（改为脚本渲染 1024×1024 PNG）、包名 `@lingshell/desktop` 含非法字符（可执行名固定为 `lingshell`）。

工程：

- 前端分包：react / xterm / markdown / radix 拆成独立 chunk，主包不再一次解析全部依赖。
- React 四个包同步升到 19.3.1（`react`、`react-dom`、`@types/react`、`@types/react-dom` 必须同版本，只升一个会让前端测试整片失败）。
- `@types/node` 统一到 22.20.0（跟随运行时；低于 22.12 不满足 vite 8 的对等依赖）。
- Dependabot：新增 react 生态分组、忽略 `@types/node` 大版本跳跃，避免同类失败重复出现。

## [0.1.1] - 2026-10-31

修复：

- **Linux / macOS 下终端当前目录识别不到**：shell integration 的 OSC 633 路径上报其实一直在工作，但 `knownCwd` 只认 Windows 盘符路径，把 `/home/...` 这类 POSIX 路径当成"不知道"。现在非 Windows 平台直接返回原始路径 —— AI 的终端清单和资源管理器的"跟随终端目录"在 Linux / macOS 上恢复正常。

工程：

- CI 修复：IPC 清单移入 `scripts/structure/`（协议一致性检查在 CI 里继续生效）、shell 标记测试改为跨平台断言。
- Dependabot 自动 rebase，Release 说明改为从本文件自动提取并附安装包 SHA256。

## [0.1.0] - 2026-10-31

首个开源版本（Apache-2.0）。

- **AI 与终端**：本地终端（Git Bash / PowerShell / cmd / WSL）与 SSH 终端；AI 对话、工具调用、授权卡、执行计划、回滚方案、执行记录、本轮文件改动与撤销。
- **终端增强**：分屏、广播输入、标签固定 / 颜色 / 重命名、tmux 断线保持、命令成败标记、命令历史、自动补全、快速命令、撰写栏、关键字高亮与告警。
- **主机运维**：主机体检、配置漂移、变更快照、监听端口、进程、服务、日志（tail / 多主机合流 / 历史检索）、连通性探测、磁盘分析、定时巡检、看门狗、证书巡检、基线合规、部署评审、群机器人推送。
- **文件与开发**：本地 / SFTP 资源管理器、上传下载、断点续传、双栏管理、sudo 模式、目录同步、文件预览、外部编辑器回传、报错定位、配置解释、配置按键对比、Git 面板、接口调试。
- **数据与集群**：本机 / 远程 Docker、Compose、Kubernetes，MySQL / PostgreSQL / Redis / MongoDB 快查与备份。
- **安全**：应用锁、密钥保险箱、按主机授权、命令规则、AI 复核、预演模式、危险命令确认、sudo 限时提权、执行记录、终端录像与会话日志；密钥经系统密钥链加密，发给模型前可脱敏。
- **打包**：Windows NSIS 安装包（未签名），安装包内随附 `LICENSE`、`NOTICE`、`THIRD_PARTY_NOTICES.md`。

**尚未验证**：macOS DMG 与 Linux AppImage 的构建与运行；Team / Enterprise 功能不在社区版内（见 [COMMERCIAL.md](COMMERCIAL.md)）。
