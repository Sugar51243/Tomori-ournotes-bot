import { isInteger, EntityInput } from '../../search/fuzzySearch';
import { Server, withServer } from '../types/Server';
import { Gacha } from '../types/Gacha';
import { simulateGacha, getCurrentGacha } from './simulate';
import { drawGachaSimulate } from '../../render/view/gacha/gachaSimulate';
import { findGachaMatches } from './searchGacha';

/**
 * 抽卡模拟(单服)的功能实现。
 *
 * 卡池输入: `id` > `gachaId` > `text` > `fuzzySearchResult`, 一个都不传时取该服当前开放卡池;
 * 传文本时只在该服索引里搜索(数据本身只属于这一个服)。
 */

export interface GachaSimulateQuery {
    /** 不传 = 该服当前开放卡池 */
    input?: EntityInput;
    times?: number;
    compress?: boolean;
}

/** 抽卡模拟入口: 不传卡池取当前卡池, 按 gachaDefaultRates 模拟 times 次并出结果图 */
export async function commandGachaSimulate(server: Server, query: GachaSimulateQuery = {}): Promise<Array<Buffer | string>> {
    const { input, times = 10, compress = false } = query;
    if (times > 10000) {
        return ['错误: 抽卡次数过多, 请不要超过10000次'];
    }

    let gacha: Gacha | undefined;
    if (input === undefined) {
        gacha = await getCurrentGacha(server);
        if (!gacha) {
            return ['错误: 该服务器没有正在进行的卡池'];
        }
    } else if (typeof input === 'string' && isInteger(input)) {
        gacha = withServer(new Gacha(parseInt(input, 10)), server);
        await gacha.init();
        if (!gacha.isExist) {
            return ['错误: 该卡池不存在'];
        }
    } else {
        // 文本: 只在该服的索引里搜索, 唯一命中才取用
        const hit = await findGachaMatches([server], input);
        if ('error' in hit) return [hit.error];
        if (hit.gachas.length > 1) {
            const names = hit.gachas.slice(0, 5).map(g => `${g.gachaId} ${g.gachaName}`).join(' / ');
            return [`错误: 匹配到多个卡池, 请用 gachaId 精确指定: ${names}`];
        }
        gacha = hit.gachas[0];
    }

    const results = await simulateGacha(gacha, times);
    return drawGachaSimulate(gacha.gachaName, results, compress);
}
