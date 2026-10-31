import { useEffect, useRef, useState } from 'react'
import { AlertTriangle, Copy, KeyRound, Loader2, RefreshCw, Search, Trash2 } from 'lucide-react'
import { REDIS_PREVIEW_N, tk, tr, type DbConn, type RedisKeyInfo } from '@lingshell/shared'
import { client } from '../../client/index.js'
import { trx } from '../../lib/trx.js'
import { Input } from '../../components/ui/Input.js'
import { ConfirmDialog } from '../common/index.js'
import { BTN, DANGER_BOX, MUTED, PRIMARY, errText } from '../../components/ui/drawer.js'
import { Empty, ResultGrid } from './ResultGrid.js'

const fmtBytes = (n?: number) => (n === undefined ? '—' : n >= 1 << 20 ? `${(n / (1 << 20)).toFixed(1)} MB` : n >= 1024 ? `${(n / 1024).toFixed(1)} KB` : `${n} B`)
const fmtTtl = (s: number) => (s === -1 ? tr('永不过期') : s < 0 ? '—' : s < 120 ? tr('{n} 秒', { n: s }) : s < 7200 ? tr('{n} 分钟', { n: Math.round(s / 60) }) : s < 172800 ? tr('{n} 小时', { n: (s / 3600).toFixed(1) }) : tr('{n} 天', { n: (s / 86400).toFixed(1) }))
// 大小的单位：整个「{n} 单位」做键（英文单位放后面、要复数）
const SIZE: Record<string, string> = { string: tk('{n} 字节'), list: tk('{n} 项'), set: tk('{n} 个成员'), zset: tk('{n} 个成员'), hash: tk('{n} 个字段'), stream: tk('stream|{n} 条') }

// 数据库抽屉「Key」页签（Redis）：按模式 SCAN（分批，不用 KEYS，不阻塞实例），点 key 看类型 / TTL / 大小 / 内存和前 100 项内容；
// 删除单个 key 是写操作：确认（生产主机再确认一次）+ 执行记录
export function RedisKeysPanel({ conn, db, prod }: { conn: DbConn; db: string; prod: boolean }) {
  const [pattern, setPattern] = useState('*')
  const [keys, setKeys] = useState<string[]>()
  const [cursor, setCursor] = useState('0')
  const [scanning, setScanning] = useState(false)
  const [err, setErr] = useState('')
  const [pick, setPick] = useState('')
  const [info, setInfo] = useState<RedisKeyInfo>()
  const [kErr, setKErr] = useState('')
  const [del, setDel] = useState<1 | 2 | null>(null)
  const [flash, setFlash] = useState('')
  const used = useRef('*')
  const seq = useRef(0)

  const scan = (more: boolean) => {
    const p = more ? used.current : pattern.trim() || '*'
    const my = ++seq.current
    used.current = p
    setScanning(true); setErr('')
    if (!more) { setKeys(undefined); setPick(''); setInfo(undefined) }
    client.db.redisScan(conn.id, db, p, more ? cursor : '0')
      .then((r) => { if (my !== seq.current) return; setKeys((k) => [...new Set([...(more ? k ?? [] : []), ...r.keys])]); setCursor(r.cursor) },
        (e) => { if (my === seq.current) { setErr(errText(e)); if (!more) setKeys([]) } })
      .finally(() => { if (my === seq.current) setScanning(false) })
  }
  useEffect(() => { scan(false) }, [conn.id, db])
  const kseq = useRef(0)
  const open = (k: string) => {
    const my = ++kseq.current   // 连续点几个 key：只认最后一次
    setPick(k); setInfo(undefined); setKErr('')
    client.db.redisKey(conn.id, db, k).then((x) => { if (my === kseq.current) setInfo(x) }, (e) => { if (my === kseq.current) setKErr(errText(e)) })
  }
  const doDel = async () => {
    const k = pick
    setDel(null)
    try {
      await client.db.redisDel(conn.id, db, k, prod)
      setKeys((l) => l?.filter((x) => x !== k)); setPick(''); setInfo(undefined)
      setFlash(tr('已删除 {key}（已记入执行记录）', { key: k })); setTimeout(() => setFlash(''), 2500)
    } catch (e) { setKErr(errText(e)) }
  }
  const done = cursor === '0'

  return (
    <div className="flex h-full min-h-0 flex-col" data-db-keys>
      <div className="flex shrink-0 items-center gap-1.5 border-b border-[var(--color-border-subtle)] px-3 py-1.5">
        <Input data-db-key-pattern size="sm" className="!h-6 min-w-0 flex-1 font-mono" value={pattern} onChange={(e) => setPattern(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') scan(false) }} placeholder={tr('匹配模式，如 user:*、order:2024*（* 任意，? 单个字符）')} />
        <button data-db-key-scan onClick={() => scan(false)} disabled={scanning} className={PRIMARY}>{scanning ? <Loader2 className="h-3 w-3 animate-spin" /> : <Search className="h-3 w-3" />}{tr('扫描')}</button>
        <span className={`whitespace-nowrap text-[10.5px] ${MUTED}`}>{tr('库 {v}', { v: db || conn.database || '0' })}</span>
      </div>
      {flash && <div className="shrink-0 border-b border-[var(--color-border-subtle)] px-3 py-1 text-[11px] text-[var(--color-success)]">{flash}</div>}
      <div className="flex min-h-0 flex-1">
        <div className="flex w-[230px] shrink-0 flex-col border-r border-[var(--color-border-subtle)]">
          <div data-db-key-count className={`shrink-0 px-2 py-1 text-[10.5px] ${MUTED}`}>
            {keys === undefined ? tr('扫描中') : done ? tr('已扫完，{n} 个 key', { n: keys.length }) : tr('已扫一部分，{n} 个 key', { n: keys.length })}
          </div>
          <div className="min-h-0 flex-1 overflow-auto pb-2">
            {err && <div className="whitespace-pre-wrap break-all px-2 text-[11px] text-[var(--color-danger)]">{err}</div>}
            {keys?.length === 0 && !err && <Empty text={done ? tr('没有匹配的 key') : tr('这一批没有匹配的，继续扫描试试')} />}
            {keys?.map((k) => (
              <button key={k} data-db-key={k} onClick={() => open(k)} title={k}
                className={`flex w-full items-center gap-1 px-2 py-[3px] text-left text-[11.5px] ${k === pick ? 'bg-[var(--color-accent-bg)] text-[var(--color-accent)]' : 'text-[var(--color-text-primary)] hover:bg-[var(--color-bg-hover)]'}`}>
                <KeyRound className="h-3 w-3 shrink-0 text-[var(--color-text-muted)]" /><span className="min-w-0 flex-1 truncate font-mono">{k}</span>
              </button>
            ))}
            {keys && !done && (
              <div className="px-2 pt-1"><button data-db-key-more onClick={() => scan(true)} disabled={scanning} className={`${BTN} w-full justify-center text-[var(--color-accent)]`}>{scanning ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}{tr('继续扫描')}</button></div>
            )}
          </div>
        </div>
        <div className="min-w-0 flex-1 overflow-auto">
          {!pick ? <Empty text={tr('点左边的 key 看类型、过期时间、大小和内容')} icon={<KeyRound className="h-3.5 w-3.5 shrink-0" />} /> : (
            <div className="py-1.5">
              <div className="flex items-center gap-1.5 px-3 pb-1">
                <span className="min-w-0 flex-1 break-all font-mono text-[12px] font-semibold text-[var(--color-text-primary)]">{pick}</span>
                <button title={tr('复制 key 名')} onClick={() => void navigator.clipboard.writeText(pick)} className="rounded p-1 text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-accent)]"><Copy className="h-3.5 w-3.5" /></button>
                <button data-db-key-del disabled={!info} onClick={() => setDel(1)} title={tr('删除这个 key（写操作，需要确认，会记入执行记录）')} className="rounded p-1 text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-danger)] disabled:opacity-40"><Trash2 className="h-3.5 w-3.5" /></button>
              </div>
              {kErr ? <div data-db-key-err className="whitespace-pre-wrap break-all px-3 text-[11px] text-[var(--color-danger)]">{kErr}</div>
                : !info ? <div className={`flex items-center gap-1 px-3 text-[11px] ${MUTED}`}><Loader2 className="h-3 w-3 animate-spin" />{tr('load|读取')}</div> : (
                <>
                  <div data-db-key-meta className={`flex flex-wrap gap-x-3 px-3 pb-1.5 text-[11px] ${MUTED}`}>
                    <span>{trx('类型 {v}', { v: <b className="font-mono text-[var(--color-text-primary)]">{info.type}</b> })}</span>
                    <span>{trx('过期 {v}', { v: <b className="text-[var(--color-text-primary)]">{fmtTtl(info.ttl)}</b> })}</span>
                    {info.size !== undefined && <span>{trx('大小 {v}', { v: <b className="text-[var(--color-text-primary)]">{SIZE[info.type] ? tr(SIZE[info.type], { n: info.size }) : `${info.size} `}</b> })}</span>}
                    <span title={tr('MEMORY USAGE（Redis 4.0+）')}>{trx('内存 {v}', { v: <b className="text-[var(--color-text-primary)]">{fmtBytes(info.bytes)}</b> })}</span>
                  </div>
                  {info.partial && <div className="px-3 pb-1 text-[10.5px] text-[var(--color-warn)]">{info.type === 'string' ? tr('值太长，只显示前 64KB') : tr('只显示前 {n} 项', { n: REDIS_PREVIEW_N })}</div>}
                  {info.value === undefined ? <Empty text={tr('{type} 类型不支持预览', { type: info.type })} />
                    : typeof info.value === 'string' ? <pre data-db-key-value className="mx-3 whitespace-pre-wrap break-all rounded bg-[var(--color-bg-raised)] p-2 font-mono text-[11px] leading-[1.5] text-[var(--color-text-primary)]">{info.value}</pre>
                    : <ResultGrid key={pick} table={info.value} kind="redis" name={pick} empty={tr('db|空')} />}
                </>
              )}
            </div>
          )}
        </div>
      </div>
      <ConfirmDialog open={del === 1} title={prod ? tr('生产主机：删除 key') : tr('db|删除 key')} confirmText={prod ? tr('下一步') : tr('删除')}
        message={tr('这是写操作：从「{name}」的库 {db} 删除这个 key，删除后无法找回。操作会记入执行记录。', { name: conn.name, db: db || conn.database || '0' })}
        onCancel={() => setDel(null)} onConfirm={() => { if (prod) setDel(2); else void doDel() }}>
        <div className="break-all rounded bg-[var(--color-bg-raised)] p-2 font-mono text-[11.5px] text-[var(--color-text-primary)]">DEL {pick}</div>
      </ConfirmDialog>
      <ConfirmDialog open={del === 2} title={tr('生产主机二次确认')} confirmText={tr('确认删除')}
        message={tr('「{name}」在生产主机上。再次确认要删除 key「{key}」？', { name: conn.name, key: pick })} onCancel={() => setDel(null)} onConfirm={() => void doDel()}>
        <div className={`flex items-center gap-1.5 ${DANGER_BOX}`}><AlertTriangle className="h-3.5 w-3.5 shrink-0" />{tr('生产环境：确认业务不再需要这个 key（缓存删除后会回源，可能带来瞬时压力）。')}</div>
      </ConfirmDialog>
    </div>
  )
}
