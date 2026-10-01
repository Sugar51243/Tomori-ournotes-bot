# gateway —— moenotes-api 自建网关速搭

给 `/searchPlayer` 提供**查任意玩家**能力的可选组件。不搭也能用：默认走站点公开接口，
但那条路径只能查到「已在 [bdon.moe/account](https://bdon.moe/account) 添加并验证游戏账号、且个人主页设为公开」的账号。

> 上游项目：[StarMoe-org/moenotes-api](https://github.com/StarMoe-org/moenotes-api)（Rust，实验性，有限实测验证）。
> 本目录只有一个速搭脚本，网关本体是官方镜像。

## 快速开始

```bat
setup-gateway.bat            :: 建目录 / 拉镜像 / 生成 config.toml 并写入随机 api_key
setup-gateway.bat run        :: 启动容器
setup-gateway.bat status     :: 探测 /healthz 与 /v1/status
```

其他子命令：`stop`（停止）、`logs`（跟踪日志）、不带参数等于 `init`。

## 目录

| 路径 | 用途 |
| --- | --- |
| `data/` | 挂进容器 `/var/lib/moenotes`：`config.toml` 与运行状态（**含 api_key，勿提交**） |
| `accounts/` | 挂进容器 `/accounts`（只读）：游戏账号 JSON（**含密码，勿提交**） |

两个目录由脚本创建，已在 `.gitignore` 里排除。

## 还需要手动做的

1. **填 `data/config.toml`**
   - `[session]`：区域、被许可的游戏 origin、平台、客户端/数据版本
   - 多区域各自一段 `[regions.en]` / `[regions.kr]`（区域凭据不继承；日服见上游 `docs/jp-accounts.md`，要单独导入凭据）
   - `listen` 保持 `0.0.0.0:8080`（容器内），`api_key` 已由脚本写好
2. **放账号**：`accounts/` 下一个账号一个 JSON，形如
   ```json
   {"user":"你的账号","password":"你的密码"}
   ```
   日服放 `accounts/jp/`；文件权限设成仅本人可读。
3. **接上机器人**（项目根目录 `.env`）：
   ```
   MOENOTES_API_BASE=http://127.0.0.1:8080
   MOENOTES_API_KEY=<data/config.toml 里的 api_key>
   ```
   重启后 `/health` 的 `playerGateway` 变 `true`，`/searchPlayer` 自动切到网关，不用改代码。

## 接口形状（本服务已在用）

`GET {base}/v1/{server}/profile/{id}`，头 `Authorization: Bearer <api_key>`；响应是未加工的 protobuf JSON（int64 为十进制字符串），取数时间与缓存状态在响应头。另有 `/v1/profile/{id}`（按 ID 首位自动选区域）与 `/v1/{region}/profile/{profileId}/card/{page}`（个人名片 PNG 代理）。

## 注意

- 网关**持有游戏凭据**：只监听本机（脚本已固定 `127.0.0.1` 映射），或放在 TLS 反代之后，不要直接暴露公网。
- 镜像没有 `latest` 标签，升级请改脚本顶部的 `IMAGE` 版本号或 Release 里的 digest。
- `status` 里业务路由返回 503 表示配置没填全（容器只起健康监听），日志会列出缺哪些键。
- `check-config` 只做本地校验，不代表凭据有效。
