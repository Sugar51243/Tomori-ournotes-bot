import express from 'express';
import { config } from './config';
import { logger } from './logger';
import { registerFonts } from './render/component/fonts';
import { SERVER_LIST } from './features/types/Server';
import { searchSongRouter } from './routers/song/searchSong';
import { songMetaRouter } from './routers/song/songMeta';
import { songChartRouter } from './routers/song/songChart';
import { songChartDataRouter } from './routers/song/songChartData';
import { songRankingRouter } from './routers/song/songRanking';
import { searchCardRouter } from './routers/card/searchCard';
import { searchMemberCardRouter } from './routers/card/searchMemberCard';
import { searchSupportCardRouter } from './routers/card/searchSupportCard';
import { searchCharacterRouter } from './routers/character/searchCharacter';
import { searchGachaRouter } from './routers/gacha/searchGacha';
import { searchEventRouter } from './routers/event/searchEvent';
import { gachaSimulateRouter } from './routers/gacha/gachaSimulate';
import { getCardIllustrationRouter } from './routers/card/getCardIllustration';
import { getStampImageRouter } from './routers/stamp/getStampImage';
import { friendUploadRouter, friendDeleteRouter, friendListRouter } from './routers/station/friendRoute';
import { keywordUploadRouter, keywordDeleteRouter } from './routers/keywordRoute';
import { stationRouter } from './routers/station/station';
import { roomListRouter } from './routers/station/roomList';
import { songRandomRouter } from './routers/song/songRandom';
import { fuzzySearchRouter } from './routers/fuzzySearch';
import { announcementRouter } from './routers/announcement/announcementRoute';
import { createAnnouncementStreamRouter } from './routers/announcement/announcementStream';
import { playerRouter } from './routers/player/playerRoute';
import { eventRankingRouter } from './routers/event/eventRanking';
import { eventRecommendRouter } from './routers/event/eventRecommend';
import { cutoffRouter } from './routers/event/cutoffRoute';
import { searchBandRouter } from './routers/band/searchBand';
import { startCutoffRecorder } from './tasks/cutoff/recorder';
import { initCutoffStore } from './db/adapter';
import { disabledRouter } from './routers/disabled';
import { apiHealthRouter } from './routers/live/health';

const app = express();
app.use(express.json({ limit: '2mb' }));

// 接口状态查询
app.use('/health', apiHealthRouter);


/** 业务接口  */
// 模糊搜索
app.use('/fuzzySearch', fuzzySearchRouter);

//歌曲相关
app.use('/searchSong', searchSongRouter);                           // 查歌(多服一图, 静态数据)
app.use('/songChartData', songChartDataRouter);                     // 歌曲谱面数据(多服一图, 静态数据)
app.use('/songChart', songChartRouter);                             // 歌曲谱面图(多服一图, 静态数据)
app.use('/songRandom', songRandomRouter);                           // 随机歌曲(多服一图, 静态数据)

// 卡片相关
app.use('/searchCard', searchCardRouter);                           // 查卡(整合两者)
app.use('/searchMemberCard', searchMemberCardRouter);               // 查角色卡(仅角色卡)
app.use('/searchSupportCard', searchSupportCardRouter);             // 查支援卡(仅支援卡)
app.use('/getCardIllustration', getCardIllustrationRouter);         // 卡片原图(按数字 ID)

// 榜单相关
app.use('/songMeta', songMetaRouter);                               // 歌曲元信息(多服一图, 静态数据)
app.use('/eventRecommend', eventRecommendRouter);                   // 活动推荐曲(单服, 静态数据+活动报酬)
app.use('/songRanking', songRankingRouter);                         // 歌曲排行前十(单服, 用户动态数据)
app.use('/eventSongRanking', eventRankingRouter);                   // 活动歌榜(单服, 用户动态数据; 带榜线 rank 参数)
app.use('/eventRanking', eventRankingRouter);                       // 活动歌榜旧路径, 保留兼容

// 活动相关
app.use('/searchEvent', searchEventRouter);                         // 查活动(多服一图, 静态数据)
app.use('/searchGacha', searchGachaRouter);                         // 查卡池(多服一图, 静态数据)
app.use('/gachaSimulate', gachaSimulateRouter);                     // 卡池模拟(单服, 静态数据)
app.use('/cutoffAll', cutoffRouter);                                // 活动榜线(单服, 各档分数随时间变化的折线图)
app.use('/cutoffDetail', cutoffRouter);                             // 活动榜线(单服, 各档分数随时间变化的折线图)   
app.use('/cutoffListOfRecentEvent', cutoffRouter);                  // 最近活动榜线(单服, 各档分数随时间变化的折线图)

// 公告相关
app.use('/announcements', announcementRouter);                      // 公告查询(单服出图)
app.use('/announcementStream', createAnnouncementStreamRouter());   // 公告推送(每服一条 SSE)

// 其他相关
app.use('/searchCharacter', searchCharacterRouter);                 // 查角色(多服一图, 静态数据)
app.use('/searchBand', searchBandRouter);                           // 查乐团(多服一图, 静态数据)
app.use('/getStampImage', getStampImageRouter);                     // 贴纸原图(按数字 ID)
app.use('/searchPlayer', playerRouter);                             // 账号查询(单服, 用户动态数据)

// 社区功能(交友/车站): 检查是否开启数据库功能, 未启用数据库时保持 404 占位
if (config.enableDb) {
    logger('app', `community features enabled (mongo: ${config.mongoUri || '未配置'})`);
} else {
    logger('app', 'ENABLE_DB=false, community features (friend/station) stay disabled');
}

// 社区功能(交友/车站): 与 tsugu 一致, 未启用数据库时保持 404 占位
app.use('/friend/upload', config.enableDb ? friendUploadRouter : disabledRouter());     // 上传好友(单服, 用户动态数据)
app.use('/friend/delete', config.enableDb ? friendDeleteRouter : disabledRouter());     // 删除好友(单服, 用户动态数据)
app.use('/friend/list', config.enableDb ? friendListRouter : disabledRouter());         // 好友列表(单服, 用户动态数据)
app.use('/keyword/upload', config.enableDb ? keywordUploadRouter : disabledRouter());   // 上传关键字(单服, 用户动态数据)
app.use('/keyword/delete', config.enableDb ? keywordDeleteRouter : disabledRouter());   // 删除关键字(单服, 用户动态数据)
app.use('/station', config.enableDb ? stationRouter : disabledRouter());                // 车站(单服, 用户动态数据)
app.use('/roomList', config.enableDb ? roomListRouter : disabledRouter());              // 房间列表(单服, 用户动态数据)

// 占位 / 404
app.use('/user', disabledRouter());                                 // tsugu 的 /user 是账号绑定 API, 本服务不实现
app.use((_req, res) => {
    res.status(404).send('404 Not Found');
});

// 统一错误出口: 非法 JSON 等解析错误按「参数错误」返回(而不是 express 默认的 HTML + 堆栈),
// 其余未捕获错误记日志后回 500, 保持与各路由一致的响应形状。
app.use((err: Error, _req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (err instanceof SyntaxError && 'body' in err) {
        return res.status(400).send({ status: 'failed', data: '参数错误', error: [{ msg: '请求体不是合法 JSON' }] });
    }
    logger('expressMainThread', `unhandled error: ${err.stack ?? err}`);
    if (res.headersSent) return next(err);
    res.status(500).send({ status: 'failed', data: '内部错误' });
});

// 启动前检查
registerFonts();


app.listen(config.port, config.location, () => {
    logger('expressMainThread', `listening on ${config.location}:${config.port} (defaultServer=${config.defaultServer}, servers=${SERVER_LIST.join('/')})`);
    // 榜线历史存储初始化(MySQL → SQLite → 内存)与 Mongo 旧数据迁移, 后台进行不阻塞
    void initCutoffStore().catch(e => logger('cutoff', `store init failed: ${e instanceof Error ? e.message : e}`));
    // 榜线历史常驻采样(上游没有历史接口, 得自己按小时攒)
    startCutoffRecorder();
});
