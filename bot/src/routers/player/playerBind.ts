import express from 'express';
import { body } from 'express-validator';
import { listToBase64 } from '../utils';
import { middleware } from '../middleware';
import { commandBind, commandBindList, commandUnbind, commandUse } from '../../features/player/playerBind';

/**
 * 玩家绑定管理(一个 QQ 可绑多个游戏账号)。
 *
 * 绑定码由网页「我的账号」按账号包生成(一次性、15 分钟), 在这里兑换:
 * - /playerBind/bind    兑换绑定码(新增/更新一条绑定; 首个自动设为默认)
 * - /playerBind/list    列出全部绑定(标出默认)
 * - /playerBind/unbind  解绑(playerId 或列表序号)
 * - /playerBind/use     切换默认账号(不传 ID 的查玩家/b25/组卡/查名片用它)
 *
 * userId 与社区功能同一套弱鉴权(自报 QQ 号); 未启用数据库时由 app.ts 换成 404 占位。
 */
const router = express.Router();

const userIdRule = body('userId').isString().isLength({ min: 1, max: 32 });
const selectorRules = [
    body('playerId').optional().isString(),
    body('index').optional(),
];

router.post('/bind', [userIdRule, body('code').isString()], middleware, async (req: express.Request, res: express.Response) => {
    try {
        res.send(listToBase64(await commandBind(req.body)));
    } catch (e) {
        console.log(e);
        res.status(500).send({ status: 'failed', data: '内部错误' });
    }
});

router.post('/list', [userIdRule], middleware, async (req: express.Request, res: express.Response) => {
    try {
        res.send(listToBase64(await commandBindList(req.body)));
    } catch (e) {
        console.log(e);
        res.status(500).send({ status: 'failed', data: '内部错误' });
    }
});

router.post('/unbind', [userIdRule, ...selectorRules], middleware, async (req: express.Request, res: express.Response) => {
    try {
        res.send(listToBase64(await commandUnbind(req.body)));
    } catch (e) {
        console.log(e);
        res.status(500).send({ status: 'failed', data: '内部错误' });
    }
});

router.post('/use', [userIdRule, ...selectorRules], middleware, async (req: express.Request, res: express.Response) => {
    try {
        res.send(listToBase64(await commandUse(req.body)));
    } catch (e) {
        console.log(e);
        res.status(500).send({ status: 'failed', data: '内部错误' });
    }
});

export { router as playerBindRouter };
