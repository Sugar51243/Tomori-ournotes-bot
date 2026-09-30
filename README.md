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

**沿用的部分**：端点命名与请求体字段（`displayedServerList` / `mainServer` / `compress` 等）、响应协议（`listToBase64` 图片数组、域内错误以 HTTP 200 返回 `['错误: ...']`）、模型字段命名习惯。

**代码层面只移植了模糊搜索分词器**（`src/fuzzySearch.ts`，源自 tsugu `backend/src/fuzzySearch.ts`，文件头有署名）；谱面解析与渲染、数据获取、出图排版均按 Our Notes 的数据结构重写。

**与 tsugu 的差异**（照 tsugu 实际实现对齐，而非其文档）：

| 方面 | tsugu | 本服务 |
| --- | --- | --- |
| 谱面 | Bestdori GBP 格式（7 轨 / beat 计时） | Our Notes `nnnotes.live-score/1`（24 轨 / 绝对 `timeMs` / 滑条线 / fever） |
| 车站存储 | 进程内存，重启即丢，上限 100 条 | MongoDB（持久），TTL 索引自动清理 |
| 车站查询 | `GET /station/queryAllRoom` 出 JSON，出图要客户端再把列表 POST 给 `/roomList` | 两者都支持：`/roomList` 不传入参时直接查库出图，也接受 tsugu 式 `roomList` 入参 |
| 交友 | **无此功能**（其 `/user` 是账号绑定 API） | 新增 `/friend/upload` `/friend/delete` `/friend/list` |
| 外发 | 可选转发 BandoriStation（`USE_BANDORISTATION`） | 不实现（`bandoriStationToken` 接受但忽略） |
| 空列表 | 返回字符串 `myc` | 返回 `车站列表为空` / `交友列表为空` |

## 3. 数据来源

| 来源 | 内容 |
| --- | --- |
| `metadata.bdon.moe` | master 数据：`current_version.json`（**一份文档含全部区域**）与 Master 表（歌曲/卡片/角色/卡池/活动/贴纸），含文本本地化 |
| `assets.bdon.moe` | 素材 CDN：卡面原图、贴纸、背景、乐团队标、谱面渲染素材；谱面 bundle 见 `chart-site/*`（**全区共享，不带区域段**） |
| `api.bdon.moe` | rankd 游戏数据（公开只读）：游戏公告、歌曲排行，路径形如 `/api/v1/{server}/...` |
| `bdon.moe` | 站点同源 API `/api/players/{server}/{id}`（玩家档案）与国旗图标 `/flags/{hk,jp,kr,us}.svg` |
| 磁盘缓存 `./cache` | 上述资源的 TTL 缓存，ETag 重验证，断网时回退陈旧副本 |

**区域命名三套并存，是最容易踩坑的地方**（已在 `src/types/Server.ts` 统一收口）：

| 短码 | `current_version.json` 的键 | master 表路径段 | 素材区域段 | 素材语言 |
| --- | --- | --- | --- | --- |
| tw | `hk-tw-mo` | `tw` | tw | zh-Hans / zh-Hant / ja / en / ko |
| jp | `jp` | `jp` | jp | **仅 ja** |
| kr | `kr` | `kr` | kr | 同 tw |
| en | `en` | `en` | en | 同 tw |

`hk-tw-mo` **只是清单键** —— 拿它去拼 master 路径会 404。对本服务而言它是 `tw` 的**别名**（老 tsugu 客户端与历史交友记录会这么传）。
实测确认：`assets.bdon.moe/jp/zh-Hans/...` 一律 404（jp 只有 `ja` 目录），且 jp 的 `MasterText` 中文列 9924 行里仅 60 行有值 —— 所以取图语言与取字回退链都必须按区域收窄。

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
- **网络**：需能访问 `metadata.bdon.moe`、`assets.bdon.moe`、`api.bdon.moe`（公告/排行）与 `bdon.moe`（账号查询与国旗图标）

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

**环境变量**（完整清单见 `.env.example`）：`PORT`、`META_BASE` / `ASSET_BASE` / `GAME_API_BASE` / `MOENOTES_SITE_BASE`（上游地址）、`MOENOTES_API_BASE` / `MOENOTES_API_KEY`（**可选的账号查询网关**，见第 5 节）、`CACHE_DIR`、`DEFAULT_SERVER`（缺省区域）、`DEFAULT_LOCALE` / `LOCALE_FALLBACKS`（文本语言回退链，各区域另有自己的默认语言）、各项 TTL（`MASTERDATA_TTL_S` / `VERSION_TTL_S` / `CHART_MANIFEST_TTL_S` / `CHART_ASSET_TTL_S` / `IMAGE_TTL_S` / `ANNOUNCEMENT_TTL_S` / `RANKING_TTL_S` / `PLAYER_TTL_S`）、`ANNOUNCEMENT_POLL_S` / `SSE_HEARTBEAT_S`（公告推送）、`SONGS_PER_PAGE` / `STAMPS_PER_PAGE`（歌表、贴纸列表分页）、`MAX_CONCURRENCY_PER_HOST` / `HTTP_TIMEOUT_MS`（上游限流与超时）、`LOG_LEVEL`、`GACHA_DEFAULT_RATES`（概率兜底）、数据库相关见第 6 节。

**自检**：`npm run typecheck`（类型检查）；启动后用 `GET /health` 与第 5 节的端点示例验证。

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

- **服务器字段 — 按数据性质分成两类**（这是本次设计的中心原则，也决定了每个端点该传什么）：

  | | 静态游戏数据 | 动态用户数据 |
  | --- | --- | --- |
  | 端点 | `/searchSong` `/searchCard` `/searchCharacter` `/searchGacha` `/searchEvent` `/songMeta` `/songChart` `/songChartData` `/songRandom` `/gachaSimulate` `/fuzzySearch` `/getCardIllustration` `/getStampImage` | `/songRanking` `/searchPlayer` `/announcements` `/announcementStream/*` |
  | 字段 | `displayedServerList`（数组，**按序决定图中出现哪几个服**），`mainServer` 作兜底；不传则默认全部四服 | 单值 `server`（**兼容 tsugu 的 `mainServer`**），一次只查一个服 |
  | 出图 | **一图多服**：每个实体一个区块，区块内**每服一行**，行首是服国旗 | **单服一图** |
  | 理由 | 同一个实体（歌曲/卡/角色）在各服的差异可以并排比较 | 用户成绩、玩家档案、公告在各服是彼此独立的数据，没有可对比的共同实体 |

  **各服信息取数优先级：该服自己有就用自己的，没有才回退港澳台服。** 例如查一首歌时先看各服是否有这条数据 —— 韩服有就用韩服自己的数值显示那一行，没有才借港澳台的数据顶上；港澳台自己也没有（例如日服独有曲）时才显示「未收录」。这条规则对四个区域一视同仁。

  港澳台/韩/国际三服在上游目前是同一份内容，所以三行看起来仍然一致；但规则是按「各服优先」而不是「一律取港澳台」，区域分叉后行为自然正确。**渲染主体的选择另有一套判据**：必须是「自己收录了该实体」的服（借来的数据渲染不出实体本身），因此日服独有曲仍然用日服渲染主体、其它服借用它的数据。

  **出图语言以所选服务器为准**：港澳台 → 简体中文、日服 → 日文、韩服 → 韩文、国际服 → 英文。文本回退链把该区域自己的默认语言排在最前，缺失时才依次退到区域次级语言、`DEFAULT_LOCALE`、`ja`/`en`。只有**港澳台**按用户要求优先出**简体中文**（其上游 `traditionalChinese` 列仍作为次级回退）。素材语言同理（jp 只有 `ja` 目录，请求其他语言时回退到 `ja`）。

  实测各区域 `MasterText` 的覆盖度：**tw/kr/en 五语种齐全**（上游是同一份文件），**jp 以日文为主**（9924 行里只有 60 行带中文、58 行带韩文），所以日服基本只会出日文，属上游数据所限。另外上游的 `simplifiedChinese` 列本身偶有繁体字形（如部分作词/作曲名），这属于数据现状而非回退链问题。

  **详情类接口在未显式传服务器时以港澳台为主体渲染**（港澳台自己没有该实体时才回退日服）；显式传了服务器就按传入的来。

  区域可写 `tw` / `jp` / `kr` / `en`，或别名 `hk-tw-mo`（等同 `tw`）；其余值一律 400。
  **例外**：交友的 `server` 沿用同一套取值（仅登记用）；`/friend/*`、`/station`、`/roomList` 与 tsugu 的 404 占位端点不受区域影响
- **字段类型**：各字段必须按声明类型传，数组/对象冒充标量一律 400。`playerId` 是唯一的宽松项：`/friend/*` 只收纯数字字符串，`/searchPlayer` 数字与纯数字字符串都收（tsugu 传 number），内部统一转十进制字符串
- **`compress`**：可选布尔，`true` 出 JPEG（默认），`false` 出 PNG

### 端点表

| 端点 | 请求体 | 说明 |
| --- | --- | --- |
| `GET /health` | — | 服务状态、`defaultServer`、四区域各自的 dataVersion（一次请求取回全部区域）、`playerGateway` 是否已配置、运行时长 |
| `/searchSong` | `displayedServerList`, `text` \| `fuzzySearchResult`, `compress?` | 整数 ID → 歌曲详情图；否则模糊搜索 → 列表图（命中单首直接出详情） |
| `/songMeta` | `displayedServerList`, `mainServer`, `compress?` | **歌表**：每首歌一个区块（ID/标题/乐队/分类/时长）+ **只显示一个服的一行**，行内是该服的 EZ/NM/HD/EX 定数与物量（即出分）以及上架时间。**取数优先港澳台服，港澳台没有该曲时改用日服**，行首国旗标明这一行来自哪个服；曲目集合是所选服的并集（默认四服时即港澳台 ∪ 日服）。按 `SONGS_PER_PAGE`（默认 20）**分页**。**只含静态 master 数据，不含任何用户成绩** |
| `/songChart` | `songId`, `difficultyId?`(0-3，默认 3), `mirror?`, `noteSpeed?`(1.00~12.00，默认 7.50；`speed` 同义), `compress?` | **Our Notes 风格谱面预览图**（24 轨 / chord / 滑条 / fever / 金色 critical 音符，信息条置顶） |
| `/songChartData` | `displayedServerList?`, `songId`, `difficultyId?`, `mirror?`, `format?`(`raw`/`simple`/`both`，默认 `simple`) | **谱面数据 JSON**（非 base64）：`meta` + 原始 nnnotes / 简化格式。谱面站点全区共享，区域只影响标题/难度的取数来源 |
| `/searchCard` | `displayedServerList`, `text` \| `fuzzySearchResult`, `cardType?`(`member`/`support`/`auto`，默认 `auto`), `useEasyBG?`(tsugu 兼容，忽略), `compress?` | **查卡（整合）**：角色卡与支援卡一起查，列表按种类分区；按 ID 查时 `auto` 先角色卡后支援卡 |
| `/searchMemberCard` | 同上（`cardType` 无效） | **查角色卡**（成员卡） |
| `/searchSupportCard` | 同上（`cardType` 无效） | **查支援卡**（留影） |
| `/searchCharacter` | `displayedServerList`, `text` \| `fuzzySearchResult`, `compress?` | 角色搜索 / 详情 |
| `/searchGacha` | `displayedServerList`, `gachaId`, `compress?` | 卡池详情 |
| `/searchEvent` | `displayedServerList`, `text` \| `fuzzySearchResult`, `compress?` | 活动搜索（当前游戏无活动数据，返回无结果） |
| `/gachaSimulate` | `mainServer`, `times?`(默认 10，上限 10000), `gachaId?`, `compress?` | 抽卡模拟：真实概率（MasterGachaLot 权重 → MasterGachaPrize 资源，含 UP 权重），不传 `gachaId` 取当前开放卡池，10 连保底；≤10 次逐个展示，>10 次计数汇总 |
| `/getCardIllustration` | `displayedServerList?`, `cardId`, `cardType?` | 卡面原图（角色卡 1440×1920 竖版 / 支援卡 1920×1080 横版）。原图直出无法表达多服差异，取**第一个收录该卡的区域** |
| `/songRandom` | `mainServer`, `text?` \| `fuzzySearchResult?`, `compress?` | 随机歌曲详情图 |
| `/getStampImage` | `displayedServerList?`, `stampId` \| `text` \| `fuzzySearchResult`, `stampType?`, `compress?` | **查贴纸**（不需要数据库）。三种用法：<br>① `stampId` → 直出官方贴纸**原图**；<br>② `text`（或 `fuzzySearchResult`）→ **模糊搜索**；<br>③ 都不传 → 列出该服全部贴纸。<br>②③ 都出**列表图**（每格标出 ID 与名称），结果多时按 `STAMPS_PER_PAGE`（默认 30，即 5 列 × 6 行）**分页**，返回多张图并在标题标注页码。<br>`stampType` 决定关键词只认哪一类名称：`all`（默认，贴纸名/角色名/团体名都认）、`character`（只认角色名）、`band`（只认团体名）。原图直出时取第一个收录该贴纸的区域 |
| `/friend/upload` | `userId`, `userName`, `playerId`, `server`, `avatarUrl?` | **交友-登记/更新**：按 `userId`(QQ 号) upsert，一人一条；`server` 可为 `hk-tw-mo`/`jp`/`en`/`kr`（出图显示为港澳台服/日服/国际服/韩服） |
| `/friend/delete` | `userId` | **交友-删除**（弱鉴权：自报 QQ 号即可） |
| `/friend/list` | `compress?` | **交友列表图**：头像 + QQ 名 + QQ 号 + 游戏 ID + 服务器，每 30 人分页 |
| `/station/submitRoomNumber` | `number`, `rawMessage`, `platform`, `userId`, `userName`, `time`, `avatarUrl?`, `bandoriStationToken?` | **车站-上传/刷新**（字段与语义同 tsugu，同房号重复提交=刷新） |
| `/station/queryAllRoom` | —（GET 或 POST） | **车站-JSON 查询**：返回未过期房间列表 |
| `/roomList` | `roomList?`, `compress?` | **车站列表图**：传 `roomList` 数组则直接渲染该批（tsugu 兼容）；不传则查本服务数据库 |
| `/songRanking` | `songId`, `server` \| `mainServer`, `compress?` | **歌曲排行（单服）**：该曲前十用户的排行与出分（名次/玩家名/分数）。上游每首约 140KB，走磁盘缓存 |
| `/searchPlayer` | `playerId`, `server` \| `mainServer`, `useEasyBG?`(忽略), `compress?` | **账号查询（单服）**：玩家档案图 —— 最爱卡面大图 + 国旗服名 + 名称/等级/应援数/经验，玩家自制的 profile card 有则附上。`playerId` 可传 number 或纯数字字符串；省略服务器时按 ID 首位推断（`2`→tw、`3`→en、`4`→kr），**JP 无前缀规则，必须显式传 `jp`**。数据源的可用范围见下方说明 |
| `/announcements` | `server` \| `mainServer`, `id?`, `compress?` | **公告一次性查询（单服出图）**：不传 `id` 出**列表图**（分类徽章 + 标题 + 起止时间 + 横幅缩略图，港澳台/韩/国际有横幅、**日服上游没有横幅字段故退化为纯文字行**）；传 `id` 出**该条公告的详情图**（标题/分类/时间/横幅 + 正文，正文由上游的 HTML 去标签后按纯文本排版，过长自动分页） |
| `/announcementStream/{tw\|jp\|kr\|en}` | GET | **公告推送（SSE，每服四条独立端点）**：**只在公告新增或修改时**推 `announcement`（含该条公告的详情图 base64），连接时不发快照、下架也不推 —— 需要全量列表请用上面的一次性接口。另有 `ready` 握手与 `: ping` 保活。仅在有订阅者时轮询上游 |
| `/cutoffAll` `/cutoffDetail` `/cutoffListOfRecentEvent` `/user` | — | **404 占位**：`错误: 服务器未启用数据库`（与 tsugu 无 DB 时一致）。`/user` 在 tsugu 是账号绑定 API，本服务不实现 |

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
| 未配置（默认） | 站点公开接口 `https://bdon.moe/api/players/{server}/{id}` | **仅「在 StarMoe 已验证且设为公开」的账号**，其余一律返回 `错误: 该账号未公开或不存在` |

后者只能查到已验证公开的账号是**上游设计**，不是本服务的实现缺陷 —— rankd 侧也没有任意玩家查询接口。想让任意玩家 ID 可查，请自建网关。

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

## 6. 数据库相关功能（交友 / 车站）

**贴纸不需要数据库**；**交友**与**车站**需要 MongoDB。

### 用法

| 功能 | 用法 |
| --- | --- |
| 交友登记 | `POST /friend/upload`，一人一条（同 `userId` 覆盖），`server` 支持港澳台服/日服/国际服/韩服 |
| 删除交友 | `POST /friend/delete`，自报 `userId` 即删 |
| 交友列表 | `POST /friend/list`，出图，每 30 人分页 |
| 上传车牌 | `POST /station/submitRoomNumber`，同房号重复提交 = 刷新有效期 |
| 车站查询 | `GET`/`POST /station/queryAllRoom` 出 JSON；`POST /roomList` 出图 |

- **连接**：`src/data/mongo.ts` 惰性单例，首次取集合时自建索引 —— `friends.userId` 唯一、`stations.expireAt` 为 TTL 索引（`expireAfterSeconds: 0`）+ `stations.number` 唯一
- **车站过期**：TTL 后台约每 60s 清理，查询侧另带 `expireAt > now` 过滤（双保险），有效期由 `STATION_TTL_S` 控制（默认 150s，同 tsugu）
- **交友头像**：从 `avatarUrl` 拉取并走磁盘缓存；**只允许 `https://` + `qlogo.cn` 域**（避免 SSRF 内网探测），其余用"确定性颜色 + 名字首字符"占位块
- **鉴权**：与 tsugu 同类接口一样**没有鉴权**，写操作以自报 `userId`(QQ 号) 为准，伪造 QQ 号即可删他人记录 —— 仅适合自建小圈子
- **未启用数据库时**：`/friend/*`、`/station`、`/roomList` 返回 404 占位 `错误: 服务器未启用数据库`（同 tsugu 无 DB 时的行为），其余端点不受影响

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

- **活动**：上游 `MasterEvent` 当前为空（游戏初期），`/searchEvent` 只能返回"无结果"
- **分数线/账号绑定**：`/cutoffAll`、`/cutoffDetail`、`/cutoffListOfRecentEvent`、`/user`（tsugu 的账号绑定）未实现，统一 404 占位。`/searchPlayer` 已实现，但默认数据源只能查到 StarMoe 已验证公开的账号（见第 5 节）
- **BandoriStation 外发**：未实现，`bandoriStationToken` 字段接受但忽略
- **鉴权**：本服务与社区写操作都没有鉴权，未设计用户体系
- **抽卡模拟**：10 连保底为按游戏规则的近似；卡池无 lot 数据时退回 `GACHA_DEFAULT_RATES` 估计值兜底
- **区域**：四个区域（tw/jp/kr/en）都已支持。**港澳台/韩/国际三服在上游目前是同一份内容**（同版本），故三服统一取港澳台的数据展示；jp 已分叉。区域间真正的差异要等上游放量
- **公告推送**：是轮询而非真正的事件推送（上游无此能力），延迟受 `ANNOUNCEMENT_POLL_S` 限制；只推新增/修改，下架不推（客户端可定期用一次性接口对账）；进程重启后订阅者需要重连（SSE 客户端通常自带重连）
- **公告正文**：去 HTML 标签后按纯文本排版，不还原富文本样式（表格/图片/颜色会丢失）
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
