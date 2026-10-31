import { describe, it, expect } from 'vitest'
import {
  analyzeOutput, baseCommand, cellNumber, columnComparator, commandKind, filterRows, isDurationColumn, jsonPath, jsonSearch, jsonToTable,
  outputLines, parseJsonOutput, sortRows, strWidth, tableQuote, tableRecognizable, toCsv, toMarkdown, type OutTable,
} from './outputTable.js'

const table = (text: string, cmd = '', mode: 'auto' | 'whitespace' | 'fixed' = 'auto'): OutTable => {
  const v = analyzeOutput(text, cmd, mode)
  if (v.kind !== 'table') throw new Error(`不是表格：${v.kind}`)
  return v.table
}

const DF = `Filesystem      Size  Used Avail Use% Mounted on
udev            7.8G     0  7.8G   0% /dev
tmpfs           1.6G  2.1M  1.6G   1% /run
/dev/nvme0n1p2  468G  201G  244G  46% /
tmpfs           7.8G   96M  7.7G   2% /dev/shm
/dev/sdb1       1.8T  1.2T  580G  68% /mnt/my disk
`
const DF_K = `Filesystem     1K-blocks     Used Available Use% Mounted on
/dev/sda1       41152736 12345678  26690936  32% /
`
const PS_AUX = `USER         PID %CPU %MEM    VSZ   RSS TTY      STAT START   TIME COMMAND
root           1  0.0  0.1 168556 13020 ?        Ss   Oct14   0:09 /sbin/init splash
root           2  0.0  0.0      0     0 ?        S    Oct14   0:00 [kthreadd]
www-data    1234 12.5  2.3 912340 190232 ?       Sl   10:02  15:23 /usr/bin/java -Xmx2g -jar app.jar --spring.profiles.active=prod
postgres     987  0.3  1.1 215000  95000 ?       Ss   09:00   1:02 postgres: checkpointer
`
const DOCKER_PS = `CONTAINER ID   IMAGE          COMMAND                  CREATED        STATUS                      PORTS                                   NAMES
a1b2c3d4e5f6   nginx:1.25     "/docker-entrypoint.…"   2 hours ago    Up 2 hours                  0.0.0.0:80->80/tcp, :::80->80/tcp       web
0f9e8d7c6b5a   redis:7        "docker-entrypoint.s…"   3 days ago     Exited (0) 3 days ago                                               cache
123456789abc   my/app:latest  "python app.py"          5 weeks ago    Up 5 weeks (healthy)        127.0.0.1:8000->8000/tcp                api
`
const DOCKER_IMAGES = `REPOSITORY   TAG       IMAGE ID       CREATED        SIZE
nginx        1.25      a8758716bb6a   2 weeks ago    187MB
redis        7         7c1d7e2a3b4f   3 months ago   138MB
my/app       latest    0123456789ab   5 days ago     1.2GB
<none>       <none>    deadbeef0000   1 year ago     12.5kB
`
const DOCKER_STATS = `CONTAINER ID   NAME      CPU %     MEM USAGE / LIMIT     MEM %     NET I/O           BLOCK I/O         PIDS
a1b2c3d4e5f6   web       0.00%     7.5MiB / 7.6GiB       0.10%     1.2kB / 0B        0B / 4.1kB        5
0f9e8d7c6b5a   cache     12.34%    1.5GiB / 7.6GiB       19.70%    15MB / 3.2MB      8.2MB / 0B        31
`
const FREE = `               total        used        free      shared  buff/cache   available
Mem:        16310516     4380048     9030480      389548     2899988    11586060
Swap:        2097148           0     2097148
`
const SS = `State  Recv-Q Send-Q Local Address:Port  Peer Address:Port Process
LISTEN 0      4096   127.0.0.53%lo:53        0.0.0.0:*     users:(("systemd-resolve",pid=601,fd=14))
LISTEN 0      128          0.0.0.0:22        0.0.0.0:*     users:(("sshd",pid=800,fd=3))
LISTEN 0      511                *:80              *:*
`
const NETSTAT = `Active Internet connections (only servers)
Proto Recv-Q Send-Q Local Address           Foreign Address         State       PID/Program name
tcp        0      0 0.0.0.0:22              0.0.0.0:*               LISTEN      800/sshd: /usr/sbin
tcp6       0      0 :::8080                 :::*                    LISTEN      2201/java
`
const LSBLK = `NAME        MAJ:MIN RM   SIZE RO TYPE MOUNTPOINTS
nvme0n1     259:0    0 476.9G  0 disk
├─nvme0n1p1 259:1    0   512M  0 part /boot/efi
└─nvme0n1p2 259:2    0 476.4G  0 part /
sr0          11:0    1  1024M  0 rom
`
const KUBECTL = `NAME                                READY   STATUS             RESTARTS        AGE
web-7d4b9c8f6d-abcde                1/1     Running            0               5d
api-5f6c7d8e9f-xyz12                0/1     CrashLoopBackOff   12 (3m ago)     2d3h
worker-0                            1/1     Running            1               45m
`
const SYSTEMCTL = `  UNIT                     LOAD   ACTIVE SUB     DESCRIPTION
  cron.service             loaded active running Regular background program processing daemon
● nginx.service            loaded failed failed  A high performance web server and a reverse proxy server
  ssh.service              loaded active running OpenBSD Secure Shell server

LOAD   = Reflects whether the unit definition was properly loaded.
ACTIVE = The high-level unit activation state, i.e. generalization of SUB.

3 loaded units listed.
`
const SYSTEMCTL_PLAIN = `cron.service loaded active running Regular background program processing daemon
nginx.service loaded failed failed A high performance web server
`
const TOP = `top - 10:23:45 up 3 days,  2:01,  1 user,  load average: 0.15, 0.10, 0.05
Tasks: 201 total,   1 running, 200 sleeping,   0 stopped,   0 zombie
%Cpu(s):  1.6 us,  0.8 sy,  0.0 ni, 97.6 id,  0.0 wa,  0.0 hi,  0.0 si,  0.0 st
MiB Mem :  15928.2 total,   8818.4 free,   4277.4 used,   2832.4 buff/cache

    PID USER      PR  NI    VIRT    RES    SHR S  %CPU  %MEM     TIME+ COMMAND
   1234 www-data  20   0 3640012 190232  23456 S  12.5   1.2  15:23.45 java
      1 root      20   0  168556  13020   8320 S   0.0   0.1   0:09.12 systemd
    987 postgres  20   0  215000  95000  90000 S   0.3   0.6   1:02.00 postgres
`
const LS = `total 48
drwxr-xr-x  5 root root  4096 Oct 14 09:12 .
drwxr-xr-x 20 root root  4096 Sep  1  2023 ..
-rw-r--r--  1 root root  1234 Oct 14 09:12 config.yaml
-rwxr-xr-x  1 app  app  10485760 Oct 15 18:00 my app.bin
lrwxrwxrwx  1 root root    11 Oct 14 09:12 current -> release-1.2
`
const CN = `名称       状态     内存
网关服务   运行中   1.5G
数据库     已停止   512M
缓存       运行中   64M
`

describe('认命令', () => {
  it('取管道第一段、去 sudo / env 前缀', () => {
    expect(baseCommand('sudo -E LANG=C ps aux | head')).toBe('ps aux')
    expect(baseCommand('env FOO=1 docker ps -a')).toBe('docker ps -a')
  })
  it('能识别的命令', () => {
    for (const c of ['df -h', 'ps aux | head', 'docker ps', 'docker images', 'docker stats --no-stream', 'podman ps -a', 'docker container ls',
      'ss -ltnp', 'netstat -tlnp', 'free -m', 'lsblk', 'kubectl get pods -A', 'kubectl -n kube-system get svc', 'systemctl list-units --type=service',
      'top -bn1', 'top -b -n 1', 'ls -l', 'ls -la /etc', 'll', 'sudo lsof -i :80']) expect(commandKind(c), c).toBeDefined()
    for (const c of ['echo hi', 'cat x', 'ls', 'ls -a', 'top', 'docker run -it x', 'systemctl restart nginx', 'vim ps']) expect(commandKind(c), c).toBeUndefined()
  })
  it('输出是 JSON 也算可识别', () => {
    expect(tableRecognizable('curl -s http://x', '{"a":1}')).toBe(true)
    expect(tableRecognizable('curl -s http://x', 'hello')).toBe(false)
  })
})

describe('按表头位置切（固定宽度）', () => {
  it('df -h：Mounted on 是一个列名，挂载点含空格也不拆', () => {
    const t = table(DF, 'df -h')
    expect(t.columns).toEqual(['Filesystem', 'Size', 'Used', 'Avail', 'Use%', 'Mounted on'])
    expect(t.rows[2]).toEqual(['/dev/nvme0n1p2', '468G', '201G', '244G', '46%', '/'])
    expect(t.rows[4][5]).toBe('/mnt/my disk')
    expect(t.mode).toBe('fixed')
  })
  it('df 不带 -h：1K-blocks 也认作表头', () => {
    const t = table(DF_K, 'df')
    expect(t.columns[1]).toBe('1K-blocks')
    expect(t.rows[0]).toEqual(['/dev/sda1', '41152736', '12345678', '26690936', '32%', '/'])
  })
  it('ps aux：COMMAND 吞掉剩余（含空格的参数原样保留）；超宽的 RSS 也归对列', () => {
    const t = table(PS_AUX, 'ps aux')
    expect(t.columns).toEqual(['USER', 'PID', '%CPU', '%MEM', 'VSZ', 'RSS', 'TTY', 'STAT', 'START', 'TIME', 'COMMAND'])
    expect(t.rows[0][10]).toBe('/sbin/init splash')
    expect(t.rows[2]).toEqual(['www-data', '1234', '12.5', '2.3', '912340', '190232', '?', 'Sl', '10:02', '15:23', '/usr/bin/java -Xmx2g -jar app.jar --spring.profiles.active=prod'])
    expect(t.rows[3][10]).toBe('postgres: checkpointer')
  })
  it('Git Bash 的 ps：比列头靠左一格的 ?（TTY）归对列，STIME 的「Oct 14」不拆', () => {
    const t = table(`      PID    PPID    PGID     WINPID   TTY         UID    STIME COMMAND
    10384   10364   10364      26796  ?        1126896   Oct 14 /c/Users/me/node
    21378       1   21378      67220  cons6    1126896 10:43:20 /usr/bin/bash
`, 'ps aux')
    expect(t.rows[0]).toEqual(['10384', '10364', '10364', '26796', '?', '1126896', 'Oct 14', '/c/Users/me/node'])
    expect(t.rows[1][4]).toBe('cons6')
  })
  it('docker ps：列值含空格（Up 2 hours / Exited (0) 3 days ago），空的 PORTS 是空串', () => {
    const t = table(DOCKER_PS, 'docker ps -a')
    expect(t.columns).toEqual(['CONTAINER ID', 'IMAGE', 'COMMAND', 'CREATED', 'STATUS', 'PORTS', 'NAMES'])
    expect(t.rows[0]).toEqual(['a1b2c3d4e5f6', 'nginx:1.25', '"/docker-entrypoint.…"', '2 hours ago', 'Up 2 hours', '0.0.0.0:80->80/tcp, :::80->80/tcp', 'web'])
    expect(t.rows[1]).toEqual(['0f9e8d7c6b5a', 'redis:7', '"docker-entrypoint.s…"', '3 days ago', 'Exited (0) 3 days ago', '', 'cache'])
    expect(t.rows[2][4]).toBe('Up 5 weeks (healthy)')
  })
  it('docker images / docker stats（MEM USAGE / LIMIT 等多词列名）', () => {
    const im = table(DOCKER_IMAGES, 'docker images')
    expect(im.columns).toEqual(['REPOSITORY', 'TAG', 'IMAGE ID', 'CREATED', 'SIZE'])
    expect(im.rows[3]).toEqual(['<none>', '<none>', 'deadbeef0000', '1 year ago', '12.5kB'])
    const st = table(DOCKER_STATS, 'docker stats --no-stream')
    expect(st.columns).toEqual(['CONTAINER ID', 'NAME', 'CPU %', 'MEM USAGE / LIMIT', 'MEM %', 'NET I/O', 'BLOCK I/O', 'PIDS'])
    expect(st.rows[1]).toEqual(['0f9e8d7c6b5a', 'cache', '12.34%', '1.5GiB / 7.6GiB', '19.70%', '15MB / 3.2MB', '8.2MB / 0B', '31'])
  })
  it('free：右对齐的数字 + 第一列没有列名', () => {
    const t = table(FREE, 'free')
    expect(t.columns).toEqual(['', 'total', 'used', 'free', 'shared', 'buff/cache', 'available'])
    expect(t.rows[0]).toEqual(['Mem:', '16310516', '4380048', '9030480', '389548', '2899988', '11586060'])
    expect(t.rows[1]).toEqual(['Swap:', '2097148', '0', '2097148', '', '', ''])
  })
  it('ss：Local Address:Port 是一个列名；右对齐的地址归对列', () => {
    const t = table(SS, 'ss -ltnp')
    expect(t.columns).toEqual(['State', 'Recv-Q', 'Send-Q', 'Local Address:Port', 'Peer Address:Port', 'Process'])
    expect(t.rows[1]).toEqual(['LISTEN', '0', '128', '0.0.0.0:22', '0.0.0.0:*', 'users:(("sshd",pid=800,fd=3))'])
    expect(t.rows[2][5]).toBe('')
  })
  it('netstat：跳过前面的说明行，PID/Program name 含空格', () => {
    const t = table(NETSTAT, 'netstat -tlnp')
    expect(t.columns).toEqual(['Proto', 'Recv-Q', 'Send-Q', 'Local Address', 'Foreign Address', 'State', 'PID/Program name'])
    expect(t.rows[0]).toEqual(['tcp', '0', '0', '0.0.0.0:22', '0.0.0.0:*', 'LISTEN', '800/sshd: /usr/sbin'])
  })
  it('lsblk：树形前缀、空的挂载点', () => {
    const t = table(LSBLK, 'lsblk')
    expect(t.rows[1]).toEqual(['├─nvme0n1p1', '259:1', '0', '512M', '0', 'part', '/boot/efi'])
    expect(t.rows[0][6]).toBe('')
    expect(t.rows[3][1]).toBe('11:0')
  })
  it('kubectl get：RESTARTS 列值含空格', () => {
    const t = table(KUBECTL, 'kubectl get pods')
    expect(t.rows[1]).toEqual(['api-5f6c7d8e9f-xyz12', '0/1', 'CrashLoopBackOff', '12 (3m ago)', '2d3h'])
  })
  it('systemctl list-units：● 前缀去掉、图例截掉；--no-legend 用固定列名', () => {
    const t = table(SYSTEMCTL, 'systemctl list-units --type=service')
    expect(t.columns).toEqual(['UNIT', 'LOAD', 'ACTIVE', 'SUB', 'DESCRIPTION'])
    expect(t.rows).toHaveLength(3)
    expect(t.rows[1]).toEqual(['nginx.service', 'loaded', 'failed', 'failed', 'A high performance web server and a reverse proxy server'])
    const p = table(SYSTEMCTL_PLAIN, 'systemctl list-units --no-legend --plain')
    expect(p.columns).toEqual(['UNIT', 'LOAD', 'ACTIVE', 'SUB', 'DESCRIPTION'])
    expect(p.rows[1]).toEqual(['nginx.service', 'loaded', 'failed', 'failed', 'A high performance web server'])
  })
  it('top -bn1：只取进程段', () => {
    const t = table(TOP, 'top -bn1')
    expect(t.columns).toEqual(['PID', 'USER', 'PR', 'NI', 'VIRT', 'RES', 'SHR', 'S', '%CPU', '%MEM', 'TIME+', 'COMMAND'])
    expect(t.rows[0]).toEqual(['1234', 'www-data', '20', '0', '3640012', '190232', '23456', 'S', '12.5', '1.2', '15:23.45', 'java'])
    expect(t.rows).toHaveLength(3)
  })
  it('更多真实样例：ps -ef / kubectl -o wide / free -h / vmstat / lsof', () => {
    const ef = table(`UID          PID    PPID  C STIME TTY          TIME CMD
root           1       0  0 Oct14 ?        00:00:09 /sbin/init splash
mysql       2201       1  2 09:00 ?        01:02:03 /usr/sbin/mysqld --basedir=/usr --datadir=/var/lib/mysql
`, 'ps -ef')
    expect(ef.rows[1]).toEqual(['mysql', '2201', '1', '2', '09:00', '?', '01:02:03', '/usr/sbin/mysqld --basedir=/usr --datadir=/var/lib/mysql'])
    const kw = table(`NAME       READY   STATUS    RESTARTS   AGE   IP           NODE     NOMINATED NODE   READINESS GATES
web-abc    1/1     Running   0          10d   10.42.0.15   node-1   <none>           <none>
`, 'kubectl get pods -o wide')
    expect(kw.columns).toEqual(['NAME', 'READY', 'STATUS', 'RESTARTS', 'AGE', 'IP', 'NODE', 'NOMINATED NODE', 'READINESS GATES'])
    expect(kw.rows[0][7]).toBe('<none>')
    const fh = table(`               total        used        free      shared  buff/cache   available
Mem:            15Gi       4.2Gi       8.6Gi       380Mi       2.8Gi        11Gi
Swap:          2.0Gi          0B       2.0Gi
`, 'free -h')
    expect(fh.rows[0]).toEqual(['Mem:', '15Gi', '4.2Gi', '8.6Gi', '380Mi', '2.8Gi', '11Gi'])
    expect(sortRows(fh.rows, 1, true)).toEqual([0, 1])
    const vm = table(`procs -----------memory---------- ---swap-- -----io---- -system-- ------cpu-----
 r  b   swpd   free   buff  cache   si   so    bi    bo   in   cs us sy id wa st
 1  0      0 9030480 312000 2587988    0    0     3    12   45   80  2  1 97  0  0
`, 'vmstat')
    expect(vm.columns.slice(0, 4)).toEqual(['r', 'b', 'swpd', 'free'])
    expect(vm.rows[0][3]).toBe('9030480')
    const lsof = table(`COMMAND   PID     USER   FD   TYPE DEVICE SIZE/OFF NODE NAME
nginx    1234     root    6u  IPv4  23456      0t0  TCP *:http (LISTEN)
sshd      800     root    3u  IPv4  12345      0t0  TCP *:ssh (LISTEN)
`, 'lsof -i')
    expect(lsof.rows[0]).toEqual(['nginx', '1234', 'root', '6u', 'IPv4', '23456', '0t0', 'TCP', '*:http (LISTEN)'])
  })
  it('中文表头和内容按显示宽度对齐', () => {
    expect(strWidth('网关服务')).toBe(8)
    const t = table(CN, 'df')
    expect(t.columns).toEqual(['名称', '状态', '内存'])
    expect(t.rows).toEqual([['网关服务', '运行中', '1.5G'], ['数据库', '已停止', '512M'], ['缓存', '运行中', '64M']])
  })
  it('超长行 / Tab 分隔', () => {
    const long = 'x'.repeat(5000)
    const t = table(`NAME   VALUE\nkey    ${long}\n`, 'df')
    expect(t.rows[0][1]).toHaveLength(5000)
    expect(outputLines('a\tb')).toEqual(['a       b'])
    expect(table('NAME\tSIZE\nfoo\t1G\nbarbazqux\t2G\n', 'df').rows).toEqual([['foo', '1G'], ['barbazqux', '2G']])
  })
})

describe('ls -l / 无表头 / 手动切法', () => {
  it('ls -l：跳过 total，文件名含空格、软链接整段保留', () => {
    const t = table(LS, 'ls -l')
    expect(t.columns).toEqual(['权限', '链接数', '所有者', '组', '大小', '月', '日', '时间/年', '名称'])
    expect(t.rows).toHaveLength(5)
    expect(t.rows[3]).toEqual(['-rwxr-xr-x', '1', 'app', 'app', '10485760', 'Oct', '15', '18:00', 'my app.bin'])
    expect(t.rows[4][8]).toBe('current -> release-1.2')
    const iso = table('-rw-r--r-- 1 root root 12 2024-01-02 03:04 a b.txt\n', 'ls -l --time-style=long-iso')
    expect(iso.columns).toHaveLength(8)
    expect(iso.rows[0][7]).toBe('a b.txt')
  })
  it('无表头：退化为按空白分隔，列名 列1…', () => {
    const t = table('alpha 1 2\nbeta 3 4 5\n')
    expect(t.header).toBe(false)
    expect(t.columns).toEqual(['列1', '列2', '列3', '列4'])
    expect(t.rows[0]).toEqual(['alpha', '1', '2', ''])
  })
  it('无表头 + 按固定宽度：所有行都是空格的位置当分隔', () => {
    const t = table('web    Up 2 hours    80\ndb     Exited (0)    -\n', '', 'fixed')
    expect(t.rows).toEqual([['web', 'Up 2 hours', '80'], ['db', 'Exited (0)', '-']])
  })
  it('有表头 + 手动按空白分隔：最后一列吞掉剩余', () => {
    const t = table(DOCKER_PS, 'docker ps', 'whitespace')
    expect(t.mode).toBe('whitespace')
    expect(t.rows[0][0]).toBe('a1b2c3d4e5f6')
    expect(t.rows[0][1]).toBe('nginx:1.25')
    expect(t.rows[0][6]).toContain('web')
  })
  it('空输出', () => {
    expect(analyzeOutput('\n\n  \n').kind).toBe('empty')
  })
})

describe('JSON', () => {
  it('整段 JSON / JSON Lines', () => {
    expect(parseJsonOutput('{"a":[1,2,{"b":3}]}')).toEqual({ a: [1, 2, { b: 3 }] })
    expect(parseJsonOutput('{"ID":"a"}\n{"ID":"b"}\n')).toEqual([{ ID: 'a' }, { ID: 'b' }])
    expect(parseJsonOutput('{oops')).toBeUndefined()
    expect(parseJsonOutput('[1] trailing')).toBeUndefined()
    const v = analyzeOutput('{"a":[1,2,{"b":3}]}')
    expect(v.kind).toBe('json')
  })
  it('对象数组还能看表格', () => {
    const t = jsonToTable([{ name: 'a', n: 1 }, { name: 'b', extra: { x: 1 }, n: null }])!
    expect(t.columns).toEqual(['name', 'n', 'extra'])
    expect(t.rows).toEqual([['a', '1', ''], ['b', 'null', '{"x":1}']])
    expect(jsonToTable([1, 2])).toBeUndefined()
  })
  it('路径：jq 风格', () => {
    expect(jsonPath([])).toBe('.')
    expect(jsonPath(['a', 2, 'b'])).toBe('.a[2].b')
    expect(jsonPath(['带 空格', 0])).toBe('.["带 空格"][0]')
    expect(jsonPath([0, 'x'])).toBe('.[0].x')
  })
  it('搜索：命中节点和祖先都保留', () => {
    const { keep, hits } = jsonSearch({ a: [1, 2, { b: 3 }], c: 'hello' }, 'b')
    expect(hits).toBe(1)
    expect([...keep].sort()).toEqual(['.', '.a', '.a[2]', '.a[2].b'].sort())
    expect(jsonSearch({ c: 'Hello' }, 'hell').keep.has('.c')).toBe(true)
  })
})

describe('排序 / 过滤 / 导出', () => {
  it('数值：大小单位按 1024 进位、百分比、千分位、时间', () => {
    expect(cellNumber('1.2G')).toBeCloseTo(1.2 * 1024 ** 3)
    expect(cellNumber('512K')).toBe(512 * 1024)
    expect(cellNumber('187MB')).toBe(187 * 1024 ** 2)
    expect(cellNumber('1.5GiB')).toBe(1.5 * 1024 ** 3)
    expect(cellNumber('12.5kB')).toBe(12.5 * 1024)
    expect(cellNumber('46%')).toBe(46)
    expect(cellNumber('1,234,567')).toBe(1234567)
    expect(cellNumber('15:23')).toBe(15 * 60 + 23)
    expect(cellNumber('1-02:03:04')).toBe(86400 + 7384)
    expect(cellNumber('0:09.12')).toBeCloseTo(9.12)
    expect(cellNumber('nginx')).toBeUndefined()
    expect(cellNumber('')).toBeUndefined()
  })
  it('kubectl AGE 列：5m 是 5 分钟', () => {
    expect(isDurationColumn(['5d', '2d3h', '45m'])).toBe(true)
    expect(isDurationColumn(['5M', '1.2G'])).toBe(false)
    const c = columnComparator(['5d', '2d3h', '45m'])
    expect(['5d', '2d3h', '45m'].sort(c)).toEqual(['45m', '2d3h', '5d'])
  })
  it('按列排序：大小按数值，空值永远最后', () => {
    const t = table(DF, 'df -h')
    expect(sortRows(t.rows, 1, false).map((i) => t.rows[i][1])).toEqual(['1.6G', '7.8G', '7.8G', '468G', '1.8T'])
    expect(sortRows(t.rows, 1, true).map((i) => t.rows[i][1])).toEqual(['1.8T', '468G', '7.8G', '7.8G', '1.6G'])
    const rows = [['b', ''], ['a', '2'], ['c', '10']]
    expect(sortRows(rows, 1, false)).toEqual([1, 2, 0])
    expect(sortRows(rows, 1, true)).toEqual([2, 1, 0])
    expect(sortRows([['file10'], ['file9'], ['File1']], 0, false)).toEqual([2, 1, 0])
  })
  it('全局搜索 + 每列过滤', () => {
    const t = table(DOCKER_PS, 'docker ps')
    const all = t.rows.map((_, i) => i)
    expect(filterRows(t.rows, all, 'up', {})).toEqual([0, 2])
    expect(filterRows(t.rows, all, '', { 6: 'CA' })).toEqual([1])
    expect(filterRows(t.rows, all, 'up healthy', {})).toEqual([2])
    expect(filterRows(t.rows, [2, 0], 'up', { 1: 'nginx' })).toEqual([0])
  })
  it('CSV：含逗号 / 引号 / 换行加引号；Markdown 转义竖线', () => {
    expect(toCsv(['a', 'b'], [['1,2', 'say "hi"'], ['x', 'line\nbreak']])).toBe('a,b\r\n"1,2","say ""hi"""\r\nx,"line\nbreak"\r\n')
    expect(toMarkdown(['', 'b'], [['a|b', 'c']])).toBe('| 列1 | b |\n| --- | --- |\n| a\\|b | c |\n')
  })
  it('发给 AI：行多只附前 N 行', () => {
    const q = tableQuote({ title: 'web', command: 'df -h', columns: ['a'], rows: [['1'], ['2'], ['3']], total: 3, maxRows: 2 })
    expect(q).toContain('终端「web」')
    expect(q).toContain('| 1 |')
    expect(q).not.toContain('| 3 |')
    expect(q).toContain('共 3 行，只附前 2 行')
  })
})
