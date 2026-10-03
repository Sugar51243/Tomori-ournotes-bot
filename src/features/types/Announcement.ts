/**
 * 游戏公告(取自 rankd 公开接口 /api/v1/{server}/announcements)。
 * 上游所有字段都是字符串 —— 时间是 Unix 秒, id 也是字符串。
 */
export type AnnouncementCategory = 'MAINTENANCE' | 'BUG' | 'CAMPAIGN' | 'UPDATE' | 'GACHA' | 'EVENT' | 'OTHER';

export interface Announcement {
    id: string;
    category: string;
    title: string;
    /** Unix 秒(字符串) */
    startAt: string;
    endAt: string;
    /** 最后修订时间(Unix 秒), 也是上游 X-Revision 的值 */
    lastUpdatedAt: string;
    /** 横幅图; **JP 没有此字段**(只有 stylesheetId), 只能出纯文字卡片 */
    bannerUrl?: string;
    pickupBannerUrl?: string;
    /** 仅详情接口返回: 公告正文 HTML 全文 */
    body?: string;
}

/** 分类 -> 展示名与颜色 */
export const CATEGORY_META: Record<string, { label: string; color: string }> = {
    MAINTENANCE: { label: '维护', color: '#c8443c' },
    BUG: { label: '异常', color: '#d0407a' },
    CAMPAIGN: { label: '活动', color: '#e08a2c' },
    UPDATE: { label: '更新', color: '#3f9d7a' },
    GACHA: { label: '转蛋', color: '#8a5fd0' },
    EVENT: { label: '活动', color: '#3f6fd0' },
    OTHER: { label: '其他', color: '#6b7280' }
};

/** 公告分类元信息(展示名/主题色); 未知分类给默认样式 */
export function categoryMeta(category: string): { label: string; color: string } {
    return CATEGORY_META[category] ?? CATEGORY_META.OTHER;
}

/** Unix 秒字符串 -> "YYYY/MM/DD HH:mm"(按区域本地时间), 无效时返回原串 */
export function formatAnnouncementTime(seconds: string, utcOffsetMinutes: number): string {
    const n = parseInt(seconds, 10);
    if (!Number.isFinite(n) || n <= 0) return seconds || '-';
    const shifted = new Date(n * 1000 + utcOffsetMinutes * 60 * 1000);
    const p = (v: number) => String(v).padStart(2, '0');
    return `${shifted.getUTCFullYear()}/${p(shifted.getUTCMonth() + 1)}/${p(shifted.getUTCDate())} ${p(shifted.getUTCHours())}:${p(shifted.getUTCMinutes())}`;
}
