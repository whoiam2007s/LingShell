// electron-vite 在 ESM 输出时注入 __dirname/__filename 兼容垫片。
// 为类型检查声明它们（运行时由 electron-vite 提供）。
declare const __dirname: string
declare const __filename: string

// Vite 的 ?raw 导入（手机页 HTML 以字符串打进主进程 bundle，见 mobileServer.ts）
declare module '*.html?raw' {
  const content: string
  export default content
}
