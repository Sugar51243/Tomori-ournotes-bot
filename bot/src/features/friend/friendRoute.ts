import { listFriendDocs } from '../../db/adapter';
import { drawFriendList } from '../../render/view/station/friendList';

/**
 * 交友区(tsugu 无此功能, 自定义端点)的功能实现:
 * - /friend/upload  按 QQ 号新增或更新(upsert, 一人一条)
 * - /friend/delete  按 QQ 号删除(自报 QQ 号, 弱鉴权)
 * - /friend/list    交友列表图
 * 数据库未配置/连不上时统一返回域内错误, 不 500。
 */
export const DB_DISABLED = '错误: 服务器未启用数据库';

export interface FriendListQuery {
    compress?: boolean;
}

/** 交友列表入口: 查 Mongo 按更新时间倒序出图; 库不可用/为空返回提示字符串 */
export async function commandFriendList(query: FriendListQuery = {}): Promise<Array<Buffer | string>> {
    const friends = await listFriendDocs();
    if (!friends) {
        return [DB_DISABLED];
    }
    if (friends.length === 0) {
        return ['交友列表为空'];
    }
    return drawFriendList(friends, !!query.compress);
}
