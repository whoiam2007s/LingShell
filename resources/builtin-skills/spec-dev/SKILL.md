---
name: spec-dev
description: 开发新功能 / 较大改动前，按 Spec Kit / OpenSpec 兼容格式写 spec（需求 → 设计 → 任务），再实现
version: 1.0.0
when_to_use: 用户要做新功能、跨模块改动、接口或数据模型变化；或说「先写 spec / 出方案 / 设计一下再改」；或项目里已有 specs/ 或 openspec/ 目录
---

# Spec 开发规范

先写清「做什么 / 为什么」，再写「怎么做」，最后拆「怎么验收」。需求是可测的行为契约，不是实现方案。

## 0. 先探测项目用哪套体系（不要另起炉灶）

在项目根看：

- 有 `.specify/` 或 `specs/` → **Spec Kit 模式**（绝大多数情况走这个）
- 有 `openspec/` → **OpenSpec 模式**
- 都没有 → 默认 Spec Kit 模式（建 `specs/`）；用户想放别的位置时先问

已有 spec 就接着改同一份，不要新建一套并行目录。

## 1. Spec Kit 模式（`specs/<###>-<feature>/`）

`<###>` 是三位序号（001、002…），`<feature>` 用小写 kebab-case。三个文件：

| 文件 | 内容 |
|---|---|
| `spec.md` | 用户故事 + 功能需求 + 验收场景 + 成功指标 + 假设 |
| `plan.md` | 技术方案：技术上下文、项目结构、关键决策、风险、迁移/回滚 |
| `tasks.md` | 可勾选任务，按依赖分阶段，每条写文件路径 |

`spec.md` 的关键结构（骨架见本 skill 目录的 `templates/spec.md`）：

- `## User Scenarios & Testing`：用户故事按 P1/P2 排序，每条写「为什么是这个优先级」和「如何独立验收」；
- `### Functional Requirements`：`- **FR-001**: 系统 MUST …`——一条只说一个可观察行为，不写类名 / 库名；
- 每个 FR 下挂一个 `#### Scenario: <名>`，用 **WHEN / THEN**（4 个 `#`，OpenSpec 也认这个格式）；
- `## Success Criteria`：`SC-001` 必须可度量；
- `## Assumptions`：把「没说但按常识取的默认」写明。

`plan.md` 见 `templates/plan.md`；`tasks.md` 见 `templates/tasks.md`：
`- [ ] T001 [P] [US1] 描述（含文件路径）`，`[P]` = 可并行，`[US1]` = 归属哪个用户故事。

## 2. OpenSpec 模式（`openspec/changes/<change-id>/`）

四个文件（骨架见 `templates/proposal.md`、`templates/design.md`）：

```
openspec/changes/<change-id>/
├── proposal.md                 # Why / What Changes / Capabilities / Impact
├── specs/<capability>/spec.md  # delta spec
├── design.md                   # Context / Goals / Decisions / Risks / Migration
└── tasks.md                    # ## 1. 组名 + - [ ] 1.1 任务
```

delta spec 的硬性要求（`openspec validate` 会查）：

- 开头 `# Spec Delta`；新能力第一段是 `## Purpose`（≥50 字符）；
- 用 `## ADDED Requirements` / `## MODIFIED Requirements` / `## REMOVED Requirements`（REMOVED 要写 **Reason** 和 **Migration**）；
- 每条 `### Requirement: <名>`，用 SHALL/MUST，正文 ≤500 字符；
- 每条需求至少一个 `#### Scenario: <名>`（**必须 4 个 `#`**），里面 `- **WHEN**` + `- **THEN**`。

## 3. 写作规则（两种模式通用）

1. **需求只写可观察行为**：实现方式变了但行为不变，就不该改需求。
2. **一条一个行为**：需求里出现「并且 / 或者」多个行为时拆开。
3. **每条需求都要能验收**：写出 WHEN/THEN，或者给出可执行的验收命令。
4. **非功能需求单列**：性能、安全、兼容、i18n、可访问性；写数字，不写「尽量快」。
5. **任务要能独立完成**：每条写清改哪个文件、怎么验证；依赖前序任务的排在后面。
6. **设计写「为什么」**：选 X 不选 Y 的理由、风险和回滚；不写逐行实现。
7. **范围外的事写进 Assumptions / Non-Goals**：防止实现时越界。

## 4. 与 LingShell 工具配合

- 写文件用 `write_file`（一次一个文件，写绝对路径）；读现有代码用 `read_file` / `grep`；
- spec 里「3 条及以上写操作」的落地步骤，执行时走 `propose_plan`；
- 需求有歧义、要在几个方案里选：用 `ask_user`，不要自己猜；
- 需要并行查资料 / 跑测试：派子代理，但子代理只执行，不做 spec 整理。

## 5. 完成前自检

- [ ] 每个 FR 都有 Scenario，每个 Scenario 都有 WHEN 和 THEN
- [ ] 需求里没有类名 / 库名 / 步骤细节
- [ ] 每条 Success Criteria 都可度量
- [ ] 设计里写了回滚 / 迁移（如果有数据或配置变更）
- [ ] 每条任务有文件路径和验收方式，按依赖排序
- [ ] 目录和文件命名符合项目已有体系（Spec Kit / OpenSpec）

## 6. 反模式

- 把需求写成实现方案（「用 Redux 存状态」→ 应该是「状态在刷新后保留」）；
- 任务写成命令清单（「运行 npm test」不是任务，「补 xxx 的测试」才是）；
- 没有 Scenario、没有验收标准的「散文 spec」；
- 新建 `specs/` 而不管项目已有的 `openspec/`（或反过来）。

## 模板位置

本 skill 目录下的 `templates/`：`spec.md`、`plan.md`、`tasks.md`、`proposal.md`、`design.md`。
用 `read_file` 读对应模板再填；读不到时按上面的结构直接写。
