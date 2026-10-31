import { describe, expect, it } from 'vitest'
import {
  MONGO_VIEW_JS, checkMongoScript, mongoPageable, docsToTable, ejsonCell, mongoExplain, mongoJs, mongoParseOut, mongoQueryBody, mongoSchemaDetail, mongoViewResult,
  parseMongoQuery, parseMongoValue,
} from './mongoQuick.js'
import { dbCommand, type DbConn } from './dbQuick.js'
import { backupStartCommand, checkBackupOpts } from './dbBackup.js'

const mg: DbConn = { id: 'g', name: '日志库', hostKey: 'local', kind: 'mongo', via: 'client', host: '10.0.0.5', port: 27018, user: 'ops', database: 'app' }
// 生成的脚本至少要是合法 JS（没有真 mongosh 时先保证语法）
const compiles = (js: string) => { new Function('db', 'print', 'EJSON', 'Mongo', 'process', js); return true }

describe('shell 语法解析（不执行用户文本）', () => {
  it('对象 / 数组 / 未加引号的键 / 单引号 / 注释 / 结尾逗号', () => {
    expect(parseMongoValue("{ status: 'paid', n: { $gt: -1.5e2 }, tags: ['a', \"b\",], /* x */ ok: true, x: null, }")).toEqual({ status: 'paid', n: { $gt: -150 }, tags: ['a', 'b'], ok: true, x: null })
  })
  it('ObjectId / ISODate / new Date / NumberLong / 正则 → EJSON', () => {
    expect(parseMongoValue('{ _id: ObjectId("64b7f0c2a1b2c3d4e5f60718"), at: { $gte: ISODate("2024-01-01") }, d: new Date(0), big: NumberLong(9007199254740993), name: /^张/i }')).toEqual({
      _id: { $oid: '64b7f0c2a1b2c3d4e5f60718' }, at: { $gte: { $date: '2024-01-01T00:00:00.000Z' } }, d: { $date: '1970-01-01T00:00:00.000Z' }, big: { $numberLong: '9007199254740992' }, name: { $regularExpression: { pattern: '^张', options: 'i' } },
    })
  })
  it('拒绝会执行 JS / 写数据的操作符和任意函数', () => {
    expect(() => parseMongoValue('{ $where: "this.a > 1" }')).toThrow(/\$where/)
    expect(() => parseMongoValue('{ a: { $function: {} } }')).toThrow(/\$function/)
    expect(() => parseMongoValue('{ a: db.dropDatabase() }')).toThrow(/不支持/)
    expect(() => parseMongoValue('{ a: 1 } ; db.x.drop()')).toThrow(/多余/)
  })
  it('查询链：find + sort / limit / skip / projection；getCollection；show', () => {
    expect(parseMongoQuery("db.orders.find({ status: 'paid' }, { _id: 0 }).sort({ ts: -1 }).limit(20);")).toEqual({ kind: 'coll', coll: 'orders', method: 'find', args: [{ status: 'paid' }, { _id: 0 }], chain: [{ name: 'sort', args: [{ ts: -1 }] }, { name: 'limit', args: [20] }] })
    expect(parseMongoQuery('db.getCollection("a.b-c").countDocuments({})')).toMatchObject({ coll: 'a.b-c', method: 'countDocuments' })
    expect(parseMongoQuery('db.logs.v2.find()')).toMatchObject({ coll: 'logs.v2', method: 'find', args: [] })
    expect(parseMongoQuery('show collections')).toEqual({ kind: 'show', what: 'collections' })
    expect(parseMongoQuery('show dbs')).toEqual({ kind: 'show', what: 'dbs' })
    expect(parseMongoQuery('db.stats()')).toEqual({ kind: 'db', method: 'stats' })
  })
  it('写操作和不认识的写法都拒绝', () => {
    expect(() => parseMongoQuery('db.orders.deleteMany({})')).toThrow(/只读查询只支持/)
    expect(() => parseMongoQuery('db.orders.find().forEach(d => db.x.insert(d))')).toThrow(/不支持 \.forEach/)
    expect(() => parseMongoQuery('db.orders.aggregate([{ $match: {} }, { $out: "x" }])')).toThrow(/\$out/)
    expect(() => parseMongoQuery('db.system.users.find()')).toThrow(/集合名/)
    expect(() => parseMongoQuery('select * from t')).toThrow(/db\. 开头/)
  })
})

describe('生成的脚本', () => {
  it('开头：密码从环境变量取，命令行 / 脚本里都没有明文；用户名进连接串', () => {
    const js = mongoJs(mg, '__out(1);')
    expect(js).toContain("encodeURIComponent(process.env.MONGO_PWD || '')")
    expect(js).toContain('"10.0.0.5:27018"')
    expect(js).toContain('db = __conn.getDB("app")')
    expect(compiles(js)).toBe(true)
    const cmd = dbCommand(mg)
    expect(cmd).toContain('MONGO_PWD=$__p; export MONGO_PWD')
    expect(cmd).toContain('__js=$(cat)')
    expect(cmd).toContain(`mongosh --nodb --quiet --norc --eval "$__js"`)
    expect(dbCommand({ ...mg, via: 'docker', container: 'mongo1' })).toContain('docker exec -i ${MONGO_PWD+-e MONGO_PWD} ')
  })
  it('查询：参数经 EJSON.parse 传入；find 没写 limit 时补 1000；aggregate 末尾补 $limit', () => {
    const b = mongoQueryBody(parseMongoQuery("db.orders.find({ status: 'paid' }).sort({ ts: -1 })"))
    expect(b).toContain('db.getCollection("orders").find(EJSON.parse("{\\"status\\":\\"paid\\"}"))')
    expect(b).toContain('.sort(EJSON.parse("{\\"ts\\":-1}")).limit(1000)')
    expect(mongoQueryBody(parseMongoQuery('db.o.find().limit(5)'))).not.toContain('limit(1000)')
    expect(mongoQueryBody(parseMongoQuery('db.o.aggregate([{ $group: { _id: "$st" } }])'))).toContain('{\\"$limit\\":1000}')
    // 分页：find 补 skip / limit（多取一条）；自己写了 limit 的不分页；aggregate 末尾补 $skip / $limit
    expect(mongoQueryBody(parseMongoQuery('db.o.find({ a: 1 })'), false, { offset: 200, limit: 100 })).toContain('.skip(200).limit(101)')
    expect(mongoPageable(parseMongoQuery('db.o.find().limit(5)'))).toBe(false)
    expect(mongoQueryBody(parseMongoQuery('db.o.aggregate([{ $match: {} }])'), false, { offset: 0, limit: 100 })).toContain('{\\"$limit\\":101}')
    expect(mongoQueryBody(parseMongoQuery('db.o.aggregate([{ $match: {} }])'), false, { offset: 100, limit: 100 })).toContain('{\\"$skip\\":100},{\\"$limit\\":101}')
    expect(mongoPageable(parseMongoQuery('db.o.aggregate([{ $limit: 5 }])'))).toBe(false)
    expect(mongoPageable(parseMongoQuery('db.o.countDocuments({})'))).toBe(false)
    expect(mongoQueryBody(parseMongoQuery('db.o.find({ a: 1 })'), true)).toContain(".explain('executionStats')")
    expect(() => mongoQueryBody(parseMongoQuery('db.o.countDocuments()'), true)).toThrow(/EXPLAIN/)
    for (const q of ['show dbs', 'show collections', 'db.stats()', 'db.getCollectionNames()', 'db.o.findOne()', 'db.o.distinct("st", {})', 'db.o.getIndexes()', 'db.o.stats()', 'db.o.estimatedDocumentCount()', 'db.o.find().count()']) {
      expect(compiles(mongoJs(mg, mongoQueryBody(parseMongoQuery(q))))).toBe(true)
    }
  })
  it('各视图脚本语法正确', () => {
    for (const [k, v] of Object.entries(MONGO_VIEW_JS)) expect(compiles(mongoJs(mg, typeof v === 'function' ? (v as (x: never) => string)((k === 'schemaTable' ? 'orders' : 20) as never) : v)), k).toBe(true)
  })
})

describe('结果整理', () => {
  it('输出逐行解析；被截断的最后一行丢掉', () => {
    expect(mongoParseOut('Warning: x\n@@json 7\n@@doc {"a":1}\n@@doc {"a":')).toEqual({ json: 7, docs: [{ a: 1 }] })
  })
  it('文档 → 表格：_id 在前、字段并集、EJSON 包装显示成人能看的', () => {
    const t = docsToTable([{ name: '张三', _id: { $oid: 'abc' }, at: { $date: '2024-01-01T00:00:00Z' } }, { _id: { $oid: 'def' }, tags: ['a', { n: { $numberLong: '5' } }], x: null }])
    expect(t.columns).toEqual(['_id', 'name', 'at', 'tags', 'x'])
    expect(t.rows).toEqual([['ObjectId("abc")', '张三', '2024-01-01T00:00:00Z', '', ''], ['ObjectId("def")', '', '', '["a",{"n":"5"}]', 'null']])
    expect(ejsonCell({ $regularExpression: { pattern: 'a', options: 'i' } })).toBe('/a/i')
  })
  it('视图：复制不是副本集给说明；profiler 没开给说明', () => {
    expect(mongoViewResult('repl', { json: { error: 'not running with --replSet' }, docs: [] }).note).toMatch(/不是副本集/)
    expect(mongoViewResult('slow', { json: { was: 0, slowms: 100, count: 0 }, docs: [] }, { db: 'app' }).note).toMatch(/setProfilingLevel/)
    expect(mongoViewResult('sessions', { docs: [{ opid: 12, secs: 40, op: 'query' }] }).tables?.[0].table.columns).toEqual(['opid', 'secs', 'op'])
  })
  it('EXPLAIN 摘要：阶段链、扫描数、全集合扫描提示', () => {
    const e = mongoExplain({ queryPlanner: { namespace: 'app.orders', winningPlan: { stage: 'LIMIT', inputStage: { stage: 'COLLSCAN' } } }, executionStats: { nReturned: 3, totalDocsExamined: 5000, totalKeysExamined: 0, executionTimeMillis: 12 } })
    expect(e.text).toMatch(/执行计划：LIMIT ← COLLSCAN/)
    expect(e.text).toMatch(/扫描文档：5000/)
    expect(e.text).toMatch(/COLLSCAN）：没用上索引/)
  })
  it('集合结构：字段、索引、集合定义', () => {
    const d = mongoSchemaDetail('orders', { type: 'collection', options: {}, indexes: [{ v: 2, key: { _id: 1 }, name: '_id_' }, { v: 2, key: { st: 1, ts: -1 }, name: 'st_ts', unique: true }], fields: [{ field: '_id', types: 'ObjectId', seen: '100%' }] })
    expect(d.indexes.rows[1]).toEqual(['st_ts', '{"st":1,"ts":-1}', '{"unique":true}'])
    expect(d.ddl).toBe('db.createCollection("orders")\ndb.getCollection("orders").createIndex({"st":1,"ts":-1}, {"name":"st_ts","unique":true})')
    expect(mongoSchemaDetail('v', { type: 'view', options: { viewOn: 'orders', pipeline: [{ $match: { a: 1 } }] } }).ddl).toMatch(/^db\.createView\("v", "orders", \[/)
  })
})

describe('脚本页签 / 备份', () => {
  it('规则检测：删库删集合、无条件删除为高危', () => {
    const c = checkMongoScript('db.a.drop()\ndb.b.deleteMany({})\ndb.c.updateMany({}, { $set: { x: 1 } })\nprintjson(db.d.find().toArray())')
    expect(c.findings.filter((f) => f.level === 'danger').map((f) => f.line)).toEqual([1, 2, 3])
    expect(c.counts).toEqual([['drop', 1], ['deleteMany', 1], ['updateMany', 1], ['find', 1]])
  })
  it('mongodump：密码写临时配置文件（--config），不进命令行；只能一个集合', () => {
    const o = checkBackupOpts(mg, { dir: '~/bk', database: 'app', tables: ['orders'] })
    expect(typeof o).toBe('object')
    const cmd = backupStartCommand(mg, o as never, 'app-20260101-000000.archive.gz')
    expect(cmd).toContain('mongodump --archive --gzip --host')
    expect(cmd).toContain('--config=')
    expect(cmd).toContain('--collection')
    expect(cmd).not.toMatch(/--password/)
    expect(checkBackupOpts(mg, { dir: '~/bk', database: 'app', tables: ['a', 'b'] })).toMatch(/一个集合/)
  })
})
