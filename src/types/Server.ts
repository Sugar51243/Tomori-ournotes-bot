// Our Notes 为单区域(hk-tw-mo)。为兼容 tsugu 客户端请求体, 保留 displayedServerList/mainServer 字段但只接受该区域值。
export type Server = 'hk-tw-mo';

export const serverList: Server[] = ['hk-tw-mo'];

export const globalDefaultServer: Server[] = ['hk-tw-mo'];

export function isServer(value: unknown): value is Server {
    return value === 'hk-tw-mo';
}

export function isServerList(value: unknown): value is Server[] {
    return Array.isArray(value) && value.every(isServer);
}

/**
 * 交友区专用服务器: 交友名片允许登记 jp/en/kr(日服/国际服/韩服)的玩家 ID,
 * 仅用于 /friend/* 的 server 字段; 游戏内容接口仍只接受 hk-tw-mo。
 */
export type FriendServer = Server | 'jp' | 'en' | 'kr';

export const friendServerList: FriendServer[] = ['hk-tw-mo', 'jp', 'en', 'kr'];

export function isFriendServer(value: unknown): value is FriendServer {
    return typeof value === 'string' && friendServerList.includes(value as FriendServer);
}

export function getServerByServerId(serverId: unknown): Server {
    if (isServer(serverId)) return serverId;
    return 'hk-tw-mo';
}

export function getServerByPriority(_content: Array<unknown>, displayedServerList: Server[] = globalDefaultServer): Server {
    return displayedServerList[0] ?? 'hk-tw-mo';
}
