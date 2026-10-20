/**
 * 车站(房间号共享): 字段与语义对齐 tsugu 的 Room(backend/src/types/Room.ts)。
 * 差别: tsugu 只存进程内存(重启即丢、上限 100 条), 本服务存 MongoDB, 用 TTL 索引自动清理。
 */
export interface StationDoc {
    /** 房间号(唯一键; 同号重复提交 = 刷新) */
    number: number;
    /** 原始消息文本(整条), 列表图直接展示 */
    rawMessage: string;
    /** 来源平台(已归一化: onebot/red/chronocat/llonebot/Napcat → qq) */
    source: string;
    /** 上传者 QQ 号 */
    userId: string;
    /** 上传者昵称 */
    userName: string;
    /**
     * 消息时间: **客户端上报的原值, 原样返回**(前端可能自己拿它算「多久前」,
     * 换算单位就等于改了接口契约 —— 所以这里不归一)。
     */
    time: number;
    /** 同一时间的**归一秒值**(ms), 只给本服务出图与排序用, 不进对外 JSON */
    timeMs: number;
    /** 上传者头像网址(可选) */
    avatarUrl?: string;
    createdAt: Date;
    /** 过期时间(TTL 索引字段; = 服务端接收时间 + STATION_TTL_S) */
    expireAt: Date;
}

/**
 * 客户端上报的「消息时间」统一归一到**毫秒**。
 *
 * OneBot v11 的 `message.time` / tsugu 生态给的是**秒**, 但也有客户端直接给毫秒;
 * 只按一种单位理解, 另一种就会画成「497000 小时前」这种离谱值(实测的车站时间错就是这个)。
 * 秒级时间戳远小于 1e11(约公元 5138 年), 所以按量级判断: 小于它当秒, 否则当毫秒。
 */
export function normalizeStationTime(t: unknown, fallback: number = Date.now()): number {
    const n = Number(t);
    if (!Number.isFinite(n) || n <= 0) return fallback;
    return n < 1e11 ? Math.round(n * 1000) : Math.round(n);
}

/** 对外返回的房间结构(与 tsugu 一致, 不含内部字段) */
export interface RoomView {
    number: number;
    rawMessage: string;
    source: string;
    userId: string;
    userName: string;
    /** 客户端上报的原值(服务端不换算单位, 保持接口契约) */
    time: number;
    avatarUrl?: string;
    /** 归一后的毫秒值: **仅内部/出图使用**, 不随 JSON 出门(见 toRoomView) */
    timeMs?: number;
}
