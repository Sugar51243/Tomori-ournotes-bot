import { X509Certificate } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config';
import { describeError, logger } from '../logger';

/**
 * 自带的 https 监听(可选)。配齐 DB_API_HTTPS_PORT + DB_API_SSL_CERT + DB_API_SSL_KEY
 * 就额外起一个 TLS 监听, 与 http 端口同时在跑。正式对外推荐反代终止 TLS; 这里是
 * 不想引反代时的直连方案。
 *
 * 与 web 侧的原则一致: 证书读不到/端口绑不上只是「没有 https 监听」, http 照常跑;
 * 证书过期在启动日志里说明白。
 */

export interface TlsConfig {
    port: number;
    key: Buffer;
    cert: Buffer;
}

export function loadTlsConfig(): TlsConfig | undefined {
    const { httpsPort, sslCert, sslKey } = config;
    if (!httpsPort && !sslCert && !sslKey) return undefined; // 完全没配 = 静默不启用
    const missing: string[] = [];
    if (!httpsPort) missing.push('DB_API_HTTPS_PORT');
    if (!sslCert) missing.push('DB_API_SSL_CERT');
    if (!sslKey) missing.push('DB_API_SSL_KEY');
    if (missing.length) {
        logger('tls', `https 监听未启用：还缺 ${missing.join('、')}（三项要一起配）`, 'warn');
        return undefined;
    }
    try {
        // 相对路径按项目根解析
        const cert = fs.readFileSync(path.resolve(__dirname, '../..', sslCert));
        const key = fs.readFileSync(path.resolve(__dirname, '../..', sslKey));
        try {
            const x509 = new X509Certificate(cert);
            const validTo = new Date(x509.validTo).getTime();
            const daysLeft = Math.floor((validTo - Date.now()) / (24 * 3600 * 1000));
            if (daysLeft < 0) logger('tls', `证书已过期（有效期至 ${x509.validTo}）—— 请换新证书`, 'warn');
            else logger('tls', `证书有效期至 ${x509.validTo}（还有 ${daysLeft} 天）`);
        } catch (e) {
            logger('tls', `证书解析失败（${sslCert}）: ${describeError(e)}`, 'warn');
        }
        logger('tls', `已加载证书 ${sslCert}，准备监听 ${config.location}:${httpsPort}`);
        return { port: httpsPort, cert, key };
    } catch (e) {
        logger('tls', `https 证书读取失败（cert=${sslCert} key=${sslKey}）: ${describeError(e)} —— 本次只跑 http`, 'warn');
        return undefined;
    }
}
