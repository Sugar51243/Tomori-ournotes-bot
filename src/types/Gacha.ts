import { GachaRow } from './MasterData';
import { store, t } from '../data/masterdata';
import { gachaBannerUrl } from '../data/assets';
import { Card } from './Card';
import { SupportCard } from './SupportCard';
import { AnyCard, isMemberCard } from '../search';

/** 解析 "2026/10/8 23:59:59" 这类不补零的日期(按 UTC+8 处理) */
export function parseGameDate(s: string): Date | undefined {
    const m = s.trim().match(/^(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?$/);
    if (!m) return undefined;
    const [, year, month, day, hour, minute, second] = m;
    return new Date(Date.UTC(
        parseInt(year, 10), parseInt(month, 10) - 1, parseInt(day, 10),
        parseInt(hour, 10), parseInt(minute, 10), parseInt(second ?? '0', 10)
    ) - 8 * 3600 * 1000);
}

export function formatGameDate(d: Date): string {
    const p = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 服务器时间字符串(不补零, 如 "2026/1/1 0:00:00") -> "YYYY/MM/DD HH:mm (UTC+8)" */
export function formatGameDateUTC8(s: string): string {
    const m = (s ?? '').trim().match(/^(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})[ T](\d{1,2}):(\d{2})/);
    if (!m) return s || '-';
    const p = (v: string) => v.padStart(2, '0');
    return `${m[1]}/${p(m[2])}/${p(m[3])} ${p(m[4])}:${m[5]} (UTC+8)`;
}

export class Gacha {
    gachaId: number;
    isExist = false;
    row?: GachaRow;
    gachaName = '';
    startAt?: Date;
    endAt?: Date;
    isLimited = false;
    isNewMember = false;
    bannerAssetName = '';
    /** 说明/宣传语 */
    description = '';
    /** 招募券名称 */
    ticketName = '';
    /** PICK UP 对象(成员卡与留影, 已解析为模型以便出图) */
    pickUpCards: AnyCard[] = [];

    constructor(gachaId: number) {
        this.gachaId = gachaId;
    }

    async init(): Promise<void> {
        this.row = await store.gachaById(this.gachaId);
        if (!this.row) return;
        this.isExist = true;
        this.gachaName = await t(this.row.nameTextId);
        this.startAt = parseGameDate(this.row.startAt);
        this.endAt = parseGameDate(this.row.endAt);
        this.isLimited = this.row.isLimited;
        this.isNewMember = this.row.isNewMember;
        this.bannerAssetName = this.row.bannerAssetName;
        this.description = this.row.descriptionTextId ? await t(this.row.descriptionTextId) : '';
        await this.loadPickUps();
    }

    /** 读取 PICK UP 对象: lotGroup -> 各奖品组 -> 标记为 UP(resourceType 2=成员卡 / 3=留影)的卡片 */
    private async loadPickUps(): Promise<void> {
        const lotGroupId = this.row?.lotGroupId;
        if (!lotGroupId) return;
        this.ticketName = await store.itemName(this.row?.gachaTicketItemId ?? 0);
        const lots = await store.gachaLotsByGroup(lotGroupId);
        const seen = new Set<string>();
        const cards: AnyCard[] = [];
        for (const lot of lots) {
            const prizes = await store.gachaPrizesByGroup(lot.prizeGroupId);
            for (const prize of prizes) {
                if (prize.pickUpType !== 2) continue;               // 仅 UP
                if (prize.resourceType === 2) {
                    const card = new Card(prize.resourceId);
                    await card.init();
                    if (!card.isExist || seen.has(`m${card.cardId}`)) continue;
                    seen.add(`m${card.cardId}`);
                    cards.push(card);
                } else if (prize.resourceType === 3) {
                    const support = new SupportCard(prize.resourceId);
                    await support.init();
                    if (!support.isExist || seen.has(`s${support.supportCardId}`)) continue;
                    seen.add(`s${support.supportCardId}`);
                    cards.push(support);
                }
            }
        }
        // 稀有度降序(同稀有度时成员卡在前)
        cards.sort((a, b) => b.rarity - a.rarity || (isMemberCard(a) === isMemberCard(b) ? 0 : isMemberCard(a) ? -1 : 1));
        this.pickUpCards = cards;
    }

    bannerUrl(): string {
        return gachaBannerUrl(this.bannerAssetName);
    }

    /** 当前是否开放 */
    isOpen(now = new Date()): boolean {
        if (!this.startAt || !this.endAt) return false;
        return now >= this.startAt && now <= this.endAt;
    }

    fuzzyTarget(): Record<string, unknown> {
        return { gachaId: this.gachaId, gachaName: this.gachaName };
    }
}
