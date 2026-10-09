/**
 * QQ ↔ 游戏账号 的绑定（**一个 QQ 可绑多个账号**，见 src/db/mongo.ts 的 bindings 集合）。
 *
 * 绑定码在**网页**上按账号包生成（一次性、15 分钟），在 QQ 里发给 bot 兑换 ——
 * 兑换走网页的 `/api/bot/bind`（两个项目以 HTTP API 交接）。
 *
 * 绑定只做两件事: 免输玩家 ID（默认账号）+ 用绑定码证明账号归属（防冒绑）。
 * **不放行任何隐藏数据** —— 查玩家/b25/组卡/查名片在群里一律按网页的公开开关展示，
 * 绑定本人也不例外。
 */
export interface BindingDoc {
    /** QQ 号（社区功能同一套弱鉴权身份；bot 侧不会出现 `web:` 前缀的身份） */
    userId: string;
    /** 网页账号包 id（与网页 web_game_accounts.id 对应） */
    accountId: number;
    /** 玩家公开 ID（游戏里查档用的那个，与账号包上的 player_id 一致） */
    playerId: string;
    server: string;
    /** 网页上给这条账号包的备注名（绑定列表展示用） */
    label?: string;
    /** 默认账号: 不带 ID 的查玩家/b25/组卡/查名片 用它; 同一用户至多一条为 true */
    isDefault: boolean;
    createdAt: Date;
    updatedAt: Date;
}
