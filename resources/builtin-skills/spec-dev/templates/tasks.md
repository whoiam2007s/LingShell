# Tasks: <feature>

**Input**: `spec.md` + `plan.md`

**Format**: `- [ ] T### [P] [US#] 描述（含文件路径）`
- `[P]` = 可并行（不同文件、无依赖）
- `[US#]` = 归属哪个用户故事

## Phase 1: Setup

- [ ] T001 [P] <任务，含文件路径>
- [ ] T002 [P] <任务>

## Phase 2: Foundational

- [ ] T003 <任务；完成后所有用户故事才能开始>

## Phase 3: User Story 1 (P1)

- [ ] T004 [US1] <任务，含文件路径和验收方式>
- [ ] T005 [US1] <任务>

## Phase 4: User Story 2 (P2)

- [ ] T006 [US2] <任务>

## Phase N: Polish

- [ ] TXXX [P] 文档更新
- [ ] TXXX 回归测试

## Dependencies & Execution Order

- Phase 1 → Phase 2 → 用户故事（可按 P1 → P2 顺序，也可并行）
- 每个阶段结束是一个可独立验收的检查点
