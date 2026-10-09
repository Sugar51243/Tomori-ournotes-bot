import { reqStr, rawStr, reqInt, reqEnum } from '../http/validate';
import { KEYWORD_ENTITY_TYPES, type KeywordEntityType } from '../constants';
import type { OpTable } from './opRouter';
import * as repo from '../db/repos/keywords';

/** 用户关键词模块(原 bot 直连 Mongo 的 keywords 集合)。 */
export const keywordsOps: OpTable = {
    listAll: async () => repo.listAll(),

    add: async p => {
        await repo.add({
            entityType: reqEnum<KeywordEntityType>(p, 'entityType', KEYWORD_ENTITY_TYPES),
            entityId: reqInt(p, 'entityId', { min: 1 }),
            keyword: rawStr(p, 'keyword', { max: 64 }),
            normKeyword: reqStr(p, 'normKeyword', { max: 64 }),
            userId: reqStr(p, 'userId', { max: 32 }),
        });
        return { ok: true };
    },

    remove: async p => ({
        removed: await repo.remove({
            entityType: reqEnum<KeywordEntityType>(p, 'entityType', KEYWORD_ENTITY_TYPES),
            entityId: reqInt(p, 'entityId', { min: 1 }),
            normKeyword: reqStr(p, 'normKeyword', { max: 64 }),
            userId: reqStr(p, 'userId', { max: 32 }),
        }),
    }),
};
