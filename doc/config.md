# 配置说明

本服务读取项目根目录的 `.env`；下表为全部可用变量，未设置的项使用默认值。

## 服务基础

| 变量名 | 数据种类 | 默认值 | 用途 |
| --- | --- | --- | --- |
| `PORT` | int | `3000` | HTTP 监听端口 |
| `CACHE_DIR` | string | `./cache` | 上游数据的磁盘缓存目录，可整目录删除 |
| `DEFAULT_SERVER` | string（tw/jp/kr/en） | `tw` | 请求未指定服务器时的缺省区域 |
| `DEFAULT_LOCALE` | string | `zh-Hans` | 文本默认语言 |
| `LOCALE_FALLBACKS` | string（逗号分隔） | `zh-Hans,zh-CN,ja,en` | 全局语言回退链，接在 `DEFAULT_LOCALE` 之后 |
| `LOG_LEVEL` | string（debug/info/warn/error） | `info` | 日志最低等级 |

## 上游数据源

| 变量名 | 数据种类 | 默认值 | 用途 |
| --- | --- | --- | --- |
| `META_BASE` | string（URL） | `https://metadata.bdon.moe` | 版本清单与各服 master 表 |
| `ASSET_BASE` | string（URL） | `https://assets.bdon.moe` | 图片素材与谱面资源 |
| `GAME_API_BASE` | string（URL） | `https://api.bdon.moe` | 公告、活动与排行数据（rankd，公开只读） |
| `MOENOTES_SITE_BASE` | string（URL） | `https://bdon.moe` | 玩家公开档案与国旗图标 |
| `MUSIC_DATA_URL` | string（URL） | `https://storage.bdon.moe/moenotes/music-data/music-data.json` | 谱面效率数据（`/songMeta`、`/eventRecommend`） |
| `MUSIC_DATA_TTL_S` | int（秒） | `86400` | 谱面效率数据缓存 |

## 账号查询网关（可选）

| 变量名 | 数据种类 | 默认值 | 用途 |
| --- | --- | --- | --- |
| `MOENOTES_API_BASE` | string（URL） | 空 | 自建 moenotes-api 网关地址；与下面一项都填写才生效 |
| `MOENOTES_API_KEY` | string | 空 | 网关密钥 |

## 缓存有效期（秒）

| 变量名 | 数据种类 | 默认值 | 用途 |
| --- | --- | --- | --- |
| `MASTERDATA_TTL_S` | int | `3600` | 各服 master 表缓存 |
| `VERSION_TTL_S` | int | `600` | 版本清单缓存 |
| `CHART_MANIFEST_TTL_S` | int | `604800` | 谱面清单缓存 |
| `CHART_ASSET_TTL_S` | int | `2592000` | 谱面资源缓存 |
| `IMAGE_TTL_S` | int | `604800` | 图片缓存 |
| `ANNOUNCEMENT_TTL_S` | int | `300` | 公告列表与详情缓存 |
| `RANKING_TTL_S` | int | `300` | 歌曲排行与活动排行缓存 |
| `PLAYER_TTL_S` | int | `300` | 玩家档案缓存 |
| `KEYWORD_CACHE_TTL_S` | int | `60` | 关键词内存快照有效期（上传/删除即时刷新） |

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

## 渲染与分页

| 变量名 | 数据种类 | 默认值 | 用途 |
| --- | --- | --- | --- |
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

| 变量名 | 数据种类 | 默认值 | 用途 |
| --- | --- | --- | --- |
| `ENABLE_DB` | bool | `false` | 社区功能总开关；关闭时交友/关键词/车站端点返回 404 占位 |
| `MONGODB_URI` | string | 空 | MongoDB 连接串 |
| `MONGODB_DB` | string | `tomori` | 数据库名 |
| `DB_CONNECT_TIMEOUT_MS` | int（毫秒） | `3000` | 数据库连接超时 |
| `STATION_TTL_S` | int（秒） | `150` | 车站房号有效期 |
| `MAX_KEYWORD_LENGTH` | int | `32` | 单条用户关键词字数上限 |
| `MAX_KEYWORDS_PER_ENTITY` | int | `20` | 单个实体的用户关键词条数上限 |

## 抽卡模拟

| 变量名 | 数据种类 | 默认值 | 用途 |
| --- | --- | --- | --- |
| `GACHA_DEFAULT_RATES` | JSON | `{"2":88.5,"3":8.5,"4":3.0}` | 兜底出货率，真实卡池数据不可用时使用 |
