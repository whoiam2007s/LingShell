// ── 告警一键 AI 排查：终端关键字告警 / 主机体检问题项 / 仪表盘异常卡片 →「用 AI 排查」发给 AI 的话 ──
// 默认开新会话发（一事一会话，不污染手头的对话；同巡检开会话的做法）。上下文由调用方给（终端最近输出、体检摘要、当前指标），发送前调用方脱敏

import { tr } from '../i18n/i18n.js'

export interface TroubleshootReq {
  host: string             // 给人看的主机名（终端标题 / 主机名称）
  hostId?: string          // 已保存主机 id（AI 可据此 create_terminal 连上去）
  terminalId?: string      // 告警所在终端（还开着，AI 可直接在里面只读排查）
  alert: string            // 告警 / 问题一句话
  context?: string         // 上下文（多行原文）
}
export const TROUBLESHOOT_CONTEXT_MAX = 4000

export function troubleshootPrompt(r: TroubleshootReq): string {
  const ctx = (r.context ?? '').trim()
  const cut = ctx.length > TROUBLESHOOT_CONTEXT_MAX ? `…${ctx.slice(-TROUBLESHOOT_CONTEXT_MAX)}` : ctx
  const where = r.terminalId ? `（终端 ${r.terminalId}${r.hostId ? `，已保存主机 id：${r.hostId}` : ''}）` : r.hostId ? `（已保存主机 id：${r.hostId}）` : ''   // i18n-ignore 发给 AI 的话
  const L = [`「${r.host}」${where}出现 ${r.alert}${cut ? '：' : '，请排查原因。'}`]   // i18n-ignore 发给 AI 的话
  if (cut) L.push('```', cut, '```', '请排查原因。')   // i18n-ignore 发给 AI 的话
  L.push('', '先只读排查（查看日志、状态、资源占用），给出最可能的原因和依据；需要改动时先说明影响和回滚办法，等我确认再执行。'   // i18n-ignore 发给 AI 的话
    + (r.terminalId ? '' : r.hostId ? '需要时用 create_terminal（type=ssh）打开它的终端。' : ''))   // i18n-ignore 发给 AI 的话
  return L.join('\n')
}

/** 会话标题：「排查：web-1 磁盘 / 已用 96%」（截短） */
export const troubleshootTitle = (r: Pick<TroubleshootReq, 'host' | 'alert'>) => tr('排查：{host} {alert}', { host: r.host, alert: r.alert }).replace(/\s+/g, ' ').slice(0, 30)
