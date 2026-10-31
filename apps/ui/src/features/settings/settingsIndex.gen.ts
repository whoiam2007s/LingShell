// 自动生成（settingsIndexGen.ts），不要手改：npx vitest run src/features/settings/settingsIndex.test.ts -u
import type { SettingEntry } from './settingsIndexGen.js'

export const SETTINGS_INDEX: SettingEntry[] = [
 {
  "tab": "model",
  "kind": "row",
  "label": "名称",
  "hint": "在模型菜单里显示"
 },
 {
  "tab": "model",
  "kind": "row",
  "label": "提供商"
 },
 {
  "tab": "model",
  "kind": "row",
  "label": "接口协议"
 },
 {
  "tab": "model",
  "kind": "row",
  "label": "模型"
 },
 {
  "tab": "model",
  "kind": "row",
  "label": "支持图片",
  "hint": "多模态：对话里可以附图片",
  "tip": "开了才能在对话里附图片（输入框「+」→「图片…」、Ctrl+V 粘贴截图、拖入图片），图片作为多模态内容随消息发给模型。按模型名给默认值：已知支持视觉的（如 gpt-4o、qwen-vl、glm-4v、llava、DeepSeek V4.1 Flash）默认开，其它默认关；换模型会重新按默认值设置。开了但模型其实不支持图片时，带图片的请求会被接口报错。"
 },
 {
  "tab": "model",
  "kind": "row",
  "label": "API 地址"
 },
 {
  "tab": "model",
  "kind": "row",
  "label": "API Key",
  "tip": "每套配置的 Key 单独保存在本机数据目录：系统密钥链可用时加密存储、不以明文落盘；系统密钥链不可用时（部分 Linux）退化为明文，仅本机用户可读。界面读不回明文。换了提供商的配置不会沿用原来的 Key（避免把 A 家的 Key 发给 B 家）。「复制」出来的配置沿用原配置的 Key。"
 },
 {
  "tab": "model",
  "kind": "row",
  "label": "上下文窗口",
  "tip": "填 0 = 按模型自动。对话上下文超过「自动压缩阈值」时，自动把较早的对话压缩成摘要、任务不中断。阈值 = 上下文窗口的 60%，最多 600K，不用单独设置。"
 },
 {
  "tab": "model",
  "kind": "row",
  "label": "测试连接",
  "tip": "用表单当前的地址、模型、Key 和接口协议测试（Key 留空用已存的），不会自动测试。OpenAI 兼容：先请求 /models（不耗 token），端点不提供模型列表时发一条 1 token 的对话请求。Anthropic Messages：向 /v1/messages 发一条 1 token 的请求；返回 404 / 405 或格式不对时，多半是这个地址不支持 Anthropic 协议，可一键改用 OpenAI 兼容并重试。"
 },
 {
  "tab": "terminal",
  "kind": "section",
  "label": "外观",
  "tip": "改了自动保存，已打开的终端立即换上新外观。"
 },
 {
  "tab": "terminal",
  "kind": "row",
  "label": "配色",
  "section": "外观",
  "tip": "「跟随界面主题」：深色界面用深色配色，浅色界面用浅色配色（界面主题在 设置 → 通用 → 外观）。选了具体配色就固定用它，不随界面变。"
 },
 {
  "tab": "terminal",
  "kind": "row",
  "label": "字号",
  "section": "外观",
  "tip": "终端里也可以用 Ctrl+= / Ctrl+- / Ctrl+0 临时调整。"
 },
 {
  "tab": "terminal",
  "kind": "row",
  "label": "字体",
  "section": "外观",
  "hint": "留空 = 内置等宽字体",
  "tip": "填系统里装了的等宽字体名；没装的字体会自动退回内置字体。"
 },
 {
  "tab": "terminal",
  "kind": "row",
  "label": "行距",
  "section": "外观"
 },
 {
  "tab": "terminal",
  "kind": "row",
  "label": "光标样式",
  "section": "外观"
 },
 {
  "tab": "terminal",
  "kind": "row",
  "label": "光标闪烁",
  "section": "外观"
 },
 {
  "tab": "terminal",
  "kind": "row",
  "label": "回滚行数",
  "section": "外观",
  "tip": "终端能往回翻的行数。越大越占内存。"
 },
 {
  "tab": "terminal",
  "kind": "row",
  "label": "预览",
  "section": "外观"
 },
 {
  "tab": "terminal",
  "kind": "section",
  "label": "输入"
 },
 {
  "tab": "terminal",
  "kind": "row",
  "label": "粘贴安全检查",
  "section": "输入",
  "hint": "含危险命令或隐藏字符时先确认",
  "tip": "任何终端粘贴的内容含危险命令、或含隐藏 / 控制字符时先弹确认。生产终端粘贴多行内容总会先确认，不受这个开关影响。"
 },
 {
  "tab": "terminal",
  "kind": "row",
  "label": "命令自动补全",
  "section": "输入",
  "hint": "在提示符键入时弹出候选",
  "tip": "候选来自本主机命令历史、快速命令和常用命令。Tab / → 接受，Esc 关闭。"
 },
 {
  "tab": "terminal",
  "kind": "row",
  "label": "AI 预测下一条命令",
  "section": "输入",
  "hint": "提示符后灰色显示，→ 接受",
  "tip": "停在空提示符 0.8 秒后，按这个终端最近 5 条命令和最后一条输出的末尾（按「发给 AI 前脱敏」处理；生产主机只发命令、不发输出）问一次当前模型，把预测的命令用灰色显示在光标后。按 → 写进提示符（不回车），按其它键消失。同一个提示符只问一次，每分钟最多 6 次；没配 API Key 时不显示。补全浮层开着时不显示。会消耗少量 tokens。"
 },
 {
  "tab": "terminal",
  "kind": "section",
  "label": "提醒"
 },
 {
  "tab": "terminal",
  "kind": "row",
  "label": "长命令完成通知",
  "section": "提醒",
  "hint": "秒，0 = 关",
  "tip": "你自己敲的命令（需要命令成败标记，见使用帮助）跑得比这个秒数久，且窗口不在前台或该标签没显示时，弹系统通知；后台标签上同时出现绿 / 红小圆点，切过去就消失。AI 执行的命令不提醒。"
 },
 {
  "tab": "terminal",
  "kind": "row",
  "label": "命令失败时提示让 AI 排查",
  "section": "提醒",
  "hint": "终端底部出现一条横幅",
  "tip": "你自己敲的命令失败（成败标记为红点）时，终端底部出现「让 AI 排查」，点一下把命令、退出码、目录和输出尾部（按「发给 AI 前脱敏」处理）直接发到当前对话。AI 执行的命令、Ctrl+C 中断的不提示；按 × 关掉的同一条命令之后不再提示。"
 },
 {
  "tab": "terminal",
  "kind": "row",
  "label": "响铃提示",
  "section": "提醒",
  "tip": "终端收到响铃 \\a 时提示，例如远端执行 长任务; printf '\\a' 。「角标 + 通知」：后台标签显示铃铛，窗口不在前台时弹系统通知。"
 },
 {
  "tab": "terminal",
  "kind": "row",
  "label": "关键字高亮",
  "section": "提醒",
  "hint": "规则点亮铃铛 = 命中时告警",
  "tip": "只改变显示颜色，不影响录屏和 AI 读取的输出；vim / top 等全屏程序内不生效。规则点亮铃铛后，命中时标签角标 / 系统通知（每 30 秒最多一次）。"
 },
 {
  "tab": "terminal",
  "kind": "row",
  "label": "高亮规则",
  "section": "提醒"
 },
 {
  "tab": "terminal",
  "kind": "section",
  "label": "记录"
 },
 {
  "tab": "terminal",
  "kind": "row",
  "label": "即时回放缓冲",
  "section": "记录",
  "tip": "每个终端在内存里保留最近这么多输出（含时间），按 Ctrl+Alt+R 或右侧活动栏「即时回放」拖时间轴回看任意时刻的屏幕，包括被 clear、top、vim 刷掉的画面。只在内存里、不落盘，关掉终端或应用就没了；超出上限时最早的部分先丢。每个终端各占这么多内存。"
 },
 {
  "tab": "terminal",
  "kind": "row",
  "label": "自动记录会话日志",
  "section": "记录",
  "hint": "每个终端的输出存为纯文本 .log",
  "tip": "记的是终端上显示的输出（含命令回显），去掉颜色等控制字符；AI 执行命令时的内部包装不会进日志。不记键入：密码提示下不回显，所以密码不会出现在日志里（但命令输出里本身显示的敏感信息会被记下）。日志不进诊断包。"
 },
 {
  "tab": "terminal",
  "kind": "row",
  "label": "日志目录",
  "section": "记录",
  "hint": "留空 = 数据目录下 logs/sessions",
  "tip": "按日期分子目录存放。"
 },
 {
  "tab": "terminal",
  "kind": "row",
  "label": "日志保留天数",
  "section": "记录",
  "hint": "0 = 永久保留",
  "tip": "启动时及每天删除更早的日期目录。"
 },
 {
  "tab": "terminal",
  "kind": "row",
  "label": "每行加时间戳",
  "section": "记录"
 },
 {
  "tab": "terminal",
  "kind": "row",
  "label": "允许终端录屏",
  "section": "记录",
  "tip": "开启后终端标签栏出现录制按钮，点一下开始录当前终端、再点停止。录制期间会录下屏幕输出和键入的一切——包括在 sudo、ssh、mysql 等密码提示下敲的密码，以明文存在 ~/.lingshell/recordings。录像可在「终端录像」里回放，不会进入诊断包。关闭此开关会停止所有正在进行的录制。"
 },
 {
  "tab": "terminal",
  "kind": "row",
  "label": "录像保留天数",
  "section": "记录",
  "hint": "0 = 永久保留",
  "tip": "启动时删除更早的录像。"
 },
 {
  "tab": "ai",
  "kind": "section",
  "label": "AI 执行",
  "tip": "改了自动保存并即时生效：新建的会话，以及正在进行的会话的下一次请求。"
 },
 {
  "tab": "ai",
  "kind": "row",
  "label": "危险命令逐次确认",
  "section": "AI 执行",
  "hint": "rm -r、mkfs 等每次都问",
  "tip": "rm -r 、 mkfs 、 curl … | bash 这类即便已授权写入也每次问；关掉后只认授权面板里的写入权限。生产主机上的只读命令（cat / ls / grep 等）只需读取授权，不逐条确认。"
 },
 {
  "tab": "ai",
  "kind": "row",
  "label": "命令执行超时",
  "section": "AI 执行",
  "hint": "秒，10–300",
  "tip": "AI 执行单条命令的最长等待时间，超时后中断。"
 },
 {
  "tab": "ai",
  "kind": "row",
  "label": "AI 完成时通知",
  "section": "AI 执行",
  "hint": "窗口不在前台时弹系统通知",
  "tip": "AI 一轮跑完发「AI 已完成：会话标题」，出错发「AI 出错：错误摘要」；点通知回到窗口并切到那个会话。窗口在前台、你自己点了停止的不通知。"
 },
 {
  "tab": "ai",
  "kind": "row",
  "label": "AI 变更前后自动拍快照",
  "section": "AI 执行",
  "hint": "回合末显示「本轮主机变化」",
  "tip": "AI 在一轮里第一次对某台 Linux SSH 主机执行改动类命令 / 写文件前，先只读采一次端口、失败服务、容器和关键配置文件（限时 10 秒，失败不影响执行）；这一轮结束再采一次，有变化就在回复末尾显示「本轮主机变化」。只读命令（cat / ls / grep 等）不触发。快照也存进该主机的「主机体检」档案。"
 },
 {
  "tab": "ai",
  "kind": "row",
  "label": "全局自定义规则",
  "section": "AI 执行",
  "hint": "全局 → 分组 → 主机 → 工作目录 四层叠加，见「?」",
  "tip": "下一次模型请求即生效。规则分四层叠加，越具体的优先： ① 全局：这里写的，对所有会话生效； ② 分组：主机面板里右键分组 →「分组规则…」； ③ 主机：主机面板里右键主机 →「规则…」，或 设置 → 主机与连接 → 编辑主机 →「规则」； ④ 工作目录：会话绑定的工作目录里的 AGENTS.md 或 .lingshell/rules.md 。 分组 / 主机规则只在 AI 用到过该主机后才注入；总长有上限，超出时优先保留更具体的层。例：数据库组写「禁止重启 mysqld，变更前先 mysqldump」。"
 },
 {
  "tab": "ai",
  "kind": "row",
  "label": "本机备注",
  "section": "AI 执行",
  "hint": "同步成知识库里「本机」的一张卡",
  "tip": "AI 用到本地终端时会读到。写本机用途、常用目录、注意事项等，不要写密码等机密。分条记录请用知识库（左侧活动栏「知识库」）。"
 },
 {
  "tab": "ai",
  "kind": "section",
  "label": "命令规则",
  "tip": "AI 执行终端命令前先按这里的规则判定（从上到下，先匹配先生效）。复合命令（ ; &amp;&amp; || | 换行、 $( ) 、反引号）拆成段逐段匹配： 任一段命中「总是禁止」→ 直接拒绝；所有段都命中「总是放行」→ 不弹授权卡；有段命中「总是询问」→ 弹卡；其余照会话信任档。 「只读」信任档不会被放行规则突破；生产主机上的危险命令仍要确认。按规则放行 / 禁止的会在执行记录和授权卡里注明「按规则：…」。"
 },
 {
  "tab": "ai",
  "kind": "row",
  "label": "规则列表",
  "section": "命令规则",
  "hint": "前缀匹配命令段开头；正则在命令段里搜索（锚定开头写 ^）"
 },
 {
  "tab": "ai",
  "kind": "section",
  "label": "隐私"
 },
 {
  "tab": "ai",
  "kind": "row",
  "label": "发给 AI 前脱敏",
  "section": "隐私",
  "hint": "把密码、密钥等换成 [已脱敏]",
  "tip": "命令输出、文件内容、终端屏幕、MCP 结果在交给 AI 前，把已保存的主机密码/私钥、各家 API Key、群机器人 Webhook、MCP 凭据、自动应答密钥， 以及 password= 、 DB_PASS= 、私钥块、JWT、 sk-… 这类样式的值换成 [已脱敏] （对话里的工具卡片显示的也是脱敏后的）。 终端里你看到的、执行记录和录像不受影响。 代价：AI 看不到真实密钥值，排查「密码填错」「Key 不对」这类问题会受限； AI 想把 [已脱敏] 写回文件或命令会被直接拒绝。按样式识别是尽力而为，不能保证抹掉所有机密。"
 },
 {
  "tab": "ai",
  "kind": "section",
  "label": "上下文"
 },
 {
  "tab": "ai",
  "kind": "row",
  "label": "自动压缩阈值",
  "section": "上下文",
  "hint": "自动：模型上下文窗口的 60%，最多 600K",
  "tip": "对话上下文超过阈值时，自动把较早的对话压缩成摘要，任务不中断。阈值按当前会话所用模型配置的「上下文窗口」计算，不用单独设置；各配置的具体数值见「模型设置」。"
 },
 {
  "tab": "ai",
  "kind": "row",
  "label": "建议开新会话步数",
  "section": "上下文",
  "hint": "0 = 不提示",
  "tip": "会话执行到这么多步、且已压缩过时，提示是否用压缩摘要开新会话（只是建议，可忽略）。"
 },
 {
  "tab": "ai",
  "kind": "row",
  "label": "空闲自动锁定",
  "section": "上下文",
  "hint": "分钟，0 = 不按空闲锁定",
  "tip": "按系统空闲时间计算。0 = 只在启动、手动、系统锁屏 / 休眠时锁定。需要先启用应用锁。"
 },
 {
  "tab": "ai",
  "kind": "section",
  "label": "应用锁"
 },
 {
  "tab": "ai",
  "kind": "row",
  "label": "应用锁（主密码）",
  "section": "应用锁"
 },
 {
  "tab": "ai",
  "kind": "section",
  "label": "AI 复核",
  "tip": "参考 VS Code 的辅助授权与运维的双人复核：命中范围的命令在弹授权卡前，先把命令、主机、会话最近的上下文、该主机的规则与知识卡标题交给复核模型， 它回答「安全 / 风险 / 建议拦截」和一句理由，显示在授权卡上（「AI 复核：风险 · 理由」），也记进执行记录。写文件的改动还会把 diff 一并发给复核模型。 这些内容先按「发给 AI 前脱敏」处理，密钥保险箱里的值会换成占位符，复核模型同样看不到明文。 复核限时 15 秒，超时或出错按「未复核」照常弹卡。 「安全」不会自动放行（生产主机始终要你确认）。"
 },
 {
  "tab": "ai",
  "kind": "row",
  "label": "启用 AI 复核",
  "section": "AI 复核",
  "hint": "默认关；每次复核会多一次模型调用"
 },
 {
  "tab": "ai",
  "kind": "row",
  "label": "复核用的模型",
  "section": "AI 复核",
  "hint": "可选一个更便宜的配置",
  "tip": "在「模型设置」里可新建模型配置；复核用量记在用量统计的「ai-review」来源下。"
 },
 {
  "tab": "ai",
  "kind": "row",
  "label": "复核范围",
  "section": "AI 复核",
  "tip": "生产主机的写命令：只复核标为「生产」的主机上的非只读命令 / 写文件；所有危险命令：任何主机上命中危险模式的（rm -r、mkfs 等）；所有写命令：所有非只读命令与写文件（每张写入授权卡都会多等几秒）。只复核要弹授权卡的命令。"
 },
 {
  "tab": "ai",
  "kind": "row",
  "label": "复核判「建议拦截」时",
  "section": "AI 复核",
  "tip": "直接拒绝：不弹授权卡，把理由告诉主 AI（执行记录里记「AI 复核拦截」）；只提示不拦截：照常弹卡，卡上标红提示。"
 },
 {
  "tab": "ai",
  "kind": "row",
  "label": "复核通过则自动放行",
  "section": "AI 复核",
  "hint": "仅非生产主机 + 信任档「确认」",
  "tip": "会话信任档为「确认」、主机不是生产、命令不是危险命令、复核判「安全」时，不弹卡直接执行（执行记录里注明「AI 复核通过」）。其余情况照常弹卡。默认关。"
 },
 {
  "tab": "general",
  "kind": "section",
  "label": "文件传输"
 },
 {
  "tab": "general",
  "kind": "row",
  "label": "上传默认加密",
  "section": "文件传输",
  "tip": "上传对话框里默认选「加密上传」还是「不加密」，每次上传时仍可改。"
 },
 {
  "tab": "general",
  "kind": "row",
  "label": "同时传输数",
  "section": "文件传输",
  "hint": "1–5，其余排队等候",
  "tip": "上传、下载（含 AI 发起的）共用一个队列，超出的排队。"
 },
 {
  "tab": "general",
  "kind": "row",
  "label": "传输限速",
  "section": "文件传输",
  "hint": "KB/s，0 = 不限",
  "tip": "每个传输任务的速度上限（上传、下载都算），避免占满带宽影响线上业务。改了对进行中的任务立即生效。"
 },
 {
  "tab": "general",
  "kind": "row",
  "label": "外部编辑器",
  "section": "文件传输",
  "hint": "留空 = 系统默认程序",
  "tip": "资源管理器里「用本地编辑器打开」远程文件时用它。可填命令（如 code）或程序完整路径。"
 },
 {
  "tab": "general",
  "kind": "row",
  "label": "跳到行的参数",
  "section": "文件传输",
  "hint": "终端里 Ctrl+点击「文件:行号」时用",
  "tip": "按住 Ctrl 点击终端里的 src/a.ts:42:7、Python / Java / Go 等堆栈行时，用上面的外部编辑器打开并跳到这一行。「自动」按编辑器认：code / cursor 用 -g 文件:行:列，JetBrains 用 --line，Notepad++ 用 -n，Sublime 用 文件:行:列；外部编辑器留空时先试 VS Code（code -g），没装再用系统默认程序打开（不跳行）。自定义时用 {file} {line} {col} 占位。"
 },
 {
  "tab": "general",
  "kind": "section",
  "label": "连接"
 },
 {
  "tab": "general",
  "kind": "row",
  "label": "SSH 断线自动重连",
  "section": "连接",
  "hint": "退避重连，最多 8 次",
  "tip": "意外断线后按 2s / 5s / 10s / 30s… 退避重连，最多 8 次；远端 exit 退出或关闭标签不重连。默认关，免得网络抖动后悄悄连回生产机。"
 },
 {
  "tab": "general",
  "kind": "row",
  "label": "打开 ssh:// 链接",
  "section": "连接",
  "hint": "网页里点 ssh:// 链接直接连接",
  "tip": "网页 / CMDB 里点 ssh://user@host:port：已保存的主机确认后连接，否则预填新建连接；只取地址、端口、用户名。安装版注册为系统打开方式（会替换原来的 ssh:// 打开程序，如 PuTTY），开发版不注册。"
 },
 {
  "tab": "general",
  "kind": "section",
  "label": "窗口"
 },
 {
  "tab": "general",
  "kind": "row",
  "label": "连按两下 Alt 呼出",
  "section": "窗口",
  "tip": "同 Windows Terminal 的 Quake 模式：应用在后台（最小化、被别的窗口挡住）时快速连按两下 Alt，窗口立即显示并把光标交给当前终端；已在前台时再连按两下最小化。按住 Alt 配别的键（Alt+Tab 等）不会触发。应用锁定时呼出后停在锁屏。目前只支持 Windows。"
 },
 {
  "tab": "general",
  "kind": "section",
  "label": "主机状态采集"
 },
 {
  "tab": "general",
  "kind": "row",
  "label": "主机状态采集",
  "section": "主机状态采集",
  "hint": "终端工具栏显示 CPU / 内存 / 磁盘 / 负载",
  "tip": "只采当前看得到的终端。SSH 终端会在服务器上经独立通道定时执行固定的只读命令（读 /proc/stat、/proc/meminfo、df 等；macOS 用 top、vm_stat、sysctl），不经过你的终端，不进命令历史、会话日志和录像；但服务器侧的审计（如 auditd）仍可能记下这些命令。仅支持 Linux / macOS。"
 },
 {
  "tab": "general",
  "kind": "row",
  "label": "采集间隔",
  "section": "主机状态采集",
  "hint": "秒，5–300"
 },
 {
  "tab": "general",
  "kind": "row",
  "label": "生产主机也采集",
  "section": "主机状态采集",
  "hint": "间隔自动 ×3"
 },
 {
  "tab": "general",
  "kind": "section",
  "label": "历史"
 },
 {
  "tab": "general",
  "kind": "row",
  "label": "每主机历史命令上限",
  "section": "历史",
  "hint": "10–1000"
 },
 {
  "tab": "general",
  "kind": "section",
  "label": "本地终端"
 },
 {
  "tab": "general",
  "kind": "row",
  "label": "Git Bash 路径",
  "section": "本地终端",
  "tip": "Windows 上本地终端和 AI 操作本地终端都需要 Git for Windows 里的 Git Bash（SSH 远程终端不需要）。自动检测依次查：这里手动指定的路径、环境变量 LINGSHELL_BASH、注册表里 Git for Windows 的安装位置、PATH 上的 git.exe / bash.exe、常见安装目录（Program Files、用户目录、scoop、各盘符下的 Git）。不认 C:\\Windows\\System32\\bash.exe（那是 WSL）。装在别处时点「选择…」指定 bash.exe（Git 安装目录下的 bin\\bash.exe）。"
 },
 {
  "tab": "general",
  "kind": "section",
  "label": "外观",
  "tip": "改了立即生效并保存。终端配色默认「跟随界面主题」（每套主题配好了对应的终端配色），可在 设置 → 终端 单独指定。"
 },
 {
  "tab": "general",
  "kind": "row",
  "label": "界面语言",
  "section": "外观",
  "hint": "跟随系统 = 系统是中文用中文，否则用英文；切换后重启应用生效"
 },
 {
  "tab": "general",
  "kind": "row",
  "label": "主题",
  "section": "外观",
  "hint": "点一下立即切换；跟随系统 = 随 Windows / macOS 的深浅色自动切换"
 },
 {
  "tab": "general",
  "kind": "row",
  "label": "系统为深色时",
  "section": "外观",
  "hint": "只列深色类主题"
 },
 {
  "tab": "general",
  "kind": "row",
  "label": "系统为浅色时",
  "section": "外观",
  "hint": "只列浅色类主题"
 },
 {
  "tab": "general",
  "kind": "row",
  "label": "界面缩放",
  "section": "外观",
  "tip": "整个窗口按比例缩放，适合高分屏或想看大一点的时候。终端字号另外在 设置 → 终端 调（或在终端里按 Ctrl+= / Ctrl+-）。"
 },
 {
  "tab": "general",
  "kind": "row",
  "label": "图标大小",
  "section": "外观",
  "hint": "只放大按钮和活动栏的图标，文字不变"
 },
 {
  "tab": "general",
  "kind": "section",
  "label": "启动与后台",
  "tip": "开机自启、关闭窗口后留在系统托盘、桌面悬浮球。这里的改动立即生效。"
 },
 {
  "tab": "general",
  "kind": "row",
  "label": "开机自启",
  "section": "启动与后台",
  "tip": "写入系统的登录启动项（Windows：当前用户的「启动」项；macOS：登录项），关掉即删除。"
 },
 {
  "tab": "general",
  "kind": "row",
  "label": "启动时只进托盘",
  "section": "启动与后台",
  "hint": "不弹主窗口，从托盘图标打开",
  "tip": "开机自启时带 --hidden 参数启动：不显示启动画面和主窗口，只在托盘里待命（AI 会话、巡检、看门狗照常）。手动启动不受影响。"
 },
 {
  "tab": "general",
  "kind": "row",
  "label": "关闭主窗口时最小化到托盘",
  "section": "启动与后台",
  "hint": "点 × 不退出，从托盘图标再打开",
  "tip": "开着时点窗口右上角 × 只是把窗口藏到系统托盘，AI 会话、巡检、看门狗、传输都继续跑；第一次会弹一条通知提醒。要真正退出：托盘图标右键 →「退出」（悬浮球右键菜单也有）。退出时还有传输未完成会先确认。关掉则点 × 直接退出。"
 },
 {
  "tab": "general",
  "kind": "row",
  "label": "显示悬浮球",
  "section": "启动与后台",
  "hint": "桌面上的小球：悬停看状态，右键快捷操作",
  "tip": "一个始终在最前的小球：灰色 = 空闲，蓝色转圈 = AI 运行中，橙色闪烁 + 数字 = 有待授权，红色 = 看门狗报警或 AI 最近出错。鼠标悬停展开状态卡（进行中的会话、待授权、看门狗、传输、当前主机 CPU / 内存），左键显示 / 隐藏主窗口，右键快速提问、处理待授权、调透明度等。可拖到任意位置，位置会记住。应用锁定时只显示锁。"
 },
 {
  "tab": "general",
  "kind": "row",
  "label": "透明度",
  "section": "启动与后台",
  "hint": "鼠标移上去时总是不透明"
 },
 {
  "tab": "general",
  "kind": "row",
  "label": "贴边自动半隐藏",
  "section": "启动与后台",
  "hint": "拖到屏幕左右边缘时只露一半",
  "tip": "拖到屏幕左右边缘会自动吸附；开着时鼠标离开后缩进去只露半个球，鼠标移上去完整滑出。多显示器之间相邻的边不吸附。"
 },
 {
  "tab": "network",
  "kind": "section",
  "label": "出站代理",
  "tip": "改了自动保存，对之后新建的连接生效；已连着的不受影响。"
 },
 {
  "tab": "network",
  "kind": "row",
  "label": "经代理出站",
  "section": "出站代理",
  "hint": "公司网络必须走代理才能连外网时开启",
  "tip": "终端、批量执行、文件传输、端口转发等所有 SSH 连接都会经这个代理（经跳板机的主机不走代理）。 单台主机可在「主机与连接」编辑 → 高级 →「出站代理」里覆盖或选「不使用代理」。 代理密码经操作系统密钥链加密存储，离开密码框时才保存。关掉开关会清除已存的代理（含密码）。HTTP 代理需支持 CONNECT 方法（且允许连 22 等非 443 端口）；SOCKS5 由代理解析主机名。"
 },
 {
  "tab": "maintenance",
  "kind": "section",
  "label": "数据目录"
 },
 {
  "tab": "maintenance",
  "kind": "row",
  "label": "数据目录",
  "section": "数据目录"
 },
 {
  "tab": "maintenance",
  "kind": "row",
  "label": "运行日志",
  "section": "数据目录"
 },
 {
  "tab": "maintenance",
  "kind": "section",
  "label": "配置导出"
 },
 {
  "tab": "maintenance",
  "kind": "row",
  "label": "导出内容",
  "section": "配置导出",
  "hint": "勾选要导出的部分"
 },
 {
  "tab": "maintenance",
  "kind": "row",
  "label": "导出密码",
  "section": "配置导出",
  "hint": "可选，设了才导出凭据"
 },
 {
  "tab": "maintenance",
  "kind": "row",
  "label": "导出到文件",
  "section": "配置导出"
 },
 {
  "tab": "maintenance",
  "kind": "section",
  "label": "配置导入"
 },
 {
  "tab": "maintenance",
  "kind": "row",
  "label": "从文件导入",
  "section": "配置导入"
 },
 {
  "tab": "maintenance",
  "kind": "row",
  "label": "导入密码",
  "section": "配置导入",
  "hint": "文件含加密凭据"
 },
 {
  "tab": "maintenance",
  "kind": "row",
  "label": "凭据",
  "section": "配置导入"
 },
 {
  "tab": "maintenance",
  "kind": "row",
  "label": "将执行本地命令",
  "section": "配置导入",
  "tip": "这些主机导入后，每次连接都会在本机执行下面的命令。不认识的文件来源请不要导入主机。"
 },
 {
  "tab": "maintenance",
  "kind": "section",
  "label": "诊断包"
 },
 {
  "tab": "maintenance",
  "kind": "row",
  "label": "日志与环境信息",
  "section": "诊断包"
 },
 {
  "tab": "mobile",
  "kind": "section",
  "label": "手机访问"
 },
 {
  "tab": "mobile",
  "kind": "row",
  "label": "允许手机在局域网查看与授权",
  "section": "手机访问"
 },
 {
  "tab": "mobile",
  "kind": "row",
  "label": "网卡地址",
  "section": "手机访问",
  "hint": "只绑定这个局域网地址；公网地址不会出现在列表里",
  "tip": "默认用第一个私有网段地址（10.x / 172.16–31.x / 192.168.x）。电脑有多块网卡（有线 / 无线 / 虚拟网卡）时，选手机所在的那个网络。选的地址不在了（换了网络）服务不会自动换到别的网卡，需要重新选。"
 },
 {
  "tab": "mobile",
  "kind": "row",
  "label": "端口",
  "section": "手机访问",
  "hint": "首次开启时随机选定的高位端口，改后立即生效"
 },
 {
  "tab": "mobile",
  "kind": "section",
  "label": "配对新设备",
  "tip": "配对码 5 分钟内有效、只能用一次；同一台设备输错 5 次会锁定 10 分钟（不影响在电脑上重新生成配对码）。配对后手机会记住（浏览器 cookie，30 天有效），以后直接打开地址即可；清了浏览器数据需要重新配对。"
 },
 {
  "tab": "mobile",
  "kind": "row",
  "label": "配对码",
  "section": "配对新设备",
  "hint": "手机浏览器打开下面的地址，输入配对码"
 },
 {
  "tab": "mobile",
  "kind": "row",
  "label": "在手机上打开",
  "section": "配对新设备"
 },
 {
  "tab": "mobile",
  "kind": "row",
  "label": "已配对的手机",
  "section": "配对新设备",
  "hint": "扫码直接打开（不含配对码，没配对过的手机需要先生成配对码）"
 },
 {
  "tab": "mobile",
  "kind": "section",
  "label": "已配对设备",
  "tip": "撤销后该手机立即无法访问（下次刷新即要求重新配对）。设备令牌 30 天后自动过期。"
 },
 {
  "tab": "mobile",
  "kind": "row",
  "label": "全部撤销",
  "section": "已配对设备",
  "hint": "手机丢失或不确定是否可信时用；撤销后所有手机都要重新配对"
 },
 {
  "tab": "about",
  "kind": "section",
  "label": "运行环境"
 },
 {
  "tab": "about",
  "kind": "row",
  "label": "Electron",
  "section": "运行环境"
 },
 {
  "tab": "about",
  "kind": "row",
  "label": "Chrome",
  "section": "运行环境"
 },
 {
  "tab": "about",
  "kind": "row",
  "label": "Node.js",
  "section": "运行环境"
 },
 {
  "tab": "about",
  "kind": "row",
  "label": "系统",
  "section": "运行环境"
 },
 {
  "tab": "about",
  "kind": "section",
  "label": "更新"
 },
 {
  "tab": "about",
  "kind": "row",
  "label": "软件更新",
  "section": "更新"
 }
]
