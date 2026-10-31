# 更新日志

本项目遵循[语义化版本](https://semver.org/lang/zh-CN/)。版本号在 `apps/desktop/package.json` 与根 `package.json` 中同步维护。

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
