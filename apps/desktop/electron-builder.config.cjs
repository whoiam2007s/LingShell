// 打包配置入口：静态配置都在 electron-builder.yml，这里按环境变量/平台追加几样东西（见 docs/release.md）。
//
// 1. 自动更新源：构建时设了 LINGSHELL_UPDATE_URL → 写 publish(generic)，electron-builder 会生成
//    resources/app-update.yml（运行时 updater 据此启用）和 release/latest.yml（上传到更新服务器）。
//    没设 → publish 显式置 null：不生成 app-update.yml，应用内更新完全禁用；
//    也避免 electron-builder 在有 GH_TOKEN 等环境变量时自动推断出 github 发布源。
//
// 2. 代码签名：electron-builder 自动读取 CSC_LINK / CSC_KEY_PASSWORD（或 Windows 专用的
//    WIN_CSC_LINK / WIN_CSC_KEY_PASSWORD），这里无需配置；都没设就跳过签名，照旧出未签名安装包。
//
// 3. Linux 两处必须显式指定（Windows 没这些限制，所以一直没暴露）：
//    - icon：electron-builder 的 icon-tool 只认 .png/.svg/.icns，仓库只有 icon.ico，会给
//      Unsupported input format ".ico" 并中断。icon.png 由 build/gen-icon.cjs 从 logo.svg 渲染。
//    - executableName：包名是 @lingshell/desktop，拿它当可执行文件名会撞
//      "characters that cannot be safely used in file paths"，这里固定成 lingshell。
const url = (process.env.LINGSHELL_UPDATE_URL || '').trim()

module.exports = {
  extends: 'file:electron-builder.yml',
  publish: url ? [{ provider: 'generic', url }] : null,
  linux: {
    icon: 'build/icon.png',
    category: 'Development',
    executableName: 'lingshell',
  },
}
