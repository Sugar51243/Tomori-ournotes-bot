# Tomori — Our Notes 后端 API

《BanG Dream! Our Notes》的后端 API 服务（项目代号 **Tomori**）：实时代理 bdon 数据源，出图或出 JSON，响应协议与 [tsugu 后端](https://github.com/Yamamoto-2/tsugu-bangdream-bot) 兼容。

---

## 1. vibe coding 声明

本项目是 **vibe coding** 产物：代码由 AI 按对话迭代生成，**未经人工逐行审查**，验证以"接口跑通 + 出图目检"为主。

- 不保证正确性、安全性、稳定性与长期维护；请自行评估后使用
- 上游数据与接口随时可能变动，本项目不承诺跟进
- 欢迎 fork / 修改 / 提 issue，但不保证响应

## 2. 前身：Tsugu 后端

本服务是 tsugu 后端的 **Our Notes 版重写**，不是其官方分支，与 tsugu 作者无隶属关系。

**沿用的部分**：部分框架、端点命名、请求字段及响应协议。

**由于OurNotes从底层开始已经与老BangDream手游有所区别，如谱面渲染、活动榜线等功能在具体实现与端点使用意义上已经无可避免的与Tsugu有所区分。具体请按本文件的端点表进行查询。**

**与 tsugu 的差异**（照 tsugu 实际实现对齐，而非其文档）：

| 方面 | tsugu | 本服务 |
| --- | --- | --- |
| 谱面 | Bestdori GBP 格式（7 轨 / beat 计时） | Our Notes `nnnotes.live-score/1`（24 轨 / 绝对 `timeMs` / 滑条线 / fever） |
| 车站存储 | 通过明确的BandoriStation车站实服务转接实现 | 通过本地MongoDB实现，TTL 索引自动清理 |
| 车站查询 | `GET /station/queryAllRoom` 出 JSON，出图要客户端再把列表 POST 给 `/roomList` | 两者都支持：`/roomList` 不传入参时直接查库出图，也接受 tsugu 式 `roomList` 入参 |
| 交友 | 无此功能 | 新增 `/friend/upload` `/friend/delete` `/friend/list` |
| 关键词 | 无此功能 | 新增 `/keyword/upload` `/keyword/delete`，可给角色/角色卡/支援卡/歌曲挂检索别名 |

## 3. 数据来源

项目数据皆源于`bdon.moe`及其子域/副网点

- 数据**实时代理**，本仓库**不打包任何官方素材**；素材版权归 Bushiroad / 官方所有
- 对上游**礼貌限流**：每主机并发 4、间隔 100ms
- 缓存 TTL：master 表 1h、谱面清单 7d、谱面资源 30d、图片 7d

## 4. 部署步骤与依赖声明

### 依赖声明

- **运行时**：Node.js **>= 20**（见 `package.json.engines`）
- **npm 依赖**：`express` / `express-validator`（HTTP 与参数校验）、`axios`（上游请求）、`dotenv`（配置）、`@napi-rs/canvas`（**原生模块**，出图）、`mongodb`（仅社区功能）
- **开发依赖**：`typescript` / `tsx` / `@types/node` / `@types/express`
- **系统字体**（出图必需）：中文走 `Microsoft YaHei`，符号与 emoji 回退 `Segoe UI Symbol` / `Segoe UI Emoji`。**Linux 部署需自备中文字体**，否则出图中文异常
- **MongoDB**：可选，仅交友/车站需要（见第 6 节）
- **网络**：需能访问 `metadata.bdon.moe`、`assets.bdon.moe`、`api.bdon.moe`（公告/排行）、`storage.bdon.moe`（歌曲meta 的谱面效率数据 music-data.json）与 `bdon.moe`（账号查询与国旗图标）

### 部署步骤

Windows 一键（自动检查 Node、安装依赖、生成 `.env`、构建并启动）：

| 脚本 | 用途 |
| --- | --- |
| `start.bat` | 生产模式：构建后以 `node dist/app.js` 启动（日常使用） |
| `dev.bat` | 开发模式：`tsx watch`，改源码自动重启（调试用） |

手动部署（任意平台）：

```bash
npm install
cp .env.example .env    # 按需修改
npm run build && npm start
# 开发模式: npm run dev
```

启动后默认监听 `http://127.0.0.1:3000`，用 `GET /health` 检查（返回 master dataVersion 与运行时长）。缓存目录默认 `./cache`（已 gitignore）。

### 环境变量
**基础参数**
| 变量名 | 参数 | 用途 |
| --- | --- | --- |
| `PORT` | INT | 监听端口 |
| `CACHE_DIR` | STR | 缓存文件夹 |
| `DEFAULT_SERVER` | tw/jp/kr/en | 缺参时的默认服务器参数 |
| `DEFAULT_LOCALE` | STR | 文本默认语言 |
| `LOCALE_FALLBACKS` | STR | 文本默认语言(全局回退链) |
| `LOG_LEVEL` | STR | 日志输出等级 |

**数据来源**
| 变量名 | 参数 | 用途 |
| --- | --- | --- |
| `META_BASE` | STR | 数据来源 |
| `ASSET_BASE` | STR | 数据来源 |
| `GAME_API_BASE` | STR | 数据来源 |
| `MOENOTES_SITE_BASE` | STR | 数据来源 |
| `MUSIC_DATA_URL` | STR | 谱面效率数据来源 |

**TTL**
| 变量名 | 参数 | 用途 |
| --- | --- | --- |
| `MASTERDATA_TTL_S` | INT | 各项 TTL |
| `VERSION_TTL_S` | INT | 各项 TTL |
| `CHART_MANIFEST_TTL_S` | INT | 各项 TTL |
| `CHART_ASSET_TTL_S` | INT | 各项 TTL |
| `IMAGE_TTL_S` | INT | 各项 TTL |
| `ANNOUNCEMENT_TTL_S` | INT | 各项 TTL |
| `RANKING_TTL_S` | INT | 各项 TTL |
| `PLAYER_TTL_S` | INT | 各项 TTL |
| `ANNOUNCEMENT_POLL_S` | INT | 各项 TTL |
| `SSE_HEARTBEAT_S` | INT | 各项 TTL |
| `MUSIC_DATA_TTL_S` | INT | 各项 TTL |
| `KEYWORD_CACHE_TTL_S` | INT | 用户关键词内存快照存活时间 |
| `HTTP_TIMEOUT_MS` | INT | 上游限流与超时 |

**渲染/缓存**
| 变量名 | 参数 | 用途 |
| --- | --- | --- |
| `STAMPS_PER_PAGE` | INT | 贴纸列表分页: 每张图放多少张 |
| `RENDER_CACHE_MB` | INT | 渲染结果缓存上限 |
| `IMAGE_CACHE_MB` | INT | 已解码图片缓存上限 |
| `MAX_CONCURRENCY_PER_HOST` | INT | |

**模拟抽卡概率**
| 变量名 | 参数 | 用途 |
| --- | --- | --- |
| `GACHA_DEFAULT_RATES` | OBJ | 模拟抽卡（概率兜底） |

**账号查询相关网关(自建)**
| 变量名 | 参数 | 用途 |
| --- | --- | --- |
| `MOENOTES_API_BASE` | STR | 账号查询相关自建网关(可选) |
| `MOENOTES_API_KEY` | STR | 账号查询相关自建网关(可选) |

> **本服务没有任何访问鉴权**，不要直接暴露到公网；仅建议本机或内网自用。

## 5. 接口规则

除 `GET /health` 外**全部为 POST**，请求体为 JSON。响应统一三种：

| 情况 | HTTP | 响应体 |
| --- | --- | --- |
| 成功（图片类） | 200 | `[{type:'string'\|'base64', string}]`（`listToBase64`，与 tsugu 一致） |
| 成功（JSON 类，如 `/songChartData`、`/station/queryAllRoom`） | 200 | `{status:'success', data:…}` |
| 领域错误（无数据、参数合法但查不到等） | 200 | `['错误: …']` 字符串数组 / `{status:'failed', data:'错误: …'}` |
| 参数校验失败 | 400 | `{status:'failed', data:'参数错误', error:[…字段级原因]}` |
| 内部错误 | 500 | `{status:'failed', data:'内部错误'}` |

- **服务器字段 — 按数据性质分成两类**：

  | | 静态游戏数据 | 动态用户数据 |
  | --- | --- | --- |
  | 端点 | `/searchSong` `/searchCard` `/searchCharacter` `/searchBand` `/searchGacha` `/searchEvent` `/songMeta` `/songChart` `/songChartData` `/songRandom` `/gachaSimulate` `/fuzzySearch` `/getCardIllustration` `/getStampImage` | `/songRanking` `/eventSongRanking`(`/eventRanking`) `/cutoffAll` `/eventRecommend` `/searchPlayer` `/announcements` `/announcementStream/*` |
  | 字段 | `displayedServerList`（数组，**按序决定图中出现哪几个服**），`mainServer` 作兜底；不传则默认全部四服 | 单值 `server`（**兼容 tsugu 的 `mainServer`**），一次只查一个服 |
  | 出图 | **一图多服**：每个实体一个区块，区块内**每服一行**，行首是服国旗 | **单服一图** |
  | 理由 | 同一个实体（歌曲/卡/角色）在各服的差异可以并排比较 | 用户成绩、玩家档案、公告在各服是彼此独立的数据，没有可对比的共同实体 |

  **各服信息取数优先级：该服自己有就用自己的，没有才回退港澳台服。** 例如查一首歌时先看各服是否有这条数据 —— 韩服有就用韩服自己的数值显示那一行，没有才借港澳台的数据顶上；港澳台自己也没有（例如日服独有曲）时才显示「未收录」。这条规则对四个区域一视同仁。

  **出图语言以所选服务器为准**：港澳台 → 简体中文、日服 → 日文、韩服 → 韩文、国际服 → 英文。文本回退链把该区域自己的默认语言排在最前，缺失时才依次退到区域次级语言、`DEFAULT_LOCALE`、`ja`/`en`。只有**港澳台**优先出**简体中文**（其上游 `traditionalChinese` 列仍作为次级回退）。素材语言同理（jp 只有 `ja` 目录，请求其他语言时回退到 `ja`）。

  区域可写 `tw` / `jp` / `kr` / `en`，或别名 `hk-tw-mo`（等同 `tw`）；其余值一律 400。
  **例外**：交友的 `server` 沿用同一套取值（仅登记用）；`/friend/*`、`/station`、`/roomList` 与 tsugu 的 404 占位端点不受区域影响
- **字段类型**：各字段必须按声明类型传，数组/对象冒充标量一律 400。`playerId` 是唯一的宽松项：`/friend/*` 只收纯数字字符串，`/searchPlayer` 数字与纯数字字符串都收（tsugu 传 number），内部统一转十进制字符串
- **`compress`**：可选布尔，`true` 出 JPEG（默认），`false` 出 PNG

### 端点表

| 端点 | 请求体 | 说明 |
| --- | --- | --- |
| `GET /health` | — | 服务状态、`defaultServer`、四区域各自的 dataVersion（一次请求取回全部区域）、`playerGateway` 是否已配置、运行时长 |
| `/searchSong` | `displayedServerList`, `text` \| `fuzzySearchResult`, `compress?`, `singleDraw?`(`detail`/`chart`), `difficultyId?`, `mirror?`, `noteSpeed?`/`speed?` | 整数 ID → 歌曲详情图；否则模糊搜索 → 列表图（**命中单首时按 `singleDraw` 出图**：默认 `detail` 出歌曲详情；`chart` 直接出该曲谱面图、难度/镜像/流速随参透传——供"查谱面"类调用方避免唯一命中时误出歌曲详情；多结果始终列表图） |
| `/songMeta` | `displayedServerList`, `mainServer`, `compress?` | **歌曲meta · 效率排行**（算法与站点「歌曲meta」一致，数据同源）：一张图两榜 —— **击奏live 与 自由live 各自效率最高的前 15 张谱面**，难度**四难度混排**（EZ/NM/HD/EX 一起参与排行）。每行：封面 + ID + 曲名 + 乐团 ｜ 综合力/分钟 ｜ 等级 ｜ 难度 ｜ 时长（**BGM 时长**）｜ BPM ｜ Notes ｜ 出分（= 分/综合力）。效率 = 期望分/综合力 ÷ (BGM 时长 + 30 秒结算耗时)，技能按五槽位各 +100% 计（站点把百分比 ÷100 后入模型，W 本身就是「一个 +100% 技能多得的分数 ÷ 综合力」）；每行另按站点口径算出**相对**（该行效率 ÷ 榜首）与**支配/前沿**（技能 0~150% 下两轴都不差于它的谱面数），**只算不画**；击奏榜跳过「激走无法游玩」的谱面（第 4 个 Fever 游戏会出错），自由榜不受影响。数值与服务器无关（同一份谱面模拟数据），所选服只决定曲名/乐团的显示语言与封面取图区域（曲目本体优先港澳台，无则日服） |
| `/songChart` | `songId`, `difficultyId?`(0-3，默认 3), `mirror?`, `noteSpeed?`(1.00~12.00，默认 7.50；`speed` 同义), `compress?` | **Our Notes 风格谱面预览图**（24 轨 / chord / 滑条 / fever / 金色 critical 音符，信息条置顶） |
| `/songChartData` | `displayedServerList?`, `songId`, `difficultyId?`, `mirror?`, `format?`(`raw`/`simple`/`both`，默认 `simple`) | **谱面数据 JSON**（非 base64）：`meta` + 原始 nnnotes / 简化格式。谱面站点全区共享，区域只影响标题/难度的取数来源 |
| `/searchCard` | `displayedServerList`, `text` \| `fuzzySearchResult`, `cardType?`(`member`/`support`/`auto`，默认 `auto`), `useEasyBG?`(tsugu 兼容，忽略), `compress?` | **查卡（整合）**：角色卡与支援卡一起查，列表按种类分区；按 ID 查时 `auto` 先角色卡后支援卡 |
| `/searchMemberCard` | 同上（`cardType` 无效） | **查角色卡**（成员卡） |
| `/searchSupportCard` | 同上（`cardType` 无效） | **查支援卡**（留影） |
| `/searchCharacter` | `displayedServerList`, `text` \| `fuzzySearchResult`, `compress?` | 角色搜索 / 详情 |
| `/searchBand` | `displayedServerList`, `text` \| `fuzzySearchResult`, `compress?` | **查乐团（静态数据，多服一图）**：数字 id 或模糊搜索（**支持自定义关键词**，`entityType: band`）。详情图内容：乐团 **ID**、**图标**（等比缩放不拉伸）、**名称**、**应援色**（主/副色 + 色带）、**简介**、**成员**（角色头像 + ID + 名称），下方附各服信息表；命中多个乐团时出**列表图**（小图标 + ID + 名称 + 成员数 + 应援色）。曲目/角色以外的多服对比规则与其它静态接口一致 |
| `/searchGacha` | `displayedServerList`, `gachaId`, `compress?` | 卡池详情 |
| `/searchEvent` | `displayedServerList`, `text` \| `fuzzySearchResult`, `compress?` | **活动查询**。渲染模式**按「该服自己有没有这个活动」决定，不做任何服务器硬编码**：<br>① 只请求一个服且**该服自己有**该活动 → **丰富详情图**（定宽 1000，自上而下分块，块间用整条底色标题带 + 分隔线区分）：<br>· **顶图**：活动底图 + 活动图标叠放（与网页同款）<br>· **基础信息**：左＝活动名称、种类、开放/结束时间、总时长、状态（未开始→距开始，进行中→距结束，已结束→已结束多久）、展示结束时间；右＝活动道具（图标 + 名称 + ID）<br>· **加成对象**：成员卡 ── 分界线 ── 支援卡，各带 ID、缩图与按觉醒等级的加成区间；条件加成用小表格（条件/适用/加成）<br>· **相关曲目**：**活动新曲在前**（曲目 ID 右方跟一个「活动新曲」角标：黑框红底白字），后接该活动的挑战曲（多为复用的老歌），每项 = 封面 + 曲目 ID + 曲名；挑战演出类活动在标题右侧标出 `(挑战live)`<br>· **点数奖励**：每格 = pt + 奖励图标 + 数量，**每行 4 格**；只列含星钻 / 幸运水晶 / 奇迹水晶 / 棱晶 / 角色卡 / 支援卡的档位（全量 78 档大半是金币与经验，全画会非常长）<br>· **总奖励**：**全部**奖励的合计（含上面被筛掉的金币、经验、技能券、活动徽章等），图标 + 数量按实际宽度流式排列，放不下换行<br>· **演出报酬 / 挑战演出报酬**：分开两张表，每行 = 得分评级 + 分数门槛 + 活动点数 + 道具<br><br>· 说明：活动卡牌**暂未**画进这张图（版式按最新要求重排后未列入，且图已经偏长）；模型里有解析，需要时可直接加回；<br><br>② **按名称搜索命中多个活动 → 活动列表图**（一行一个活动：活动图标 + 活动 ID + 活动名称 + 起止时间 + 相关乐团名称；命中只有一个活动时仍出上面的丰富详情图，多服请求时同规则）；<br>③ 其余情况（多服请求，或请求的那个服自己没有）→ **多服组合表**（每服一行、行首国旗）。<br>上游活动数据由各服独立上传，「某服暂时没有」不等于活动不存在 —— 这时用组合表 + **未收录占位**呈现，顺带看出哪个服有；只有**四个服都没有**才返回「该活动不存在」。 |
| `/gachaSimulate` | `mainServer`, `times?`(默认 10，上限 10000), `gachaId?`, `compress?` | 抽卡模拟：真实概率（MasterGachaLot 权重 → MasterGachaPrize 资源，含 UP 权重），不传 `gachaId` 取当前开放卡池，10 连保底；≤10 次逐个展示，>10 次计数汇总 |
| `/getCardIllustration` | `displayedServerList?`, `cardId`, `cardType?` | 卡面原图（角色卡 1440×1920 竖版 / 支援卡 1920×1080 横版）。原图直出无法表达多服差异，取**第一个收录该卡的区域** |
| `/songRandom` | `mainServer`, `text?` \| `fuzzySearchResult?`, `compress?` | 随机歌曲详情图 |
| `/getStampImage` | `displayedServerList?`, `stampId` \| `text` \| `fuzzySearchResult`, `stampType?`, `compress?` | **查贴纸**（不需要数据库）。三种用法：<br>① `stampId` → 直出官方贴纸**原图**；<br>② `text`（或 `fuzzySearchResult`）→ **模糊搜索**；<br>③ 都不传 → 列出该服全部贴纸。<br>②③ 都出**列表图**（每格标出 ID 与名称），结果多时按 `STAMPS_PER_PAGE`（默认 30，即 5 列 × 6 行）**分页**，返回多张图并在标题标注页码。<br>`stampType` 决定关键词只认哪一类名称：`all`（默认，贴纸名/角色名/团体名都认）、`character`（只认角色名）、`band`（只认团体名）。原图直出时取第一个收录该贴纸的区域 |
| `/friend/upload` | `userId`, `userName`, `playerId`, `server`, `avatarUrl?` | **交友-登记/更新**：按 `userId`(QQ 号) upsert，一人一条；`server` 可为 `hk-tw-mo`/`jp`/`en`/`kr`（出图显示为港澳台服/日服/国际服/韩服） |
| `/friend/delete` | `userId` | **交友-删除**（弱鉴权：自报 QQ 号即可） |
| `/friend/list` | `compress?` | **交友列表图**：头像 + QQ 名 + QQ 号 + 游戏 ID + 服务器，每 30 人分页 |
| `/keyword/upload` | `userId`, `entityType`(`character`/`card`/`supportCard`/`song`/`band`), `entityId`, `keyword` | **关键词-上传**：给角色/角色卡/支援卡/歌曲/乐团挂一个便于检索的别名。两道查重：同一实体上不能重复；且不得与任何现有实体名/别名重合（乐团、角色、歌曲、角色卡、支援卡、卡池、活动、属性、贴纸的全部语言别名与去标点变体）。命中即拒绝 |
| `/keyword/delete` | `userId`, `entityType`, `entityId`, `keyword` | **关键词-删除**（弱鉴权：只能删自己上传的，按 `userId` 过滤） |
| `/station/submitRoomNumber` | `number`, `rawMessage`, `platform`, `userId`, `userName`, `time`, `avatarUrl?`, `bandoriStationToken?` | **车站-上传/刷新**（字段与语义同 tsugu，同房号重复提交=刷新）。`time` 秒/毫秒都接受，入参归一到毫秒 |
| `/station/queryAllRoom` | —（GET 或 POST） | **车站-JSON 查询**：返回未过期房间列表 |
| `/roomList` | `roomList?`, `compress?` | **车站列表图**：传 `roomList` 数组则直接渲染该批（tsugu 兼容）；不传则查本服务数据库。**时间单位两种都收**：OneBot/tsugu 生态的 `time` 是**秒**，也有客户端给毫秒 —— 入参统一按量级归一到毫秒，两种都显示成「x 秒前」 |
| `/songRanking` | `songId`, `server` \| `mainServer`, `compress?` | **歌曲排行（单服）**：该曲前十用户的排行与出分（名次/玩家名/分数）。上游每首约 140KB，走磁盘缓存 |
| `/eventSongRanking` | `id` \| `eventId?`, `rank?`(榜线: 10/100/1000/5000/10000), `server` \| `mainServer`, `compress?` | **活动歌榜（单服一图）**：把该活动的**每个乐曲榜**自上而下画进一张图（挑战演出活动 = 3 首）。每段有：歌曲封面 + 歌曲 ID + 曲名 + 所属乐团 + 「最后更新时间 / 已更新多久」，以及前十名的**名次 / 玩家名 / 综合力 / 出分**。**榜线参数 `rank`**：传 10/100/1000/5000/10000 时改出「**到该名次为止的 10 名**」（如 `rank=100` → 第 91~100 名），段头与页脚都会标出区间；上游每曲榜固定只给前 100，**数据不支持的档位直接不适配**（如 1000/5000/10000 会返回领域错误并列出可用档位），某一曲榜不足该档时只有那一段标注原因、其余照画。**取数与站点活动追踪器（`bdon.moe/events/tracker`）同源**：`/api/v1/{server}/events/current`、`/events/{id}`、`/events/{id}/challenges/{挑战曲id}/ranking`。不传活动 id 时取该服当前开放的活动（上游取不到时退回 masterdata 时间窗）；歌曲列表退回 `MasterChallengeMusic`，非挑战型活动退回活动本曲。旧路径 `/eventRanking` 保留为同一 router 的别名 |
| `/eventRecommend` | `id` \| `eventId?`, `server` \| `mainServer`, `compress?` | **活动推荐曲**（算法与站点「歌曲meta」的**活动 · 评级**一致，数据同源）：**一张图三截**，三截都**只收 HD/EX** 两档难度 —— ① **击奏live**、② **自由live**，各按**目标评级 SS / S / A / B** 分四段，每段是**所需综合力最低的前 10 张谱面**（全曲池，活动挑战曲也在池内）；③ **挑战live（单独模式，只能用当前活动的挑战曲）**，单开一表放在最下方，按目标评级 SS 的所需综合力升序全列，分数口径同自由live（激走关、单人门槛）。**报酬列按场景分表**：击奏/自由只算**演出报酬**，挑战live 只算**挑战演出报酬**，互不混算。新曲还没进 music-data 时**借**游戏 masterdata 的门槛分 + 谱面站的定数/物量/BPM/时长补一行，取不到模拟数据的列显示「—」并在页脚说明。每行：封面 + ID + 曲名 + 乐团 ｜ **所需综合力** ｜ 等级 ｜ 难度 ｜ 时长（BGM）｜ BPM ｜ Notes ｜ **局/小时** ｜ 演出报酬 pt/时 · 道具/时 ｜ 挑战演出报酬 pt/时 · 道具/时。所需综合力 = 该评级门槛 ÷ 分/综合力（击奏用**满员 5 人房**的房间门槛，自由用单人门槛）；局/小时 = 3600s ÷ (BGM 时长 + 30s)；pt/时、道具/时 = 该评级报酬 × 局/小时，**两张报酬表都列**。不传活动 id 时取该服当前开放的活动（与 `/eventSongRanking` 同一套解析） |
| `/cutoffAll` | `id` \| `eventId?` \| `text?`(模糊搜索活动), `rank?`(只看某一档), `server` \| `mainServer` \| `displayedServerList`, `compress?` | **活动榜线 · 分数记录（单服一图，四格折线）**：一格一首挑战曲 + 最后一格三曲同图，共 4 格画在一张图里。每条线 = 某曲的某一档（前 10 / 前 100 …）在**整个活动时长**（横轴铺满 开启→结束）内的分数变化，同一条线四格同色；每格左上有曲目封面 + ID，格子用纯色打底保证可读。**上游没有历史接口**，数据由本服务**每小时采样**（`CUTOFF_RECORD_INTERVAL_S`，查询时也会顺带采一次，同一整点桶只留一条）自己攒：配了 MongoDB 就落库、没配就退化为进程内存（页脚会标注，重启即遗忘）。**档位同样按数据适配**（挑战曲榜只有前 100 → 实际可用 10 / 100），`rank` 参数只画其中一档。**服务器只查一个**：传多个时取第一个，失败自动回退下一个；`text` 模糊搜索命中多个活动时返回**活动列表图**（与查活动同款），命中一个就直接按该 id 出图 |
| `/searchPlayer` | `playerId`, `server` \| `mainServer`, `useEasyBG?`(忽略), `compress?` | **账号查询（单服）**：玩家档案图 —— 最爱卡面大图 + 国旗服名 + 名称/等级/应援数/经验，玩家自制的 profile card 有则附上。`playerId` 可传 number 或纯数字字符串；省略服务器时按 ID 首位推断（`2`→tw、`3`→en、`4`→kr），**JP 无前缀规则，必须显式传 `jp`**。查不到时**优先引导玩家去 `https://bdon.moe/account` 添加并验证游戏账号、再把个人主页设为「公开」**；数据源的可用范围见下方说明 |
| `/announcements` | `server` \| `mainServer`, `id?`, `compress?` | **公告一次性查询（单服出图）**：不传 `id` 出**列表图**（分类徽章 + 标题 + 起止时间 + 横幅缩略图，港澳台/韩/国际有横幅、**日服上游没有横幅字段故退化为纯文字行**）；传 `id` 出**该条公告的详情图**（标题/分类/时间/横幅 + 正文，正文由上游的 HTML 去标签后按纯文本排版，过长自动分页） |
| `/announcementStream/{tw\|jp\|kr\|en}` | GET | **公告推送（SSE，每服四条独立端点）**：**只在公告新增或修改时**推 `announcement`（含该条公告的详情图 base64），连接时不发快照、下架也不推 —— 需要全量列表请用上面的一次性接口。另有 `ready` 握手与 `: ping` 保活。**同一服支持任意多个客户端同时连接**：每条连接各自订阅、事件广播给全部订阅者，公告图在所有订阅者之间**只渲染一次**；仅在该服**还有订阅者**时轮询上游（最后一个客户端断开才停，断开时按 `close`/`error` 清理，不会留下空转的定时器） |
| `/cutoffDetail` `/cutoffListOfRecentEvent` `/user` | — | **404 占位**：`错误: 服务器未启用数据库`（与 tsugu 无 DB 时一致）。`/user` 在 tsugu 是账号绑定 API，本服务不实现 |

### 活动查询

**渲染模式按「该服自己有没有这个活动」决定，没有任何服务器硬编码**（上游活动数据各服独立上传，将来别的服有活动时会自动走丰富版）：

| 情况 | 输出 |
| --- | --- |
| 只请求一个服，且该服自己有该活动 | 丰富详情图 |
| 只请求一个服，但该服没有 | 多服组合表（放宽到四个服，缺的显示「未收录」占位） |
| 请求多个服 | 多服组合表（覆盖请求的那些服） |
| 四个服都没有该 ID | `错误: 该活动不存在` |

「某服暂时没有」不等于活动不存在，所以第 2 行走占位而不是报错。

**模糊搜索维度**（复用既有模糊索引，不另建匹配逻辑）：

| 维度 | 关键词示例 | 走哪条路 |
| --- | --- | --- |
| 活动名称 | `アイの奔流` | 索引类型键 `eventId` 的名称别名 |
| 乐队 | `夢限大` | 索引类型键 `bandId`；部分名走 `_all` 子串回退 |
| 角色 | `千石` | 索引类型键 `characterId`；部分名走 `_all` 子串回退 |
| 属性 | `紺碧` | 索引类型键 `cardType`（本服务为活动新增，覆盖五种属性的多语言名与去后缀名） |
| 时间 | `进行中` / `未开始` / `已结束` / `即将结束` | **状态关键词**，由搜索层直接筛活动状态 |
| 时间 | `2026-09-30` | 日期串与活动的开放/结束时间做子串匹配（`-` 与 `/` 等价） |

**活动种类**：主数据里**没有种类名称表**，只有一个 `eventType` 数字，站点也不显示种类。本服务暂时用活动自身的排名开关拼出种类标签（实测该活动 = `乐曲排名 · 乐曲总排名`），见 `Event.typeLabel()`。

### 贴纸检索的匹配维度

`/getStampImage` 的模糊搜索复用既有的模糊索引，关键词可落在三个维度上：

| `stampType` | 认哪些名称 | 说明 |
| --- | --- | --- |
| `all`（默认） | 贴纸名 / 角色名 / 团体名 | 贴纸名走索引的 `stampId` 类型；角色名与团体名分别命中 `characterId` / `bandId` 两个既有类型 |
| `character` | 只认角色名 | 例如「高松灯」→ 她的 2 张表情贴纸 |
| `band` | 只认团体名 | 例如「MyGO!!!!!」→ 该团五位角色的 10 张贴纸 |

结果多时按 `STAMPS_PER_PAGE`（默认 30）分页；**只有一页时**列数会随结果数收缩（搜到 2 张就是 2 列宽的窄图），**分页时**固定 5 列以保证各页对齐一致。

贴纸自身只有**角色**归属（`MasterStamp.characterIds`），团体是靠角色反查 `MasterCharacter.bandID` 得到的。文字贴纸（category 2）没有角色归属，因此只在 `all` 范围下按贴纸名命中。

### 账号查询的数据源与能力边界

`/searchPlayer` 的数据源**自动选择**：

| 配置 | 数据源 | 能查到谁 |
| --- | --- | --- |
| 设了 `MOENOTES_API_BASE` + `MOENOTES_API_KEY` | 自建网关 [moenotes-api](https://github.com/StarMoe-org/moenotes-api)（Rust，需自行 docker 部署并导入游戏凭据） | **任意玩家**（tw/en/kr，JP 走 `/v1/jp/profile/{id}`） |
| 未配置（默认） | 站点公开接口 `https://bdon.moe/api/players/{server}/{id}` | **仅「已在 [bdon.moe/account](https://bdon.moe/account) 添加并验证游戏账号、且个人主页已设为公开」的账号**，其余一律 404 |

站点这条路径的要求是**上游设计**，不是本服务的实现缺陷（站点自己的玩家主页也走同一个接口，rankd 侧没有任意玩家查询接口）。查不到时的报错会**优先引导玩家去 `https://bdon.moe/account`**：先在「游戏账号」里添加账号（把验证码临时写进游戏内昵称完成验证），再把个人主页设为「公开」。想让任意玩家 ID 可查，请自建网关。

#### 自建网关（moenotes-api）流程

自建网关直连游戏协议，能查**任意**玩家；代价是**要自己保管游戏凭据**，且属实验性项目（有限实测验证）。

仓库里的 [`gateway/`](gateway/) 放了一个速搭脚本（Windows），省掉下面 1~4 步的手工活：

```bat
gateway\setup-gateway.bat          :: 建目录 + 拉镜像 + 生成 config.toml 并自动写入随机 api_key
gateway\setup-gateway.bat run      :: 启动容器（只监听本机 8080）
gateway\setup-gateway.bat status   :: 探测 /healthz 与 /v1/status
```

它会在 `gateway/data` 与 `gateway/accounts` 两个目录里放配置与账号（**两个目录都已 gitignore，也不会随 `npm run export` 导出**）。手动部署的话按下面走：

1. **拉镜像**：`ghcr.io/starmoe-org/moenotes-api`（无 `latest` 标签，用具体版本或 GitHub Release 里的 digest）。镜像自带的启动监听器是 `0.0.0.0:8080`，进程以 UID/GID **65532** 运行。
2. **起容器**：挂三份目录 —— 配置（`/etc/moenotes`，只读）、账号（`/accounts`，只读）、状态（`/var/lib/moenotes`，**可写**，首次启动会在这里生成 `config.toml` 模板）；或直接用仓库自带的 `compose.yaml`，配置落在宿主机 `./data/config.toml`，改完重启即可。宿主侧按 0700 建目录、65532 属主，配置文件 0600。
3. **填配置** `config.toml`：`listen`（容器内必须 `0.0.0.0:8080`）、`api_key`（**32–4096 位随机 ASCII**）、`[session]`（区域、被许可的游戏 origin、平台与客户端/数据版本）。多区域各加一段 `[regions.en]` / `[regions.kr]` …（区域凭据不继承，要各自配）；JP 走单独凭据导入（见其 `docs/jp-accounts.md`）。改完先 `moenotes-server check-config <config>` 校验，再 `serve <config>`。
4. **放账号**：`/accounts` 下放 `{"user":"EMAIL","password":"PASSWORD"}` 的 JSON（国际服；JP 放 `accounts/jp/`），权限 0600；可选 `strategy = "round_robin"` 在多个账号间轮询。
5. **验证**：`/healthz` 只看进程存活；带 `Authorization: Bearer <api_key>` 打 `/readyz` 与 `/v1/status` 看会话状态；再试一条真实查询：
   ```sh
   curl -H "Authorization: Bearer $KEY" http://127.0.0.1:8080/v1/tw/profile/20000000001
   ```
6. **接上本服务**：`.env` 填 `MOENOTES_API_BASE=http://127.0.0.1:8080` 与 `MOENOTES_API_KEY=<api_key>`，重启后 `/health` 的 `playerGateway` 变 `true`，`/searchPlayer` 自动切到网关（无需改代码）。

**接口形状**（本服务已在用，无需适配）：`GET {base}/v1/{server}/profile/{id}`，头 `Authorization: Bearer <api_key>`，响应是未加工的 protobuf JSON（int64 为十进制字符串），取数时间与缓存状态在响应头；另有 `/v1/profile/{id}`（按 ID 首位自动选区域）与 `/v1/{region}/profile/{profileId}/card/{page}`（个人名片 PNG 代理）。

**部署注意**：网关持有游戏凭据，只监听本机或放在 TLS 反代之后，**不要直接暴露公网**；key、账号文件一律 0600 且不进版本库；`check-config` 只做本地校验，不代表凭据有效。

### 公告推送（SSE）

公告拆成**两个接口**，职责不重叠：

| 接口 | 用途 |
| --- | --- |
| `POST /announcements` | **一次性查询**：不传 `id` 出列表图；传 `id` 出单条公告的详情图 |
| `GET /announcementStream/{server}` | **推流**：只在公告**新增或修改**时推送该条公告的内容图 |

```
GET /announcementStream/tw     # 四条独立端点: tw / jp / kr / en
```

- 每条流只服务一个服，订阅者集合与轮询互相独立
- 连接时**不发任何快照**（全量列表走一次性接口），**下架也不推** —— 只推新增与修改，避免客户端收到它没请求过的内容
- 上游**没有推送能力**，更新来自**轮询 + 本地 diff**：延迟等于 `ANNOUNCEMENT_POLL_S`（默认 300s，与上游 `Cache-Control: max-age=300` 对齐）
- 只在**有订阅者**时轮询，最后一个订阅者断开即停止
- 变更判据是 `id` + `lastUpdatedAt`
- 事件载荷里的图片是 base64（与其它接口的 `{type,string}` 同构），按 `compress=true` 出 JPEG
- **推送前会按 id 补一次详情请求**：上游的**列表接口不返回正文**（`body` 只有详情接口才给），少了这一步推出去的详情图会画成「（该公告没有正文）」

### 详情图的「相关卡池 / 相关活动」栏位

歌曲、角色卡、支援卡、卡池、活动五类详情图各带对应的关联栏位（缩图 + 右下角黑底 ID 徽章）。关联的取数依据如下，**前三种是上游的显式字段，第四种只能推断**：

| 关联 | 依据 |
| --- | --- |
| 歌曲 → 活动 | `MasterEvent.musicId`、`MasterChallengeMusic.liveMusicId`（一个活动可有多首挑战曲） |
| 角色卡/支援卡 → 活动 | `MasterEventPickUpCard`（活动卡）、`MasterEventEffect`（加成对象卡） |
| 角色卡/支援卡 → 卡池 | `MasterGacha` → `MasterGachaLot` → `MasterGachaPrize.pickUpType=2`（即「作为 UP 卡出现」的卡池） |
| 活动 ↔ 卡池 | **无字段**，按「卡池 UP 卡集合 ∩ 活动卡集合非空，且两者时间区间重叠」推断 |

- 第 4 条是**启发式**，实现在 `src/data/relations.ts` 的 `eventGachaRelated()`，活动页与卡池页共用同一处判定。实测当前数据吻合：活动 1 的加成卡 `M61/M62/S62/S63` 恰是卡池 10 的全部 UP 卡，两者开始时间同为 `2026/09/30 18:00`。**已知取舍**：复刻池、纯道具池这类 UP 卡与当期活动卡不重合的卡池不会被关联
- 侧边的时间区间：活动用 `startAt..displayEndAt`，卡池用 `startAt..endAt`；任一侧时间缺失（实测多数卡池 `_startAt` 为空串）时按开区间处理，退化为只看卡片交集
- 取数区域用**该详情页的主体渲染区域**（与页面文字同源）；**国际服上游没有卡池表**，按既有规则退回港澳台
- 缩图走逐区域回退（各区域素材镜像进度不一），单张缺失只画占位块
- 每个栏位最多列 6 项，没有关联时整个栏位不出现

### 模糊搜索的多语言别名

别名索引按「区域 + dataVersion」构建，但**文本从四个区域一并取**：

- 上游 jp 的 `MasterText` 几乎没有中文列（实测实体文本里 1083 条完全没有中文，其中 1082 条能在 tw 找到），只按本区域取会让日服索引只剩日文别名 —— 中文用户在日服搜不到歌
- 各区域指向同一实体的 textId 是同一个（歌曲/角色/卡/乐团实测 0 例外），所以对同一 textId 取四区域的并集既安全又完整
- 索引体积仍在几十 KB 量级（tw 428 个键 / 4289 条别名 / 77KB），构建只发生在 dataVersion 变化时

> 局限：**整名**的多语言查询都能命中；但「部分名」的兜底匹配（`_all` 子串）是拿关键词跟**该区域自己的标题**比的，所以在日服搜中文的半个歌名仍可能落空。

## 6. 数据库相关功能（交友 / 车站 / 关键词）

**贴纸不需要数据库**；**交友**、**车站**与**关键词**需要 MongoDB。

### 用法

| 功能 | 用法 |
| --- | --- |
| 交友登记 | `POST /friend/upload`，一人一条（同 `userId` 覆盖），`server` 支持港澳台服/日服/国际服/韩服 |
| 删除交友 | `POST /friend/delete`，自报 `userId` 即删 |
| 交友列表 | `POST /friend/list`，出图，每 30 人分页 |
| 上传关键词 | `POST /keyword/upload`，为角色/角色卡/支援卡/歌曲/乐团挂别名，上传时查重 |
| 删除关键词 | `POST /keyword/delete`，只能删自己上传的（按 `userId` 过滤） |
| 上传车牌 | `POST /station/submitRoomNumber`，同房号重复提交 = 刷新有效期 |
| 车站查询 | `GET`/`POST /station/queryAllRoom` 出 JSON；`POST /roomList` 出图 |

- **连接**：`src/data/mongo.ts` 惰性单例，首次取集合时自建索引 —— `friends.userId` 唯一、`stations.expireAt` 为 TTL 索引（`expireAfterSeconds: 0`）+ `stations.number` 唯一、`keywords` 的 `(entityType, entityId, normKeyword)` 唯一（同实体重复上传由数据库兜底，并发下也只会成功一条）
- **关键词怎么生效**：关键词**不写进**模糊索引的磁盘缓存（那份缓存按 dataVersion 失效，与数据库无关），而是作为**独立覆盖层**在内存里合并（`src/fuzzySearch.ts` 的 `setKeywordOverlay`）。`ensureFuzzyIndex()` 会顺带装载覆盖层并带 `KEYWORD_CACHE_TTL_S` 的 TTL，上传/删除后立即强刷
- **关键词进渲染缓存**：详情图会因关键词变化而变，但 dataVersion 与请求体都不变 —— 所以上传/删除会 `bumpRenderEpoch()`，让渲染缓存的世代号前移，旧图自然不再命中（见 `src/renderEpoch.ts`）
- **车站过期**：TTL 后台约每 60s 清理，查询侧另带 `expireAt > now` 过滤（双保险），有效期由 `STATION_TTL_S` 控制（默认 150s，同 tsugu）
- **交友头像**：从 `avatarUrl` 拉取并走磁盘缓存；**只允许 `https://` + `qlogo.cn` 域**（避免 SSRF 内网探测），其余用"确定性颜色 + 名字首字符"占位块
- **鉴权**：与 tsugu 同类接口一样**没有鉴权**，写操作以自报 `userId`(QQ 号) 为准，伪造 QQ 号即可删他人记录 —— 仅适合自建小圈子
- **未启用数据库时**：`/friend/*`、`/keyword/*`、`/station`、`/roomList` 返回 404 占位 `错误: 服务器未启用数据库`（同 tsugu 无 DB 时的行为），其余端点不受影响 —— 详情图照常出，只是不带「关键词」栏位

### 启动步骤

1. 安装并启动 MongoDB（本机）：

   ```bash
   # Windows 服务方式（需管理员）
   net start MongoDB
   # 或手动起一个实例
   mongod --dbpath <数据目录>
   ```

2. 在 `.env` 中启用：

   ```ini
   ENABLE_DB=true                        # 总开关；false 时交友/车站走 404 占位
   MONGODB_URI=mongodb://127.0.0.1:27017
   MONGODB_DB=tomori
   DB_CONNECT_TIMEOUT_MS=3000
   STATION_TTL_S=150                     # 车站房号有效期（秒）
   ```

3. 重启服务（`start.bat` 或 `npm start`），索引会在首次访问时自动创建。

4. 验证：

   ```bash
   # 交友登记（server 可为 hk-tw-mo/jp/en/kr）
   curl.exe -X POST http://127.0.0.1:3000/friend/upload -H "Content-Type: application/json" \
     -d '{"userId":"123456789","userName":"昵称","playerId":"9876543210","server":"jp"}'
   # 交友列表图
   curl.exe -X POST http://127.0.0.1:3000/friend/list -H "Content-Type: application/json" -d '{"compress":true}'
   # 车站查询
   curl.exe http://127.0.0.1:3000/station/queryAllRoom
   ```

## 7. 未完成功能

- **分数线/账号绑定**：`/cutoffDetail`、`/cutoffListOfRecentEvent`、`/user`（tsugu 的账号绑定）未实现，统一 404 占位；`/cutoffAll` 已补全为**活动榜线 · 分数记录**（各档分数随时间的折线图，见接口表）。**已知限制**：档位分数取自**挑战曲榜**（上游每曲固定只给前 100，所以实际可用 10 / 100 两档；1000/5000/10000 没有数据来源，按需求不适配）；上游的**积分榜**（`pointRanking`）与档位表（`tiers`）目前全是 `enabled: false` / `available: false`，所以活动积分榜与奖励档位分数线暂时画不出来。历史需要自己攒：服务按小时采样，配 MongoDB 落库、没配就只在内存里。`/searchPlayer` 已实现，但默认数据源只能查到 StarMoe 已验证公开的账号（见第 5 节）
- **鉴权**：本服务与社区写操作都没有鉴权，未设计用户体系
- **活动 ↔ 卡池**：上游没有关联字段，是按「UP 卡重合 + 时间重叠」推断的启发式（见第 5 节），复刻池/纯道具池不会关联到活动
- **关键词**：单实体上限 20 个、单条上限 32 字；只做查重不做审核内容，也没有跨实体的全局唯一性（同一别名挂到两个不同实体是允许的）
- **多服图的内存**：四个区域全量 master 约 4× 单区域（单区域约 7MB，`MasterText` 占大头），暂未做 LRU
- **工程化**：无 Docker/CI，无自动化测试套件（只有 `npm run typecheck`），无 API 限流

## 8. MIT 许可证

```
MIT License

Copyright (c) 2026 Sugar51243

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

> 本项目与 Bushiroad、Craft Egg 及《BanG Dream!》官方无任何关联；游戏素材版权归官方所有。
