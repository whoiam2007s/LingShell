// 打开「手册视图」的窗口事件（设置 → 运维手册「打开」、命令面板、终端活动栏都走这里）
export const RUNBOOK_VIEW_EVENT = 'lingshell:runbook-view'
export function openRunbookView(id?: string): void {
  window.dispatchEvent(new CustomEvent<string | undefined>(RUNBOOK_VIEW_EVENT, { detail: id }))
}
