import express from 'express';
import { body } from 'express-validator';
import { isInteger, listToBase64, pickEntityInput, EntityInput } from '../utils';
import { fallbackChain, isServerInput, SERVER_LIST } from '../../types/Server';
import { middleware } from '../middleware';
import { isFuzzySearchResult } from '../../fuzzySearch';
import { Character } from '../../types/Character';
import { Server, withServer } from '../../types/Server';
import { characterServerRows, firstOwnServer } from '../../data/serverInfo';
import { drawCharacterDetail } from '../../view/character/characterDetail';
import { drawCharacterList } from '../../view/character/characterList';
import { searchCharacters, textToFuzzyResult } from '../../search';

/**
 * 查角色(单服回退)。
 *
 * 查询输入按统一规则解析(见 utils.pickEntityInput): `id` > `characterId` > `text` > `fuzzySearchResult`;
 * 传一个字段即可 —— 纯数字按角色 ID 直查, 其它文本走模糊搜索。
 */
const router = express.Router();

router.post(
    '/',
    [
        body('displayedServerList').optional().custom(isServerInput),
        body('id').optional(),
        body('characterId').optional(),
        body('fuzzySearchResult').optional().custom(isFuzzySearchResult),
        body('text').optional().isString(),
        body('compress').optional().isBoolean(),
    ],
    middleware,
    async (req: express.Request, res: express.Response) => {
        const input = pickEntityInput(req.body, ['characterId']);
        if (input === undefined) {
            return res.status(422).json({ status: 'failed', data: '需要提供查询输入: id / characterId / text / fuzzySearchResult 之一' });
        }
        try {
            const result = await commandCharacter(fallbackChain(req.body), { input, compress: req.body.compress });
            res.send(listToBase64(result));
        } catch (e) {
            console.log(e);
            res.status(500).send({ status: 'failed', data: '内部错误' });
        }
    }
);

export interface CharacterQuery {
    input: EntityInput;
    compress?: boolean;
}

export async function commandCharacter(servers: Server[], query: CharacterQuery): Promise<Array<Buffer | string>> {
    const { input, compress = false } = query;
    if (typeof input === 'string' && isInteger(input)) {
        const characterId = parseInt(input, 10);
        // 图内恒列全部四服; 主体按回退链取第一个收录该角色的服
        const rows = await characterServerRows(characterId, [...SERVER_LIST]);
        const bodyServer = firstOwnServer(rows, servers);
        if (!bodyServer) {
            return ['错误: 该角色不存在'];
        }
        const character = withServer(new Character(characterId), bodyServer);
        await character.init();
        return drawCharacterDetail(character, rows, compress);
    }

    if (typeof input !== 'string') {
        const bodyServer = servers[0];
        const characters = await searchCharacters(bodyServer, input);
        if (characters.length === 0) return ['没有搜索到符合条件的角色'];
        if (characters.length === 1) {
            return drawCharacterDetail(characters[0], await characterServerRows(characters[0].characterId, [...SERVER_LIST]), compress);
        }
        return drawCharacterList(bodyServer, characters, compress);
    }

    // 文本: 沿回退链依次查各服的模糊索引, 取第一个有结果的服
    let hasKeyword = false;
    for (const server of servers) {
        const matches = await textToFuzzyResult(server, input);
        if (Object.keys(matches).length === 0) continue;
        hasKeyword = true;
        const characters = await searchCharacters(server, matches);
        if (characters.length === 0) continue;
        if (characters.length === 1) {
            return drawCharacterDetail(characters[0], await characterServerRows(characters[0].characterId, [...SERVER_LIST]), compress);
        }
        return drawCharacterList(server, characters, compress);
    }
    return hasKeyword ? ['没有搜索到符合条件的角色'] : ['错误: 没有有效的关键词'];
}

export { router as searchCharacterRouter };
