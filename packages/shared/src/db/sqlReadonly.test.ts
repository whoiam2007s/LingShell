import { describe, expect, it } from 'vitest'
import { checkExplainSql, checkReadonlySql, sqlPageable } from './sqlReadonly.js'

const ok = (sql: string, d: 'mysql' | 'postgres' = 'mysql') => checkReadonlySql(sql, d).ok
const why = (sql: string, d: 'mysql' | 'postgres' = 'mysql') => { const r = checkReadonlySql(sql, d); return r.ok ? '' : r.reason }

describe('checkReadonlySql', () => {
  it('放行 SELECT / SHOW / EXPLAIN / DESCRIBE / WITH，去掉结尾分号', () => {
    expect(checkReadonlySql('SELECT * FROM t WHERE a = 1;', 'mysql')).toEqual({ ok: true, sql: 'SELECT * FROM t WHERE a = 1' })
    expect(ok('show processlist')).toBe(true)
    expect(ok('DESC users')).toBe(true)
    expect(ok('explain select 1')).toBe(true)
    expect(ok('WITH x AS (SELECT 1) SELECT * FROM x', 'postgres')).toBe(true)
    expect(ok('(SELECT 1) UNION (SELECT 2)')).toBe(true)
    // 列名 / 函数名不误拒
    expect(ok("SELECT load, comment, replace(name, 'a', 'b'), update_time FROM t")).toBe(true)
  })
  it('拒绝写语句与非白名单语句', () => {
    expect(why('UPDATE t SET a = 1')).toMatch(/UPDATE/)
    expect(why('delete from t')).toMatch(/DELETE/)
    expect(why('DROP TABLE t')).toMatch(/DROP/)
    expect(why('SET GLOBAL slow_query_log = ON')).toMatch(/SET/)
    expect(why('')).toBe('没有 SQL')
    expect(why('-- 只有注释')).toMatch(/只有注释/)
  })
  it('多语句（含注释夹带、字符串里的分号不算）', () => {
    expect(why('SELECT 1; DROP TABLE t')).toMatch(/一条语句/)
    expect(why('SELECT 1 /* ; */; DELETE FROM t')).toMatch(/一条语句/)
    expect(ok("SELECT ';' AS x, \"a;b\" FROM t")).toBe(true)
    // MySQL 里 1--1 不是注释：后面的分号和 DROP 要看见
    expect(why('SELECT 1--1; DROP TABLE t')).toMatch(/一条语句/)
    expect(ok('SELECT 1 -- 注释; DROP TABLE t\n')).toBe(true)
    expect(ok('SELECT 1 # 注释; DROP\n')).toBe(true)
    // PG 里 # 不是注释
    expect(why('SELECT 1 # 2; DROP TABLE t', 'postgres')).toMatch(/一条语句/)
  })
  it('SELECT … INTO OUTFILE / 建表、FOR UPDATE、有副作用的函数', () => {
    expect(why("SELECT * FROM t INTO OUTFILE '/tmp/x'")).toMatch(/INTO/)
    expect(why('SELECT * INTO new_t FROM t', 'postgres')).toMatch(/INTO/)
    expect(why('SELECT * FROM t FOR UPDATE')).toMatch(/取锁/)
    expect(why('SELECT * FROM t LOCK IN SHARE MODE')).toMatch(/取锁/)
    expect(why('SELECT pg_terminate_backend(123)', 'postgres')).toMatch(/pg_terminate_backend/)
    expect(why("SELECT nextval('s')", 'postgres')).toMatch(/nextval/)
    expect(why("SELECT LOAD_FILE('/etc/passwd')")).toMatch(/load_file/i)
    expect(why('WITH d AS (DELETE FROM t RETURNING *) SELECT * FROM d', 'postgres')).toMatch(/DELETE/)
  })
  it('客户端命令、可执行注释、未闭合的引号', () => {
    expect(why('SELECT 1 \\! rm -rf /')).toMatch(/反斜杠/)
    expect(why('SELECT 1\n\\! id', 'postgres')).toMatch(/反斜杠/)
    expect(why('SELECT /*! 1; DROP TABLE t */ 1')).toMatch(/可执行注释/)
    expect(why("SELECT 'abc")).toMatch(/字符串没有结束/)
    expect(why('SELECT 1 /* x')).toMatch(/注释没有结束/)
    // 字符串里的反斜杠没问题（MySQL 转义 / PG E''）
    expect(ok("SELECT 'a\\'b; DROP'")).toBe(true)
    expect(ok("SELECT E'a\\'b; drop'", 'postgres')).toBe(true)
    expect(ok('SELECT $q$ ; DELETE $q$ AS x', 'postgres')).toBe(true)
    // PG 标准字符串里反斜杠不是转义：'a\' 已经结束，后面的分号是真分号
    expect(why("SELECT 'a\\'; DELETE FROM t", 'postgres')).toMatch(/一条语句/)
  })
  it('EXPLAIN ANALYZE 会执行语句，拒绝', () => {
    expect(why('EXPLAIN ANALYZE SELECT 1', 'postgres')).toMatch(/ANALYZE/)
    expect(why('EXPLAIN (ANALYZE, BUFFERS) SELECT 1', 'postgres')).toMatch(/ANALYZE/)
  })
})

describe('sqlPageable', () => {
  it('查询语句最外层没写 LIMIT / OFFSET 才能分页；子查询里的不算', () => {
    expect(sqlPageable('select * from t', 'mysql')).toBe(true)
    expect(sqlPageable('with a as (select 1) table a', 'postgres')).toBe(true)
    expect(sqlPageable('select * from (select 1 limit 1) x', 'postgres')).toBe(true)
    expect(sqlPageable('select * from t limit 5', 'mysql')).toBe(false)
    expect(sqlPageable('select * from t offset 5 rows fetch next 10 rows only', 'postgres')).toBe(false)
    expect(sqlPageable('show tables', 'mysql')).toBe(false)
    expect(sqlPageable('delete from t', 'mysql')).toBe(false)
  })
})

describe('checkExplainSql', () => {
  it('只放查询语句；用户自带的 EXPLAIN 前缀去掉', () => {
    expect(checkExplainSql('select * from t where id = 1;', 'mysql')).toEqual({ ok: true, sql: 'select * from t where id = 1' })
    expect(checkExplainSql('EXPLAIN select 1', 'mysql')).toEqual({ ok: true, sql: 'select 1' })
    expect(checkExplainSql('EXPLAIN FORMAT=JSON select 1', 'mysql')).toEqual({ ok: true, sql: 'select 1' })
    expect(checkExplainSql('EXPLAIN (COSTS OFF) select 1', 'postgres')).toEqual({ ok: true, sql: 'select 1' })
  })
  it('非 SELECT / ANALYZE 拒绝', () => {
    const r = checkExplainSql('UPDATE t SET a = 1', 'mysql')
    expect(r.ok).toBe(false)
    expect(!r.ok && r.reason).toMatch(/只能 EXPLAIN 查询语句/)
    expect(checkExplainSql('SHOW TABLES', 'mysql').ok).toBe(false)
    expect(checkExplainSql('EXPLAIN ANALYZE SELECT 1', 'mysql').ok).toBe(false)
    expect(checkExplainSql('EXPLAIN (FORMAT JSON, ANALYZE) SELECT 1', 'postgres').ok).toBe(false)
  })
})
