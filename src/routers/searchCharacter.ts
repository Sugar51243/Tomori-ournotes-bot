import express from 'express';
import { body } from 'express-validator';
import { isInteger, listToBase64 } from './utils';
import { isServerList } from '../types/Server';
import { middleware } from './middleware';
import { isFuzzySearchResult, FuzzySearchResult } from '../fuzzySearch';
import { Character } from '../types/Character';
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
            const result = await commandCharacter(text || fuzzySearchResult, compress);
            res.send(listToBase64(result));
        } catch (e) {
            console.log(e);
            res.status(500).send({ status: 'failed', data: '内部错误' });
        }
    }
);

export async function commandCharacter(input: string | FuzzySearchResult, compress: boolean): Promise<Array<Buffer | string>> {
    if (typeof input === 'string' && isInteger(input)) {
        const character = new Character(parseInt(input, 10));
        await character.init();
        if (!character.isExist) {
            return ['错误: 该角色不存在'];
        }
        return drawCharacterDetail(character, compress);
    }
    const matches = typeof input === 'string' ? textToFuzzyResult(input) : input;
    if (Object.keys(matches).length == 0) {
        return ['错误: 没有有效的关键词'];
    }
    const characters = await searchCharacters(matches);
    if (characters.length === 0) {
        return ['没有搜索到符合条件的角色'];
    }
    if (characters.length === 1) {
        return drawCharacterDetail(characters[0], compress);
    }
    return drawCharacterList(characters, compress);
}

export { router as searchCharacterRouter };
