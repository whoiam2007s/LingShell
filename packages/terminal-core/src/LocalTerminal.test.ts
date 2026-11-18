import { describe, expect, it } from 'vitest'
import { extraEnvOf, terminalEnv } from './LocalTerminal.js'

// 设置 → 终端 → 环境变量：贴进设置里的多行文本要能安全变成终端的环境变量
describe('自定义环境变量（设置 → 终端）', () => {
  it('正常的 变量名=值 行都能解析，值里的等号原样保留', () => {
    expect(extraEnvOf('FOO=1\nBAR=a=b\n  SPACED = x  ')).toEqual({ FOO: '1', BAR: 'a=b', SPACED: ' x' })
  })

  it('空行、注释行、没有等号的行、非法变量名都跳过', () => {
    expect(extraEnvOf('\n# 注释\n没有等号\n1BAD=x\nBAD-NAME=1\nOK=1\n')).toEqual({ OK: '1' })
  })

  it('不允许把引擎自己的密钥塞进终端', () => {
    expect(extraEnvOf('LINGSHELL_DEEPSEEK_KEY=leak\nOK=1')).toEqual({ OK: '1' })
  })

  it('terminalEnv 保留用户设置：设置里写了 LC_ALL 就用它', () => {
    const env = terminalEnv('LC_ALL=C')
    expect(env.LC_ALL).toBe('C')
  })

  it('没写 LC_ALL 时仍然兜 UTF-8（Windows 下中文不乱码）', () => {
    const env = terminalEnv('FOO=1')
    expect(env.FOO).toBe('1')
    // 只在 Windows 兜底；Linux / macOS 由系统 locale 决定
    if (process.platform === 'win32') expect(env.LC_ALL).toBe('C.utf8')
  })
})
