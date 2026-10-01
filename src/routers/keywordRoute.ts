import express from 'express';
import { body } from 'express-validator';
import { middleware } from './middleware';
import { addKeyword, removeKeyword } from '../data/keywords';
import { KEYWORD_ENTITY_TYPES, MAX_KEYWORD_LENGTH, KeywordEntityType } from '../types/Keyword';

/**
 * 用户关键词(tsugu 无此功能, 自定义端点):
 * - /keyword/upload  为角色/角色卡/支援卡/歌曲挂一个检索用别名
 * - /keyword/delete  删除自己上传的关键词
 *
 * 与 /friend/* 同一套弱鉴权: `userId`(QQ 号)只用于留痕与「只能删自己的」,
 * **不是访问鉴权**。数据库未启用/连不上时统一返回域内错误, 不 500。
 */
export const keywordUploadRouter = express.Router();
keywordUploadRouter.post(
    '/',
    [
        body('userId').isString().isLength({ min: 1, max: 32 }),
        body('entityType').isIn(KEYWORD_ENTITY_TYPES as unknown as string[]),
        body('entityId').isInt({ min: 1 }),
        body('keyword').isString().isLength({ min: 1, max: MAX_KEYWORD_LENGTH }),
    ],
    middleware,
    async (req: express.Request, res: express.Response) => {
        const { entityType, entityId, keyword, userId } = req.body;
        try {
            const result = await addKeyword({
                entityType: entityType as KeywordEntityType,
                entityId: Number(entityId),
                keyword,
                userId
            });
            if (!result.ok) {
                return res.status(200).send({ status: 'failed', data: `错误: ${result.reason}` });
            }
            res.status(200).send({ status: 'success', data: `已添加关键词：${result.keyword}` });
        } catch (e) {
            console.log(e);
            res.status(500).send({ status: 'failed', data: '内部错误' });
        }
    }
);

export const keywordDeleteRouter = express.Router();
keywordDeleteRouter.post(
    '/',
    [
        body('userId').isString().isLength({ min: 1, max: 32 }),
        body('entityType').isIn(KEYWORD_ENTITY_TYPES as unknown as string[]),
        body('entityId').isInt({ min: 1 }),
        body('keyword').isString().isLength({ min: 1, max: MAX_KEYWORD_LENGTH }),
    ],
    middleware,
    async (req: express.Request, res: express.Response) => {
        const { entityType, entityId, keyword, userId } = req.body;
        try {
            const result = await removeKeyword({
                entityType: entityType as KeywordEntityType,
                entityId: Number(entityId),
                keyword,
                userId
            });
            if (!result.ok) {
                return res.status(200).send({ status: 'failed', data: `错误: ${result.reason}` });
            }
            res.status(200).send({
                status: 'success',
                data: result.removed > 0 ? '已删除该关键词' : '没有找到你上传的该关键词'
            });
        } catch (e) {
            console.log(e);
            res.status(500).send({ status: 'failed', data: '内部错误' });
        }
    }
);
