// 手机查看与授权（局域网）：设置页与主进程之间的数据形状。实现见 desktop/main/mobile*.ts

export interface MobileDevice {
  id: string
  name: string          // 配对时手机自报的名字（浏览器 UA 摘要），仅用于辨认
  createdAt: number     // epoch ms
  expiresAt?: number    // epoch ms；到期后令牌失效，需要重新配对
  lastSeenAt?: number
  lastIp?: string
}

export interface MobileAddress { address: string; name: string }   // 网卡名 + 私有网段 IPv4

export interface MobileStatus {
  enabled: boolean
  running: boolean
  url?: string                     // 运行中：http://地址:端口/
  address?: string                 // 选中的网卡地址（缺省 = 第一个私有网段地址）
  port: number
  addresses: MobileAddress[]       // 本机当前的私有网段地址（可选的绑定地址）
  error?: string                   // 开启了但没起来的原因（地址不在 / 端口被占等）
  devices: MobileDevice[]
  pairing?: { code: string; expiresAt: number }   // 当前有效的一次性配对码
}
