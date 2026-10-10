/**
 * 交友区(自定义功能, tsugu 无对应实现): 一条记录 = 一个 QQ 号的交友名片。
 * 字段名沿用 tsugu 词汇(userId/userName/avatarUrl/playerId/server)便于理解.
 */
import { FriendServer } from './Server';

export interface FriendDoc {
    /** QQ 号(唯一键) */
    userId: string;
    /** QQ 名字 */
    userName: string;
    /** 头像地址: QQ 头像(qlogo.cn) 或网页账号头像(/api/avatars/<内容哈希>, 相对网页平台拼绝对); 出图时校验 */
    avatarUrl?: string;
    /** 游戏 ID */
    playerId: string;
    /** 服务器(hk-tw-mo/jp/en/kr, 仅交友区接受 jp/en/kr) */
    server: FriendServer;
    createdAt: Date;
    updatedAt: Date;
}
