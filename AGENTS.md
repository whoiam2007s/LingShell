# LingShell 项目记忆（AGENTS.md）

> 本文件是项目的长期记忆与工作约定，从原 Claude Code 记忆（66 篇）提炼而来；全文归档在 [`docs/memory/`](docs/memory/MEMORY.md)，遇到细节先查那里。
> `docs/` 是本地的开发文档与项目记忆，已加入 `.gitignore`，**不随公开仓库发布**；从 GitHub 克隆的仓库里没有该目录，看到文中 `docs/` 链接时按本地路径理解。
> 与历史记忆冲突时，以**当前代码**和本文件为准。

**始终用简体中文回复。**

## 项目是什么

灵壳 LingShell：Electron 桌面端「AI 终端 + 运维工作台」。左侧 AI 对话，右侧本地终端 / SSH 主机；AI 经工具调用在用户授权后执行命令、读结果、继续下一步。定位是单机、本地优先、BYO Key、开源社区版（Apache-2.0），闭源 Team Server 另行收费。

- 技术栈：Electron 40 + React 19 + xterm.js 6 + node-pty + ssh2 + Tailwind v3 + Vite 8 + Turborepo。
- AI 引擎：**DeepSeek Harness（`@deepseek-ai/dsh-*` 0.2.1-rc.2）进程内嵌**，封装在 `packages/dsh-controller`。CodeWhale 已完全退出运行路径，相关记忆只作历史背景。
- 当前版本 0.1.x（早期版本，接口/配置可能变）。平台优先 Windows。

## 常用命令

```bash
pnpm install            # pnpm 9.0.0（packageManager 固定）；若全局 pnpm 版本不对，用 npx pnpm@9.0.0
pnpm dev                # Vite(:5183) + Electron，等待前端就绪后启动
pnpm typecheck          # 全量 TS
pnpm lint
pnpm test               # turbo run test（部分 e2e 需要 Electron 的 Node，系统 Node 缺 zstd 会跳过）
pnpm check:structure    # TDZ + IPC 协议三方一致 + 目录边界（eslint）
pnpm i18n:check         # 改过界面文案必跑
pnpm build              # libs + ui + desktop
pnpm dist:win           # Windows NSIS 安装包 → release/（未签名）
```

## 目录结构

```
apps/
  desktop/   Electron 主进程 + preload + IPC 装配（electron-vite）
  ui/        React 渲染层（Vite），可独立跑
packages/
  shared/         两端契约/类型/纯逻辑、i18n、protocol/client
  terminal-core/  本地 / SSH 终端、命令捕获、tmux、日志与录像
  dsh-controller/ DeepSeek Harness 会话、工具、压缩、附件、Skills、MCP
  auth-registry/  授权决策链 + 危险命令检测
  config/         设置 / 主机 / 凭据 / 会话 / 布局 / 历史等持久化
  platform/       数据路径与日志
cli/              外部 agent 调本地 API 的脚本
docs/             设计、迁移、功能说明、memory/
scripts/          check-tdz / check-protocol / i18n-check / 打包冒烟等
```

主进程领域：`terminal, ai, ops, files, git, db, integrations, mobile, app`（内部还有 `core/`）。每个目录只用 `index.ts` 对外；跨目录必须经 index（ESLint 强制）。`apps/ui/src/features/**` 禁止直接 import Electron / `window.electronAPI`，一律走 `client`（`AppClient`）。

**加一个 IPC 通道改 4 处**：`apps/desktop/src/main/<领域>/register.ts`、`packages/shared/src/protocol/client/<领域>.ts`、`apps/ui/src/client/transports/ipc/<领域>.ts`、`apps/ui/src/client/transports/HttpTransport.ts`；然后 `node scripts/check-protocol.mjs --write` + `pnpm check:structure`。

## 命名约定（2026-10-25 全量改名）

- 目录：项目源码在 `source/`；展示名统一 **LingShell / 灵壳**。
- npm 包作用域：`@lingshell/*`（小写）；根包名 `lingshell`。
- 环境变量：`LINGSHELL_*`（`LINGSHELL_DATA_DIR`、`LINGSHELL_BASH`、`LINGSHELL_UPDATE_URL`、`LINGSHELL_RENDERER_URL` 等）。
- 数据目录：`~/.lingshell`；Electron `userData` 固定 `%APPDATA%\LingShell`（开发版与安装版共用）。
- appId / AppUserModelId：`com.lingshell.app`；安装包 `LingShell-<版本>-win-x64.exe`。
- 内部事件 / localStorage 键：`lingshell:*`、`lingshell.*`。
- **不再保留 ai-shell / AI_SHELL / .ai-shell 旧名兼容**：改名前的目录迁移、旧配置导入、旧环境变量回退都已删除；不要重新引入。

## 数据与安全

- 业务数据全部在 `~/.lingshell`：`config/`（JSON，凭据用 safeStorage 字段级加密）、`logs/`、`sessions/`、`recordings/`。浏览器数据在 `%APPDATA%\LingShell`。
- **safeStorage 密文与 userData 路径绑定**：不要改 `app.setPath('userData', ...)`，不要搬目录；否则已存 API Key / 主机密码全部解不开（见 `docs/memory/electron-safestorage-path-bound.md`）。
- 安全底线：AI 不静默执行；每条命令按主机授权，生产写操作逐条确认；危险命令强制确认；密钥不落明文；发送模型前可脱敏；执行记录可审计。不要为了测试通过而降低这些校验。
- 单实例锁按 userData；多开会互相覆盖 `~/.lingshell/config`。自测必须用隔离 `--user-data-dir` + `LINGSHELL_DATA_DIR`。
- 窗口标题 / 任务栏名称已统一「灵壳 LingShell」。

## 工作方式与验收

- 用户要求：**能自动化验证的自己验证，不要逐项让用户点**；只把真实机器人、真实生产主机、安装包体验留给用户。
- 交付前按「质量清单」自测：真实鼠标/键盘（CDP）、选择语义、悬停占位、下拉、空状态、提示准确、本机 + SSH 两通道、危险操作确认与执行记录。
- 自测隔离：`unset ELECTRON_RUN_AS_NODE`；`LINGSHELL_DATA_DIR=<临时>`；`--user-data-dir=<临时>`；假 SSH（ssh2 本地服务）/ 假 OpenAI 兼容服务；绝不用真实 API Key 或生产主机。
- 用户偏好：一次只验一项、说明短；不要不动手就问；大改动先给清单。

## 已知坑（当前仍适用）

1. **node-pty 打包**：1.1.0 自带 N-API prebuilds，`npmRebuild: false` + `asarUnpack: **/*.node, node-pty/**`；不要开 rebuild，否则 winpty 源码编译失败。
2. **Tailwind v3 变量色透明度**：`bg-[var(--c)]/NN` 不生成样式，用 `color-mix` 写法。
3. **i18n**：中文原文即键，`tr()` / `tk()`；英文词典在 `packages/shared/src/i18n/locales/en/<块>.ts`；帮助正文有 `helpContent.en.ts` 两份、结构须一致；改文案跑 `pnpm i18n:check`。模型提示词保持中文。
4. **结构守护**：`check:tdz` 防顶层循环读取；`check:protocol` 校验主进程 / 协议 / 前端 IPC 三方一致。新增通道漏一处会被拦。
5. **Git Bash（Windows）**：本地终端与 AI 本地执行依赖 Git for Windows；不认 `System32\bash.exe`（WSL）。GNU grep 3.0 的 `-i -F` 同用会 SIGABRT 且静默，远程检索用 `-E` + ERE 转义。
6. **dsh 事件回调**：不能在 session/event 回调里同步 `followup/append`（`cannot reenter`），先 `whenIdle` 或 `setTimeout` 跳出。
7. **自动压缩**：超限自动压缩并继续，不暂停；只有「步数多且已压缩」才建议开新会话。阈值 = min(600K, 模型上下文 × 60%)，不要再加可配阈值。
8. **多模态图片**：需自建 `ctx.attachments`（`LocalImageStore`）并在路由声明 `input: ['text','image']`，否则图片会被静默换成文字。
9. **Electron 构建**：main 用 ESM，preload 必须输出 CJS；electron / node-pty / ssh2 保持 external。
10. **测试环境**：Vitest 并发跑 terminal-core 的 PowerShell 用例偶发失败，单独重跑可过；e2e 需要在 Electron 的 Node 下跑。
11. **pnpm 版本管理**：全局 pnpm 12 可能尝试自我安装 pnpm 9 失败；用 `npx pnpm@9.0.0` 最稳。
12. **Windows 跑测试的 PATH**：desktop 里有用例直接 `spawn('bash' / 'ssh-keygen' / 'openssl')`，需要把 `C:\Program Files\Git\bin`、`C:\Program Files\Git\usr\bin`（以及 `mingw64\bin`）加进 PATH，否则会 ENOENT 或超时。应用运行不依赖这个 PATH（Git Bash 走 `detectGitBash` 的注册表探测）。

## 记忆归档

- 索引与 66 篇原始记忆（含索引）、全局指令存档与改名记录：[`docs/memory/MEMORY.md`](docs/memory/MEMORY.md)。
- 历史文档（设计 / 计划 / 验收）：`docs/superpowers/`、`docs/功能清单与验证说明.md`、`docs/打包回归验收.md`。
- 结构与 IPC 细则：`docs/structure-refactor/README.md`、`CONTRIBUTING.md`。
- i18n 细则：`docs/i18n.md`；发版 / 自动更新：`docs/release.md`。
- 这些文档中的提交号、分支名、CodeWhale 机制属于历史记录，不代表当前实现。
