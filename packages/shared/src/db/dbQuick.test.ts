import { describe, expect, it } from 'vitest'
import {
  DB_END, dbAuditCommand, dbCommand, dbErrorText, dbKillSql, explainInput, explainPrompt, explainText, parseBigkeys, parseDbTable, parseRedisInfo,
  parseRedisReply, redisSlowlogTable, sanitizeDbConn, sanitizeDbConns, slowlogTailCommand, splitDbOutput, tableToKv, type DbConn,
  DB_OUT_LIMIT, DB_TRUNC, queryInput, parseCsvTable, withDatabase, redisKeyspace, schemaTableSql, schemaTablesSql, pgDdl,
  parseRedisClients, redisPreviewTable, redisKeyCmds, redisErrorOf, isRedisKey, tableToText, guessTableName,
} from './dbQuick.js'

const my: DbConn = { id: 'c1', name: '订单库', hostKey: 'h1', kind: 'mysql', via: 'client', host: '127.0.0.1', port: 3306, user: 'root', database: 'shop', secret: 'mysql-root' }

describe('sanitizeDbConn', () => {
  it('合法连接；密码只收保险箱名称（占位符写法也认）', () => {
    const c = sanitizeDbConn({ name: ' 订单库 ', hostKey: 'h1', kind: 'mysql', via: 'client', host: '127.0.0.1', port: '3306', user: 'root', database: 'shop', secret: '{{secret:mysql-root}}' })
    expect(c).toMatchObject({ name: '订单库', hostKey: 'h1', kind: 'mysql', via: 'client', port: 3306, secret: 'mysql-root' })
    expect(typeof c !== 'string' && c.id).toMatch(/^db-/)
  })
  it('非法值给原因', () => {
    expect(sanitizeDbConn({ name: 'x', kind: 'oracle' })).toBe('请选择数据库类型')
    expect(sanitizeDbConn({ name: '', kind: 'mysql' })).toMatch(/名称/)
    expect(sanitizeDbConn({ name: 'x', kind: 'mysql', via: 'docker', container: '' })).toMatch(/容器/)
    expect(sanitizeDbConn({ name: 'x', kind: 'mysql', host: 'a b' })).toMatch(/地址/)
    expect(sanitizeDbConn({ name: 'x', kind: 'mysql', user: "root'; rm -rf /" })).toMatch(/用户名/)
    expect(sanitizeDbConn({ name: 'x', kind: 'mysql', port: 70000 })).toMatch(/端口/)
    expect(sanitizeDbConn({ name: 'x', kind: 'mysql', secret: 'Hunter2 明文' })).toMatch(/密钥保险箱/)
    expect(sanitizeDbConn({ name: 'x', kind: 'redis', database: 'abc' })).toMatch(/库序号/)
  })
  it('列表去重、丢掉坏项', () => {
    expect(sanitizeDbConns([my, { ...my }, { name: 'bad' }]).map((c) => c.id)).toEqual(['c1'])
    expect(sanitizeDbConns('x')).toEqual([])
  })
})

describe('dbCommand', () => {
  it('密码经 stdin 读进环境变量，命令行里只有变量名', () => {
    const cmd = dbCommand(my)
    expect(cmd.startsWith("sh -c '")).toBe(true)
    expect(cmd).toContain('IFS= read -r __p')
    expect(cmd).toContain('MYSQL_PWD=$__p; export MYSQL_PWD')
    expect(cmd).toContain("mysql --binary-mode --default-character-set=utf8mb4 -B --connect-timeout=8 -h '\\''127.0.0.1'\\'' -P 3306 -u '\\''root'\\'' -D '\\''shop'\\''")
    expect(cmd).not.toMatch(/-p\S|--password/)
    expect(cmd).toContain(DB_END)
  })
  it('PG：只读事务 + 非对齐制表符输出；docker 经 -e 变量名传', () => {
    const pg = dbCommand({ ...my, kind: 'postgres', via: 'docker', container: 'pg1', port: undefined, host: undefined })
    expect(pg).toContain('default_transaction_read_only=on')
    expect(pg).toContain('PGCLIENTENCODING=UTF8; export PGCLIENTENCODING')
    expect(pg).toContain('-e PGOPTIONS -e PGCLIENTENCODING')
    expect(pg).toContain('docker exec -i ${PGPASSWORD+-e PGPASSWORD} -e PGOPTIONS')
    expect(pg).toContain('psql -X -w -q -A -F')
    expect(pg).toContain('-f -')
  })
  it('Redis：命令参数追加在后', () => {
    const r = dbCommand({ ...my, kind: 'redis', user: undefined, database: '2', port: 6380 }, ['INFO'])
    expect(r).toContain('redis-cli --no-auth-warning -h')
    expect(r).toContain('-p 6380 -n 2 INFO')
    expect(r).toContain('REDISCLI_AUTH=$__p')
  })
  it('慢日志 tail：路径校验，权限不够试免密 sudo', () => {
    expect(slowlogTailCommand(my, '/var/lib/mysql/slow.log')).toContain('sudo -n tail -c')
    expect(slowlogTailCommand({ ...my, via: 'docker', container: 'm1' }, '/var/lib/mysql/slow.log')).toContain('docker exec')
    expect(() => slowlogTailCommand(my, 'slow.log; rm -rf /')).toThrow(/不支持/)
  })
})

describe('输出解析', () => {
  it('splitDbOutput：stdout / 退出码 / stderr', () => {
    expect(splitDbOutput(`a\tb\n1\t2\n\n${DB_END}0\n`)).toEqual({ stdout: 'a\tb\n1\t2', rc: 0, err: '' })
    expect(splitDbOutput(`\n${DB_END}1\nERROR 1045 (28000): Access denied`)).toEqual({ stdout: '', rc: 1, err: 'ERROR 1045 (28000): Access denied' })
    expect(splitDbOutput('被截断')).toEqual({ stdout: '被截断', err: '' })
  })
  it('mysql -B：首行列名，值里的转义还原', () => {
    const t = parseDbTable('Id\tInfo\n5\tselect 1\\nfrom dual\n6\tNULL\n', 'mysql')
    expect(t).toEqual({ columns: ['Id', 'Info'], rows: [['5', 'select 1\nfrom dual'], ['6', 'NULL']] })
    expect(tableToKv(t, 1)).toEqual([['Id', '6'], ['Info', 'NULL']])
    expect(tableToKv({ columns: ['a'], rows: [] })).toBeUndefined()
  })
  it('psql -A：多出来的制表符并进最后一列', () => {
    expect(parseDbTable('pid\tquery\n1\ta\tb', 'postgres').rows).toEqual([['1', 'a\tb']])
  })
  it('dbErrorText：常见错误给中文说明', () => {
    expect(dbErrorText(my, 'sh: mysql: command not found', 127)).toMatch(/^这台机器上没有 mysql 客户端/)
    // 真机上见到的：业务账号查复制状态 / 锁等待，权限不够（别误报成密码不对）
    expect(dbErrorText(my, 'ERROR 1227 (42000) at line 1: Access denied; you need (at least one of) the SUPER, REPLICATION CLIENT privilege(s) for this operation', 1)).toMatch(/^当前数据库账号权限不够/)
    expect(dbErrorText(my, "ERROR 1142 (42000) at line 1: SELECT command denied to user 'appuser'@'localhost' for table 'innodb_lock_waits'", 1)).toMatch(/^当前数据库账号权限不够/)
    expect(dbErrorText(my, "ERROR 1045 (28000): Access denied for user 'root'@'localhost' (using password: YES)", 1)).toMatch(/^用户名或密码不对/)
    expect(dbErrorText({ ...my, user: undefined }, "ERROR 1045 (28000): Access denied for user 'ODBC'@'localhost' (using password: YES)", 1)).toMatch(/^「用户」没填/)
    expect(dbErrorText(my, "ERROR 1045 (28000): Access denied for user 'root'@'localhost'", 1)).toMatch(/^用户名或密码不对/)
    expect(dbErrorText({ ...my, via: 'docker', container: 'm1' }, 'Error response from daemon: No such container: m1', 1)).toMatch(/^容器 m1 不存在/)
    expect(dbErrorText(my, "ERROR 2003 (HY000): Can't connect to MySQL server", 1)).toMatch(/^连不上数据库/)
    expect(dbErrorText(my, '', 3)).toBe('退出码 3')
  })
})

describe('Redis 解析', () => {
  it('INFO 分节', () => {
    const s = parseRedisInfo('# Server\r\nredis_version:7.2.4\r\nuptime_in_days:3\r\n\r\n# Keyspace\r\ndb0:keys=10,expires=0,avg_ttl=0\r\n')
    expect(s).toEqual([{ title: 'Server', items: [['redis_version', '7.2.4'], ['uptime_in_days', '3']] }, { title: 'Keyspace', items: [['db0', 'keys=10,expires=0,avg_ttl=0']] }])
  })
  it('--no-raw 嵌套回复（含两位数序号对齐）→ 慢日志表', () => {
    const lines = [
      ' 1) 1) (integer) 14', '    2) (integer) 1760774401', '    3) (integer) 25000', '    4) 1) "KEYS"', '       2) "user:*"',
      '    5) "127.0.0.1:58217"', '    6) ""',
    ]
    for (let i = 2; i <= 10; i++) lines.push(`${String(i).padStart(2)}) 1) (integer) ${i}`, '    2) (integer) 1760774402', '    3) (integer) 1000', '    4) 1) "GET"', '       2) "k with space"', '    5) "10.0.0.1:1"', '    6) "w"')
    const r = parseRedisReply(lines.join('\n'))
    expect(Array.isArray(r) && r.length).toBe(10)
    expect((r as unknown[])[0]).toEqual([14, 1760774401, 25000, ['KEYS', 'user:*'], '127.0.0.1:58217', ''])
    const t = redisSlowlogTable(r)
    expect(t.rows[0]).toEqual(['14', '2025-10-18 08:00:01', '25.00', 'KEYS user:*', '127.0.0.1:58217', ''])
    expect(t.rows[9][3]).toBe('GET "k with space"')
    expect(parseRedisReply('(empty array)')).toEqual([])
    expect(parseRedisReply('"a\\"b\\x41"')).toBe('a"bA')
  })
  it('--bigkeys 摘要（新旧两种引号）', () => {
    const t = parseBigkeys("-------- summary -------\nBiggest string found 'sess:9' has 52 bytes\nBiggest   hash found \"user:1\" has 120 fields\nBiggest   list found '\"q:mail\"' has 8 items\n")
    expect(t.rows).toEqual([['string', 'sess:9', '52', 'bytes'], ['hash', 'user:1', '120', 'fields'], ['list', 'q:mail', '8', 'items']])
  })
})

describe('kill / EXPLAIN / 执行记录', () => {
  it('kill 语句', () => {
    expect(dbKillSql('mysql', 42)).toBe('KILL 42')
    expect(dbKillSql('postgres', 42)).toBe('SELECT pg_terminate_backend(42) AS terminated')
    expect(() => dbKillSql('mysql', -1)).toThrow(/非法/)
    expect(dbKillSql('redis', 7)).toBe('CLIENT KILL ID 7')
  })
  it('EXPLAIN：只放 SELECT；MySQL 先设只读事务', () => {
    expect(explainInput('mysql', 'select * from t;').input).toBe('SET SESSION TRANSACTION READ ONLY;\nEXPLAIN select * from t\n;\n')
    expect(explainInput('postgres', 'select 1').input).toBe('EXPLAIN select 1\n;\n')
    expect(() => explainInput('mysql', 'delete from t')).toThrow(/只能 EXPLAIN 查询语句/)
    expect(() => explainInput('redis', 'select 1')).toThrow(/Redis/)
  })
  it('计划文本与 AI 提示', () => {
    expect(explainText('postgres', { columns: ['QUERY PLAN'], rows: [['Seq Scan on t'], ['  Filter: (a = 1)']] })).toBe('Seq Scan on t\n  Filter: (a = 1)')
    expect(explainText('mysql', { columns: ['id', 'type', 'key'], rows: [['1', 'ALL', 'NULL']] })).toBe('#1 id=1  type=ALL')
    const p = explainPrompt({ kind: 'mysql', conn: '订单库', version: '8.0.36', sql: 'select 1', plan: '#1 type=ALL' })
    expect(p).toContain('MySQL（8.0.36）')
    expect(p).toContain('```sql\nselect 1\n```')
  })
  it('执行记录文本去控制字符', () => {
    expect(dbAuditCommand(my, 'KILL 5', 'app@web1 select\n1')).toBe('KILL 5  # MySQL「订单库」 app@web1 select 1')
  })
})

describe('输出截断 / 即席查询 / 切库 / 结构', () => {
  it('超过上限：去掉截断标记和最后半行，标 truncated；退出码还在', () => {
    expect(dbCommand(my)).toContain(`head -c ${DB_OUT_LIMIT}`)
    expect(splitDbOutput(`a\tb\n1\t2\n3\t4x\n${DB_TRUNC}9999999\n\n${DB_END}0\n`)).toEqual({ stdout: 'a\tb\n1\t2', rc: 0, err: '', truncated: true })
  })
  it('即席查询只放单条只读语句；MySQL 先设只读事务；PG 用 --csv', () => {
    expect(queryInput('mysql', 'show tables;').input).toBe('SET SESSION TRANSACTION READ ONLY;\nshow tables\n;\n')
    expect(queryInput('postgres', 'select 1').input).toBe('select 1\n;\n')
    expect(() => queryInput('mysql', 'update t set a=1')).toThrow(/只读/)
    expect(() => queryInput('mysql', 'select 1; select 2')).toThrow(/一条语句/)
    expect(() => queryInput('postgres', 'select * from t for update')).toThrow(/取锁/)
    // 分页：没写 LIMIT 的查询补 LIMIT（多取一条判断下一页）；自己写了 LIMIT 的按原样
    expect(queryInput('mysql', 'select * from t', { offset: 0, limit: 100 })).toMatchObject({ paged: true, input: 'SET SESSION TRANSACTION READ ONLY;\nselect * from t\nLIMIT 101\n;\n' })
    expect(queryInput('postgres', 'select * from t', { offset: 200, limit: 100 })).toMatchObject({ paged: true, body: 'select * from t\nLIMIT 101 OFFSET 200' })
    expect(queryInput('mysql', 'select * from t limit 5', { offset: 0, limit: 100 }).paged).toBe(false)
    expect(queryInput('mysql', 'show tables', { offset: 0, limit: 100 }).paged).toBe(false)
    expect(queryInput('postgres', 'select * from (select 1) x', { offset: 0, limit: 100 }).paged).toBe(true)
    expect(dbCommand({ ...my, kind: 'postgres' }, [], undefined, true)).toContain('psql -X -w -q --csv')
  })
  it('psql --csv 解析：引号、换行、空值', () => {
    expect(parseCsvTable('id,note,x\n1,"a,b",\n2,"多\n行 ""引号""",z\n')).toEqual({ columns: ['id', 'note', 'x'], rows: [['1', 'a,b', ''], ['2', '多\n行 "引号"', 'z']] })
    expect(parseCsvTable('')).toEqual({ columns: [], rows: [] })
  })
  it('切库：校验库名；Redis 只收序号', () => {
    expect(withDatabase(my, 'crm').database).toBe('crm')
    expect(withDatabase(my, '')).toBe(my)
    expect(() => withDatabase(my, "a';drop")).toThrow(/库名/)
    expect(() => withDatabase({ ...my, kind: 'redis' }, 'x')).toThrow(/库名/)
    expect(redisKeyspace('# Keyspace\r\ndb0:keys=12,expires=0,avg_ttl=0\r\ndb3:keys=1,expires=1\r\n')).toEqual([['0', 12], ['3', 1]])
  })
  it('表结构：名字校验后拼进 SQL；PG 由字段 + 约束 + 索引拼建表语句', () => {
    expect(schemaTableSql('mysql', 'shop', { name: 't_order' }).ddl).toBe('SHOW CREATE TABLE `shop`.`t_order`')
    expect(() => schemaTableSql('mysql', 'shop', { name: 'a`b' })).toThrow(/非法/)
    expect(() => schemaTablesSql('mysql', '')).toThrow(/选择/)
    expect(schemaTableSql('postgres', '', { schema: 'public', name: 'users' }).columns).toContain(`'"public"."users"'::regclass`)
    const ddl = pgDdl({ schema: 'public', name: 'users' },
      { columns: ['name', 'type', 'nullable', 'default', 'comment'], rows: [['id', 'bigint', 'NO', "nextval('users_id_seq'::regclass)", ''], ['email', 'text', 'YES', '', '']] },
      { columns: ['name', 'definition'], rows: [['users_pkey', 'PRIMARY KEY (id)']] },
      { columns: ['name', 'definition', 'by_constraint'], rows: [['users_pkey', 'CREATE UNIQUE INDEX users_pkey ON public.users USING btree (id)', 'constraint'], ['ix_email', 'CREATE INDEX ix_email ON public.users USING btree (email)', '']] }, 'r', '')
    expect(ddl).toBe(`CREATE TABLE "public"."users" (\n  "id" bigint NOT NULL DEFAULT nextval('users_id_seq'::regclass),\n  "email" text,\n  CONSTRAINT "users_pkey" PRIMARY KEY (id)\n);\nCREATE INDEX ix_email ON public.users USING btree (email);`)
    expect(pgDdl({ name: 'v' }, { columns: [], rows: [] }, { columns: [], rows: [] }, { columns: [], rows: [] }, 'v', ' SELECT 1;')).toBe('CREATE VIEW "public"."v" AS\nSELECT 1;')
  })
})

describe('Redis 客户端 / Key 浏览', () => {
  it('CLIENT LIST → 表格，去掉查询自己', () => {
    const t = parseRedisClients('id=3 addr=10.0.0.5:5000 laddr=x fd=8 name=web age=100 idle=2 flags=N db=0 cmd=get user=default\nid=9 addr=127.0.0.1:6000 name= age=0 idle=0 flags=N db=0 cmd=client|list user=default\n')
    expect(t.rows).toEqual([['3', '10.0.0.5:5000', 'web', 'default', '0', '100', '2', 'N', 'get']])
  })
  it('--no-raw 里的 \\xHH 按 UTF-8 还原中文；非法 UTF-8 保持逐字节', () => {
    expect(parseRedisReply('"\\xe8\\xae\\xa2\\xe5\\x8d\\x95:1"')).toBe('订单:1')
    expect(parseRedisReply('"\\xff\\x00a"')).toBe('\xff\x00a')
  })
  it('预览：hash / zset 成对，SSCAN 取第二项，string 原文', () => {
    expect(redisPreviewTable('hash', parseRedisReply('1) "0"\n2) 1) "f1"\n   2) "v1"\n   3) "f2"\n   4) "v2"'))).toEqual({ columns: ['field', 'value'], rows: [['f1', 'v1'], ['f2', 'v2']] })
    expect(redisPreviewTable('zset', parseRedisReply('1) "a"\n2) "1.5"'))).toEqual({ columns: ['member', 'score'], rows: [['a', '1.5']] })
    expect(redisPreviewTable('set', parseRedisReply('1) "0"\n2) 1) "x"'))).toEqual({ columns: ['#', 'value'], rows: [['0', 'x']] })
    expect(redisPreviewTable('string', parseRedisReply('"hello"'))).toBe('hello')
    expect(redisKeyCmds('list')).toEqual({ size: 'LLEN', preview: ['LRANGE', '{k}', '0', '99'] })
    expect(redisErrorOf('(error) WRONGTYPE Operation against a key')).toBe('WRONGTYPE Operation against a key')
    expect(isRedisKey('a\nb')).toBe(false)
  })
})

describe('结果表复制 / 导出', () => {
  const t = { columns: ['id', 'name'], rows: [['1', 'a,"b"'], ['2', "O'Neil\\x"], ['3', 'NULL']] }
  it('CSV / TSV / Markdown', () => {
    expect(tableToText(t, 'csv')).toBe('id,name\r\n1,"a,""b"""\r\n2,O\'Neil\\x\r\n3,NULL')
    expect(tableToText({ columns: ['a'], rows: [['x\ty\nz']] }, 'tsv')).toBe('a\nx y z')
    expect(tableToText({ columns: ['a|b'], rows: [['1\n2']] }, 'markdown')).toBe('| a\\|b |\n| --- |\n| 1<br>2 |')
  })
  it('INSERT：数字不加引号，NULL 原样，MySQL 双写反斜杠，PG 不双写', () => {
    expect(tableToText(t, 'insert', { kind: 'mysql', table: 'shop.users' }).split('\n')).toEqual([
      'INSERT INTO `shop`.`users` (`id`, `name`) VALUES (1, \'a,"b"\');',
      "INSERT INTO `shop`.`users` (`id`, `name`) VALUES (2, 'O''Neil\\\\x');",
      'INSERT INTO `shop`.`users` (`id`, `name`) VALUES (3, NULL);',
    ])
    expect(tableToText({ columns: ['v'], rows: [['a\\b'], ['007']] }, 'insert', { kind: 'postgres' })).toBe(`INSERT INTO "table_name" ("v") VALUES ('a\\b');\nINSERT INTO "table_name" ("v") VALUES ('007');`)
    expect(guessTableName('select * from `shop`.users where 1')).toBe('shop.users')
  })
})
