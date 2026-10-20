import { config } from '../config';
import type { OpTable } from './opRouter';

/**
 * 杂项只读配置。原先 bot 的 STATION_TTL_S 与 web 的 WEB_STATION_TTL_S 各配一份
 * 且必须人工保持一致; 现在值只看本服务, 消费方(web 的站台接口要回 ttlSeconds
 * 给前端做倒计时)按需来取。
 */
export const miscOps: OpTable = {
    stationTtlSeconds: async () => ({ seconds: config.stationTtlS }),
};
