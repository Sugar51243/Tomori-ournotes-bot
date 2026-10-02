import express from 'express';
import { body } from 'express-validator';
import { isInteger, listToBase64, pickEntityInput, EntityInput } from '../utils';
import { fallbackChain, isServerInput, SERVER_LIST, Server, withServer } from '../../types/Server';
import { middleware } from '../middleware';
import { isFuzzySearchResult } from '../../fuzzySearch';
import { Event } from '../../types/Event';

import { eventServerRows, firstOwnServer } from '../../data/serverInfo';
import { drawEventRichDetail } from '../../view/event/eventRichDetail';
import { drawEventDetail } from '../../view/event/eventDetail';
import { drawEventList } from '../../view/event/eventList';
import { searchEvents, textToFuzzyResult } from '../../search';

/**
 * 查活动(单服回退)。
 *
 * 查询输入按统一规则解析(见 utils.pickEntityInput): `id` > `eventId` > `text` > `fuzzySearchResult`;
 * 传一个字段即可 —— 纯数字按活动 ID 直查, 其它文本走模糊搜索(支持「进行中」等状态词与日期串)。
 */
const router = express.Router();

router.post(
    '/',
    [
        body('displayedServerList').optional().custom(isServerInput),
        body('id').optional(),
        body('eventId').optional(),
        body('fuzzySearchResult').optional().custom(isFuzzySearchResult),
        body('text').optional().isString(),
        body('compress').optional().isBoolean(),
    ],
    middleware,
    async (req: express.Request, res: express.Response) => {
        const input = pickEntityInput(req.body, ['eventId']);
        if (input === undefined) {
            return res.status(422).json({ status: 'failed', data: '需要提供查询输入: id / eventId / text / fuzzySearchResult 之一' });
        }
        try {
            const result = await commandEvent(fallbackChain(req.body), { input, compress: req.body.compress });
            res.send(listToBase64(result));
        } catch (e) {
            console.log(e);
            res.status(500).send({ status: 'failed', data: '内部错误' });
        }
    }
);

export interface EventQuery {
    input: EntityInput;
    compress?: boolean;
}

/**
 * 活动查询(单服回退)。
 *
 * 服务器输入 `displayedServerList`(单个或列表, 可缺省)沿回退链依次查询:
 * 取第一个收录该活动的服出**丰富详情图**; 链上都没有时改用**多服组合表**
 * (未收录的服显示占位, 顺带看出哪个服有), 只有四个服都没有才当作活动 ID 不存在。
 */
export async function commandEvent(servers: Server[], query: EventQuery): Promise<Array<Buffer | string>> {
    const { input, compress = false } = query;
    if (typeof input === 'string' && isInteger(input)) {
        return drawEventForId(servers, parseInt(input, 10), compress);
    }

    if (typeof input !== 'string') {
        const bodyServer = servers[0];
        const hits = await searchEvents(bodyServer, input);
        if (hits.length === 0) return ['没有搜索到符合条件的活动'];
        return finishSearchDraw(bodyServer, hits, servers, compress);
    }

    // 文本: 沿回退链依次查各服的模糊索引, 取第一个有结果的服
    let hasKeyword = false;
    for (const server of servers) {
        const matches = await textToFuzzyResult(server, input);
        if (Object.keys(matches).length === 0) continue;
        hasKeyword = true;
        const hits = await searchEvents(server, matches);
        if (hits.length === 0) continue;
        return finishSearchDraw(server, hits, servers, compress);
    }
    return hasKeyword ? ['没有搜索到符合条件的活动'] : ['错误: 没有有效的关键词'];
}

/** 命中多个活动 -> 活动列表图; 唯一命中 -> 按回退链出该活动的图 */
async function finishSearchDraw(foundServer: Server, hits: Event[], servers: Server[], compress: boolean): Promise<Array<Buffer | string>> {
    if (hits.length > 1) {
        return drawEventList(foundServer, hits, compress);
    }
    return drawEventForId(servers, hits[0].eventId, compress);
}

/** 按活动 ID 出图: 回退链上首个收录的服出丰富详情, 否则多服组合表(恒列全部四服) */
async function drawEventForId(servers: Server[], eventId: number, compress: boolean): Promise<Array<Buffer | string>> {
    const rows = await eventServerRows(eventId, [...SERVER_LIST]);
    const owner = firstOwnServer(rows, servers);
    if (owner) {
        const event = withServer(new Event(eventId), owner);
        await event.init();
        return drawEventRichDetail(owner, event, compress);
    }
    return drawEventCombined(eventId, servers.length === 1 ? [...SERVER_LIST] : servers, compress);
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
