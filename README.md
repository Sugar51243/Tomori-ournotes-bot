# Tomori — Our Notes 后端 API

**文档索引**

| 文档 | 内容 |
| --- | --- |
| [doc/endpoint.md](doc/endpoint.md) | 全部端点、请求参数、响应约定 |
| [doc/fuzzySearch.md](doc/fuzzySearch.md) | 模糊搜索机制（别名索引、搜索优先级、用户关键词） |
| [doc/config.md](doc/config.md) | `.env` 全部配置项 |
| [doc/community.md](doc/community.md) | 社区功能（交友 / 车站 / 关键词）与 MongoDB 部署 |
| [gateway/README.md](gateway/README.md) | 账号查询的数据源说明与 moenotes-api 自建网关教程 |

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

**沿用的部分**：部分框架、端点命名、请求字段及响应协议。

**由于OurNotes从底层开始已经与老BangDream手游有所区别，如谱面渲染、活动榜线等功能在具体实现与端点使用意义上已经无可避免的与Tsugu有所区分。具体请按 [doc/endpoint.md](doc/endpoint.md) 的端点表进行查询。**

## 4. 数据来源

项目数据皆源于`bdon.moe`及其子域/副网点

- 数据**实时代理**，本仓库**不打包任何官方素材**；素材版权归 Bushiroad / 官方所有
- 对上游**礼貌限流**：每主机并发 4、间隔 100ms
- 缓存 TTL 等可在 `.env` 调整，见 [doc/config.md](doc/config.md)

## 5. 部署步骤与依赖声明

### 依赖声明

- **运行时**：Node.js **>= 20**（见 `package.json.engines`）
- **npm 依赖**：`express` / `express-validator`（HTTP 与参数校验）、`axios`（上游请求）、`dotenv`（配置）、`@napi-rs/canvas`（**原生模块**，出图）、`mongodb`（仅社区功能）
- **开发依赖**：`typescript` / `tsx` / `@types/node` / `@types/express`
- **系统字体**（出图必需）：中文走 `Microsoft YaHei`，符号与 emoji 回退 `Segoe UI Symbol` / `Segoe UI Emoji`。**Linux 部署需自备中文字体**，否则出图中文异常
- **MongoDB**：可选，仅交友/车站/关键词需要（见 [doc/community.md](doc/community.md)）
- **网络**：需能访问 `metadata.bdon.moe`、`assets.bdon.moe`、`api.bdon.moe`（公告/排行）、`storage.bdon.moe`（歌曲meta 的谱面效率数据）与 `bdon.moe`（账号查询与国旗图标）

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
2. 默认监听 `http://127.0.0.1:3000`（`PORT` 可改）；用 `GET /health` 检查，返回各区域 dataVersion 与运行时长
3. 缓存目录默认 `./cache`（已 gitignore），可整目录删除后按需重建
4. 可选：启用社区功能需装 MongoDB 并配置 `.env`，见 [doc/community.md](doc/community.md)

> **本服务没有任何访问鉴权**，不要直接暴露到公网；仅建议本机或内网自用。

## 7. 个人声明

AI代码意外的清晰易懂，没那么屎山，**项目基础链路已经确认**。<br>
首先说一下**我做了什么**:<br>
1. 从路由开始手动**追踪具体查询流程**，然后**到渲染那步停下**了。
2. 手动**排清端点以及配置文件参数**，然后要求AI以固定格式补充说明了一波。
3. 向AI重新**指定了模糊搜索的规则和适用范围**。
4. 对于越堆越多的奇怪端点参数做了一波清洗，**指定了服务器传入规则**。
5. 用文件夹**按功能分类了代码文件**，要人为修改的时候好找一点。

Tomori作为一个本地项目本来就没有多少安全性和稳定性问题，功能也偏向齐全。虽然使用vibe coding开发，但是决策层基本都是本人手动决定。加上多次目视检查和人为补充bug原因干扰AI的项目迭代，质量上应该还是有基础保证的。<br>
<br>
榜线以及查玩家落实不到位主要是在于**游戏本身限制**导致的，我也无可奈何。<br>
介于目前**查玩家只能做到查用户名片**，**活动排名只有100名**，后续**玩家账号相关开发会直接停滞**，**榜线也只能停留在100t**的情况。**非常抱歉**。<br>
<br>
有任何问题欢迎给我提issue，或者开讨论。直接通过QQ群找到我反映也可以。我很乐意按需求进一步更新项目。

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
