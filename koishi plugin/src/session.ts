/**
 * 会话信息的最小抽象。
 *
 * 上传车牌 / 交友登记只需要「谁发的、叫什么、什么平台、头像是什么」这几项。
 * 抽成结构类型而不是直接依赖 Koishi 的 Session 类，是为了让这些功能
 * 在单测里能直接用普通对象驱动。
 */
import type { Session } from 'koishi'

export interface SessionInfo {
  userId?: string
  username?: string
  platform?: string
  avatar?: string
}

/** 从真实会话里取出发送者信息 */
export function fromSession(session: Session): SessionInfo {
  return {
    userId: session.userId,
    username: session.username,
    platform: session.platform,
    // 头像不在 Session 上，得从事件的 user 对象里拿
    avatar: session.event?.user?.avatar,
  }
}
