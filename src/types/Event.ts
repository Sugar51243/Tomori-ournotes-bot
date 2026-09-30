import { EventRow } from './MasterData';
import { regionFor } from '../data/region';
import { parseGameDate } from './Gacha';
import { Server, defaultServer } from './Server';

/** 活动模型: MasterEvent 表当前为空, 结构以容错方式处理 */
export class Event {
    eventId: number;
    /** 该实体由哪个区域渲染(文本/素材来源); 默认主服, 由调用方在 init() 前指定 */
    server: Server = defaultServer();
    isExist = false;
    row?: EventRow;
    eventName = '';
    startAt?: Date;
    endAt?: Date;

    constructor(eventId: number) {
        this.eventId = eventId;
    }

    async init(): Promise<void> {
        const { store, t } = regionFor(this.server);
        this.row = await store.eventById(this.eventId);
        if (!this.row) return;
        this.isExist = true;
        const nameId = String(this.row.nameTextId ?? this.row.eventNameTextId ?? '');
        this.eventName = nameId ? await t(nameId) : `Event ${this.eventId}`;
        this.startAt = parseGameDate(String(this.row.startAt ?? ''), this.server);
        this.endAt = parseGameDate(String(this.row.endAt ?? ''), this.server);
    }

    fuzzyTarget(): Record<string, unknown> {
        return { eventId: this.eventId, eventName: this.eventName };
    }
}
