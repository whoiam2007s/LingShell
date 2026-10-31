import { describe, expect, it } from 'vitest'
import { checkScript, fixScriptLines, parseScriptOutput, scriptInput, scriptIsReadonly, splitSql } from './sqlScript.js'

describe('脚本输出分段', () => {
  it('mysql -t -vvv：每条语句一段，表格解析（中文、值里有 |），去掉 Bye', () => {
    const out = [
      '--------------', 'START TRANSACTION', '--------------', '', 'Query OK, 0 rows affected (0.00 sec)', '',
      '--------------', 'show tables', '--------------', '',
      '+-------------------+', '| Tables_in_shop    |', '+-------------------+', '| t_order           |', '| 订单明细          |', '+-------------------+', '2 rows in set (0.00 sec)', '',
      '--------------', "select 'a|b' as v, 2 as n", '--------------', '',
      '+-----+---+', '| v   | n |', '+-----+---+', '| a|b | 2 |', '+-----+---+', '1 row in set (0.00 sec)', '', 'Bye',
    ].join('\n')
    const s = parseScriptOutput('mysql', out)
    expect(s.map((x) => x.stmt)).toEqual(['START TRANSACTION', 'show tables', "select 'a|b' as v, 2 as n"])
    expect(s[0]).toMatchObject({ tables: [], text: 'Query OK, 0 rows affected (0.00 sec)' })
    expect(s[1].tables).toEqual([{ columns: ['Tables_in_shop'], rows: [['t_order'], ['订单明细']] }])
    expect(s[1].text).toBe('2 rows in set (0.00 sec)')
    expect(s[2].tables[0]).toEqual({ columns: ['v', 'n'], rows: [['a|b', '2']] })
  })
  it('psql 对齐输出：表格一段，命令标签另起一段', () => {
    const out = ['UPDATE 3', ' id | name ', '----+------', '  1 | 张三', '  2 | b', '(2 rows)', '', 'COMMIT'].join('\n')
    const s = parseScriptOutput('postgres', out)
    expect(s).toEqual([
      { tables: [], text: 'UPDATE 3' },
      { tables: [{ columns: ['id', 'name'], rows: [['1', '张三'], ['2', 'b']] }], text: '(2 rows)' },
      { tables: [], text: 'COMMIT' },
    ])
    expect(parseScriptOutput('redis', 'OK')).toEqual([])
  })
})

describe('只读脚本不用确认', () => {
  it('每条都是只读语句才算；结尾没分号也行', () => {
    expect(scriptIsReadonly('mysql', 'select * from t limit 50')).toBe(true)
    expect(scriptIsReadonly('mysql', 'show tables;\nselect 1;\n-- 注释\ndesc t')).toBe(true)
    expect(scriptIsReadonly('mysql', 'select 1;\nupdate t set a = 1')).toBe(false)
    expect(scriptIsReadonly('mysql', 'select * from t for update')).toBe(false)
    expect(scriptIsReadonly('mysql', "select 'x")).toBe(false)
    expect(scriptIsReadonly('postgres', 'select 1; select 2')).toBe(true)
    expect(scriptIsReadonly('redis', 'GET k')).toBe(false)
    expect(scriptIsReadonly('mysql', '  ')).toBe(false)
  })
})

// want：每项「行:级别:关键字」，按顺序一一对应（关键字是提示文字的一部分）
const expectFindings = (kind: 'mysql' | 'postgres' | 'redis', src: string, tx: boolean, want: string[]) => {
  const got = checkScript(kind, src, tx).findings
  expect(got.map((f) => `${f.line}:${f.level}`)).toEqual(want.map((w) => w.split(':').slice(0, 2).join(':')))
  want.forEach((w, i) => expect(got[i].msg).toContain(w.split(':').slice(2).join(':')))
}

describe('脚本拆分', () => {
  it('字符串 / 注释里的分号不拆；行号指向语句首行', () => {
    const { stmts, errors, tail } = splitSql("-- 头注释\nUPDATE t SET a = 'x;y' WHERE id = 1;\n/* ; */\nDELETE FROM t WHERE b = \"q;\"\n", 'mysql')
    expect(errors).toEqual([])
    expect(stmts.map((s) => [s.line, s.verb])).toEqual([[2, 'update'], [4, 'delete']])
    expect(tail).toBe(';')
  })
  it('MySQL DELIMITER：存储过程体里的分号不拆', () => {
    const { stmts, tail } = splitSql('DELIMITER $$\nCREATE PROCEDURE p() BEGIN SELECT 1; SELECT 2; END$$\nDELIMITER ;\nCALL p();\n', 'mysql')
    expect(stmts.map((s) => s.verb)).toEqual(['create procedure', 'call'])
    expect(tail).toBeUndefined()
  })
  it('PG 美元引号；CREATE UNIQUE INDEX 归为 create index', () => {
    const { stmts } = splitSql("CREATE FUNCTION f() RETURNS int AS $$ BEGIN RETURN 1; END $$ LANGUAGE plpgsql;\nCREATE UNIQUE INDEX i ON t(a);", 'postgres')
    expect(stmts.map((s) => s.verb)).toEqual(['create function', 'create index'])
  })
  it('引号没结束 → 语法错误带行号', () => {
    expect(splitSql("SELECT 1;\nSELECT 'abc;\n", 'mysql').errors).toEqual([{ level: 'danger', line: 2, msg: '字符串没有结束（缺少 \'）' }])
  })
})

describe('智能检测', () => {
  it('缺 WHERE / 恒真 WHERE / 删表 / TRUNCATE 是高危；字符串里的 DROP 不误报', () => {
    expectFindings('mysql', "UPDATE t SET a = 1;\nDELETE FROM t WHERE 1=1;\nDROP TABLE t2;\nTRUNCATE t3;\nINSERT INTO log(msg) VALUES ('drop table x');\nDELETE FROM t WHERE id = 3;", false,
      ['1:danger:UPDATE 没有 WHERE', '2:danger:WHERE 恒为真', '3:danger:DROP TABLE', '4:danger:TRUNCATE'])
  })
  it('括号不配对；客户端命令', () => {
    expectFindings('postgres', 'SELECT count(*) FROM t WHERE (a = 1;\n\\! rm -rf /\n', false, ['1:danger:括号不配对', '2:danger:客户端命令'])
  })
  it('整体事务：MySQL DDL 隐式提交、脚本自带 COMMIT；PG CONCURRENTLY 不能在事务里', () => {
    expectFindings('mysql', 'ALTER TABLE t ADD c int;\nCOMMIT;', true, ['1:warn:锁表', '1:warn:隐式提交', '2:warn:自带 COMMIT'])
    expectFindings('postgres', 'CREATE INDEX CONCURRENTLY i ON t(a);', true, ['1:danger:不能在事务里'])
    expectFindings('postgres', 'CREATE INDEX i ON t(a);', false, ['1:warn:CONCURRENTLY'])
  })
  it('统计语句种类', () => {
    expect(checkScript('mysql', 'insert into a(x) values (1); insert into a(x) values (2); update a set x=3 where x=1;', true).counts).toEqual([['INSERT', 2], ['UPDATE', 1]])
  })
  it('Redis 按行', () => {
    expectFindings('redis', '# 注释\nSET k v\nFLUSHDB\nKEYS user:*\nSET "a b\n', false, ['3:danger:清空数据', '4:warn:SCAN', '5:danger:引号没有配对'])
  })
})

describe('执行输入', () => {
  it('末尾没分号才补；MySQL 整体事务包 START TRANSACTION / COMMIT，报错行号回正', () => {
    expect(scriptInput('postgres', 'select 1;', false)).toBe('select 1;\n')
    expect(scriptInput('postgres', 'select 1', true)).toBe('select 1\n;\n')
    expect(scriptInput('mysql', 'DELIMITER $$\nCREATE PROCEDURE p() BEGIN SELECT 1; END', true)).toBe('START TRANSACTION;\nDELIMITER $$\nCREATE PROCEDURE p() BEGIN SELECT 1; END\n$$\nDELIMITER ;\nCOMMIT;\n')
    expect(fixScriptLines('mysql', true, 'ERROR 1064 (42000) at line 3: You have an error')).toBe('ERROR 1064 (42000) at line 2: You have an error')
    expect(fixScriptLines('mysql', false, 'at line 3')).toBe('at line 3')
  })
})
