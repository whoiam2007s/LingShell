// 打开知识库视图的窗口事件（活动栏 / 命令面板 / 主机面板 / 对话里的知识卡都走这里，组件树隔得远）
import type { KnowledgeFilter } from '@lingshell/shared'

export const KNOWLEDGE_OPEN_EVENT = 'lingshell:knowledge-open'
export function openKnowledge(filter: KnowledgeFilter = {}): void {
  window.dispatchEvent(new CustomEvent<KnowledgeFilter>(KNOWLEDGE_OPEN_EVENT, { detail: filter }))
}

/** 归属选择框的值：global / group:<名> / host:<hostKey> */
export const scopeValue = (scope: string, target: string) => (scope === 'global' ? 'global' : `${scope}:${target}`)
export function parseScopeValue(v: string): { scope: 'host' | 'group' | 'global'; target: string } {
  if (v === 'global') return { scope: 'global', target: '' }
  const i = v.indexOf(':')
  return { scope: v.slice(0, i) === 'group' ? 'group' : 'host', target: v.slice(i + 1) }
}
