import express from 'express';
import { config } from './config';
import { logger } from './logger';
import { registerFonts } from './components/fonts';
import { getVersionManifest } from './data/masterdata/client';
import { SERVER_LIST, Server, serverProfile } from './types/Server';
import { searchSongRouter } from './routers/searchSong';
import { songMetaRouter } from './routers/songMeta';
import { songChartRouter } from './routers/songChart';
import { songChartDataRouter } from './routers/songChartData';
import { songRankingRouter } from './routers/songRanking';
import { searchCardRouter } from './routers/searchCard';
import { searchMemberCardRouter } from './routers/searchMemberCard';
import { searchSupportCardRouter } from './routers/searchSupportCard';
import { searchCharacterRouter } from './routers/searchCharacter';
import { searchGachaRouter } from './routers/searchGacha';
import { searchEventRouter } from './routers/searchEvent';
import { gachaSimulateRouter } from './routers/gachaSimulate';
import { getCardIllustrationRouter } from './routers/getCardIllustration';
import { getStampImageRouter } from './routers/getStampImage';
import { friendUploadRouter, friendDeleteRouter, friendListRouter } from './routers/friendRoute';
import { keywordUploadRouter, keywordDeleteRouter } from './routers/keywordRoute';
import { stationRouter } from './routers/station';
import { roomListRouter } from './routers/roomList';
import { songRandomRouter } from './routers/songRandom';
import { fuzzySearchRouter } from './routers/fuzzySearch';
import { announcementRouter } from './routers/announcementRoute';
import { createAnnouncementStreamRouter } from './routers/announcementStream';
import { playerRouter } from './routers/playerRoute';
import { eventRankingRouter } from './routers/eventRanking';
import { eventRecommendRouter } from './routers/eventRecommend';
import { cutoffRouter } from './routers/cutoffRoute';
import { searchBandRouter } from './routers/searchBand';
import { startCutoffRecorder } from './data/cutoff/recorder';
import { gatewayConfigured } from './data/player/client';
import { disabledRouter } from './routers/disabled';
import { renderCacheMiddleware } from './routers/renderCache';

const app = express();
app.use(express.json({ limit: '2mb' }));

// 渲染结果缓存: 只作用于确定性的出图/数据端点(见 renderCache.ts 的白名单)
app.use(renderCacheMiddleware);

app.get('/health', async (_req, res) => {
    try {
        const manifest = await getVersionManifest(true);
        const regions: Record<string, { version: string; resourceVersion: string }> = {};
        for (const server of SERVER_LIST) {
            const info = manifest.regions[serverProfile(server).masterdataKey];
            if (info) regions[server] = { version: info.dataVersion, resourceVersion: info.resourceVersion };
        }
        res.send({
            status: 'success',
            data: {
                ok: true,
                // 保留旧的单值字段, 便于既有监控继续工作
                region: config.defaultServer,
                defaultServer: config.defaultServer,
                servers: SERVER_LIST as unknown as Server[],
                regions,
                playerGateway: gatewayConfigured(),
                upTimeS: Math.floor(process.uptime())
            }
        });
    } catch (e) {
        res.status(500).send({ status: 'failed', data: '内部错误' });
    }
});

app.use('/searchSong', searchSongRouter);
app.use('/songMeta', songMetaRouter);
app.use('/songChart', songChartRouter);
app.use('/songChartData', songChartDataRouter);
app.use('/songRanking', songRankingRouter);                // 歌曲排行前十(单服, 用户动态数据)
app.use('/searchCard', searchCardRouter);                  // 查卡(整合两者)
app.use('/searchMemberCard', searchMemberCardRouter);      // 查角色卡(仅角色卡)
app.use('/searchSupportCard', searchSupportCardRouter);    // 查支援卡(仅支援卡)
app.use('/searchCharacter', searchCharacterRouter);
app.use('/searchBand', searchBandRouter);                  // 查乐团(多服一图, 静态数据)
app.use('/searchGacha', searchGachaRouter);
app.use('/searchEvent', searchEventRouter);
app.use('/gachaSimulate', gachaSimulateRouter);
app.use('/getCardIllustration', getCardIllustrationRouter);
app.use('/getStampImage', getStampImageRouter);            // 贴纸原图(按数字 ID)
app.use('/songRandom', songRandomRouter);
app.use('/fuzzySearch', fuzzySearchRouter);
app.use('/announcements', announcementRouter);             // 公告查询(单服出图)
app.use('/announcementStream', createAnnouncementStreamRouter());  // 公告推送(每服一条 SSE)
app.use('/searchPlayer', playerRouter);                    // 账号查询(单服, 用户动态数据)

if (config.enableDb) {
    logger('app', `community features enabled (mongo: ${config.mongoUri || '未配置'})`);
} else {
    logger('app', 'ENABLE_DB=false, community features (friend/station) stay disabled');
}
app.use('/eventSongRanking', eventRankingRouter);          // 活动歌榜(单服, 用户动态数据; 带榜线 rank 参数)
app.use('/eventRanking', eventRankingRouter);              // 旧路径, 保留兼容
app.use('/eventRecommend', eventRecommendRouter);          // 活动推荐曲(单服, 静态数据+活动报酬)
app.use('/cutoffAll', cutoffRouter);                       // 活动榜线(单服, 各档分数随时间变化的折线图)
app.use('/cutoffDetail', disabledRouter());
app.use('/cutoffListOfRecentEvent', disabledRouter());
app.use('/user', disabledRouter());                        // tsugu 的 /user 是账号绑定 API, 本服务不实现
// 社区功能(交友/车站): 与 tsugu 一致, 未启用数据库时保持 404 占位
app.use('/friend/upload', config.enableDb ? friendUploadRouter : disabledRouter());
app.use('/friend/delete', config.enableDb ? friendDeleteRouter : disabledRouter());
app.use('/friend/list', config.enableDb ? friendListRouter : disabledRouter());
app.use('/keyword/upload', config.enableDb ? keywordUploadRouter : disabledRouter());
app.use('/keyword/delete', config.enableDb ? keywordDeleteRouter : disabledRouter());
app.use('/station', config.enableDb ? stationRouter : disabledRouter());
app.use('/roomList', config.enableDb ? roomListRouter : disabledRouter());

app.use((_req, res) => {
    res.status(404).send('404 Not Found');
});

registerFonts();

app.listen(config.port, () => {
    logger('expressMainThread', `listening on port ${config.port} (defaultServer=${config.defaultServer}, servers=${SERVER_LIST.join('/')})`);
    // 榜线历史常驻采样(上游没有历史接口, 得自己按小时攒)
    startCutoffRecorder();
});
