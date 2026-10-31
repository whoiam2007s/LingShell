import { describe, it, expect } from 'vitest'
import { isReadOnlyScript } from './watchdogScript.js'

describe('isReadOnlyScript：看门狗检查脚本只读校验', () => {
  it.each([
    'test -e /tmp/lingshell-wd && { echo 存在; exit 1; } || { echo 不存在; exit 0; }',
    'pgrep -x mysqld >/dev/null || { echo "mysqld 未运行"; exit 1; }\necho "mysqld 运行中"',
    'u=$(df -P /data | tail -n 1 | tr -s " " | cut -d " " -f 5 | tr -d %)\necho "/data 使用率 ${u}%"\nif [ "$u" -gt 90 ]; then exit 1; fi\nexit 0',
    'n=$(tail -n 1000 /var/log/nginx/access.log | grep -c \' 5[0-9][0-9] \')\necho "最近 1000 行 5xx：$n"\n[ "$n" -gt 10 ] && exit 1\nexit 0',
    '# 注释行\nlocal x=1\nfor f in /a /b; do test -e $f || exit 1; done\necho ok',
    'c=$(( $(grep -c x /tmp/f) + 1 ))\necho $c',
    'if ! systemctl is-active --quiet nginx; then echo down; exit 1; else echo up; fi',
  ])('放行：%s', (s) => expect(isReadOnlyScript(s)).toBe(true))

  it.each([
    ['写文件', 'echo 1 > /tmp/x'],
    ['删除', 'test -e /tmp/x && rm -f /tmp/x'],
    ['命令替换里写', 'n=$(rm -rf /tmp/a)\necho $n'],
    ['反引号', 'echo `id`'],
    ['重启服务', 'systemctl restart nginx || exit 1'],
    ['环境前缀命令', 'X=1 rm /tmp/a'],
    ['改 PATH', 'PATH=/tmp/evil\ncat /etc/hosts'],
    ['sudo', 'sudo cat /etc/shadow'],
    ['awk（可执行任意代码）', "df | awk '{print $5}'"],
    ['后台', 'sleep 100 &'],
    ['heredoc', 'cat <<EOF\nx\nEOF'],
    ['进程替换', 'cat <(rm -rf /tmp/a)'],
    ['函数定义', 'f() { rm /tmp/a; }\nf'],
    ['eval', 'eval "rm /tmp/a"'],
    ['空', '  \n'],
    ['未闭合引号', 'echo "abc'],
  ])('拒绝 %s', (_n, s) => expect(isReadOnlyScript(s)).toBe(false))
})
