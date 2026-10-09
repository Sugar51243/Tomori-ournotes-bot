import express from 'express';
import { body } from 'express-validator';
import { isServerInput, pickServers, withServer } from '../../features/types/Server';
import { middleware } from '../middleware';
import { Event } from '../../features/types/Event';
import { resolveCurrentEvent } from '../../upstream/adapter';

/**
 * 组卡器的「活动模式」上下文（给网页端，不是给聊天机器人用的）。
 *
 * 给的是当前进行中的活动 + 该活动的演出报酬表：**各得分评级能拿多少活动点数、
 * 掉哪些交换所道具**。网页端拿它乘以每小时局数，就得到「收益/小时」。
 *
 * 点数与掉落都来自主数据（MasterLiveEventPoint / MasterLiveEventReward），
 * 所以是真实数值，不是估算。活动结束后上游仍会挂着旧活动，这里按「只取进行中」处理。
 */
const router = express.Router();

router.post(
    '/',
    [body('displayedServerList').optional().custom(isServerInput)],
    middleware,
    async (req: express.Request, res: express.Response) => {
        const servers = pickServers(req.body);
        try {
            for (const server of servers) {
                const current = await resolveCurrentEvent(server);
                if (current.eventId === undefined || current.finished) continue;

                const event = withServer(new Event(current.eventId), server);
                await event.init();
                if (!event.isExist) continue;

                const toRows = (rows: typeof event.liveRewards) =>
                    rows.map(r => ({
                        scoreRank: r.scoreRank,
                        points: r.points,
                        requiredScore: r.requiredScore,
                        items: r.items.map(i => ({ kind: i.kind, name: i.name, imagePath: i.imagePath, count: i.count })),
                    }));

                res.send({
                    status: 'success',
                    data: {
                        server,
                        eventId: event.eventId,
                        eventName: event.eventName,
                        // 演出报酬：评级 → 点数 + 道具
                        liveRewards: toRows(event.liveRewards),
                        // 挑战演出报酬单列（挑战曲的收益与普通演出不是同一套表）
                        challengeRewards: toRows(event.challengeRewards),
                    },
                });
                return;
            }
            // 没有进行中的活动不是错误 —— 网页端据此把活动模式置灰
            res.send({ status: 'success', data: { event: null } });
        } catch (e) {
            console.log(e);
            res.status(500).send({ status: 'failed', data: '内部错误' });
        }
    }
);

export { router as eventDeckContextRouter };
