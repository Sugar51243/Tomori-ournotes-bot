import express from 'express';
import { middleware } from '../middleware';
import { getMusicData, OVERHEAD_MS } from '../../upstream/musicData/client';
import { RANK_NUMBERS } from '../../features/event/eventRecommend';

/**
 * 谱面效率表（给网页端组卡器用，不是给聊天机器人用的）。
 *
 * 把 music-data.json 里组卡器真正需要的部分裁成一个紧凑 JSON：
 * 时长、物量、评级门槛、以及两个场景下的得分模型系数。
 *
 * 为什么不把 13MB 的原始文件丢给浏览器：网页只算「给定综合力与技能，这首能打多少分、
 * 每小时几局」，用不到种子级的明细；裁完只剩几十 KB。
 *
 * 与服务器**无关** —— 同一份谱面模拟数据四个服共用（服务器的选择只影响曲名与封面），
 * 所以这个端点不吃 server 参数，网页端也可以长期缓存。
 */
const router = express.Router();

router.post('/', middleware, async (_req: express.Request, res: express.Response) => {
    try {
        const data = await getMusicData();
        if (!data) {
            res.send({ status: 'failed', data: '曲效率数据暂不可用' });
            return;
        }
        // 组卡器按 base+权重 在浏览器端算出分, 没有技能权重的降级数据(备用源的替代模型)不能供它使用
        if (data.degraded) {
            res.send({ status: 'failed', data: '曲效率数据暂不可用（当前为备用源的降级数据，缺少技能权重）' });
            return;
        }

        // 紧凑行：[musicId, 难度 0..3, BGM时长, 物量, 显示等级, 击奏无效, 自由base, 自由weights, 击奏base, 击奏weights, [[评级, 分数线]…]]
        const charts = data.charts.map(c => {
            const free = c.free;
            const battle = c.battle;
            const ranks = c.scoreRanks
                .map(r => [RANK_NUMBERS[r.rank] ?? 0, r.requiredScore ?? 0] as [number, number])
                .filter(([n]) => n > 0)
                .sort((a, b) => a[0] - b[0]);
            return [
                c.musicId,
                DIFFICULTY_INDEX[c.difficulty] ?? 3,
                c.bgmMs,
                c.notes,
                c.displayLevel,
                c.unplayable ? 1 : 0,
                free?.base ?? 0,
                free?.weights ?? [],
                battle?.base ?? 0,
                battle?.weights ?? [],
                ranks,
            ];
        });

        res.send({
            status: 'success',
            data: {
                power: data.power,
                overheadMs: OVERHEAD_MS,
                // 实际供数的数据源(网页端「数据来源」标注用)
                source: data.origin,
                // 四难度在数组里的下标固定为 easy/normal/hard/expert
                difficulties: ['easy', 'normal', 'hard', 'expert'],
                charts,
            },
        });
    } catch (e) {
        console.log(e);
        res.status(500).send({ status: 'failed', data: '内部错误' });
    }
});

const DIFFICULTY_INDEX: Record<string, number> = { easy: 0, normal: 1, hard: 2, expert: 3 };

export { router as chartEfficiencyRouter };
