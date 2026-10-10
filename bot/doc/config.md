# 配置说明

本服务读取**启动目录**（即 `bot/`，所有入口脚本都会先切到脚本所在目录）下的 `.env`；下表为全部可用变量，未设置的项使用默认值。
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
| `PLAYER_SOURCE` | string | 空 | **玩家查询优先源**（可选）：玩家查询（site 角色）先试它、失败再回落通用链。`haneoka.org` 能查任意日服玩家，而站点公开接口只收录已绑定账号——填它可省掉一次注定 404 的请求。该源必须承担 site 角色，否则启动告警且设置不生效；留空 = 完全跟随通用链顺序 |

**回退链**：`DATA_SOURCE → BACKUP_SOURCE → bdon.moe`（去重，bdon.moe 恒为最终兜底）。任一源失败（**含 404**）即切下一个；全部失败时最后一个若是 4xx 原样抛出（保留「空表 / 未被追踪」语义），否则报「上游崩溃」。磁盘缓存键按源前缀隔离（`{源名}/{原键}`；不匹配任何数据角色的 URL 保持原键）。

链按**数据角色**分发，每个源只参与自己声明的角色；某源不认识该 URL 形态时直接跳过、不发请求。尝试顺序默认按 `DATA_SOURCE → BACKUP_SOURCE → bdon.moe`，`PLAYER_SOURCE` 可单独把玩家查询（site 角色）的优先源置顶（其余角色的顺序不受影响）：

- 走链：master 表与版本清单（meta）、图片素材（asset）、公告与**活动 / 曲榜排行**（gameApi）、**玩家查询的站点公开接口**（site）、**谱面效率数据**（musicData）
- 不走链（固定 bdon 一路）：谱面站清单与谱面文件（chartSite 资源）、带鉴权的自建网关玩家查询

**数据来源标注**：凡走过链的取数，结果都带 `origin`（实际供数的源档案名），活动歌榜 / 歌曲排行 / 榜线图 / 歌曲meta / 玩家档案图 / 推荐曲图会在页脚（或错误文案）里标注「数据来源：…」；榜线采样把 `origin` 逐条落库，回退链中途换源时页脚会把多家都列出。

内置档案：

- `bdon.moe`（规范化布局，承担全部角色）：版本清单 `https://metadata.bdon.moe`、图片素材 `https://assets.bdon.moe`、游戏数据 `https://api.bdon.moe`、站点 `https://bdon.moe`、谱面效率数据 `https://storage.bdon.moe/moenotes/music-data/music-data.json`
- `bdon.yatta.moe`（Project Yume 自制数据库，**只承担 master 表与图片**）：`Resources/en/Master/{表}.json`（34/35 张表，行/键与 bdon 一致；`MasterEventPickupCard` 缺失，404 后回退）；图片按「去掉重复末段」规则换算（`…/x/x.webp → …/x.webp`，仅限已验证种类）；只有一份 `en` 数据集（四个区域都映射到它）；无 `current_version.json`，版本由站点页面标记合成（退化时用页面哈希）。公告/排行/玩家/谱面/效率数据没有对应，这些角色继续由 bdon 承担
- `haneoka.org`（BanG Dream! Our Notes 数据库，`https://haneoka.org`，**承担 gameApi / site / musicData**）：
  - **活动与曲榜排行**（`/api/v1/game/records/{tw|jp|kr|en}/…`）与 bdon rankd 是**同一份数据**（前 100 名逐条比对过），可等价替换；单活动详情没有对应端点——用 `/events/current` 校验活动 id，匹配不上就回退下一个源
  - **玩家查询**能查任意日服玩家（比站点公开接口宽：bdon 站点只收录在站内绑定并公开的账号）
  - **乐曲分析**（`/api/v1/servers/intl/song-meta`）是**降级**数据：站点直接给效率/出分/物量等结果，没有 bdon music-data.json 的种子模型（技能权重、评级门槛）。只在 bdon 效率数据不可用时顶上——歌曲meta 照常出榜并在图上注明模型差异；**活动推荐曲与网页组卡器拒绝降级数据**（缺权重/门槛算不了）
  - **剧透（超前内容）**：上游作者声明不可接入超前内容。本档案只访问**发行数据集**（catalog 固定 `intl`，game records 只用 tw/jp/kr/en），从不请求 `-cbt` / `-test` 数据集（站点关闭剧透模式时同样不展示它们）

## 账号查询网关（可选）

| 变量名 | 数据种类 | 默认值 | 用途 |
| --- | --- | --- | --- |
| `MOENOTES_API_BASE` | string（URL） | 空 | 自建 moenotes-api 网关地址；与下面一项都填写才生效 |
| `MOENOTES_API_KEY` | string | 空 | 网关密钥 |

## 网页平台对接（可选）

bot 与**私有部署的网页平台**以 HTTP API 交接，bot 不直连网页的数据库（网页代码不在本仓库发布）。配好下面两项后，
「查玩家增强（完成状态/乐队道具/各乐队理论最高队伍）、查名片、b25、组卡、玩家绑定」可用；
未对接或网页不可达时这些功能按「未对接/暂不可用」提示，查玩家仍只出上游档案图。

| 变量名 | 数据种类 | 默认值 | 用途 |
| --- | --- | --- | --- |
| `WEB_PLATFORM_BASE` | string（URL） | `http://127.0.0.1:3003` | 网页平台地址；账号包查询与绑定码兑换走它的 `/api/bot/*`（`X-Bot-Token` 鉴权）。端口按网页平台部署时实际的监听端口来 |
| `WEB_PLATFORM_TOKEN` | string | 空 | 与网页 `WEB_BOT_TOKEN` **填同一个值**的共享令牌；留空 = 账号包相关功能整体未对接 |

**隐私口径**：网页返回给 bot 的账号包数据一律遵循它自己的**公开开关**（卡片 / 道具 / 歌曲各自是否公开）——
隐藏的类别对任何人都不下发，**绑定本人也一样**。绑定的作用只有两个：免输玩家 ID（默认账号）+
用一次性绑定码证明账号归属（防冒绑）。绑定关系存在 MongoDB 的 `bindings` 集合（一个 QQ 可绑多个账号，
唯一键 `(userId, accountId)`），读写经「数据库 API」；与社区功能同一个 `ENABLE_DB` 门槛。

### 绑定流程

1. 网页「我的账号」里给某个账号包填好**玩家 ID**（游戏里的公开 ID，1~15 位数字），点「bot 绑定码」生成一次性码（15 分钟有效）；
2. 在 QQ 里发 `/playerBind/bind`（带该码）——bot 调网页 `/api/bot/bind` 兑换并存绑定；
3. `/playerBind/list` 查看全部绑定、`/playerBind/use` 切换默认、`/playerBind/unbind` 解绑（按 playerId 或序号）。

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

采样只对**进行中**的活动进行（阶段取自上游活动对象的 `eventStatus`）——已结束/集计中/结果公布的活动榜已定格，定时采样会跳过，查询也不再触发采样（见 `src/features/types/EventPhase.ts`）。每条采样同时记录**实际供数的数据源**（`origin`，回退链标出），出图页脚会把所画数据的来源列出（老数据没有该记录则标「未记录（历史数据）」）；榜线库首次打开会自动补 `origin` 列（可空，向后兼容）。

| 变量名 | 数据种类 | 默认值 | 用途 |
| --- | --- | --- | --- |
| `CUTOFF_RECORD_INTERVAL_S` | int（秒） | `3600` | 活动榜线（各档分数）采样间隔（仅进行中的活动） |
| `CUTOFF_BUCKET_S` | int（秒） | `3600` | 采样聚合桶大小，同一桶内采样互相覆盖 |
| `CUTOFF_QUERY_RECORD_MIN_INTERVAL_S` | int（秒） | `300` | 用户查询触发采样的冷却；冷却内直接复用上次采样。`0` = 关闭冷却（每次查询都采） |
| `DB_API_BASE_URL` | string（URL） | 空 | 「数据库 API」地址（`database/` 项目）；留空 = 不启用远程存储，直接用 SQLite |
| `DB_API_TOKEN` | string | 空 | 访问数据库 API 的令牌；与 `database/` 的 `.env` 里 `DB_API_TOKENS` 的 `bot=` 那段同值 |
| `DB_API_TIMEOUT_MS` | int（毫秒） | `10000` | 单次数据库 API 请求超时；超时按不可用处理（降级 SQLite 缓冲） |
| `SQLITE_PATH` | string | `./data/tomori.sqlite` | SQLite 回退/缓冲文件；数据库 API 不可用时榜线写入这里，恢复后自动回灌 |

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
| `USER_AGENT` | string | `tomori/<本包版本> (Node <运行时版本>)` | 上游请求的 User-Agent；**留空即用内置默认**（版本号从 package.json 现读，不会随发版漂移） |

## 数据库与社区

**全部 MySQL 与 MongoDB 读写都经「数据库 API」**（`database/` 项目，全系统唯一持有数据库凭据的
进程）；本进程不再有连接串、SQL 或数据库驱动。所谓 `DB_API_*`（见「榜线采样」节）同时服务两件事：

- **榜线历史**：优先经数据库 API 写入 MySQL；不可用时回退 SQLite 缓冲，恢复后自动回灌；
  首次启动会把 Mongo `cutoffs` 集合里的旧数据只读迁移过来，**Mongo 原数据保留不动**。
- **社区数据**（交友/车站/关键词/绑定）：经数据库 API 访问 MongoDB，索引由它统一创建。

API 地址或令牌未配置、或者 API 连不上时：榜线走 SQLite 兜底，社区端点按「服务器未启用数据库」
处理（与旧版直连失败时的行为一致）。

| 变量名 | 数据种类 | 默认值 | 用途 |
| --- | --- | --- | --- |
| `ENABLE_DB` | bool | `false` | 社区功能总开关；关闭时交友/关键词/车站端点返回 404 占位 |
| `MAX_KEYWORD_LENGTH` | int | `32` | 单条用户关键词字数上限 |
| `MAX_KEYWORDS_PER_ENTITY` | int | `20` | 单个实体的用户关键词条数上限 |

> 车站房号有效期（原 `STATION_TTL_S`）与 MongoDB/MySQL 连接信息都已归 `database/` 项目配置，
> 见 `database/README.md` 的「配置速查」。

## 抽卡模拟

| 变量名 | 数据种类 | 默认值 | 用途 |
| --- | --- | --- | --- |
| `GACHA_DEFAULT_RATES` | JSON | `{"2":88.5,"3":8.5,"4":3.0}` | 兜底出货率，真实卡池数据不可用时使用 |
