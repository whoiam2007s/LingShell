import { defineConfig } from 'vitest/config'

// 本包的 e2e 用例在 beforeAll 里起本地假模型 / 假 MCP 服务，
// vitest 默认 10s 的 hookTimeout 在 CI 或高负载机器上不够用，会表现为
// "Hook timed out in 10000ms"，随后 afterAll 里 ctrl 还是 undefined。
// 另外把范围限定到 src：dist/ 是 tsc 产物，里面有编译后的同名测试，
// 缺 __fixtures__ 时会误报。
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    hookTimeout: 120_000,
    testTimeout: 120_000,
  },
})
