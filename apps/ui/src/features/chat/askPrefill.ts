// 面板「问 AI」把问题预填进输入框的规则（纯函数，方便单测）：
//  - 输入框空着             → 用这句问题
//  - 还停在上一次自动预填的 → 换成新的（连着点几个面板不会留一堆旧问题）
//  - 用户自己打了字         → 不动（点 ✨ 不该冲掉正在写的内容）
export function prefillAsk(prev: string, question: string, lastAuto: string): string {
  const cur = prev.trim()
  if (!cur) return question
  return cur === lastAuto.trim() ? question : prev
}
