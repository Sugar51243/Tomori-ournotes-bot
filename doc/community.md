# 社区功能（交友 / 车站 / 关键词）

交友、车站与关键词的数据存在 MongoDB，**读写经「数据库 API」服务**（`database/` 项目，全系统唯一持有数据库凭据的进程）—— 本进程不再直连 Mongo。端点参数见 [endpoint.md](endpoint.md)，关键词的搜索机制见 [fuzzySearch.md](fuzzySearch.md)，配置项见 [config.md](config.md)。

## 用法

| 功能 | 用法 |
| --- | --- |
| 交友登记 | `POST /friend/upload`，一人一条（同 `userId` 覆盖），`server` 支持港澳台服/日服/国际服/韩服 |
| 删除交友 | `POST /friend/delete`，自报 `userId` 即删 |
| 交友列表 | `POST /friend/list`，出图，按 `FRIENDS_PER_PAGE`（默认 30 人）分页 |
| 上传关键词 | `POST /keyword/upload`，为角色/角色卡/支援卡/歌曲/乐团挂别名，上传时查重 |
| 删除关键词 | `POST /keyword/delete`，只能删自己上传的（按 `userId` 过滤） |
| 上传车牌 | `POST /station/submitRoomNumber`，同房号重复提交 = 刷新有效期 |
| 车站查询 | `GET`/`POST /station/queryAllRoom` 出 JSON；`POST /roomList` 出图（传 `roomList` 则直接渲染不查库） |

## 行为说明

- **连接**：经 `src/db/apiClient.ts` 调「数据库 API」的 `/v1/friends|stations|keywords|bindings` 语义化端点（HTTP + Bearer 令牌）。集合索引由数据库 API 启动时统一创建 —— `friends.userId` 唯一、`stations.expireAt` 为 TTL 索引（`expireAfterSeconds: 0`）+ `stations.number` 唯一、`keywords` 的 `(entityType, entityId, normKeyword)` 唯一（并发下同实体重复上传只会成功一条）。API 连不上时相关命令按「服务器未启用数据库」处理，与旧版直连失败时的行为一致。
- **关键词生效**：关键词不写进模糊索引的磁盘缓存，而是作为**独立覆盖层**在内存里合并（`src/fuzzySearch.ts` 的 `setKeywordOverlay`）；上传/删除立即强刷，并让渲染缓存换代。
- **车站过期**：TTL 后台约每 60s 清理，查询侧另带 `expireAt > now` 过滤（双保险），有效期由**数据库 API 的 `STATION_TTL_S`** 统一控制（默认 150s，同 tsugu；本进程不再配置）。
- **交友头像**：从 `avatarUrl` 拉取并走磁盘缓存；**只允许 `https://` + `qlogo.cn` 域**（避免 SSRF 内网探测），其余用「确定性颜色 + 名字首字符」占位块。
- **鉴权**：与 tsugu 同类接口一样**没有鉴权**，写操作以自报 `userId`(QQ 号) 为准，伪造 QQ 号即可删他人记录 —— 仅适合自建小圈子。
- **未启用数据库时**：`/friend/*`、`/keyword/*`、`/station`、`/roomList` 返回 404 占位「错误: 服务器未启用数据库」（同 tsugu 无 DB 时的行为），其余端点不受影响。

## 部署

1. 部署并启动「数据库 API」（`database/` 项目）；MongoDB 连接信息（`MONGODB_URI`/`MONGODB_DB`）
   与集合索引都由它持有和创建，见 `database/README.md`。

2. 在 bot 的 `.env` 中启用（各项含义见 [config.md](config.md)）：

   ```ini
   ENABLE_DB=true                        # 总开关；false 时交友/车站/关键词走 404 占位
   DB_API_BASE_URL=http://127.0.0.1:3004 # 数据库 API 地址(同时也是榜线历史的存储)
   DB_API_TOKEN=<与 database/ 的 DB_API_TOKENS 里 bot= 同值>
   ```

3. 重启服务（`start.bat` 或 `npm start`）；数据库 API 不可用时相关端点按「服务器未启用数据库」处理。

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

