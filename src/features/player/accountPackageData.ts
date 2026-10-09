import { Server } from '../types/Server';
import { logger } from '../../logger';
import { getAccountData, lookupAccount, WebPlatformError, webPlatformConfigured } from '../../webPlatform/client';
import type { SongStatusSummary, WebAccountSummary } from '../../webPlatform/client';
import { getMasterBundle } from '../../deck/bundle';
import { bestDecksPerBand } from '../../deck/bandDecks';
import type { BandDeck } from '../../deck/bandDecks';
import type { GameAccountCardsData, GameAccountItemsData, MasterBundle } from '../../deck/types';

/**
 * 「查玩家」用的账号包数据组装（网页平台 → 渲染层要的形状）。
 *
 * 全部遵循网页的**公开开关**：隐藏的类别不取、不算、不显示（绑定本人也一样）。
 * 任何失败（未对接 / 网页不可达 / 没有账号包）都返回 undefined —— 查玩家静默降级成
 * 只出上游档案，不打扰用户。
 */

export interface AccountPackageData {
    account: WebAccountSummary;
    songStatus?: SongStatusSummary;
    bandItems: Array<[number, number]>;
    /** 需要卡片与道具**都公开**才算得出来；否则为空数组（图上会注明） */
    bandDecks: BandDeck[];
    bundle?: MasterBundle;
}

export async function loadAccountPackage(playerId: string, server: Server): Promise<AccountPackageData | undefined> {
    if (!webPlatformConfigured()) return undefined;

    let account: WebAccountSummary;
    let songStatus: SongStatusSummary | undefined;
    try {
        const lookup = await lookupAccount(playerId, server);
        account = lookup.account;
        songStatus = lookup.songStatus;
    } catch (e) {
        if (e instanceof WebPlatformError && e.kind !== 'not_found') {
            logger('player', `网页账号包查询失败(${server}/${playerId}): ${e.message}`);
        }
        return undefined;
    }

    const data: AccountPackageData = { account, songStatus, bandItems: [], bandDecks: [] };
    if (account.visible.items) {
        try {
            const items = ((await getAccountData(account.id, 'items')).data ?? {}) as unknown as GameAccountItemsData;
            if (Array.isArray(items.bandItems)) data.bandItems = items.bandItems;
        } catch { /* 明细取不到就少一段, 不失败 */ }
    }

    // 理论队伍要卡片 + 道具 + 查表数据（bundle）三样齐全
    if (account.visible.cards && account.visible.items && data.bandItems.length) {
        const bundle = await getMasterBundle(server) as MasterBundle | undefined;
        if (bundle) {
            data.bundle = bundle;
            try {
                const cards = ((await getAccountData(account.id, 'cards')).data ?? {}) as unknown as GameAccountCardsData;
                if (Array.isArray(cards.members)) {
                    data.bandDecks = bestDecksPerBand(bundle, cards, { items: [], bandItems: data.bandItems }, account.tgwCardRank);
                }
            } catch { /* 同上 */ }
        } else {
            // 没有查表数据时, 乐队道具的名字也拿不到 —— 保留原始 [id, level] 让渲染层给出提示
            data.bundle = undefined;
        }
    }

    return data;
}
