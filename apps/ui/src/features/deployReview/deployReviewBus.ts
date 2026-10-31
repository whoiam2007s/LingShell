// 打开「部署评审」的窗口事件（活动栏按钮、命令面板都走这里）。detail = 要打开的评审 id
export const DEPLOY_REVIEW_EVENT = 'lingshell:deploy-review'
export function openDeployReview(id?: string): void {
  window.dispatchEvent(new CustomEvent<string | undefined>(DEPLOY_REVIEW_EVENT, { detail: id }))
}
