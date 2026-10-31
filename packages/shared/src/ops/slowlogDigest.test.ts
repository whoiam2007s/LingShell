import { describe, expect, it } from 'vitest'
import { digestSlow, mysqlTimeToSec, parseMysqlSlowLog, sqlFingerprint } from './slowlogDigest.js'

// MySQL 8 慢日志夹具：开头是被 tail 截断的半条 + 启动横幅
const LOG = `t_order WHERE id = 3;
/usr/sbin/mysqld, Version: 8.0.36 (MySQL Community Server - GPL). started with:
Tcp port: 3306  Unix socket: /var/run/mysqld/mysqld.sock
Time                 Id Command    Argument
# Time: 2026-10-18T08:00:01.123456Z
# User@Host: app[app] @ web1 [10.0.0.5]  Id:    11
# Query_time: 2.500000  Lock_time: 0.000100 Rows_sent: 1  Rows_examined: 500000
use shop;
SET timestamp=1760774401;
SELECT * FROM t_order WHERE user_id = 42 AND status = 'paid';
# Time: 2026-10-18T08:00:05.000000Z
# User@Host: app[app] @ web2 [10.0.0.6]  Id:    12
# Query_time: 3.000000  Lock_time: 0.000200 Rows_sent: 0  Rows_examined: 600000
SET timestamp=1760774405;
select *   from t_order
 where user_id=7 and status="new";
# Time: 2026-10-18T08:01:00.000000Z
# User@Host: report[report] @ localhost []  Id:    13
# Query_time: 1.200000  Lock_time: 0.000000 Rows_sent: 3  Rows_examined: 90000
SET timestamp=1760774460;
SELECT id FROM t_user WHERE id IN (1, 2, 3, 4);
# Time: 2026-10-18T08:02:00.000000Z
# User@Host: report[report] @ localhost []  Id:    13
# Query_time: 0.800000  Lock_time: 0.000000 Rows_sent: 1  Rows_examined: 30000
SET timestamp=1760774520;
SELECT id FROM t_user WHERE id IN (9);
`

describe('sqlFingerprint', () => {
  it('字面量换 ?、IN 列表 / VALUES 折叠、大小写与空白归一', () => {
    expect(sqlFingerprint("SELECT * FROM t WHERE a = 1 AND b = 'x'")).toBe('select * from t where a = ? and b = ?')
    expect(sqlFingerprint('select *  from t\n where a=2 and b="y";')).toBe('select * from t where a = ? and b = ?')
    expect(sqlFingerprint('SELECT id FROM u WHERE id IN (1, 2, 3)')).toBe(sqlFingerprint('select id from u where id in (7)'))
    expect(sqlFingerprint('INSERT INTO t (a, b) VALUES (1, 2), (3, 4)')).toBe(sqlFingerprint('insert into t (a, b) values (5, 6)'))
    expect(sqlFingerprint('SELECT 1 FROM t LIMIT 10, 20')).toBe('select ? from t limit ?')
    expect(sqlFingerprint('SELECT a FROM t /* hint */ WHERE x = 0xFF')).toBe('select a from t where x = ?')
    expect(sqlFingerprint('SELECT col1 FROM t2')).toBe('select col1 from t2')   // 标识符里的数字不动
  })
})

describe('parseMysqlSlowLog / digestSlow', () => {
  it('解析头、跳过 use / SET timestamp / 横幅 / 截断的半条', () => {
    const es = parseMysqlSlowLog(LOG)
    expect(es).toHaveLength(4)
    expect(es[0]).toMatchObject({ queryTime: 2.5, lockTime: 0.0001, rowsSent: 1, rowsExamined: 500000, user: 'app', db: 'shop', time: '2026-10-18T08:00:01.123456Z' })
    expect(es[0].sql).toBe("SELECT * FROM t_order WHERE user_id = 42 AND status = 'paid';")
    expect(es[1].sql).toContain('where user_id=7')
  })
  it('按指纹归并：次数 / 总耗时 / 平均 / 最大 / 示例取最慢那次，按总耗时排序', () => {
    const ds = digestSlow(parseMysqlSlowLog(LOG))
    expect(ds).toHaveLength(2)
    expect(ds[0]).toMatchObject({ count: 2, totalTime: 5.5, avgTime: 2.75, maxTime: 3, rowsExamined: 550000, users: ['app'], dbs: ['shop'] })
    expect(ds[0].example).toContain('user_id=7')
    expect(ds[0].first).toBe('2026-10-18T08:00:01.123456Z')
    expect(ds[1]).toMatchObject({ count: 2, totalTime: 2, avgTime: 1, fingerprint: 'select id from t_user where id in(?+)' })
  })
  it('mysql.slow_log 表的 TIME 列', () => {
    expect(mysqlTimeToSec('00:00:02.500000')).toBe(2.5)
    expect(mysqlTimeToSec('01:02:03')).toBe(3723)
    expect(mysqlTimeToSec('1.5')).toBe(1.5)
  })
})
