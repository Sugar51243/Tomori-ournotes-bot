import { Server, SERVER_LIST } from '../types/Server';
import { MasterDataStore } from './masterdata';

/**
 * 区域上下文: 把该区域的表存储与文本解析器绑在一个对象上。
 *
 * 领域模型不接收 server 参数 —— 它们各自持有一个 `server` 字段(默认 config.defaultServer),
 * 在 init() 里用 `const { store, t } = regionFor(this.server)` 取到本区域的数据源。
 */
export interface RegionContext {
    readonly server: Server;
    readonly store: MasterDataStore;
    readonly t: (textId: string, locale?: string) => Promise<string>;
    readonly tSync: (textId: string, locale?: string) => string;
    readonly preloadText: () => Promise<void>;
}

const contexts = new Map<Server, RegionContext>();

export function regionFor(server: Server): RegionContext {
    let ctx = contexts.get(server);
    if (!ctx) {
        const store = new MasterDataStore(server);
        ctx = {
            server,
            store,
            t: (textId: string, locale?: string) => store.text.t(textId, locale),
            tSync: (textId: string, locale?: string) => store.text.tSync(textId, locale),
            preloadText: () => store.text.preload()
        };
        contexts.set(server, ctx);
    }
    return ctx;
}

/** 只要表存储时的简写 */
export function storeFor(server: Server): MasterDataStore {
    return regionFor(server).store;
}

/** 检查该区域 dataVersion 是否变化, 变化则只重置这个区域 */
export async function refreshRegion(server: Server): Promise<void> {
    await regionFor(server).store.refresh();
}

/** 全部区域(供 /health 之类的入口) */
export async function refreshAllRegions(): Promise<void> {
    await Promise.all(SERVER_LIST.map(s => refreshRegion(s).catch(() => undefined)));
}
