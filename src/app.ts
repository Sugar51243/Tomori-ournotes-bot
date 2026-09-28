import express from 'express';
import { config, REGION } from './config';
import { logger } from './logger';
import { registerFonts } from './components/fonts';
import { getDataVersion } from './data/masterdata/client';
import { searchSongRouter } from './routers/searchSong';
import { songMetaRouter } from './routers/songMeta';
import { songChartRouter } from './routers/songChart';
import { songChartDataRouter } from './routers/songChartData';
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
import { stationRouter } from './routers/station';
import { roomListRouter } from './routers/roomList';
import { songRandomRouter } from './routers/songRandom';
import { fuzzySearchRouter } from './routers/fuzzySearch';
import { disabledRouter } from './routers/disabled';

const app = express();
app.use(express.json({ limit: '2mb' }));

app.get('/health', async (_req, res) => {
    try {
        const version = await getDataVersion();
        res.send({
            status: 'success',
            data: { ok: true, dataVersion: version.dataVersion, resourceVersion: version.resourceVersion, region: REGION, upTimeS: Math.floor(process.uptime()) }
        });
    } catch (e) {
        res.status(500).send({ status: 'failed', data: '内部错误' });
    }
});

app.use('/searchSong', searchSongRouter);
app.use('/songMeta', songMetaRouter);
app.use('/songChart', songChartRouter);
app.use('/songChartData', songChartDataRouter);
app.use('/searchCard', searchCardRouter);                  // 查卡(整合两者)
app.use('/searchMemberCard', searchMemberCardRouter);      // 查角色卡(仅角色卡)
app.use('/searchSupportCard', searchSupportCardRouter);    // 查支援卡(仅支援卡)
app.use('/searchCharacter', searchCharacterRouter);
app.use('/searchGacha', searchGachaRouter);
app.use('/searchEvent', searchEventRouter);
app.use('/gachaSimulate', gachaSimulateRouter);
app.use('/getCardIllustration', getCardIllustrationRouter);
app.use('/getStampImage', getStampImageRouter);            // 贴纸原图(按数字 ID)
app.use('/songRandom', songRandomRouter);
app.use('/fuzzySearch', fuzzySearchRouter);

if (config.enableDb) {
    logger('app', `community features enabled (mongo: ${config.mongoUri || '未配置'})`);
} else {
    logger('app', 'ENABLE_DB=false, community features (friend/station) stay disabled');
}
app.use('/searchPlayer', disabledRouter());
app.use('/cutoffAll', disabledRouter());
app.use('/cutoffDetail', disabledRouter());
app.use('/cutoffListOfRecentEvent', disabledRouter());
app.use('/user', disabledRouter());                        // tsugu 的 /user 是账号绑定 API, 本服务不实现
// 社区功能(交友/车站): 与 tsugu 一致, 未启用数据库时保持 404 占位
app.use('/friend/upload', config.enableDb ? friendUploadRouter : disabledRouter());
app.use('/friend/delete', config.enableDb ? friendDeleteRouter : disabledRouter());
app.use('/friend/list', config.enableDb ? friendListRouter : disabledRouter());
app.use('/station', config.enableDb ? stationRouter : disabledRouter());
app.use('/roomList', config.enableDb ? roomListRouter : disabledRouter());

app.use((_req, res) => {
    res.status(404).send('404 Not Found');
});

registerFonts();

app.listen(config.port, () => {
    logger('expressMainThread', `listening on port ${config.port}`);
});
