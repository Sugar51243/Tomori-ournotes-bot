import { addBinding, getDefaultBinding, listBindings, removeBinding, setDefaultBinding } from '../../db/adapter';
import type { BindingLookup } from '../../db/adapter';
import type { BindingDoc } from '../types/Binding';
import { redeemBindCode, WebPlatformError, webPlatformConfigured } from '../../webPlatform/client';
import { Server, pickServer, serverProfile } from '../types/Server';

/**
 * 玩家绑定管理（**一个 QQ 可绑多个游戏账号**）。
 *
 * 绑定码在网页「我的账号」里按账号包生成（一次性、15 分钟有效），在 QQ 里用
 * `/playerBind/bind` 兑换 —— 兑换走网页的 `/api/bot/bind`。绑定只做两件事:
 * 免输玩家 ID（默认账号）+ 证明账号归属（防冒绑）；**不放行任何隐藏数据**
 *（查玩家/b25/组卡/查名片一律按网页的公开开关展示, 见 src/features/player/playerRoute.ts）。
 *
 * 动作: bind / list / unbind / use（切换默认）。unbind/use 用 playerId 或列表序号指定。
 */

export interface BindQuery {
    userId?: unknown;
    code?: unknown;
    playerId?: unknown;
    /** 绑定列表里的序号（1 起） */
    index?: unknown;
    /** 查玩家/b25/组卡/查名片 会带服务器; 绑定动作不用 */
    displayedServerList?: unknown;
}

const DB_DISABLED_TEXT = '错误: 服务器未启用数据库（绑定功能需要 ENABLE_DB 与可用的 MongoDB）';

function userIdOf(query: BindQuery): string {
    return String(query.userId ?? '').trim().slice(0, 32);
}

function displayServer(server: string): string {
    return (['tw', 'jp', 'kr', 'en'] as const).includes(server as Server)
        ? serverProfile(server as Server).displayName
        : server;
}

/** 兑换绑定码并落一条绑定 */
export async function commandBind(query: BindQuery): Promise<Array<Buffer | string>> {
    const userId = userIdOf(query);
    if (!userId) return ['错误: 缺少 userId'];
    if (!webPlatformConfigured()) return ['错误: 未对接网页平台（在 bot 配置 WEB_PLATFORM_TOKEN，并与网页的 WEB_BOT_TOKEN 一致）'];

    const code = String(query.code ?? '').trim().toUpperCase();
    if (!/^[A-Z0-9]{8}$/.test(code)) {
        return ['错误: 绑定码格式不对（8 位字母数字）。到网页「我的账号」里给账号包生成绑定码后发过来'];
    }

    let identity;
    try {
        identity = await redeemBindCode(code);
    } catch (e) {
        if (e instanceof WebPlatformError) {
            const hint = e.kind === 'unavailable' ? '（稍后重试；也可能是网页平台没在运行）' : '';
            return [`错误: ${e.message}${hint}`];
        }
        throw e;
    }

    const res = await addBinding({
        userId,
        accountId: identity.accountId,
        playerId: identity.playerId,
        server: identity.server,
        label: identity.label || identity.playerName || undefined
    });
    if (res === 'db_disabled') return [DB_DISABLED_TEXT];

    const name = identity.label || identity.playerName || '未命名';
    return [
        `绑定成功: ${name}（${displayServer(identity.server)} · ID ${identity.playerId}）\n` +
        `查玩家 / b25 / 组卡 / 查名片 不传 ID 时默认用它；多个账号用 /playerBind/list 查看、/playerBind/use 切换默认。\n` +
        `注意: 群里的展示按你在网页上的公开开关来（隐藏的类别不显示，绑定本人也一样）。`
    ];
}

/** 列出全部绑定 */
export async function commandBindList(query: BindQuery): Promise<Array<Buffer | string>> {
    const userId = userIdOf(query);
    if (!userId) return ['错误: 缺少 userId'];
    const docs = await listBindings(userId);
    if (docs === undefined) return [DB_DISABLED_TEXT];
    if (!docs.length) {
        return ['还没有绑定任何游戏账号。到网页「我的账号」给账号包填好玩家 ID、生成绑定码，然后发「/playerBind/bind 绑定码」'];
    }
    const lines = docs.map((d, i) =>
        `${i + 1}. ${d.isDefault ? '★ ' : ''}${d.label || d.playerId} · ${displayServer(d.server)} · ID ${d.playerId}`);
    return [
        `已绑定的游戏账号（★ = 默认，共 ${docs.length} 个）:\n${lines.join('\n')}\n\n` +
        `解绑: /playerBind/unbind 传 playerId 或序号; 切换默认: /playerBind/use`
    ];
}

/** 按 playerId 或序号找到一条绑定 */
async function resolveTarget(userId: string, query: BindQuery): Promise<{ doc: BindingDoc } | { error: string; docs?: BindingDoc[] }> {
    const docs = await listBindings(userId);
    if (docs === undefined) return { error: DB_DISABLED_TEXT };
    if (!docs.length) return { error: '错误: 还没有绑定任何账号（先用 /playerBind/bind 兑换绑定码）' };

    const playerId = String(query.playerId ?? '').trim();
    if (/^\d{1,15}$/.test(playerId)) {
        const hit = docs.find(d => d.playerId === playerId);
        return hit ? { doc: hit } : { error: `错误: 没有绑定过 ID ${playerId} 的账号（/playerBind/list 看全部）`, docs };
    }
    const index = Number(query.index);
    if (Number.isInteger(index) && index >= 1 && index <= docs.length) return { doc: docs[index - 1] };
    return { error: `错误: 请用 playerId 或序号指定要操作的账号（1~${docs.length}）`, docs };
}

/** 解绑指定账号（默认账号被解绑时, 最早的一条自动升为默认） */
export async function commandUnbind(query: BindQuery): Promise<Array<Buffer | string>> {
    const userId = userIdOf(query);
    if (!userId) return ['错误: 缺少 userId'];
    const target = await resolveTarget(userId, query);
    if ('error' in target) return [target.error];
    const res = await removeBinding(userId, target.doc.accountId);
    if (res === 'db_disabled') return [DB_DISABLED_TEXT];
    if (res === 'not_found') return ['错误: 这条绑定已经不存在了'];
    return [`已解绑: ${target.doc.label || target.doc.playerId}（${displayServer(target.doc.server)}）`];
}

/** 切换默认账号（不传 ID 的查玩家/b25/组卡/查名片 用它） */
export async function commandUse(query: BindQuery): Promise<Array<Buffer | string>> {
    const userId = userIdOf(query);
    if (!userId) return ['错误: 缺少 userId'];
    const target = await resolveTarget(userId, query);
    if ('error' in target) return [target.error];
    const res = await setDefaultBinding(userId, target.doc.accountId);
    if (res === 'db_disabled') return [DB_DISABLED_TEXT];
    if (res === 'not_found') return ['错误: 这条绑定已经不存在了'];
    return [`默认账号已切换为: ${target.doc.label || target.doc.playerId}（${displayServer(target.doc.server)} · ID ${target.doc.playerId}）`];
}

/**
 * 命令入口（查玩家/b25/组卡/查名片）共用的「解析玩家」:
 * - 显式给 playerId: 直接用（服务器按输入/默认服）;
 * - 不给: 取默认绑定（服务器优先用绑定里记的）; 没有绑定则报错文案（引导去绑定）。
 */
export async function resolvePlayerTarget(
    query: BindQuery
): Promise<{ status: 'ok'; playerId: string; server: Server; fromBinding: boolean } | { status: 'error'; message: string }> {
    const explicit = String(query.playerId ?? '').trim();
    if (explicit) {
        if (!/^\d{1,15}$/.test(explicit)) return { status: 'error', message: '错误: 玩家 ID 只能是 1~15 位数字' };
        return { status: 'ok', playerId: explicit, server: pickServer(query), fromBinding: false };
    }

    const userId = userIdOf(query);
    if (!userId) return { status: 'error', message: '错误: 缺少 playerId（或 userId + 先绑定账号）' };
    const lookup: BindingLookup = await getDefaultBinding(userId);
    if (lookup.status === 'db_disabled') return { status: 'error', message: DB_DISABLED_TEXT };
    if (!lookup.doc) {
        return { status: 'error', message: '错误: 还没绑定账号。到网页「我的账号」生成绑定码后发「/playerBind/bind 绑定码」，或直接带上 playerId 查询' };
    }
    const server = (['tw', 'jp', 'kr', 'en'] as const).includes(lookup.doc.server as Server)
        ? lookup.doc.server as Server
        : pickServer(query);
    return { status: 'ok', playerId: lookup.doc.playerId, server, fromBinding: true };
}
