# 配置说明

本服务读取项目根目录的 `.env`；下表为全部可用变量，未设置的项使用默认值。
**缓存 TTL 不是环境变量**：它们是 `src/config/ttl.ts` 中的纯代码常量，改后需重新构建（见「缓存有效期」节）。

## 服务基础

| 变量名 | 数据种类 | 默认值 | 用途 |
| --- | --- | --- | --- |
| `PORT` | int | `3000` | HTTP 监听端口 |
| `LOCATION` | string | `127.0.0.1` | HTTP 监听地址。默认仅本机可访问；设 `0.0.0.0` 对外公开（本服务无鉴权，暴露前请自行加防护） |
| `LOG_LEVEL` | string（debug/info/warn/error） | `info` | 日志最低等级 |

## 默认服务器回退链

| 变量名 | 数据种类 | 默认值 | 用途 |
| --- | --- | --- | --- |
| `DEFAULT_SERVER_CHAIN` | string（逗号分隔） | `tw,jp,kr,en` | 缺省选服与回退顺序：**首项即默认服务器**；回退到下一个服时语言一并回退（语言由各服档案决定：tw→简中、jp→日文、kr→韩文、en→英文）；别名（如 `hk-tw-mo`）可用。未列出的服务器会自动补在链尾（自定义链只改顺序、不缩集合） |

## 上游数据源

| 变量名 | 数据种类 | 默认值 | 用途 |
| --- | --- | --- | --- |
| `DATA_SOURCE` | string | `bdon.moe` | 主源档案名（最先尝试）；具体取数方式写死在 `src/config/sources.ts`。未知值告警并跳过 |
| `BACKUP_SOURCE` | string | 空 | 备用源档案名（可选）；留空 = 无备用 |

**回退链**：`DATA_SOURCE → BACKUP_SOURCE → bdon.moe`（去重，bdon.moe 恒为最终兜底）。任一源失败（**含 404**）即切下一个；全部失败时最后一个若是 4xx 原样抛出（保留「空表 / 未被追踪」语义），否则报「上游崩溃」。磁盘缓存键按源前缀隔离（`{源名}/{原键}`；不匹配任何数据角色的 URL 保持原键；rankd/玩家/效率数据/谱面等只有 bdon 一路的请求不经过链、键不加前缀）。

内置档案：

- `bdon.moe`（规范化布局，承担全部角色）：版本清单 `https://metadata.bdon.moe`、图片素材 `https://assets.bdon.moe`、游戏数据 `https://api.bdon.moe`、站点 `https://bdon.moe`、谱面效率数据 `https://storage.bdon.moe/moenotes/music-data/music-data.json`
- `bdon.yatta.moe`（Project Yume 自制数据库，**只承担 master 表与图片**）：`Resources/en/Master/{表}.json`（34/35 张表，行/键与 bdon 一致；`MasterEventPickupCard` 缺失，404 后回退）；图片按「去掉重复末段」规则换算（`…/x/x.webp → …/x.webp`，仅限已验证种类）；只有一份 `en` 数据集（四个区域都映射到它）；无 `current_version.json`，版本由站点页面标记合成（退化时用页面哈希）。公告/排行/玩家/谱面/效率数据没有对应，这些角色继续由 bdon 承担

## 账号查询网关（可选）

| 变量名 | 数据种类 | 默认值 | 用途 |
| --- | --- | --- | --- |
| `MOENOTES_API_BASE` | string（URL） | 空 | 自建 moenotes-api 网关地址；与下面一项都填写才生效 |
| `MOENOTES_API_KEY` | string | 空 | 网关密钥 |

## 缓存有效期（代码常量）

以下 TTL 为 `src/config/ttl.ts` 中的纯代码常量，**不再通过 `.env` 配置、不可用环境变量覆盖**；调整时改该文件并重新构建。单位均为秒。

| 常量名 | 默认值 | 用途 |
| --- | --- | --- |
| `masterdataTtlS` | `3600` | 各服 master 表缓存 |
| `versionTtlS` | `600` | 版本清单缓存 |
| `chartManifestTtlS` | `604800` | 谱面清单缓存 |
| `chartAssetTtlS` | `2592000` | 谱面资源缓存（内容寻址，sha 不变即内容不变） |
| `imageTtlS` | `604800` | 游戏图片缓存 |
| `announcementTtlS` | `300` | 公告列表与详情缓存 |
| `rankingTtlS` | `300` | 歌曲排行与活动排行缓存 |
| `musicDataTtlS` | `86400` | 谱面效率数据缓存 |
| `playerTtlS` | `300` | 玩家档案缓存（仅进程内） |
| `keywordCacheTtlS` | `60` | 关键词内存快照有效期（上传/删除即时刷新） |

## 公告推送（SSE）

| 变量名 | 数据种类 | 默认值 | 用途 |
| --- | --- | --- | --- |
| `ANNOUNCEMENT_POLL_S` | int（秒） | `300` | 公告轮询间隔，即推送延迟上限 |
| `SSE_HEARTBEAT_S` | int（秒） | `25` | SSE 心跳间隔 |

## 榜线采样

| 变量名 | 数据种类 | 默认值 | 用途 |
| --- | --- | --- | --- |
| `CUTOFF_RECORD_INTERVAL_S` | int（秒） | `3600` | 活动榜线（各档分数）采样间隔 |
| `CUTOFF_BUCKET_S` | int（秒） | `3600` | 采样聚合桶大小，同一桶内采样互相覆盖 |
| `CUTOFF_QUERY_RECORD_MIN_INTERVAL_S` | int（秒） | `300` | 用户查询触发采样的冷却；冷却内直接复用上次采样。`0` = 关闭冷却（每次查询都采） |
| `MYSQL_HOST` | string | 空 | 榜线历史的 MySQL 主机；留空则不启用 MySQL，直接用 SQLite |
| `MYSQL_PORT` | int | `3306` | MySQL 端口 |
| `MYSQL_USER` | string | 空 | MySQL 用户 |
| `MYSQL_PASSWORD` | string | 空 | MySQL 密码 |
| `MYSQL_DATABASE` | string | `tomori` | MySQL 库名；库不存在时自动 `CREATE DATABASE IF NOT EXISTS`（**只建库，不建用户**），无权限则回退 SQLite |
| `SQLITE_PATH` | string | `./data/tomori.sqlite` | SQLite 回退/缓冲文件；MySQL 不可用时榜线写入这里，恢复后自动回灌 |

## 渲染与分页

| 变量名 | 数据种类 | 默认值 | 用途 |
| --- | --- | --- | --- |
| `CACHE_DIR` | string | `./cache` | 上游数据的磁盘缓存目录，可整目录删除 |
| `STAMPS_PER_PAGE` | int | `30` | 贴纸列表每张图放多少张 |
| `FRIENDS_PER_PAGE` | int | `30` | 交友列表每张图放多少人 |
| `NOTE_SPEED_DEFAULT` | float | `7.5` | 谱面预览默认流速（范围固定 1.00~12.00） |
| `RENDER_CACHE_MB` | int（MB） | `128` | 渲染结果缓存上限（该缓存中间件当前停用） |
| `IMAGE_CACHE_MB` | int（MB） | `64` | 已解码图片的缓存上限 |

## 上游请求控制

| 变量名 | 数据种类 | 默认值 | 用途 |
| --- | --- | --- | --- |
| `MAX_CONCURRENCY_PER_HOST` | int | `4` | 单个上游主机的并发请求上限 |
| `HTTP_MIN_INTERVAL_MS` | int（毫秒） | `100` | 同一主机的请求最小间隔 |
| `HTTP_RETRIES` | int | `3` | 网络错误/5xx 的重试次数（4xx 不重试） |
| `HTTP_RETRY_BASE_MS` | int（毫秒） | `1000` | 重试退避基数：第 n 次重试等待 基数×3^(n-1) |
| `HTTP_TIMEOUT_MS` | int（毫秒） | `20000` | 单次上游请求超时 |
| `USER_AGENT` | string | `tomori/0.1 (Node <运行时版本>)` | 上游请求的 User-Agent，留空使用内置默认 |

## 数据库与社区

榜线历史**不再**存 MongoDB：优先 MySQL（见「榜线采样」节的 `MYSQL_*`），连接失败回退 SQLite，
MySQL 恢复后自动把降级期数据回灌；首次启动会把 Mongo `cutoffs` 集合里的旧数据只读迁移过来，
**Mongo 原数据保留不动**。下面的 MongoDB 配置仅服务于社区功能（交友/车站/关键词）。

| 变量名 | 数据种类 | 默认值 | 用途 |
| --- | --- | --- | --- |
| `ENABLE_DB` | bool | `false` | 社区功能总开关；关闭时交友/关键词/车站端点返回 404 占位 |
| `MONGODB_URI` | string | 空 | 社区功能的 MongoDB 连接串（榜线迁移也会读取其中的 `cutoffs` 集合） |
| `MONGODB_DB` | string | `tomori` | 数据库名 |
| `DB_CONNECT_TIMEOUT_MS` | int（毫秒） | `3000` | 数据库连接超时 |
| `STATION_TTL_S` | int（秒） | `150` | 车站房号有效期 |
| `MAX_KEYWORD_LENGTH` | int | `32` | 单条用户关键词字数上限 |
| `MAX_KEYWORDS_PER_ENTITY` | int | `20` | 单个实体的用户关键词条数上限 |

## 抽卡模拟

| 变量名 | 数据种类 | 默认值 | 用途 |
| --- | --- | --- | --- |
| `GACHA_DEFAULT_RATES` | JSON | `{"2":88.5,"3":8.5,"4":3.0}` | 兜底出货率，真实卡池数据不可用时使用 |
