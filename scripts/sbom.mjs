#!/usr/bin/env node
// 生成 CycloneDX 1.5 SBOM（JSON）。数据来自 `pnpm licenses list --json`，
// 不联网、不引额外工具，CI 里也能跑。
//
// 用法：node scripts/sbom.mjs [输出路径]      默认 sbom.json
//       pnpm sbom release/sbom.json
import { execSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'

const out = process.argv[2] ?? 'sbom.json'
const root = JSON.parse(readFileSync('package.json', 'utf8'))

// pnpm licenses list --json 的形状：{ "<许可证表达式>": [{ name, versions: [...] }, ...] }
const byLicense = JSON.parse(
  execSync('pnpm licenses list --json', { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 }),
)

const components = []
for (const [license, packages] of Object.entries(byLicense)) {
  // 单个 SPDX 标识符用 id，表达式（如 "(MIT OR CC0-1.0)"）用 expression
  const simple = /^[A-Za-z0-9.+-]+$/.test(license)
  for (const pkg of packages) {
    for (const version of pkg.versions ?? []) {
      components.push({
        type: 'library',
        name: pkg.name,
        version,
        licenses: simple ? [{ license: { id: license } }] : [{ expression: license }],
      })
    }
  }
}
components.sort((a, b) => `${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`))

const bom = {
  bomFormat: 'CycloneDX',
  specVersion: '1.5',
  serialNumber: `urn:uuid:${randomUUID()}`,
  version: 1,
  metadata: {
    timestamp: new Date().toISOString(),
    tools: [{ vendor: 'LingShell', name: 'scripts/sbom.mjs', version: '1' }],
    component: {
      type: 'application',
      name: root.name,
      version: root.version,
      licenses: [{ license: { id: root.license } }],
    },
  },
  components,
}

writeFileSync(out, `${JSON.stringify(bom, null, 2)}\n`)
console.log(`SBOM 已生成：${out}（${components.length} 个依赖组件）`)
