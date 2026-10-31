import { describe, it, expect } from 'vitest'
import { langOf, isShellLang, commandOf, insertText, isMultiline } from './codeBlock.js'

describe('代码块按钮的纯逻辑', () => {
  it('langOf：从 language-xxx 取语言，没有为空', () => {
    expect(langOf(['language-Bash'])).toBe('bash')
    expect(langOf('foo language-sh')).toBe('sh')
    expect(langOf(undefined)).toBe('')
  })
  it('只有 shell 类 / 无语言能发到终端', () => {
    for (const l of ['', 'bash', 'sh', 'shell', 'zsh', 'console', 'powershell']) expect(isShellLang(l)).toBe(true)
    for (const l of ['python', 'json', 'ts', 'yaml']) expect(isShellLang(l)).toBe(false)
  })
  it('commandOf：去末尾换行；全部带提示符才去提示符', () => {
    expect(commandOf('ls -la\n')).toBe('ls -la')
    expect(commandOf('$ cd /tmp\n$ ls\n')).toBe('cd /tmp\nls')
    expect(commandOf('$ ls\nfile.txt\n')).toBe('$ ls\nfile.txt')
    expect(commandOf('a\r\nb')).toBe('a\nb')
    expect(commandOf('# 只是注释\n# 第二行')).toBe('# 只是注释\n# 第二行')
  })
  it('插入去掉隐藏字符；多行判断忽略空行', () => {
    expect(insertText('rm​ -rf\x1b /tmp/x')).toBe('rm -rf /tmp/x')
    expect(isMultiline('ls\n\n')).toBe(false)
    expect(isMultiline('cd /tmp\nls')).toBe(true)
  })
})
