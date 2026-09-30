import express from 'express';
import { body } from 'express-validator';
import { isInteger, listToBase64 } from './utils';
import { isServerList, pickServers } from '../types/Server';
import { middleware } from './middleware';
import { isFuzzySearchResult, FuzzySearchResult } from '../fuzzySearch';
import { Character } from '../types/Character';
import { Server, withServer } from '../types/Server';
import { characterServerRows } from '../data/serverInfo';
import { drawCharacterDetail } from '../view/characterDetail';
import { drawCharacterList } from '../view/characterList';
import { searchCharacters, textToFuzzyResult } from '../search';

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
            const result = await commandCharacter(servers, text || fuzzySearchResult, compress);
            res.send(listToBase64(result));
        } catch (e) {
            console.log(e);
            res.status(500).send({ status: 'failed', data: '内部错误' });
        }
    }
);

export async function commandCharacter(servers: Server[], input: string | FuzzySearchResult, compress: boolean): Promise<Array<Buffer | string>> {
    if (typeof input === 'string' && isInteger(input)) {
        const characterId = parseInt(input, 10);
        const rows = await characterServerRows(characterId, servers);
        // 必须用「自己有数据」的服做主体: 借港澳台数据的行渲染不出该实体本身
        const bodyServer = rows.find(r => r.hasOwn)?.server;
        if (!bodyServer) {
            return ['错误: 该角色不存在'];
        }
        const character = withServer(new Character(characterId), bodyServer);
        await character.init();
        return drawCharacterDetail(character, rows, compress);
    }
    const bodyServer = servers[0];
    const matches = typeof input === 'string' ? textToFuzzyResult(bodyServer, input) : input;
    if (Object.keys(matches).length == 0) {
        return ['错误: 没有有效的关键词'];
    }
    const characters = await searchCharacters(bodyServer, matches);
    if (characters.length === 0) {
        return ['没有搜索到符合条件的角色'];
    }
    if (characters.length === 1) {
        const rows = await characterServerRows(characters[0].characterId, servers);
        return drawCharacterDetail(characters[0], rows, compress);
    }
    return drawCharacterList(bodyServer, characters, compress);
}

export { router as searchCharacterRouter };
