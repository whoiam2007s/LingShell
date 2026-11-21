// 真实数据：当前会话 sess_a6a6cc7e 的 turn_64 / turn_65 + 当前轮（含参考图 chip）
// 结构：每轮 = 三个阶段（提问+chips → 工具/文字 → 产物），横向按轮推进，阶段内竖向多节点
export type Kind = 'ask' | 'chip' | 'tool' | 'text' | 'file'

export interface GNode {
  id: string
  turn: number          // 0 / 1 / 2
  stage: 0 | 1 | 2      // 提问 / 工具文字 / 产物
  kind: Kind
  label: string
  detail?: string
  meta?: string
  badge?: string
  tone?: 'ok' | 'warn' | 'error'
  refs?: string[]       // chip 指向的节点 id
}

export const nodes: GNode[] = [
  // ── 轮 1：turn_64（15:21:52 ~ 15:22:42）──
  { id: 'a0', turn: 0, stage: 0, kind: 'ask', label: '你的提问', detail: '你先找个当前对话画个图然后导出成图片给我看下效果', meta: 'turn_64 · 15:21:52' },
  { id: 't0-1', turn: 0, stage: 1, kind: 'tool', label: 'exec_in_terminal', detail: '查日志 · 统计记录 · 建临时目录', meta: '15:21:52', badge: '×3', tone: 'ok' },
  { id: 't0-2', turn: 0, stage: 1, kind: 'tool', label: 'write_file', detail: 'D:/temp/flow/flow.html', meta: '15:22:18', tone: 'warn' },
  { id: 't0-3', turn: 0, stage: 1, kind: 'tool', label: 'exec_in_terminal', detail: 'msedge --headless 截图', meta: '15:22:27', tone: 'ok' },
  { id: 't0-4', turn: 0, stage: 1, kind: 'tool', label: 'read_image', detail: '读回 flow.png 自查', meta: '15:22:42' },
  { id: 't0-5', turn: 0, stage: 1, kind: 'text', label: 'AI 说明', detail: '生成了效果图，含 9 个节点', meta: '15:22:45' },
  { id: 'p0-1', turn: 0, stage: 2, kind: 'file', label: 'flow.html', detail: 'write_file 产出', meta: '15:22:18' },
  { id: 'p0-2', turn: 0, stage: 2, kind: 'file', label: 'flow.png', detail: '命令产出', meta: '15:22:27', badge: '191 KB' },

  // ── 轮 2：turn_65（15:23:57 ~ 15:31:18）──
  { id: 'a1', turn: 1, stage: 0, kind: 'ask', label: '你的提问', detail: '搞个 html 页面，用 react-flow 用当前会话真实数据生成', meta: 'turn_65 · 15:23:57' },
  { id: 't1-1', turn: 1, stage: 1, kind: 'tool', label: 'write_file', detail: 'package.json', meta: '15:23:57', tone: 'warn' },
  { id: 't1-2', turn: 1, stage: 1, kind: 'tool', label: 'start_background', detail: 'pnpm install', meta: '15:24:00' },
  { id: 't1-3', turn: 1, stage: 1, kind: 'tool', label: 'check_background', detail: '等安装完成', meta: '15:24:48' },
  { id: 't1-4', turn: 1, stage: 1, kind: 'tool', label: 'exec_in_terminal', detail: '查审计：统计 · 分组 · 看字段', meta: '15:24:56', badge: '×5', tone: 'ok' },
  { id: 't1-5', turn: 1, stage: 1, kind: 'tool', label: 'write_file', detail: 'data.ts / FlowView.tsx / main.tsx / index.html / vite.config.ts', meta: '15:25:42', badge: '×5', tone: 'warn' },
  { id: 't1-6', turn: 1, stage: 1, kind: 'tool', label: 'start_background', detail: 'vite 预览服务', meta: '15:26:03' },
  { id: 't1-7', turn: 1, stage: 1, kind: 'tool', label: 'exec_in_terminal', detail: '截图 · 关服务 · 删临时目录', meta: '15:26:46', badge: '×4', tone: 'ok' },
  { id: 't1-8', turn: 1, stage: 1, kind: 'tool', label: '授权 · 危险命令', detail: '已允许', meta: '15:31:16', tone: 'warn' },
  { id: 't1-9', turn: 1, stage: 1, kind: 'text', label: 'AI 说明', detail: '解释关系图与真实数据的差距', meta: '15:31:30' },
  { id: 'p1-1', turn: 1, stage: 2, kind: 'file', label: 'package.json', meta: '15:23:57' },
  { id: 'p1-2', turn: 1, stage: 2, kind: 'file', label: 'data.ts', meta: '15:25:42' },
  { id: 'p1-3', turn: 1, stage: 2, kind: 'file', label: 'FlowView.tsx', meta: '15:25:49' },
  { id: 'p1-4', turn: 1, stage: 2, kind: 'file', label: 'main.tsx', meta: '15:25:52' },
  { id: 'p1-5', turn: 1, stage: 2, kind: 'file', label: 'index.html', meta: '15:25:54' },
  { id: 'p1-6', turn: 1, stage: 2, kind: 'file', label: 'vite.config.ts', meta: '15:26:00' },
  { id: 'p1-7', turn: 1, stage: 2, kind: 'file', label: 'flow-graph.png', meta: '15:26:46', badge: '176 KB' },

  // ── 轮 3：当前轮（带参考图 chip）──
  { id: 'a2', turn: 2, stage: 0, kind: 'ask', label: '你的提问', detail: '我要的是单个会话的流程…这样横向的多个阶段，每个阶段竖向多个节点', meta: '当前轮 · 23:36' },
  { id: 'c2-1', turn: 2, stage: 0, kind: 'chip', label: '📎 参考图', detail: '粘贴的图片-233634.png', meta: 'chip', refs: ['t2-1'] },
  { id: 'c2-2', turn: 2, stage: 0, kind: 'chip', label: '⌘ 会话', detail: 'sess_a6a6cc7e', meta: 'context' },
  { id: 't2-1', turn: 2, stage: 1, kind: 'tool', label: 'exec_in_terminal', detail: '取两轮完整审计（32 条）', meta: '23:37', tone: 'ok' },
  { id: 't2-2', turn: 2, stage: 1, kind: 'text', label: 'AI 说明', detail: '三点设计判断：chip 是数据源 · 跨轮衔接 · 工具与文字分开', meta: '23:38' },
  { id: 't2-3', turn: 2, stage: 1, kind: 'tool', label: 'write_file', detail: '三阶段数据流 demo', meta: '23:39', tone: 'warn' },
  { id: 't2-4', turn: 2, stage: 1, kind: 'tool', label: 'exec_in_terminal', detail: '起预览 · Edge 截图 · 清理', meta: '23:40', badge: '×4', tone: 'ok' },
  { id: 't2-5', turn: 2, stage: 1, kind: 'tool', label: 'read_image', detail: '自查截图渲染', meta: '23:41' },
  { id: 'p2-1', turn: 2, stage: 2, kind: 'file', label: 'flow-stages.png', meta: '23:40', badge: '265 KB' },
  { id: 'p2-2', turn: 2, stage: 2, kind: 'file', label: 'flow-stages 效果图', meta: '23:40' },
]

export interface GEdge { from: string; to: string; label?: string; tone?: 'ok' | 'warn' | 'weak' | 'chip'; dashed?: boolean }
export const edges: GEdge[] = [
  // 轮 1
  { from: 'a0', to: 't0-1', tone: 'ok' },
  { from: 'a0', to: 't0-2', tone: 'ok' },
  { from: 'a0', to: 't0-3', tone: 'ok' },
  { from: 'a0', to: 't0-4', tone: 'ok' },
  { from: 't0-2', to: 'p0-1', label: '写入', tone: 'warn' },
  { from: 't0-3', to: 'p0-2', label: '产出', tone: 'weak', dashed: true },
  // 轮 2
  { from: 'a1', to: 't1-1', tone: 'ok' },
  { from: 'a1', to: 't1-2', tone: 'ok' },
  { from: 'a1', to: 't1-3', tone: 'ok' },
  { from: 'a1', to: 't1-4', tone: 'ok' },
  { from: 'a1', to: 't1-5', tone: 'ok' },
  { from: 't1-1', to: 'p1-1', label: '写入', tone: 'warn' },
  { from: 't1-5', to: 'p1-2', tone: 'warn' },
  { from: 't1-5', to: 'p1-3', tone: 'warn' },
  { from: 't1-5', to: 'p1-4', tone: 'warn' },
  { from: 't1-5', to: 'p1-5', tone: 'warn' },
  { from: 't1-5', to: 'p1-6', tone: 'warn' },
  { from: 't1-7', to: 'p1-7', label: '产出', tone: 'weak', dashed: true },
  // 轮 3
  { from: 'a2', to: 't2-1', tone: 'ok' },
  { from: 'a2', to: 't2-2', tone: 'ok' },
  { from: 'a2', to: 't2-3', tone: 'ok' },
  { from: 'a2', to: 't2-4', tone: 'ok' },
  { from: 'a2', to: 't2-5', tone: 'ok' },
  { from: 'c2-1', to: 't2-1', label: '参考', tone: 'chip', dashed: true },
  { from: 't2-3', to: 'p2-1', label: '写入', tone: 'warn' },
  { from: 't2-4', to: 'p2-2', label: '产出', tone: 'weak', dashed: true },
  // 跨轮：上一轮产物被下一轮用到（示例：这里用真实存在的「同一会话续接」）
  { from: 'p0-2', to: 'a1', label: '上一轮结果', tone: 'weak', dashed: true },
  { from: 'p1-7', to: 'a2', label: '上一轮结果', tone: 'weak', dashed: true },
]
