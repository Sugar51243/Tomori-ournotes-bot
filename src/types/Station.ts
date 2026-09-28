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
    /** 消息时间(ms, 客户端上报; 仅用于展示"x 秒前") */
    time: number;
    /** 上传者头像网址(可选) */
    avatarUrl?: string;
    createdAt: Date;
    /** 过期时间(TTL 索引字段; = 服务端接收时间 + STATION_TTL_S) */
    expireAt: Date;
}

/** 对外返回的房间结构(与 tsugu 一致, 不含内部字段) */
export interface RoomView {
    number: number;
    rawMessage: string;
    source: string;
    userId: string;
    userName: string;
    time: number;
    avatarUrl?: string;
}
