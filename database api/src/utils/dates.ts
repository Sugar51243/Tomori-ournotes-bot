/**
 * Date 的跨 HTTP 保真编码。
 *
 * MySQL 的 DATETIME(3) 与 Mongo 的 Date 原来由直连驱动返回 JS Date 对象;
 * 走 HTTP 后 JSON 里只剩字符串。这里把 Date 编码成 `{ "$date": "<ISO>" }`,
 * 消费方客户端(web/bot 的 apiClient)对称解码回 Date —— 保证
 * `row.created_at.toISOString()` 这类既有调用一字不改。
 *
 * 注意与"普通字符串"不会混淆: 只有恰好只含 $date 键的对象才会被解码。
 */
export const DATE_TAG = '$date';

export function encodeDates(value: unknown): unknown {
    if (value instanceof Date) return { [DATE_TAG]: value.toISOString() };
    if (Array.isArray(value)) return value.map(encodeDates);
    if (value !== null && typeof value === 'object') {
        const out: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = encodeDates(v);
        return out;
    }
    return value;
}
