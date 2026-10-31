// ESLint 9 flat config
import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import globals from 'globals'
import { readdirSync } from 'node:fs'

// ── 目录边界：其它目录只能经 index.ts 引用（目录名启动时读取，新加的目录自动生效）──
const dirsOf = (p) => readdirSync(new URL(p, import.meta.url), { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name)
const FEATURES = dirsOf('./apps/ui/src/features/').join('|')
const MAIN_DOMAINS = dirsOf('./apps/desktop/src/main/').join('|')
const SHARED_DOMAINS = dirsOf('./packages/shared/src/').join('|')
const up = (n) => '(\\.\\./){' + n + '}'
const notIndex = '(?!index\\.js$)'
// 在某个领域目录（或其子目录，深 depth 层）里：退回上层再进别的领域、且不是那个领域的 index.js
const crossDomain = (domains, depth, msg) => ({ regex: `^${up(depth)}(${domains})/${notIndex}`, message: msg })
const BOUNDARY_UI = '功能目录之间只能经对方的 index.ts 引用（features/<目录>/index.js）；要用的东西先在对方 index.ts 里导出'
const BOUNDARY_MAIN = '领域目录之间只能经对方的 index.ts 引用（<领域>/index.js）；要用的东西先在对方 index.ts 里导出'
const BOUNDARY_SHARED = 'shared 的领域之间只能经对方的 index.ts 引用（<领域>/index.js），不要引用根 index.ts'
// UI 原有规则：业务代码不直接碰 Electron / IPC（与边界规则合并成一个配置，flat config 里同名规则后者覆盖前者）
const NO_ELECTRON = {
  paths: [{ name: 'electron', message: '业务代码禁止直接 import electron，请通过 client 层' }],
  patterns: [{ group: ['**/preload/**', '**/main/**'], message: '业务代码禁止访问 Electron 进程代码，请通过 client 层' }],
}
const uiBoundary = (depth) => ['error', {
  paths: NO_ELECTRON.paths,
  patterns: [...NO_ELECTRON.patterns, crossDomain(FEATURES, depth, BOUNDARY_UI), { regex: `(^|/)features/(${FEATURES})/${notIndex}`, message: BOUNDARY_UI }],
}]

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // 忽略产物目录
    ignores: ['**/dist/**', '**/out/**', '**/node_modules/**']
  },
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      globals: { ...globals.node, ...globals.browser }
    },
    rules: {
      // 下划线前缀的参数/变量允许未用（惯例：标记"故意不用"的参数，如接口要求但实现不需要的）
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    }
  },
  {
    // 测试文件：mock/替身用 any 是惯例，放宽 no-explicit-any
    files: ['**/*.test.{ts,tsx}'],
    rules: { '@typescript-eslint/no-explicit-any': 'off' }
  },
  {
    // cli/ 是给外部 agent 调的裸 Node 脚本（无构建、无 TS），补 node 全局
    files: ['cli/**/*.mjs'],
    languageOptions: { globals: globals.node }
  },
  {
    // UI 里 features 以外的代码（App、lib、components…）引用功能目录也只能经 index.ts
    files: ['apps/ui/src/**/*.{ts,tsx}'],
    rules: { 'no-restricted-imports': ['error', { patterns: [{ regex: `(^|/)features/(${FEATURES})/${notIndex}`, message: BOUNDARY_UI }] }] }
  },
  {
    // 传输无关原则：前端业务代码禁止直接碰 Electron/IPC，必须经 client 层；功能目录之间经 index.ts（见 uiBoundary）
    files: ['apps/ui/src/features/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': uiBoundary(1),
      'no-restricted-globals': ['error',
        { name: 'electronAPI', message: '业务代码禁止用 window.electronAPI，请通过 client 层' }
      ]
    }
  },
  // 功能目录的子目录里：多退一层才到 features/
  { files: ['apps/ui/src/features/*/*/*.{ts,tsx}'], rules: { 'no-restricted-imports': uiBoundary(2) } },
  { files: ['apps/ui/src/features/*/*/*/*.{ts,tsx}'], rules: { 'no-restricted-imports': uiBoundary(3) } },
  // 主进程：ipc.ts / index.ts 与各领域之间、领域与领域之间都经 index.ts
  { files: ['apps/desktop/src/main/*.ts'], rules: { 'no-restricted-imports': ['error', { patterns: [{ regex: `^\\./(${MAIN_DOMAINS})/${notIndex}`, message: BOUNDARY_MAIN }] }] } },
  ...[1, 2].map((d) => ({ files: [`apps/desktop/src/main/${'*/'.repeat(d)}*.ts`], rules: { 'no-restricted-imports': ['error', { patterns: [crossDomain(MAIN_DOMAINS, d, BOUNDARY_MAIN)] }] } })),
  // shared：根 index.ts 只经各领域 index；领域里不引用根 index.ts；
  // 领域之间引用具体文件，不引用对方的 index（barrel 会把整个领域拉进来，和对方的反向引用形成循环依赖）。纯类型不受限
  { files: ['packages/shared/src/*.ts'], rules: { 'no-restricted-imports': ['error', { patterns: [{ regex: `^\\./(${SHARED_DOMAINS})/${notIndex}`, message: BOUNDARY_SHARED }] }] } },
  ...[1, 2, 3].map((d) => ({
    files: [`packages/shared/src/${'*/'.repeat(d)}*.ts`],
    ignores: ['**/*.test.ts'],
    rules: {
      '@typescript-eslint/no-restricted-imports': ['error', {
        patterns: [
          { regex: `^${up(d)}(${SHARED_DOMAINS})/index\\.js$`, allowTypeImports: true, message: 'shared 的领域之间不要引用对方的 index.ts（会拉进整个领域、形成循环依赖），改为引用具体文件；纯类型可以继续经 index' },
          { regex: `^${up(d)}index\\.js$`, message: BOUNDARY_SHARED },
        ],
      }],
    },
  })),
  {
    // 各领域 register.ts 之间只能有类型引用：领域 index 会导出 register，值引用会把那个领域整个拉进来——
    // ai/index 经 skillsIpc 带进 dsh-controller（要较新 Node 的 zlib zstd，单测里加载失败），
    // app/index 带进 background.ts（模块顶层调 app.on）。要用的值放进 services.ts 的 MainContext，经 ctx 传入
    // （用 typescript-eslint 的同名规则，因为要 allowTypeImports；不影响上面的目录边界规则）
    files: ['apps/desktop/src/main/*/register.ts'],
    rules: {
      '@typescript-eslint/no-restricted-imports': ['error', {
        paths: [{ name: '@lingshell/dsh-controller', allowTypeImports: true, message: 'register.ts 不直接引用 dsh-controller 的值（会拉进整个 dsh），经 ctx（services.ts）传入' }],
        patterns: [{ regex: '^\\.\\./(ai|app)/index\\.js$', allowTypeImports: true, message: 'register.ts 不直接引用 ai/index、app/index 的值（ai 带进 dsh-controller，app 带进 background.ts 顶层的 app.on），经 ctx（services.ts）传入' }],
      }],
    },
  },
  {
    // transports/ipc/<领域>.ts 之间互不引用：每个领域只实现自己的命名空间，组合在 IpcTransport.ts
    files: ['apps/ui/src/client/transports/ipc/*.ts'],
    rules: { '@typescript-eslint/no-restricted-imports': ['error', { patterns: [{ regex: '^\\./', message: 'transports/ipc/<领域>.ts 之间不互相引用；共用的东西放到 IpcTransport.ts 或 @lingshell/shared' }] }] },
  },
  {
    // 表单控件统一：业务代码不直接用原生下拉 / 候选 / 勾选 / 单选 / 数字框（深色主题下样式不一致），
    // 改用 apps/ui/src/components/ui 里的 Select / Combobox / Checkbox / Radio / NumberInput（那里允许用原生）
    files: ['apps/ui/src/features/**/*.tsx'],
    rules: {
      'no-restricted-syntax': ['error',
        { selector: "JSXOpeningElement[name.name='select']", message: '不要用原生 <select>，请用 components/ui/Select' },
        { selector: "JSXOpeningElement[name.name='datalist']", message: '不要用 <datalist>，请用 components/ui/Combobox' },
        { selector: "JSXOpeningElement[name.name='input'] > JSXAttribute[name.name='list']", message: '不要用 <input list>，请用 components/ui/Combobox' },
        { selector: "JSXOpeningElement[name.name='input'] > JSXAttribute[name.name='type'][value.value=/^(checkbox|radio|number)$/]", message: '不要用原生 checkbox / radio / number，请用 components/ui 的 Checkbox / Radio / NumberInput（开关语义用 Switch）' },
        { selector: "JSXOpeningElement[name.name='input'] > JSXAttribute[name.name='type'][value.value='password']", message: '密码框请用 components/ui/PasswordInput（带显示切换、隐藏真实长度）' },
      ]
    }
  }
)
