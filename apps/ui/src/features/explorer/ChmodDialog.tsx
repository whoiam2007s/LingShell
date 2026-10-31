import { useState } from 'react'
import { modeOctal, modeString, parseOctal, tk, tr } from '@lingshell/shared'
import { ConfirmDialog } from '../common/index.js'
import { Checkbox } from '../../components/ui/Checkbox.js'

const WHO = [[tk('属主'), 6], [tk('属组'), 3], [tk('其他'), 0]] as const
const PERM = [[tk('perm|读'), 4], [tk('perm|写'), 2], [tk('执行'), 1]] as const

// 修改权限：rwx 勾选框与八进制输入双向同步；含目录时可勾「递归」（chmod -R，同一权限套到全部子项）。生产主机红字再提醒一次
export function ChmodDialog({ names, initial, anyDir, prod, onConfirm, onCancel }: {
  names: string[]
  initial: number
  anyDir: boolean
  prod?: boolean
  onConfirm: (mode: number, recursive: boolean) => void
  onCancel: () => void
}) {
  const [text, setText] = useState(modeOctal(initial))
  const [recursive, setRecursive] = useState(false)
  const mode = parseOctal(text)
  const flip = (bit: number) => setText(modeOctal((mode ?? 0) ^ bit))
  const head = names.slice(0, 3).join(tr('、'))
  const label = names.length > 3 ? tr('{names} 等 {n} 项', { names: head, n: names.length }) : head

  return (
    <ConfirmDialog open title={prod ? tr('修改生产主机上的文件权限') : tr('修改权限')} confirmText={tr('修改权限')}
      message={mode === undefined ? tr('{label}：请输入 3–4 位八进制权限（如 755）', { label }) : tr('{label}：改为 {mode}（{octal}）', { label, mode: modeString(mode), octal: modeOctal(mode) })}
      onConfirm={() => { if (mode !== undefined) onConfirm(mode, anyDir && recursive) }} onCancel={onCancel}>
      <div className="space-y-3 text-[12px] text-[var(--color-text-secondary)]">
        <table className="border-separate border-spacing-x-3 border-spacing-y-1">
          <tbody>
            {WHO.map(([who, shift]) => (
              <tr key={who}>
                <td className="pr-2 text-[var(--color-text-primary)]">{tr(who)}</td>
                {PERM.map(([p, v]) => (
                  <td key={p}>
                    <label className="flex cursor-pointer items-center gap-1">
                      <Checkbox checked={mode !== undefined && !!(mode & (v << shift))} onCheckedChange={() => flip(v << shift)} />{tr(p)}
                    </label>
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        <label className="flex items-center gap-2">
          {tr('八进制')}
          <input value={text} onChange={(e) => setText(e.target.value)} spellCheck={false} maxLength={4}
            className={`w-20 rounded border bg-[var(--color-bg-base)] px-2 py-0.5 font-mono text-[var(--color-text-primary)] outline-none ${mode === undefined ? 'border-[var(--color-danger)]' : 'border-[var(--color-border-default)]'}`} />
        </label>
        {anyDir && (
          <label className="flex cursor-pointer items-start gap-2">
            <Checkbox className="mt-0.5" checked={recursive} onCheckedChange={setRecursive} />
            <span>{tr('递归应用到目录下的全部文件和子目录（同一权限，如 755 会让所有文件都可执行）')}</span>
          </label>
        )}
        {prod && (
          <div className="rounded-md border border-[var(--color-danger)] bg-[color:color-mix(in_srgb,var(--color-danger)_12%,transparent)] px-3 py-2 font-medium text-[var(--color-danger)]">
            {tr('这是生产主机，权限改错可能导致服务无法读取文件或产生安全隐患，请再确认一遍。')}
          </div>
        )}
      </div>
    </ConfirmDialog>
  )
}
