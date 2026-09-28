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
| `metadata.bdon.moe` | master 数据：`current_version.json` 与 Master 表（歌曲/卡片/角色/卡池/活动/贴纸），含文本本地化 |
| `assets.bdon.moe` | 谱面 bundle（`chart-site/charts/{musicId}_{difficulty}.json` → `score/*.notes.json`）、谱面渲染素材（音符精灵贴图集）、卡面原图、贴纸素材 |
| 磁盘缓存 `./cache` | 上述资源的 TTL 缓存，ETag 重验证，断网时回退陈旧副本 |

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
- **网络**：需能访问 `metadata.bdon.moe` 与 `assets.bdon.moe`

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

**环境变量**（完整清单见 `.env.example`）：`PORT`、`META_BASE` / `ASSET_BASE`（上游地址）、`CACHE_DIR`、`DEFAULT_LOCALE` / `LOCALE_FALLBACKS`（文本语言回退链）、各项 TTL（`MASTERDATA_TTL_S` / `VERSION_TTL_S` / `CHART_MANIFEST_TTL_S` / `CHART_ASSET_TTL_S` / `IMAGE_TTL_S`）、`MAX_CONCURRENCY_PER_HOST` / `HTTP_TIMEOUT_MS`（上游限流与超时）、`LOG_LEVEL`、`GACHA_DEFAULT_RATES`（概率兜底）、数据库相关见第 6 节。

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

- **服务器字段**：`displayedServerList` / `mainServer` 为 tsugu 客户端兼容字段，游戏内容端点**只接受** `hk-tw-mo`。**例外**：交友的 `server` 额外接受 `jp` / `en` / `kr`（仅登记用，不影响任何游戏内容接口），其余值 400
- **字段类型**：各字段必须按声明类型传（如 `playerId` 为纯数字**字符串**，传数字或数组一律 400）
- **`compress`**：可选布尔，`true` 出 JPEG（默认），`false` 出 PNG

### 端点表

| 端点 | 请求体 | 说明 |
| --- | --- | --- |
| `GET /health` | — | 服务状态、master dataVersion、运行时长 |
| `/searchSong` | `displayedServerList`, `text` \| `fuzzySearchResult`, `compress?` | 整数 ID → 歌曲详情图；否则模糊搜索 → 列表图（命中单首直接出详情） |
| `/songMeta` | `displayedServerList`, `mainServer`, `compress?` | 全歌曲表（ID/标题/乐队/分类/四难度等级/EX 音符数/时长） |
| `/songChart` | `songId`, `difficultyId?`(0-3，默认 3), `mirror?`, `noteSpeed?`(1.00~12.00，默认 7.50；`speed` 同义), `compress?` | **Our Notes 风格谱面预览图**（24 轨 / chord / 滑条 / fever / 金色 critical 音符，信息条置顶） |
| `/songChartData` | `songId`, `difficultyId?`, `mirror?`, `format?`(`raw`/`simple`/`both`，默认 `simple`) | **谱面数据 JSON**（非 base64）：`meta` + 原始 nnnotes / 简化格式 |
| `/searchCard` | `displayedServerList`, `text` \| `fuzzySearchResult`, `cardType?`(`member`/`support`/`auto`，默认 `auto`), `useEasyBG?`(tsugu 兼容，忽略), `compress?` | **查卡（整合）**：角色卡与支援卡一起查，列表按种类分区；按 ID 查时 `auto` 先角色卡后支援卡 |
| `/searchMemberCard` | 同上（`cardType` 无效） | **查角色卡**（成员卡） |
| `/searchSupportCard` | 同上（`cardType` 无效） | **查支援卡**（留影） |
| `/searchCharacter` | `displayedServerList`, `text` \| `fuzzySearchResult`, `compress?` | 角色搜索 / 详情 |
| `/searchGacha` | `displayedServerList`, `gachaId`, `compress?` | 卡池详情 |
| `/searchEvent` | `displayedServerList`, `text` \| `fuzzySearchResult`, `compress?` | 活动搜索（当前游戏无活动数据，返回无结果） |
| `/gachaSimulate` | `mainServer`, `times?`(默认 10，上限 10000), `gachaId?`, `compress?` | 抽卡模拟：真实概率（MasterGachaLot 权重 → MasterGachaPrize 资源，含 UP 权重），不传 `gachaId` 取当前开放卡池，10 连保底；≤10 次逐个展示，>10 次计数汇总 |
| `/getCardIllustration` | `cardId`, `cardType?` | 卡面原图（角色卡 1440×1920 竖版 / 支援卡 1920×1080 横版） |
| `/songRandom` | `mainServer`, `text?` \| `fuzzySearchResult?`, `compress?` | 随机歌曲详情图 |
| `/getStampImage` | `stampId` | **查贴纸**：按数字 ID 直出官方贴纸原图（不需要数据库） |
| `/friend/upload` | `userId`, `userName`, `playerId`, `server`, `avatarUrl?` | **交友-登记/更新**：按 `userId`(QQ 号) upsert，一人一条；`server` 可为 `hk-tw-mo`/`jp`/`en`/`kr`（出图显示为港澳台服/日服/国际服/韩服） |
| `/friend/delete` | `userId` | **交友-删除**（弱鉴权：自报 QQ 号即可） |
| `/friend/list` | `compress?` | **交友列表图**：头像 + QQ 名 + QQ 号 + 游戏 ID + 服务器，每 30 人分页 |
| `/station/submitRoomNumber` | `number`, `rawMessage`, `platform`, `userId`, `userName`, `time`, `avatarUrl?`, `bandoriStationToken?` | **车站-上传/刷新**（字段与语义同 tsugu，同房号重复提交=刷新） |
| `/station/queryAllRoom` | —（GET 或 POST） | **车站-JSON 查询**：返回未过期房间列表 |
| `/roomList` | `roomList?`, `compress?` | **车站列表图**：传 `roomList` 数组则直接渲染该批（tsugu 兼容）；不传则查本服务数据库 |
| `/searchPlayer` `/cutoffAll` `/cutoffDetail` `/cutoffListOfRecentEvent` `/user` | — | **404 占位**：`错误: 服务器未启用数据库`（与 tsugu 无 DB 时一致）。`/user` 在 tsugu 是账号绑定 API，本服务不实现 |

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
- **玩家/分数查询**：`/searchPlayer`、`/cutoffAll`、`/cutoffDetail`、`/cutoffListOfRecentEvent`、`/user`（tsugu 的账号绑定）均未实现，统一 404 占位
- **BandoriStation 外发**：未实现，`bandoriStationToken` 字段接受但忽略
- **鉴权**：本服务与社区写操作都没有鉴权，未设计用户体系
- **抽卡模拟**：10 连保底为按游戏规则的近似；卡池无 lot 数据时退回 `GACHA_DEFAULT_RATES` 估计值兜底
- **区域**：游戏内容端点仅支持单区域 `hk-tw-mo`（交友登记除外）
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
