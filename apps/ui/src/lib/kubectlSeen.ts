// 每个终端探测一次 kubectl 的结果：「更多视图」菜单里提示「未检测到」，K8s 抽屉重新检测后同步。
// 放在 lib：运维视图（写）和 K8s 抽屉（读 / 写）都要用，直接互相 import 会形成循环依赖
const kubectlSeen = new Map<string, boolean>()
export const noteKubectl = (termId: string, found: boolean) => { kubectlSeen.set(termId, found) }
export const kubectlFound = (termId: string) => kubectlSeen.get(termId)
