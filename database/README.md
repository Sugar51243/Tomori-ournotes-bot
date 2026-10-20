# Tomori 数据库 API

bot 与 web 共用的 MySQL / MongoDB 存取服务。**全系统唯一持有数据库凭据的进程** ——
bot 与 web 的代码里不再有任何 SQL、连接串或数据库驱动，只发语义化 HTTP 请求。

```
bot  ──HTTP(Bearer)──┐
                     ├──►  database/ (本服务)  ──►  MySQL(tomori / tomori_web)
web  ──HTTP(Bearer)──┘                        └──►  MongoDB(tomori)
```

## 快速开始

```bash
npm install
cp .env.example .env        # 填 DB_API_TOKENS 与 MYSQL_*/MONGODB_* 连接信息
npm run dev                 # 开发模式(tsx watch), 默认 127.0.0.1:3004
# 或 Windows 下双击 dev.bat / start.bat
```

生成访问令牌（bot 与 web 各一个，互不相同）：

```bash
node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"
```

令牌要填三处：本服务 `.env` 的 `DB_API_TOKENS="bot=<令牌1>,web=<令牌2>"`、
bot 的 `.env`（`DB_API_TOKEN=<令牌1>`）、网页平台的 `.env`（`WEB_DB_API_TOKEN=<令牌2>`）。

自检：

```bash
npm run selftest                             # 冒烟: 存活/鉴权/协议形状/参数校验
# 等价的手工检查:
curl http://127.0.0.1:3004/api/health        # 两库状态 + 运行摘要(不鉴权)
curl -X POST http://127.0.0.1:3004/v1/cutoff/ping \
     -H "Authorization: Bearer <令牌>"        # 业务端点(需要令牌)
```

`selftest` 可用 `DB_API_URL` / `DB_API_TEST_TOKEN` 指向任意实例（默认本机 3004）。

## 协议

- 全部业务端点是 **`POST /v1/<module>/<op>`**，请求体与响应体都是 JSON。
- 成功：`{ "ok": true, "data": ... }`；失败：`{ "ok": false, "error": { "code", "message" } }`，
  HTTP 状态按 code 映射（`VALIDATION`→400、`UNAUTHENTICATED`→401、`CONFLICT`→409、
  `DB_UNAVAILABLE`→503 ……）。错误码与 web/server 的 `ErrorCode` 是同一套，消费方原样重抛。
- **Date 字段**：MySQL 的 DATETIME 与 Mongo 的 Date 统一编码成 `{"$date":"<ISO>"}`，
  消费方客户端解码回 `Date` —— 直连时代的 `row.created_at.toISOString()` 这类代码不用改。
- 请求体上限 8MB（`DB_API_BODY_LIMIT_MB`；自制谱 `chart_data` 有几百 KB）。
- 刻意**没有**「任意 SQL / 任意集合」的通用入口：公网暴露时，每个 op 的语义边界就是安全边界。

## 鉴权

`Authorization: Bearer <令牌>`；令牌表由 `DB_API_TOKENS` 配置（`名字=令牌` 逗号分隔，名字只用于
日志与限流分桶）。比对是 sha256 + `timingSafeEqual` 的常量时间实现。

**威胁模型**：任何持有令牌的消费方都能触达全部端点。令牌泄露 ≈ 数据库全量泄露，所以令牌必须
与数据库凭据同级保管 —— 只放在本服务与各消费方自己的 `.env` 里，绝不进代码仓库。

## 模块与端点

| 模块 | 用途 | 消费方 | 代表性 op |
|---|---|---|---|
| `/v1/cutoff` | 榜线采样读写与聚合 | bot(写) + web(读) | `upsert` `load` `scan` `metaGet/metaSet` `listEvents` `series` `legacyScan` |
| `/v1/users` | 平台账号 | web | `findById` `createUser` `updatePassword` `setStatus` `listUsers` … |
| `/v1/forum` | 论坛(板块/帖子/评论/点赞) | web | `listPosts` `createPost` `createComment`①`toggleLike`① `searchPosts` … |
| `/v1/charts` | 自制谱 | web | `create` `update` `publishWithPost`① `listPublished` … |
| `/v1/chat` | 沙盒聊天室 | web | `ensurePrivateRoom` `insertMessage` `listMessages` … |
| `/v1/notices` | 网页公告 | web | `listNotices` `createNotice` `updateNotice` … |
| `/v1/audit` | 管理审计 | web | `writeAudit` `listAudit` |
| `/v1/songCache` | 曲名缓存 | web | `getCachedTitle` `putCachedTitles` |
| `/v1/bindCodes` | bot 绑定码(网页签发/QQ 兑换) | web | `issueCode` `consumeCode`② |
| `/v1/accounts` | 游戏账号包 | web + bot | `upsert` `findByPlayerId` `getDetailCategory` … |
| `/v1/keywords` | 用户关键词(Mongo) | bot | `listAll` `add` `remove` |
| `/v1/friends` | 交友名片(Mongo) | bot + web | `list` `get` `upsert` `search` `remove` |
| `/v1/stations` | 车站房号(Mongo, TTL) | bot + web | `listActive` `search` `submit` `deleteOwned` |
| `/v1/bindings` | QQ ↔ 游戏账号绑定(Mongo) | bot | `add` `list` `getDefault` `remove` `setDefault` |
| `/v1/misc` | 杂项只读配置 | web | `stationTtlSeconds` |

① 整段事务在服务端执行（点赞计数、发评论连带计数、发谱建帖），失败整体回滚。
② 兑换用单条原子 UPDATE 标记已用，并发兑换只有一个能成功。

完整的 op 参数与返回形状见 `src/routes/*.ts`（每个模块一张 op 表，一处看全）。

## 启动时自动完成的事

- **MySQL**：库不存在自动 `CREATE DATABASE IF NOT EXISTS`（只建库不建用户）；建 web 平台
  13 张表 + bot 库 2 张榜线表；增量迁移（补列/补索引）与种子（默认板块、欢迎公告）。
  失败不阻塞启动，每 30s 重试 —— 允许"先起本服务后起 MySQL"。
- **MongoDB**：连接并创建全部索引（keywords / friends / stations / bindings / cutoffs，
  索引名与 key 规格是历史契约，与旧部署逐字一致）。
- 遗留兼容：老部署里 bot 库的 `cutoff_meta` 是另一种结构（server/event_id/storage/updated_at），
  与现在的 (k,v) 不同名同构，启动时会自动改名为 `cutoff_meta_legacy_v1`（数据保留）后重建。

## 公网部署（必读）

本服务**允许**暴露到公网，但必须满足下面条件，否则令牌与数据会以明文传输：

1. **TLS**，二选一：
   - 反代终止（推荐）：nginx / Caddy 指向 `127.0.0.1:3004`，反代层数配 `DB_API_TRUST_PROXY=1`；
   - 自带 https 监听：`DB_API_HTTPS_PORT=443` + `DB_API_SSL_CERT`/`DB_API_SSL_KEY`（证书路径相对本目录）。
     推荐组合：`DB_API_LOCATION=127.0.0.1`（明文口只给本机）+ `DB_API_HTTPS_LOCATION=0.0.0.0`（加密口对外）。
2. **端口与地址白名单**：防火墙只放行 TLS 端口给消费方所在机器；服务内还可配
   `DB_API_IP_ALLOWLIST`（精确 IP 或 IPv4 CIDR，如 `203.0.113.0/24`，逗号分隔）。
3. **强随机令牌**（见上文生成命令），并定期轮换；`DB_API_RATE_LIMIT_PER_MIN` 兜住失控循环。
4. 自签证书场景：消费方需设 `NODE_EXTRA_CA_CERTS=<CA 证书路径>` 才能校验通过；
   有域名时优先用正式证书（Let's Encrypt 等）。

## 配置速查

| 变量 | 默认 | 说明 |
|---|---|---|
| `DB_API_PORT` / `DB_API_LOCATION` | 3004 / 127.0.0.1 | 明文监听 |
| `DB_API_TOKENS` | (空=拒绝一切请求) | `bot=<令牌>,web=<令牌>` |
| `DB_API_IP_ALLOWLIST` | (空=不限制) | 精确 IP 或 IPv4 CIDR |
| `DB_API_HTTPS_PORT` / `_LOCATION` / `_SSL_CERT` / `_SSL_KEY` | 0 / 跟随 LOCATION | 可选的自带 https |
| `MYSQL_HOST/PORT/USER/PASSWORD` | 127.0.0.1:3306 root | 唯一持有凭据的地方 |
| `MYSQL_DATABASE` / `MYSQL_BOT_DATABASE` | tomori_web / tomori | web 平台库 / bot 榜线库 |
| `MONGODB_URI` / `MONGODB_DB` | mongodb://127.0.0.1:27017 / tomori | 社区集合 |
| `STATION_TTL_S` | 150 | 车站房号有效期（原先两边各配一份且必须一致，现在只此一处） |
| `DB_API_BODY_LIMIT_MB` | 8 | 请求体上限 |

## 故障排查

| 现象 | 排查 |
|---|---|
| 消费方报 `DB_UNAVAILABLE` | 看 `/api/health` 的 `services.mysql/mongo`；确认数据库进程与连接串 |
| 消费方报 401 | 令牌是否与 `DB_API_TOKENS` 对应项逐字符一致（含首尾空格） |
| 消费方报 403 | 来源 IP 不在 `DB_API_IP_ALLOWLIST`；反代场景确认 `DB_API_TRUST_PROXY` |
| 时间戳整体偏移一个时区 | 不应发生（每条连接的会话时区钉在 UTC）；若出现检查 MySQL 服务器时区配置 |
| 车站房号两侧存活时间不一致 | 不应发生（TTL 已归本服务）；检查是否有旧版进程仍在跑 |
