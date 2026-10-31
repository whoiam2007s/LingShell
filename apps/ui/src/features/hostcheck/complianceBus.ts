// 打开「批量合规检查」的窗口事件（主机体检抽屉「合规」页、命令面板、设置 → 合规基线都走这里）。detail = 预选的主机 id
export const COMPLIANCE_BATCH_EVENT = 'lingshell:compliance-batch'
export function openComplianceBatch(hostIds?: string[]): void {
  window.dispatchEvent(new CustomEvent<string[] | undefined>(COMPLIANCE_BATCH_EVENT, { detail: hostIds }))
}
