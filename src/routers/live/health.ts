import express from 'express';
import { config } from '../../config';
import { getVersionManifest } from '../../data/masterdata/client';
import { SERVER_LIST, Server, serverProfile } from '../../types/Server';
import { gatewayConfigured } from '../../data/player/client';

/**
 * 健康检查接口。
 * 
 *  这是静态接口，返回接口运行状态相关Json
 */

const router = express.Router();

router.get('/', async (_req, res) => {
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

export { router as apiHealthRouter };