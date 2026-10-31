// MainContext：各领域 register.ts 共用的东西（窗口、数据目录、事件、系统设置，以及多个领域都用到的服务）。
// 由 services.ts 的 createMainContext 创建；只有一个领域用的服务不放这里，在该领域里创建或作为参数传入
import type { createMainContext } from '../services.js'

export type MainContext = ReturnType<typeof createMainContext>
