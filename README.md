# Tomori 项目组

《BanG Dream! Our Notes》相关的自建服务集合。本仓库（根目录）为**容器**，包含两个可独立部署的项目：

| 项目 | 说明 |
| --- | --- |
| [bot/](bot/) | **QQ 机器人后端（Tomori）**：实时聚合游戏数据源并渲染成图片 / JSON，响应协议与 [tsugu 后端](https://github.com/Yamamoto-2/tsugu-bangdream-bot) 兼容 |
| [database/](database/) | **数据库 API**：bot 与网页平台共用的 MySQL / MongoDB 存取服务；**全系统唯一持有数据库凭据的进程**，消费方只发语义化 HTTP 请求 |

> 另有**私有部署的网页平台**（社区论坛、账号包与组卡器、自制谱、Sonolus 等）不随本仓库发布；
> 它同样通过 HTTP API 与上面两个项目对接。

## 快速开始

**bot**（需要 Node.js ≥ 20）：

```bash
cd bot
npm install
cp .env.example .env      # 按需修改；全部配置项见 bot/doc/config.md
npm run build && npm start
```

Windows 下可直接双击 `bot/start.bat`（生产）或 `bot/dev.bat`（开发，改源码自动重启）。
数据源开箱即用（默认 `bdon.moe`，可配 haneoka.org 等回退源）；社区/榜线等数据库功能需要下面的 database 项目。

**database**（bot 与网页平台共用；只需要起一次）：

```bash
cd database
npm install
cp .env.example .env      # 填 DB_API_TOKENS 与 MYSQL_*/MONGODB_* 连接信息
npm run dev               # 默认 127.0.0.1:3004；Windows 可双击 start.bat / dev.bat
```

细节见各项目自己的 README：bot 的部署、端点、数据来源与配置；database 的协议、鉴权、模块表与公网部署要求。

## 进程管理与防误杀

三个项目的服务运行时会**给自己的控制台窗口命名**（程序自身设置，经 `.bat` 启动时同样生效），
标题里带实际端口 —— 多开时一眼能分清，也能按标题精确结束，不必 `taskkill /IM node.exe` 一把梭：

| 项目 | 窗口标题 |
| --- | --- |
| bot | `Tomori Bot [3002]` |
| database | `Tomori Database API [3004]` |
| 网页平台（私有） | `Tomori Web [80]`；其 `dev.bat` 另开两个子窗口 `Tomori Web API` / `Tomori Web Client` |

```bat
:: 只结束某一个项目（/T 连同其子进程）
taskkill /FI "WINDOWTITLE eq Tomori Bot*" /T /F
taskkill /FI "WINDOWTITLE eq Tomori Database API*" /T /F

:: 辨认：tasklist /V 的「窗口标题」列 / 任务管理器里对应窗口
```

> 不经过控制台的后台/服务化启动没有窗口标题，此时按端口定位：
> `netstat -ano | findstr :3002` 找到 PID 再 `taskkill /PID <pid> /T /F`。

## 许可证

MIT License，Copyright (c) 2026 Sugar51243（完整文本见 [bot/README.md](bot/README.md) 末尾）。
游戏素材版权归 Bushiroad / 官方所有，本仓库不打包任何官方素材。
