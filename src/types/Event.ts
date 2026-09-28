import { EventRow } from './MasterData';
import { store, t } from '../data/masterdata';
import { parseGameDate } from './Gacha';

/** 活动模型: MasterEvent 表当前为空, 结构以容错方式处理 */
export class Event {
    eventId: number;
    isExist = false;
    row?: EventRow;
    eventName = '';
    startAt?: Date;
    endAt?: Date;

    constructor(eventId: number) {
        this.eventId = eventId;
    }

    async init(): Promise<void> {
        this.row = await store.eventById(this.eventId);
        if (!this.row) return;
        this.isExist = true;
        const nameId = String(this.row.nameTextId ?? this.row.eventNameTextId ?? '');
        this.eventName = nameId ? await t(nameId) : `Event ${this.eventId}`;
        this.startAt = parseGameDate(String(this.row.startAt ?? ''));
        this.endAt = parseGameDate(String(this.row.endAt ?? ''));
    }

    fuzzyTarget(): Record<string, unknown> {
        return { eventId: this.eventId, eventName: this.eventName };
    }
}
