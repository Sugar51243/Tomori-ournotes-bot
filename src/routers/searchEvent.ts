import express from 'express';
import { body } from 'express-validator';
import { isInteger, listToBase64 } from './utils';
import { isServerList, pickServers, SERVER_LIST, Server, withServer } from '../types/Server';
import { middleware } from './middleware';
import { isFuzzySearchResult, FuzzySearchResult } from '../fuzzySearch';
import { Event } from '../types/Event';

import { eventServerRows } from '../data/serverInfo';
import { drawEventRichDetail } from '../view/eventRichDetail';
import { drawEventDetail } from '../view/eventDetail';
import { searchEvents, textToFuzzyResult } from '../search';

const router = express.Router();

router.post(
    '/',
    [
        body('displayedServerList').custom(isServerList),
        body('fuzzySearchResult').optional().custom(isFuzzySearchResult),
        body('text').optional().isString(),
        body('compress').optional().isBoolean(),
    ],
    middleware,
    async (req: express.Request, res: express.Response) => {
        const { text, fuzzySearchResult, compress } = req.body;

        if (text && fuzzySearchResult) {
            return res.status(422).json({ status: 'failed', data: 'text 与 fuzzySearchResult 不能同时存在' });
        }
        if (!text && !fuzzySearchResult) {
            return res.status(422).json({ status: 'failed', data: '不能同时不存在 text 与 fuzzySearchResult' });
        }

        try {
            const servers = pickServers(req.body);
            const result = await commandEvent(servers, text || fuzzySearchResult, compress);
            res.send(listToBase64(result));
        } catch (e) {
            console.log(e);
            res.status(500).send({ status: 'failed', data: '内部错误' });
        }
    }
);

/**
 * 活动的两种渲染, **按「该服自己有没有这个活动」判定, 不做任何服务器硬编码**:
 *
 * - 只请求了一个服, 且**该服自己有**该活动 -> 丰富详情图
 * - 其余情况(多服请求, 或请求的那个服自己没有) -> 多服组合表
 *
 * 「一个服没有」并不等于「活动不存在」: 上游的活动数据是各服独立上传的,
 * 某个服暂时没有时用**组合表 + 未收录占位**呈现 (顺带看出哪个服有),
 * 只有**四个服都没有**才当作活动 ID 不存在。
 */
export async function commandEvent(servers: Server[], input: string | FuzzySearchResult, compress: boolean): Promise<Array<Buffer | string>> {
    if (typeof input === 'string' && isInteger(input)) {
        const eventId = parseInt(input, 10);
        const single = servers.length === 1;
        const requested = await eventServerRows(eventId, servers);
        const owner = requested.find(r => r.hasOwn)?.server;
        if (single && owner) {
            const event = withServer(new Event(eventId), owner);
            await event.init();
            return drawEventRichDetail(owner, event, compress);
        }
        return drawEventCombined(eventId, single ? [...SERVER_LIST] : servers, compress);
    }

    // 模糊搜索: 先在请求的服上搜; 搜不到且只请求了一个服时, 放宽到全部服再试
    const bodyServer = servers[0];
    const matches = typeof input === 'string' ? textToFuzzyResult(bodyServer, input) : input;
    if (Object.keys(matches).length == 0) {
        return ['错误: 没有有效的关键词'];
    }
    const primary = await searchEvents(bodyServer, matches);
    if (primary.length === 0) {
        for (const fallback of servers.length === 1 ? SERVER_LIST.filter(s => s !== bodyServer) : []) {
            const hits = await searchEvents(fallback, matches).catch(() => []);
            if (hits.length) {
                return drawEventCombined(hits[0].eventId, [...SERVER_LIST], compress);
            }
        }
        return ['没有搜索到符合条件的活动'];
    }
    const event = primary[0];
    if (servers.length === 1) {
        return drawEventRichDetail(event.server, event, compress);
    }
    return drawEventCombined(event.eventId, servers, compress);
}

/** 多服组合表: 每个服一行, 没有该活动的服显示「未收录」占位 */
async function drawEventCombined(eventId: number, servers: Server[], compress: boolean): Promise<Array<Buffer | string>> {
    const rows = await eventServerRows(eventId, servers);
    // 四个服都没有 -> 这个 ID 确实不存在
    const owner = rows.find(r => r.hasOwn)?.server;
    if (!owner) return ['错误: 该活动不存在'];
    const event = withServer(new Event(eventId), owner);
    await event.init();
    return drawEventDetail(event, rows, compress);
}

export { router as searchEventRouter };
