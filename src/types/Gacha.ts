import { GachaRow } from './MasterData';
import { regionFor } from '../data/region';
import { gachaBannerUrl } from '../data/assets';
import { Card } from './Card';
import { SupportCard } from './SupportCard';
import { AnyCard, isMemberCard } from '../search';
import { config } from '../config';
import { Server, serverProfile, withServer, defaultServer } from './Server';

/**
 * 各区域的“游戏内本地时间”偏移不同(jp 为 UTC+9, 其余为 UTC+8),
 * 主数据里的日期字符串必须按所属区域解析, 否则日服时间会差一小时。
 */
function offsetMinutes(server: Server): number {
    return serverProfile(server).utcOffsetMinutes;
}

function offsetLabel(minutes: number): string {
    const sign = minutes < 0 ? '-' : '+';
    const abs = Math.abs(minutes);
    const hours = Math.floor(abs / 60);
    const mins = abs % 60;
    return `UTC${sign}${hours}${mins ? `:${String(mins).padStart(2, '0')}` : ''}`;
}

/** 解析 "2026/10/8 23:59:59" 这类不补零的日期(按所属区域的本地时间处理) */
export function parseGameDate(s: string, server: Server = defaultServer()): Date | undefined {
    const m = s.trim().match(/^(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?$/);
    if (!m) return undefined;
    const [, year, month, day, hour, minute, second] = m;
    return new Date(Date.UTC(
        parseInt(year, 10), parseInt(month, 10) - 1, parseInt(day, 10),
        parseInt(hour, 10), parseInt(minute, 10), parseInt(second ?? '0', 10)
    ) - offsetMinutes(server) * 60 * 1000);
}

/**
 * 把已解析的 Date 按所属区域的本地时间格式化。
 * 注意不能用 getHours() —— 那取的是**运行机器**的时区, 部署在 UTC 机器上会整体偏移。
 */
export function formatGameDate(d: Date, server: Server = defaultServer()): string {
    const shifted = new Date(d.getTime() + offsetMinutes(server) * 60 * 1000);
    const p = (n: number) => String(n).padStart(2, '0');
    return `${shifted.getUTCFullYear()}/${p(shifted.getUTCMonth() + 1)}/${p(shifted.getUTCDate())} ${p(shifted.getUTCHours())}:${p(shifted.getUTCMinutes())}`;
}

/** 该区域的时区标签(如 "UTC+8" / "UTC+9") */
export function zoneLabel(server: Server = defaultServer()): string {
    return offsetLabel(offsetMinutes(server));
}

/** 服务器时间字符串(不补零, 如 "2026/1/1 0:00:00") -> "YYYY/MM/DD HH:mm (UTC+8/UTC+9)" */
export function formatGameDateUTC8(s: string, server: Server = defaultServer()): string {
    const m = (s ?? '').trim().match(/^(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})[ T](\d{1,2}):(\d{2})/);
    if (!m) return s || '-';
    const p = (v: string) => v.padStart(2, '0');
    return `${m[1]}/${p(m[2])}/${p(m[3])} ${p(m[4])}:${m[5]} (${offsetLabel(offsetMinutes(server))})`;
}

export class Gacha {
    gachaId: number;
    /** 该实体由哪个区域渲染(文本/素材来源); 默认主服, 由调用方在 init() 前指定 */
    server: Server = defaultServer();
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
        const { store, t } = regionFor(this.server);
        this.row = await store.gachaById(this.gachaId);
        if (!this.row) return;
        this.isExist = true;
        this.gachaName = await t(this.row.nameTextId);
        this.startAt = parseGameDate(this.row.startAt, this.server);
        this.endAt = parseGameDate(this.row.endAt, this.server);
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
        const { store } = regionFor(this.server);
        this.ticketName = await store.itemName(this.row?.gachaTicketItemId ?? 0);
        const lots = await store.gachaLotsByGroup(lotGroupId);
        const seen = new Set<string>();
        const cards: AnyCard[] = [];
        for (const lot of lots) {
            const prizes = await store.gachaPrizesByGroup(lot.prizeGroupId);
            for (const prize of prizes) {
                if (prize.pickUpType !== 2) continue;               // 仅 UP
                if (prize.resourceType === 2) {
                    const card = withServer(new Card(prize.resourceId), this.server);
                    await card.init();
                    if (!card.isExist || seen.has(`m${card.cardId}`)) continue;
                    seen.add(`m${card.cardId}`);
                    cards.push(card);
                } else if (prize.resourceType === 3) {
                    const support = withServer(new SupportCard(prize.resourceId), this.server);
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
        return gachaBannerUrl(this.server, this.bannerAssetName);
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
