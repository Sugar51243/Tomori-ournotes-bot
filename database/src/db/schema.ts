import { query, execute } from './mysql';
import { logger } from '../logger';

/**
 * 平台自己的建表脚本(库 MYSQL_DATABASE, 默认 tomori_web)。全部 IF NOT EXISTS, 可重复执行。
 * 榜线表不在这里 —— 那是 bot 的库(见 cutoffSchema.ts)。
 *
 * 本文件原样搬自 web/server/src/db/schema.ts(2026-10): 建表/迁移/种子的所有权
 * 随数据库操作一起移交本服务, web 侧不再有任何 DDL。
 *
 * 命名统一加 web_ 前缀: 一是与 bot 的表一眼区分, 二是跨库查询时写
 * `tomori.cutoff_samples` / `tomori_web.web_users` 不会看混。
 */

const DDL: string[] = [
    // ---- 账号 ----
    `CREATE TABLE IF NOT EXISTS web_users (
        id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        username      VARCHAR(32)     NOT NULL,
        nickname      VARCHAR(32)     NOT NULL,
        password_hash VARCHAR(255)    NOT NULL,
        avatar_url    VARCHAR(512)    NULL,
        role          ENUM('user','admin_low','admin_high') NOT NULL DEFAULT 'user',
        status        ENUM('active','banned')               NOT NULL DEFAULT 'active',
        ban_reason    VARCHAR(255)    NULL,
        token_version INT UNSIGNED    NOT NULL DEFAULT 0,
        profile       JSON            NULL,
        created_at    DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        updated_at    DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
        last_login_at DATETIME(3)     NULL,
        PRIMARY KEY (id),
        UNIQUE KEY uk_username (username),
        KEY idx_role_status (role, status)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

    // ---- 论坛 ----
    `CREATE TABLE IF NOT EXISTS web_forum_boards (
        id          INT UNSIGNED NOT NULL AUTO_INCREMENT,
        slug        VARCHAR(32)  NOT NULL,
        name        VARCHAR(32)  NOT NULL,
        description VARCHAR(255) NOT NULL DEFAULT '',
        sort_order  INT          NOT NULL DEFAULT 0,
        is_locked   TINYINT(1)   NOT NULL DEFAULT 0,
        is_hidden   TINYINT(1)   NOT NULL DEFAULT 0,
        created_at  DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        PRIMARY KEY (id),
        UNIQUE KEY uk_slug (slug)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

    `CREATE TABLE IF NOT EXISTS web_forum_posts (
        id               BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        board_id         INT UNSIGNED    NOT NULL,
        author_id        BIGINT UNSIGNED NOT NULL,
        title            VARCHAR(120)    NOT NULL,
        content          MEDIUMTEXT      NOT NULL,
        status           TINYINT         NOT NULL DEFAULT 1,
        is_pinned        TINYINT(1)      NOT NULL DEFAULT 0,
        is_locked        TINYINT(1)      NOT NULL DEFAULT 0,
        view_count       INT UNSIGNED    NOT NULL DEFAULT 0,
        like_count       INT UNSIGNED    NOT NULL DEFAULT 0,
        comment_count    INT UNSIGNED    NOT NULL DEFAULT 0,
        deleted_by       BIGINT UNSIGNED NULL,
        deleted_at       DATETIME(3)     NULL,
        last_activity_at DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        created_at       DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        updated_at       DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
        PRIMARY KEY (id),
        KEY idx_board_listing (board_id, is_pinned, last_activity_at),
        KEY idx_author (author_id, created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

    `CREATE TABLE IF NOT EXISTS web_forum_comments (
        id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        post_id    BIGINT UNSIGNED NOT NULL,
        parent_id  BIGINT UNSIGNED NULL,
        author_id  BIGINT UNSIGNED NOT NULL,
        content    TEXT            NOT NULL,
        status     TINYINT         NOT NULL DEFAULT 1,
        like_count INT UNSIGNED    NOT NULL DEFAULT 0,
        deleted_by BIGINT UNSIGNED NULL,
        deleted_at DATETIME(3)     NULL,
        created_at DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        updated_at DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
        PRIMARY KEY (id),
        KEY idx_post (post_id, status, created_at),
        KEY idx_author (author_id, created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

    `CREATE TABLE IF NOT EXISTS web_likes (
        user_id     BIGINT UNSIGNED NOT NULL,
        target_type ENUM('post','comment') NOT NULL,
        target_id   BIGINT UNSIGNED NOT NULL,
        created_at  DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        PRIMARY KEY (user_id, target_type, target_id),
        KEY idx_target (target_type, target_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

    // ---- 用户通知（被艾特 / 被回复）----
    // 注意别和下面的 web_notices（管理员发的站内公告）看混：一个是发给个人的提醒，
    // 一个是全站公告，命名刻意分成 notification / notice 两套。
    `CREATE TABLE IF NOT EXISTS web_notifications (
        id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        user_id    BIGINT UNSIGNED NOT NULL,
        actor_id   BIGINT UNSIGNED NOT NULL,
        kind       ENUM('mention','reply') NOT NULL,
        post_id    BIGINT UNSIGNED NOT NULL,
        -- 0 表示「这条通知对应的是帖子本身」。**故意不用 NULL**：
        -- 唯一索引里 NULL 互不相等，用 NULL 会让帖子级的通知完全不去重。
        comment_id BIGINT UNSIGNED NOT NULL DEFAULT 0,
        is_read    TINYINT(1)      NOT NULL DEFAULT 0,
        created_at DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        PRIMARY KEY (id),
        UNIQUE KEY uniq_source (user_id, post_id, comment_id),
        KEY idx_user_unread (user_id, is_read, id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

    // ---- 网页公告 ----
    `CREATE TABLE IF NOT EXISTS web_notices (
        id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        title        VARCHAR(120)    NOT NULL,
        content      MEDIUMTEXT      NOT NULL,
        author_id    BIGINT UNSIGNED NULL,
        status       TINYINT         NOT NULL DEFAULT 0,
        is_pinned    TINYINT(1)      NOT NULL DEFAULT 0,
        published_at DATETIME(3)     NULL,
        created_at   DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        updated_at   DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
        PRIMARY KEY (id),
        KEY idx_listing (status, is_pinned, published_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

    // ---- 沙盒聊天室(现在只用 private 房间; public 供后续多人模式) ----
    `CREATE TABLE IF NOT EXISTS web_chat_rooms (
        id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        kind       ENUM('private','public') NOT NULL DEFAULT 'private',
        slug       VARCHAR(64)     NOT NULL,
        title      VARCHAR(64)     NOT NULL,
        owner_id   BIGINT UNSIGNED NULL,
        created_at DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        PRIMARY KEY (id),
        UNIQUE KEY uk_slug (slug)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

    `CREATE TABLE IF NOT EXISTS web_chat_messages (
        id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        room_id    BIGINT UNSIGNED NOT NULL,
        author_id  BIGINT UNSIGNED NULL,
        kind       ENUM('text','result','error') NOT NULL DEFAULT 'text',
        content    MEDIUMTEXT      NOT NULL,
        attachment VARCHAR(160)    NULL,
        created_at DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        PRIMARY KEY (id),
        KEY idx_room (room_id, id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

    // ---- 自制谱 ----
    // chart_data 存**游戏原格式**的谱面 JSON（`nnnotes.live-score/1`）：
    // 存什么、预览就播什么、以后导出也是什么，中间不做任何格式转换。
    `CREATE TABLE IF NOT EXISTS web_charts (
        id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        author_id   BIGINT UNSIGNED NOT NULL,
        music_id    BIGINT UNSIGNED NOT NULL,
        difficulty  VARCHAR(16)     NOT NULL,
        title       VARCHAR(120)    NOT NULL,
        song_title  VARCHAR(200)    NOT NULL DEFAULT '',
        song_artist VARCHAR(120)    NOT NULL DEFAULT '',
        description TEXT            NULL,
        chart_data  MEDIUMTEXT      NOT NULL,
        note_count  INT UNSIGNED    NOT NULL DEFAULT 0,
        -- 来源: official = 基于官方曲目(music_id 就是那首歌);
        --       standalone = 作者自带的曲目(music_id 只当场景模板, 曲名/艺术家/音源都是作者的)
        origin      ENUM('official','standalone') NOT NULL DEFAULT 'official',
        -- 音源: 默认跟着歌曲走 upstream; 用户上传 mp3 则是 upload + 内容寻址文件名
        audio_kind        ENUM('upstream','upload') NOT NULL DEFAULT 'upstream',
        audio_file        VARCHAR(80)   NULL,
        audio_duration_ms INT UNSIGNED  NULL,
        audio_sample_rate INT UNSIGNED  NULL,
        -- 作者上传的封面(内容寻址); NULL = 用场景模板那首歌的官方封面
        cover_file        VARCHAR(80)   NULL,
        status      ENUM('draft','published') NOT NULL DEFAULT 'draft',
        post_id     BIGINT UNSIGNED NULL,
        deleted_at  DATETIME(3)     NULL,
        created_at  DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        updated_at  DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
        PRIMARY KEY (id),
        KEY idx_author (author_id, status),
        KEY idx_listing (status, updated_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

    // ---- 管理审计 ----
    `CREATE TABLE IF NOT EXISTS web_audit_logs (
        id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        actor_id    BIGINT UNSIGNED NOT NULL,
        actor_role  VARCHAR(16)     NOT NULL,
        action      VARCHAR(64)     NOT NULL,
        target_type VARCHAR(32)     NOT NULL,
        target_id   BIGINT UNSIGNED NULL,
        detail      JSON            NULL,
        ip          VARCHAR(45)     NULL,
        created_at  DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        PRIMARY KEY (id),
        KEY idx_actor (actor_id, created_at),
        KEY idx_action (action, created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

    // ---- 曲名缓存(榜线图例用; bot 唯一的 JSON 端点 /songChartData 拉一次存一份) ----
    `CREATE TABLE IF NOT EXISTS web_song_cache (
        song_id    BIGINT UNSIGNED NOT NULL,
        server     VARCHAR(16)     NOT NULL,
        title      VARCHAR(255)    NOT NULL,
        fetched_at DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        PRIMARY KEY (song_id, server)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

    // ---- 游戏账号包导入 ----
    // 一个用户可以有多个账号的记录(models 侧不做限制, 只有每用户条数上限)。
    // 解析与换算全部在浏览器里做完, 这里只存结果 —— 所以大字段是「快照」而不是原始包。
    `CREATE TABLE IF NOT EXISTS web_game_accounts (
        id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        user_id        BIGINT UNSIGNED NOT NULL,
        -- int64 超出 JS 安全整数(19 位), 必须字符串存; 只做等值比较, 从不参与算术
        game_uid       VARCHAR(24)     NULL,
        server         VARCHAR(16)     NOT NULL,
        package_id     VARCHAR(64)     NOT NULL DEFAULT '',
        player_name    VARCHAR(64)     NOT NULL DEFAULT '',
        label          VARCHAR(32)     NOT NULL DEFAULT '',
        -- 玩家公开 ID(游戏里查档用)。存档里读不到(aid 是另一套), 由用户按账号填;
        -- bot 侧「查玩家/b25/组卡」就靠它把 QQ 绑定对上号。可空。
        player_id      VARCHAR(15)     NULL,
        show_cards     TINYINT(1)      NOT NULL DEFAULT 1,
        show_items     TINYINT(1)      NOT NULL DEFAULT 1,
        show_songs     TINYINT(1)      NOT NULL DEFAULT 1,
        -- T.G.W CARD 等级（1~21）。**存档里没有这个值**，所以是用户自己填的；
        -- 没填时按 1 级（无加成）算。全量模型的 tgw_card 组件要用。
        tgw_card_rank  TINYINT UNSIGNED NOT NULL DEFAULT 1,
        -- 换算时用的主数据版本, 便于判断「数据旧了该重导」
        master_version VARCHAR(64)     NULL,
        schema_ver     TINYINT UNSIGNED NOT NULL DEFAULT 1,
        -- 列表页只读这个, 不拖后面的明细大字段
        stats          JSON            NOT NULL,
        cards_data     JSON            NULL,
        items_data     JSON            NULL,
        songs_data     JSON            NULL,
        created_at     DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        updated_at     DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
        deleted_at     DATETIME(3)     NULL,
        PRIMARY KEY (id),
        -- 同一用户对同一帐号重复导入走覆盖(且能复活软删的行); game_uid 可空, MySQL 唯一键允许多个 NULL
        UNIQUE KEY uk_user_uid (user_id, game_uid, server),
        KEY idx_user (user_id, deleted_at),
        -- bot 侧按玩家 ID 查账号包(不带 user_id), 所以这里也要个索引
        KEY idx_player (player_id, server)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

    // ---- bot 绑定码 ----
    // 用户在网页为自己的某个账号包签发一次性短时绑定码, 发到 QQ 里让 bot 兑换成
    // 「QQ ↔ 该账号」绑定。码只证明归属, 不携带任何读取权限(QQ 内的展示
    // 一律按 show_cards/show_items/show_songs 的公开规则来)。
    `CREATE TABLE IF NOT EXISTS web_bind_codes (
        code       CHAR(8)         NOT NULL,
        user_id    BIGINT UNSIGNED NOT NULL,
        account_id BIGINT UNSIGNED NOT NULL,
        expires_at DATETIME(3)     NOT NULL,
        used_at    DATETIME(3)     NULL,
        created_at DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        PRIMARY KEY (code),
        KEY idx_user (user_id),
        KEY idx_expires (expires_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
];

/**
 * 默认板块; INSERT IGNORE 保证重复执行不会覆盖管理员改过的名字。
 * 最后一项是"是否隐藏": 隐藏的板块不出现在列表里, 也不能发新帖, 但数据留着 ——
 * 自制谱就是这样, 功能还没做, 先把板块占住。
 */
const SEED_BOARDS: Array<[slug: string, name: string, desc: string, sort: number, hidden: 0 | 1]> = [
    ['general', '综合讨论', '随便聊，但请遵守社区规范', 10, 0],
    ['game', '游戏交流', 'Our Notes 的游戏内容、活动与卡池讨论', 20, 0],
    ['team', '交友组队', '找人一起打活动、协力求人', 30, 0],
    ['selfmade', '自制谱', '自制谱面分享与讨论', 40, 0],
    ['feedback', '站务反馈', '站点问题反馈与功能建议', 50, 0],
];

const SEED_NOTICE_TITLE = '欢迎来到 Tomori偷摸零平台';
const SEED_NOTICE_BODY = `这里是《BanG Dream! Our Notes》的资讯与社区站点，由 Tomori 后端提供数据支持。

**各版块能做什么**

- **公告**：查看四个服务器的游戏公告，以及本站的站点公告
- **查询**：像和机器人聊天一样查询歌曲、谱面、卡片、角色、活动、卡池与玩家档案
- **榜线**：查看活动各档位分数线随时间的变化
- **社区**：登记交友名片、分享车站房号、在论坛里讨论

**账号**

浏览不需要登录；要在社区里发布、评论或点赞，注册一个账号即可。`;

/**
 * 增量迁移。建表用的是 CREATE TABLE IF NOT EXISTS, 对**已存在**的表不会补新列 ——
 * 所以后续新增的列都要在这里补一次(靠 information_schema 判断, 可重复执行)。
 */
async function migrate(): Promise<void> {
    await ensureColumn('web_forum_boards', 'is_hidden', 'is_hidden TINYINT(1) NOT NULL DEFAULT 0');
    // 全量模型的 T.G.W 等级（存档里读不到，由用户填）
    await ensureColumn('web_game_accounts', 'tgw_card_rank', 'tgw_card_rank TINYINT UNSIGNED NOT NULL DEFAULT 1');
    // 每个账号包各自的玩家公开 ID（bot 绑定与查档匹配用）
    await ensureColumn('web_game_accounts', 'player_id', 'player_id VARCHAR(15) NULL');
    await ensureIndex('web_game_accounts', 'idx_player', 'KEY idx_player (player_id, server)');
    // 自制谱的音源字段(阶段 5 加): 老库里补上, 新库由上面的 DDL 直接建出
    await ensureColumn('web_charts', 'audio_kind', "audio_kind ENUM('upstream','upload') NOT NULL DEFAULT 'upstream'");
    await ensureColumn('web_charts', 'audio_file', 'audio_file VARCHAR(80) NULL');
    await ensureColumn('web_charts', 'audio_duration_ms', 'audio_duration_ms INT UNSIGNED NULL');
    await ensureColumn('web_charts', 'audio_sample_rate', 'audio_sample_rate INT UNSIGNED NULL');
    // 自带音源建谱(阶段: 脱离官方曲目): 来源标记 + 作者填的艺术家 + 上传的封面
    await ensureColumn('web_charts', 'origin', "origin ENUM('official','standalone') NOT NULL DEFAULT 'official'");
    await ensureColumn('web_charts', 'song_artist', "song_artist VARCHAR(120) NOT NULL DEFAULT ''");
    await ensureColumn('web_charts', 'cover_file', 'cover_file VARCHAR(80) NULL');
}

async function ensureColumn(table: string, column: string, definition: string): Promise<void> {
    const rows = await query<Array<{ n: number }>>(
        `SELECT COUNT(*) AS n FROM information_schema.columns
         WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?`,
        [table, column]
    );
    if (Number(rows[0]?.n ?? 0) > 0) return;
    await execute(`ALTER TABLE \`${table}\` ADD COLUMN ${definition}`);
    logger('schema', `migrated: added ${table}.${column}`);
}

/** 补索引(与 ensureColumn 同理: CREATE TABLE IF NOT EXISTS 不会给老表加键) */
async function ensureIndex(table: string, index: string, definition: string): Promise<void> {
    const rows = await query<Array<{ n: number }>>(
        `SELECT COUNT(*) AS n FROM information_schema.statistics
         WHERE table_schema = DATABASE() AND table_name = ? AND index_name = ?`,
        [table, index]
    );
    if (Number(rows[0]?.n ?? 0) > 0) return;
    await execute(`ALTER TABLE \`${table}\` ADD ${definition}`);
    logger('schema', `migrated: added index ${index} on ${table}`);
}

async function seed(): Promise<void> {
    for (const [slug, name, description, sortOrder, hidden] of SEED_BOARDS) {
        await execute(
            'INSERT IGNORE INTO web_forum_boards (slug, name, description, sort_order, is_hidden) VALUES (?, ?, ?, ?, ?)',
            [slug, name, description, sortOrder, hidden]
        );
    }
    // 自制谱板块已经开放（改动前它靠每次启动强制置为隐藏来"占位"，
    // 现在功能做好了，把它放出来；老库里若还留着隐藏标记，这里同步一次）。
    // 之后管理员想再藏起来直接改数据库即可，不会再被启动流程覆盖。
    await execute("UPDATE web_forum_boards SET is_hidden = 0 WHERE slug = 'selfmade' AND is_hidden = 1");

    const noticeRows = await query<Array<{ n: number }>>('SELECT COUNT(*) AS n FROM web_notices');
    if ((noticeRows[0]?.n ?? 0) === 0) {
        await execute(
            `INSERT INTO web_notices (title, content, author_id, status, is_pinned, published_at)
             VALUES (?, ?, NULL, 1, 1, CURRENT_TIMESTAMP(3))`,
            [SEED_NOTICE_TITLE, SEED_NOTICE_BODY]
        );
        logger('schema', 'seeded welcome notice');
    }
}

let running: Promise<void> | undefined;

/** 幂等: 并发调用共用同一个执行中的 Promise, 失败后允许下次重试 */
export function ensureSchema(): Promise<void> {
    running ??= (async () => {
        for (const ddl of DDL) await execute(ddl);
        await migrate();
        await seed();
        logger('schema', `schema ready (${DDL.length} tables)`);
    })().catch(e => {
        running = undefined;
        throw e;
    });
    return running;
}
