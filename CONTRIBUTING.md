# 贡献指南

感谢参与灵壳 LingShell。这个项目是社区版（Apache-2.0），欢迎 issue、文档、测试和代码。

## 先读

- [README](README.md) · [行为准则](CODE_OF_CONDUCT.md) · [安全披露](SECURITY.md) · [CLA](CLA.md)
- 商业版边界见 [COMMERCIAL.md](COMMERCIAL.md)。请不要把闭源的 Team Server / 企业模块代码提交到这个仓库。

## 环境

- Node.js ≥ 18、pnpm 9、Git。
- Windows 本地终端需要 Git for Windows；开发 node-pty 可能需要 VS Build Tools。
- 首次安装：`pnpm install`。
- 启动：`pnpm dev`（UI dev server + Electron）。

## 提交前自测

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm check:structure   # 目录边界、IPC 协议三方一致、循环依赖里的顶层读取（见下文「代码结构」）
pnpm i18n:check        # 改了界面文案时
```

- `pnpm test` 是本地全量（包含 `*.real.test.ts`：需要真实 Git Bash / SSH / Docker 和稳定的宿主机时序，机器负载高时会有偶发失败）；CI 跑的是 `pnpm test:ci`，排除这些用例。

- 涉及 UI 的改动请附截图或录屏；涉及终端 / SSH 的改动说明测试环境。
- 新增纯逻辑请补单元测试；涉及主进程 IPC 的改动请补参数校验和失败路径。
- 不要提交真实 API Key、主机密码、私钥、内部地址或客户数据。
- 不要为了让测试通过而降低安全校验（授权、脱敏、路径校验、危险命令检测等）。

## 代码风格

- TypeScript strict；沿用现有文件命名、注释密度和 UI 组件写法。
- 新文件建议加 `SPDX-License-Identifier: Apache-2.0` 头。
- 用户可见文案用简体中文原文写（`tr('…')`），英文译文放词典；英文文档 / 注释欢迎补充。
- 一个 PR 只做一件事，避免顺手重构无关文件。

## 代码结构

按领域分目录，每个目录用 `index.ts` 作为唯一对外入口，目录内部保持平铺。

| 位置 | 放什么 |
| --- | --- |
| `apps/desktop/src/main/<领域>/` | 主进程：领域是 terminal、ai、ops、files、git、db、integrations、mobile、app。`register.ts` 注册该领域的 IPC 通道，多个领域共用的服务在 `services.ts`，日志 / 诊断在 `core/`。`ipc.ts` 只负责装配 |
| `packages/shared/src/<领域>/` | 两端共用的类型和纯逻辑。领域是 protocol、i18n、terminal、ai、files、ops、db、git、ui。`protocol/client/<领域>.ts` 是渲染层调主进程的接口（`AppClient`） |
| `apps/ui/src/features/<功能>/` | 界面功能。`lib/`、`components/` 是公用的底层，不引用 features |
| `apps/ui/src/client/transports/ipc/<领域>.ts` | `AppClient` 的 IPC 实现，和主进程领域一一对应 |

新功能放进它所属的领域目录。领域内部的文件直接互相引用；别的目录要用，就在该目录的 `index.ts` 里导出，再从 `index.ts` 引用（ESLint 会拦）。例外是 `packages/shared` 内部：领域之间直接引用具体文件、不要引用对方的 index（会拉进整个领域、形成循环依赖），纯类型不受限。被多个功能共用的小件放到 `apps/ui/src/components/` 或 `lib/`，不要跨功能引用。

`@lingshell/shared` 根入口导出全部内容；只用到一个领域时也可以写 `@lingshell/shared/<领域>`，如 `@lingshell/shared/i18n`。

**加一个 IPC 通道要改 4 处：**

1. `apps/desktop/src/main/<领域>/register.ts`：`ipcMain.handle('<前缀>:<名字>', …)`，校验参数
2. `packages/shared/src/protocol/client/<领域>.ts`：在对应命名空间里加方法签名
3. `apps/ui/src/client/transports/ipc/<领域>.ts`：`window.electronAPI.invoke('<前缀>:<名字>', …)`
4. `apps/ui/src/client/transports/HttpTransport.ts`：补占位（`ni`）

改完跑 `node scripts/check-protocol.mjs --write`（IPC 清单会生成到本地 `docs/structure-refactor/`，该目录不随仓库发布），再跑 `pnpm check:structure`。

**用户可见文案**一律走 `tr()`，并在英文词典里补上对应条目，改完跑 `pnpm i18n:check` 校验。

## 提交信息

建议使用 Conventional Commits：

```
feat(terminal): ...
fix(chat): ...
docs(help): ...
chore(repo): ...
```

## PR 流程

1. Fork，从 `master` 建分支（`feat/...`、`fix/...`、`docs/...`）。
2. 提交前跑 typecheck / lint / test，并在 PR 描述里写清测试方式。
3. 首次贡献在 PR 里评论：`I have read the CLA and I agree to its terms.`（或按 CLA Assistant 提示操作）。
4. 维护者会做代码审查；涉及安全的改动会额外审查。
5. 合并后你的贡献按 Apache-2.0 发布；你保留自己的版权。

## 功能建议

- 先开 issue 描述使用场景、现状和期望，不要直接写大功能再提 PR。
- 社区版功能应保持单机可用、本地优先；团队 / 集中管理类需求请标记为 `team-edition` 讨论。
- 安全漏洞不要开公开 issue，按 [SECURITY.md](SECURITY.md) 私下报告。

## 文档

- 用户可见功能请同步更新 `apps/ui/src/features/help/helpContent.ts`（F1 帮助）。
- 较大变更请在 `docs/` 补设计或迁移说明。
- 文档里的命令、按钮名、菜单路径必须和实际界面一致。

## 联系

维护者：BigZ（`whoiam2007s@163.com`）。安全问题请按 [SECURITY.md](SECURITY.md) 私下报告。

## 许可证与商标

- 代码采用 [Apache-2.0](LICENSE)。
- 名称 / Logo 使用规则见 [TRADEMARK.md](TRADEMARK.md)。
- 提交贡献即表示你同意 [CLA](CLA.md)。
