# Tomori — Our Notes 后端 API

**文档索引**

| 文档 | 内容 |
| --- | --- |
| [doc/framework.html](doc/framework.html) | **项目框架图**（交互式）：请求主路径、数据源回退机制、两个数据库、后台任务 |
| [doc/endpoint.md](doc/endpoint.md) | 全部端点、请求参数、响应约定 |
| [doc/fuzzySearch.md](doc/fuzzySearch.md) | 模糊搜索机制（别名索引、搜索优先级、用户关键词） |
| [doc/config.md](doc/config.md) | `.env` 配置项与代码常量（缓存 TTL） |
| [doc/community.md](doc/community.md) | 社区功能（交友 / 车站 / 关键词）与 MongoDB 部署 |
| [gateway/README.md](gateway/README.md) | 账号查询的数据源说明与 moenotes-api 自建网关教程 |

> 框架图说明（[doc/framework.html](doc/framework.html)，浏览器打开，支持深浅色切换 / 缩放 / 章节视图）：
> - **数据源回退**：主源 `DATA_SOURCE` → 备用源 `BACKUP_SOURCE` → `bdon.moe` 兜底（去重），任一源失败（含 404）即回退，全败报「上游崩溃」
> - **两个数据库**：MongoDB 只存社区数据（交友/车站/关键词）；榜线历史存 MySQL（失败自动回退 SQLite 缓冲并回灌）
> - **后台任务**：榜线每小时采样写库；公告轮询经 SSE 推送给订阅方

---

## 1. 项目简介

本项目是《BanG Dream! Our Notes》的后端 API 服务（项目代号 **Tomori**）：实时代理 bdon 数据源，把游戏数据渲染成图片（或返回 JSON），供机器人 / 客户端调用。功能覆盖公告、歌曲与谱面、卡片、角色、乐团、活动与榜线、卡池与抽卡模拟、账号档案、贴纸，以及交友 / 车站等社区功能；响应协议与 [tsugu 后端](https://github.com/Yamamoto-2/tsugu-bangdream-bot) 兼容。<br>
<br>
**已在官方QQ机器人(偷摸零)上线，欢迎使用**

## 2. vibe coding 声明

本项目是 **vibe coding** 产物：代码由 AI 按对话迭代生成，**未经人工逐行审查**，验证以"接口跑通 + 出图目检"为主。

- 不保证正确性、安全性、稳定性与长期维护；请自行评估后使用
- 上游数据与接口随时可能变动，本项目不承诺跟进
- 欢迎 fork / 修改 / 提 issue，但不保证响应

## 3. 前身：Tsugu 后端

本服务是 tsugu 后端的 **Our Notes 版重写**，不是其官方分支，与 tsugu 作者无隶属关系。

**沿用的部分**：端点命名、请求字段及响应协议。

**由于OurNotes从底层开始已经与老BangDream手游有所区别，如谱面渲染、活动榜线等功能在具体实现与端点使用意义上已经无可避免的与Tsugu有所区分。具体请按 [doc/endpoint.md](doc/endpoint.md) 的端点表进行查询。**

## 4. 数据来源

项目数据源于`bdon.moe`及其子域/副网点，可选备用源 [haneoka.org](https://haneoka.org)（活动/曲榜排行、玩家查询与乐曲分析；只访问发行数据集，不接超前内容）。出图与接口会标注实际供数的来源。

**网页平台（`web/`）对接**（可选，`WEB_PLATFORM_*`，见 [doc/config.md](doc/config.md) 的「网页平台对接」节）：查玩家会附带网页账号包数据（歌曲完成状态、乐队道具、各乐队理论最高综合力队伍），并提供查名片、B25、组卡工具与玩家绑定；两个项目以 HTTP API 交接，展示范围遵循网页的公开开关（绑定本人也一样）。

- 数据**实时代理**，本仓库**不打包任何官方素材**；素材版权归 Bushiroad / 官方所有
- 对上游**礼貌限流**：每主机并发 4、间隔 100ms
- 上游限流、监听地址等可在 `.env` 调整；缓存 TTL 是代码常量（`src/config/ttl.ts`），见 [doc/config.md](doc/config.md)

## 5. 部署步骤与依赖声明

### 依赖声明

- **运行时**：Node.js **>= 20**（见 `package.json.engines`）
- **npm 依赖**：`express` / `express-validator`（HTTP 与参数校验）、`axios`（上游请求）、`dotenv`（配置）、`@napi-rs/canvas`（**原生模块**，出图）、`mongodb`（仅社区功能）
- **开发依赖**：`typescript` / `tsx` / `@types/node` / `@types/express`
- **系统字体**（出图必需）：中文走 `Microsoft YaHei`，符号与 emoji 回退 `Segoe UI Symbol` / `Segoe UI Emoji`。**Linux 部署需自备中文字体**，否则出图中文异常
- **MongoDB**：可选，仅交友/车站/关键词需要（见 [doc/community.md](doc/community.md)）
- **网络**：需能访问 `metadata.bdon.moe`、`assets.bdon.moe`、`api.bdon.moe`（公告/排行）、`storage.bdon.moe`（歌曲meta 的谱面效率数据）与 `bdon.moe`（账号查询与国旗图标）；选了 `haneoka.org` 作为数据源时还需能访问 `haneoka.org`

### 部署步骤

Windows 一键（自动检查 Node、安装依赖、生成 `.env`、构建并启动）：

| 脚本 | 用途 |
| --- | --- |
| `start.bat` | 生产模式：构建后以 `node dist/app.js` 启动（日常使用） |
| `dev.bat` | 开发模式：`tsx watch`，改源码自动重启（调试用） |

手动部署（任意平台）：

```bash
npm install
cp .env.example .env    # 按需修改，全部配置项见 doc/config.md
npm run build && npm start
# 开发模式: npm run dev
```

## 6. 启动步骤

1. 启动服务：`npm start`（或 `start.bat` / 开发用 `dev.bat`）
2. 默认监听 `http://127.0.0.1:3000`（`PORT`/`LOCATION` 可改；`LOCATION=0.0.0.0` 对外公开）；用 `GET /health` 检查，返回各区域 dataVersion 与运行时长
3. 缓存目录默认 `./cache`（已 gitignore），可整目录删除后按需重建
4. 可选：启用社区功能需装 MongoDB 并配置 `.env`，见 [doc/community.md](doc/community.md)

> **本服务没有任何访问鉴权**，不要直接暴露到公网；仅建议本机或内网自用。

## 7. 个人声明

我仔细想了一下，继续使用Tsugu框架不一定便利后续开发，所以**重新指定了项目框架**。<br>
现在的**数据源和数据库是单独拆出来的**，就像一个插件一样只弄一个对应的解释器就能直接用在后续功能，不用再改一堆东西了。<br>
允许了**多源回退**机制，而且把数据库与数据源拆出来也能更好更方便的开发更多数据源切换。<br>
另外东西也**分成了路由、上游、搜索、数据处理和渲染**，该改哪直接看哪就行。<br>
数据库采用了双库，**车站和交友的社区功能采用MongoDB**，有TTL索引方便删除，用户数据存起来也更易懂。**榜线则改成了MySQL**，**失败回退SQLite**，允许本机，也允许未来改成分布式，甚至多端。<br>
模糊搜索加了一堆机制，自己看去吧。就差没有引入AI了。[doc/fuzzySearch.md](doc/fuzzySearch.md)<br>
改动大概就这些了。

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
