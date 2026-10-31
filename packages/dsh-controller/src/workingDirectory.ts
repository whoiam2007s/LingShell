// dsh 0.2.1 起 dsh-tool-skill 注入 ctx.workingDirectory（查技能时要会话的当前目录）。
// 官方实现 dsh-working-directory 依赖 dsh-fs，且每次组装提示词都会校验目录、往上下文里写
// 「Current working directory: …」，原目录和当前目录都不存在时还会拒绝整轮请求。
// 我们的会话工作目录只给本地终端用（见 DshController.setWorkDir），dsh 的 fs/shell 工具也没挂，
// 所以只提供一个只读的最小服务：目录 = 会话头里建会话时的 cwd，不校验、不写事件、不进提示词——与 0.2.0 行为一致。
import { homedir } from 'node:os'
import { Service, type Context } from '@deepseek-ai/cordis'

interface SessionLike { header?: { cwd?: string } }

export class StaticWorkingDirectory extends Service {
  readonly defaultDirectory = homedir()
  constructor(ctx: Context) {
    super(ctx, 'workingDirectory')
  }
  get(session: SessionLike): string { return session?.header?.cwd ?? this.defaultDirectory }
  async ensure(agent: { session: SessionLike }): Promise<string> { return this.get(agent.session) }
  async set(): Promise<string> { throw new Error('working-directory: not supported') }
}
