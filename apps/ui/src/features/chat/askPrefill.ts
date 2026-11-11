// 面板「问 AI」把问题预填进输入框的规则（纯函数，方便单测）：
//  - 输入框空着                 → 用这句问题
//  - 末尾还是上次自动预填的那句 → 换成这句（连点几个面板不会叠一串旧问题）
//  - 用户自己写了字             → 换行补在下面（不冲掉用户的内容，但问题一定带进去）
export function prefillAsk(prev: string, question: string, lastAuto: string): string {
  const cur = prev.trim()
  if (!cur) return question
  const last = lastAuto.trim()
  // 末尾这段是上次自动补的：换掉它，用户自己写的内容留在上面
  if (last && cur.endsWith(last)) {
    const head = cur.slice(0, cur.length - last.length).trimEnd()
    return head ? `${head}\n\n${question}` : question
  }
  return `${prev.trimEnd()}\n\n${question}`
}
