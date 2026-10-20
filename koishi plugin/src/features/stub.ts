/**
 * 占位桩指令。
 *
 * 这些指令在参考项目（tsugu 系）里存在，但 Tomori 后端没有对应端点 ——
 * 只剩 tsugu 的 `/user`（账号绑定 API，本服务不实现）与试炼/自制谱这类没做的东西。
 *
 * 之所以还是注册它们（而不是干脆不注册）：从旧 tsugu 配置迁过来的用户
 * 敲这些指令时，得到的是「暂不支持」而不是「未知指令」，更容易理解发生了什么。
 * 不想要的话，把配置里的 stubCommands 关掉即可。
 *
 * 注意「查玩家」**不在**这里 —— 后端的 `/searchPlayer` 已经实现，它是真指令；
 * 绑定管理（绑定玩家 / 玩家绑定 / 默认玩家 / 解除绑定）后来也有了 `/playerBind/*`，
 * 现在是真指令（见 index.ts）。
 */
import { h } from 'koishi'
import type { Context } from 'koishi'
import { MESSAGES } from '../config'
import type { Config } from '../index'

export function stubReply(command: string): h[] {
  return [h.text(`${MESSAGES.stubPrefix}（${command}）。${MESSAGES.stubHint}`)]
}

/**
 * 要注册为桩的指令名。
 *
 * 注意 `ycx` / `ycxall` **不在**这里 —— 后端的 `/cutoffAll` 已经是真正的榜线端点
 * （各档分数线随时间的折线图），它们是真指令了。
 * `lsycx` 仍然挡着：它对应 `/cutoffListOfRecentEvent`，那个还是 404 占位。
 */
export const STUB_COMMANDS = [
  '逮捕',
  'lsycx',
  '查试炼',
  '查自制谱',
] as const

/** 一次性把全部桩指令挂到 ctx 上 */
export function registerStubCommands(ctx: Context, _config: Config): void {
  for (const name of STUB_COMMANDS) {
    ctx.command(name, '（Tomori 后端暂不支持）')
      .action(() => stubReply(name))
  }
}
