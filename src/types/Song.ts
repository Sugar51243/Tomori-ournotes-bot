import { LiveMusicRow, LiveMusicScoreRow } from './MasterData';
import { store, t } from '../data/masterdata';
import { jacketUrl } from '../data/assets';
import { Band } from './Band';
import { attributeName } from './Card';

export interface SongDifficulty {
    /** 0=easy 1=normal 2=hard 3=expert */
    id: number;
    /** 内部谱面编号 10000100..10000103 */
    chartId: number;
    playLevel: number;
    displayLevel: number;
    fullComboCount: number;
}

export class Song {
    songId: number;
    isExist = false;
    row?: LiveMusicRow;
    scores: LiveMusicScoreRow[] = [];
    musicTitle = '';
    bandName = '';
    /** 归属乐队 id(用于背景图); 非参战乐队为 0 */
    bandId = 0;
    /** 假名/罗马音标题 */
    phoneticTitle = '';
    /** 演唱角色名 */
    vocalNames: string[] = [];
    /** 音乐分类(本地化) */
    categories: string[] = [];
    /** 应援色(主色在前, 含副色) */
    penLightColors: string[] = [];
    /** 曲目时长(ms, 取自谱面 bundle 元数据) */
    durationMs?: number;
    /** BPM 文本(如 "190" 或 "150~180") */
    bpmText = '';
    lyricist = '';
    composer = '';
    arranger = '';
    startAt = '';
    /** 乐曲属性类型(1=红 2=蓝 3=绿 4=黄 5=紫, 与卡片 cardType 同一套) */
    musicType = 0;
    /** 属性名(本地化, 如 绯红/绀碧/翡翠/琉金/紫苑) */
    attribute = '';
    difficulty: SongDifficulty[] = [];

    constructor(songId: number) {
        this.songId = songId;
    }

    async init(): Promise<void> {
        this.row = await store.songById(this.songId);
        if (!this.row) return;
        this.isExist = true;

        const [scores] = await Promise.all([
            store.songScores()
        ]);
        this.scores = scores.filter(s => Math.floor(s.id / 100) === this.songId);
        this.musicTitle = await t(this.row.titleTextID);
        // 乐队名: 优先 MasterBand 查表; 无 bandId(如 CRYCHIC 等非参战乐队)时回退到 bandNameTextID
        this.bandName = '';
        this.bandId = this.row.bandIDs[0] ?? 0;
        if (this.row.bandIDs.length > 0) {
            const band = new Band(this.row.bandIDs[0]);
            await band.init();
            this.bandName = band.bandName;
        }
        if (!this.bandName && this.row.bandNameTextID) {
            this.bandName = await t(this.row.bandNameTextID);
        }
        this.lyricist = await t(this.row.lyricistTextID);
        this.composer = await t(this.row.composerTextID);
        this.arranger = await t(this.row.arrangerTextID);
        this.startAt = this.row.startAt;
        // 乐曲属性(红/蓝/绿/黄/紫): 与卡片同一套类型, 影响「乐曲属性加成」
        this.musicType = this.row.musicType ?? 0;
        this.attribute = this.musicType ? await attributeName(this.musicType) : '';

        const chartIds = [this.row.easyID, this.row.normalID, this.row.hardID, this.row.expertID];
        this.difficulty = chartIds.map((chartId, i) => {
            const score = this.scores.find(s => s.id === chartId);
            return {
                id: i,
                chartId,
                playLevel: score?.musicScoreLevel ?? 0,
                displayLevel: score?.musicScoreDisplayLevel ?? 0,
                fullComboCount: score?.fullComboCount ?? 0
            };
        });

        // ---- 附加信息(缺表/缺数据时静默跳过) ----
        if (this.row.phoneticTextID) {
            const phonetic = await t(this.row.phoneticTextID);
            // 中/繁体下 phonetic 常与标题相同(如"迷星叫"), 此时改用日文假名读音作为补充信息
            if (phonetic === this.row.phoneticTextID) {
                this.phoneticTitle = '';
            } else if (phonetic === this.musicTitle) {
                const kana = await t(this.row.phoneticTextID, 'ja');
                this.phoneticTitle = kana !== phonetic ? kana : '';
            } else {
                this.phoneticTitle = phonetic;
            }
        }
        for (const cid of this.row.vocalCharacterIDs ?? []) {
            const ch = await store.characterById(cid);
            if (ch) this.vocalNames.push(await t(ch.nameTextID));
        }
        const categoryNames = await store.musicCategoryNames(this.row.musicCategories ?? []);
        this.categories = categoryNames;
        this.penLightColors = await store.penLightColors(this.row.liveMusicPenLightColorID ?? 0);
    }

    /**
     * 载入谱面侧信息。
     * - withBpm=false: 仅取时长(读谱面清单, 单曲约 20KB)
     * - withBpm=true : 另取 BPM(需下载谱面音符文件, 单曲数百 KB)
     * 仅由详情/全表类视图按需调用, 列表查询不触发(避免为每首结果都抓一次)。
     */
    async loadChartInfo(withBpm = true): Promise<void> {
        if (!this.isExist) return;
        try {
            const { getChartManifest, getChartNotes } = await import('../chart/client');
            if (this.durationMs === undefined) {
                const manifest = await getChartManifest(this.songId, 'expert');
                this.durationMs = manifest.chart.durationMs;
            }
            if (!withBpm || this.bpmText) return;
            const raw = await getChartNotes(this.songId, 3);
            const changes = raw.bpmChanges ?? [];
            // 原始值为浮点(如 76.61000061035156), 取整到 1 位小数后去重
            const round = (v: number) => Math.round(v * 10) / 10;
            const bpms = [...new Set(changes.map(c => round(c.bpm)))].sort((a, b) => a - b);
            if (bpms.length === 1) this.bpmText = String(bpms[0]);
            else if (bpms.length > 1) this.bpmText = `${bpms[0]}~${bpms[bpms.length - 1]}`;
        } catch {
            /* 谱面数据不可用时省略 */
        }
    }

    jacketUrl(): string {
        return this.row ? jacketUrl(this.row.jacketAssetName) : '';
    }

    /** 供 match() 使用的模糊搜索目标对象 */
    fuzzyTarget(): Record<string, unknown> {
        return {
            songId: this.songId,
            musicTitle: this.musicTitle,
            bandName: this.bandName,
            songLevels: this.difficulty.map(d => d.playLevel),
            tagLabel: this.row?.titleTextID ?? '',
            // 乐团分类(可为复数: 对唱/合作曲)
            bandId: this.row?.bandIDs ?? []
        };
    }
}
