# 文件说明

本文件为《BanG Dream! Our Notes》的后端 API 服务（项目代号 **Tomori**）相关端点说明。

## 响应约定

除 `GET /health` 与公告推送（SSE）外，全部为 POST，请求体为 JSON。响应统一几种：

| 情况 | HTTP | 响应体 |
| --- | --- | --- |
| 成功（图片类） | 200 | `[{type:'string'\|'base64', string}]`（与 tsugu 一致） |
| 成功（JSON 类，如 `/songChartData`） | 200 | `{status:'success', data:…}` |
| 领域错误（无数据、参数合法但查不到等） | 200 | `['错误: …']` 字符串数组 / `{status:'failed', data:'错误: …'}` |
| 参数校验失败 | 400 | `{status:'failed', data:'参数错误', error:[…字段级原因]}` |
| 内部错误 | 500 | `{status:'failed', data:'内部错误'}` |

- **`compress`**：可选布尔，`true` 出 JPEG，`false` / 不传 出 PNG。
- **服务器参数**统一为 `displayedServerList`：单个（`"jp"`）或数组（`["jp","tw"]`）都接受，可缺省；区域可写 `tw` / `jp` / `kr` / `en` 或别名 `hk-tw-mo` / `hk`，其余值一律 400。单服端点取首个，单服回退端点按输入顺序依次查询，多服端点全部使用；缺省时单服用默认服、其余用全部四服。
- 出图语言与素材以所选服务器为准；详情图中各服信息「该服自己有就用自己的，没有才回退港澳台」。
- 文字搜索可搜什么、怎么匹配，见 [fuzzySearch.md](fuzzySearch.md)。

## 公告 (announcement)

Tomori提供基础的游戏公告订阅及查询服务，以下为相关端点:

**一次性公告查询** 
`POST /announcements`
| 变量名 | 种类/可用参数 | 是否必选 | 说明 |
| --- | --- | --- | --- |
| displayedServerList | 'tw' / 'jp' / 'kr' / 'en'（单个或数组） | 否 | 查询的游戏服务器，取首个；不传用默认服 |
| id | int | 否 | 要查的对应公告ID，留空即返回公告列表 |
| compress | bool | 否 | 输出格式为PNG还是JPEG(false为JPEG) |

**公告推送** 
`GET /announcementStream/{Server}` 此功能使用SSE长连接推送，每个服务器各使用一个端点，以下为端点参考:
| 端点 | 服务器 |
| --- | --- |
| /tw | 台服 |
| /jp | 日服 |
| /kr | 韩服 |
| /en | 国际服 |

- **只在公告新增或修改时**推送 `announcement` 事件（含该条公告的详情图 base64，与其它接口的 `{type,string}` 同构）；连接时不发快照，下架也不推 —— 需要全量列表请用上面的一次性查询接口
- 连接后先收到 `ready` 握手事件（含轮询间隔），之后有心跳保活；同一服支持任意多个客户端同时连接

## 乐团 (band)

Tomori提供基础的游戏乐团查询服务，以下为相关端点:

**查询** 
`POST /searchBand` 注意fuzzySearchResult与text只能二选一输入
| 变量名 | 种类/可用参数 | 是否必选 | 说明 |
| --- | --- | --- | --- |
| displayedServerList | 'tw' / 'jp' / 'kr' / 'en'（单个或数组） | 否 | 只决定主体(名称/素材/语言)的取数服：按输入顺序取首个收录该乐团的服；图内恒列四服对比 |
| fuzzySearchResult | FuzzySearchResult | 否 | 经`/fuzzySearch`端点模糊搜索的结果 |
| text | string | 否 | 搜索文本；纯数字字符串时按乐团ID直接查详情；也可**按角色名**搜索(出该角色所属乐团) |
| compress | bool | 否 | 输出格式为PNG还是JPEG(false为PNG) |

## 歌曲 (song)

Tomori提供游戏歌曲的查询、谱面渲染、随机点歌与排行服务，以下为相关端点:

**歌曲查询** 
`POST /searchSong` 注意fuzzySearchResult与text只能二选一输入
| 变量名 | 种类/可用参数 | 是否必选 | 说明 |
| --- | --- | --- | --- |
| displayedServerList | 'tw' / 'jp' / 'kr' / 'en'（单个或数组） | 否 | 只决定主体(曲名/素材/语言)的取数服：按输入顺序取首个收录该曲的服；图内恒列四服对比 |
| fuzzySearchResult | FuzzySearchResult | 否 | 经`/fuzzySearch`端点模糊搜索的结果 |
| text | string | 否 | 搜索文本；纯数字字符串时按歌曲ID直接查详情；也可按**乐团/角色/活动名**搜索(出对应歌曲) |
| singleDraw | 'detail' / 'chart' | 否 | 模糊搜索唯一命中时的出图方式：detail出歌曲详情(默认)，chart直接出该曲谱面图 |
| difficultyId | int (0-3) | 否 | singleDraw=chart时的难度：0=EASY / 1=NORMAL / 2=HARD / 3=EXPERT(默认) |
| mirror | bool | 否 | singleDraw=chart时镜像谱面 |
| noteSpeed / speed | float (1.00-12.00) | 否 | singleDraw=chart时的预览流速，默认7.50 |
| compress | bool | 否 | 输出格式为PNG还是JPEG(false为PNG) |

按ID查询或模糊搜索唯一命中时出歌曲详情图(下方附各服信息行)；命中多个出歌曲列表图。text与fuzzySearchResult同时存在或同时不存在会返回422错误。

**谱面数据(JSON)** 
`POST /songChartData` 输出纯JSON，不base64
| 变量名 | 种类/可用参数 | 是否必选 | 说明 |
| --- | --- | --- | --- |
| displayedServerList | 'tw' / 'jp' / 'kr' / 'en'（单个或数组） | 否 | 按输入顺序取首个收录该曲的服；仅影响标题/难度的取数来源，谱面数据全区共享 |
| songId | int | 是 | 歌曲ID |
| difficultyId | int (0-3) | 否 | 难度，默认3 |
| mirror | bool | 否 | 是否镜像谱面 |
| format | 'raw' / 'simple' / 'both' | 否 | 返回内容，默认simple |

成功返回`{status:'success', data:{meta, raw?, simple?}}`；歌曲/难度不存在返回`{status:'failed', data:'错误: …'}`(HTTP 200)。

**谱面图** 
`POST /songChart` 支持数字ID直查或文字搜索（songId 与 text / fuzzySearchResult 三选一）
| 变量名 | 种类/可用参数 | 是否必选 | 说明 |
| --- | --- | --- | --- |
| displayedServerList | 'tw' / 'jp' / 'kr' / 'en'（单个或数组） | 否 | 按输入顺序取首个收录该曲的服 |
| songId | int | 否 | 歌曲ID |
| text | string | 否 | 搜索文本；纯数字字符串按歌曲ID处理；也可按**乐团/角色/活动名**搜索 |
| fuzzySearchResult | FuzzySearchResult | 否 | 经`/fuzzySearch`端点模糊搜索的结果 |
| difficultyId | int (0-3) | 否 | 难度，默认3(EXPERT) |
| mirror | bool | 否 | 是否镜像谱面 |
| noteSpeed / speed | float (1.00-12.00) | 否 | 预览流速，默认7.50 |
| compress | bool | 否 | 输出格式为PNG还是JPEG(false为PNG) |

文字搜索唯一命中出该曲谱面图，多命中出歌曲列表图。

**随机歌曲** 
`POST /songRandom` 多服
| 变量名 | 种类/可用参数 | 是否必选 | 说明 |
| --- | --- | --- | --- |
| displayedServerList | 'tw' / 'jp' / 'kr' / 'en'（单个或数组） | 否 | 查询的游戏服务器，输入的服全部使用（信息行）；不传用全部四服 |
| text | string | 否 | 搜索文本，从命中的歌曲中随机 |
| fuzzySearchResult | FuzzySearchResult | 否 | 经`/fuzzySearch`端点模糊搜索的结果 |
| compress | bool | 否 | 输出格式为PNG还是JPEG(false为PNG) |

text与fuzzySearchResult都不传时从全部歌曲中随机，输出随机歌曲详情图。

**歌曲排行** 
`POST /songRanking` 单服(用户动态数据)
| 变量名 | 种类/可用参数 | 是否必选 | 说明 |
| --- | --- | --- | --- |
| displayedServerList | 'tw' / 'jp' / 'kr' / 'en'（单个或数组） | 否 | 查询的游戏服务器，取首个；不传用默认服 |
| songId | int | 是 | 歌曲ID |
| compress | bool | 否 | 输出格式为PNG还是JPEG(false为PNG) |

输出该曲前十名用户的排行图(名次/玩家名/出分)。

**歌曲meta · 效率排行** 
`POST /songMeta` 多服，数值全服通用
| 变量名 | 种类/可用参数 | 是否必选 | 说明 |
| --- | --- | --- | --- |
| displayedServerList | 'tw' / 'jp' / 'kr' / 'en'（单个或数组） | 否 | 查询的游戏服务器，输入的服全部使用(决定曲名/乐团语言与封面取图，按输入顺序优先) |
| compress | bool | 否 | 输出格式为PNG还是JPEG(false为PNG) |

一图两榜：击奏live与自由live各自效率最高的前15张谱面，难度四难度混排。

## 卡片 (card)

Tomori提供游戏卡片(角色卡/支援卡)的查询与原图服务，以下为相关端点:

**综合查卡** 
`POST /searchCard` 角色卡与支援卡一起查询，注意fuzzySearchResult与text只能二选一输入
| 变量名 | 种类/可用参数 | 是否必选 | 说明 |
| --- | --- | --- | --- |
| displayedServerList | 'tw' / 'jp' / 'kr' / 'en'（单个或数组） | 否 | 只决定主体(卡面/语言)的取数服：按输入顺序取首个收录该卡的服；图内恒列四服对比 |
| fuzzySearchResult | FuzzySearchResult | 否 | 经`/fuzzySearch`端点模糊搜索的结果 |
| text | string | 否 | 搜索文本；纯数字字符串时按卡片ID直接查详情；也可按**角色/乐团/活动/卡池名**搜索(出对应卡片) |
| cardType | 'member' / 'support' / 'auto' | 否 | 卡片种类，默认auto(先角色卡后支援卡) |
| compress | bool | 否 | 输出格式为PNG还是JPEG(false为PNG) |

按ID查询或模糊搜索唯一命中时出卡片详情图；命中多个出卡片列表图(按种类分区)。

**查角色卡** 
`POST /searchMemberCard` 仅查询成员卡(角色卡)；displayedServerList / text / fuzzySearchResult / compress 同`/searchCard`

**查支援卡** 
`POST /searchSupportCard` 仅查询支援卡；displayedServerList / text / fuzzySearchResult / compress 同`/searchCard`

**卡片原图** 
`POST /getCardIllustration`
| 变量名 | 种类/可用参数 | 是否必选 | 说明 |
| --- | --- | --- | --- |
| displayedServerList | 'tw' / 'jp' / 'kr' / 'en'（单个或数组） | 否 | 按输入顺序取首个收录该卡的服出图 |
| cardId | int | 是 | 卡片ID |
| cardType | 'member' / 'support' / 'auto' | 否 | 卡片种类，默认auto(先角色卡后支援卡) |

角色卡与支援卡ID空间重叠，按ID查询时以cardType区分。输出卡面原图，无画布加工。

## 角色 (character)

Tomori提供游戏角色查询服务，以下为相关端点:

**查询** 
`POST /searchCharacter` 注意fuzzySearchResult与text只能二选一输入
| 变量名 | 种类/可用参数 | 是否必选 | 说明 |
| --- | --- | --- | --- |
| displayedServerList | 'tw' / 'jp' / 'kr' / 'en'（单个或数组） | 否 | 只决定主体(名称/立绘/语言)的取数服：按输入顺序取首个收录该角色的服；图内恒列四服对比 |
| fuzzySearchResult | FuzzySearchResult | 否 | 经`/fuzzySearch`端点模糊搜索的结果 |
| text | string | 否 | 搜索文本；纯数字字符串时按角色ID直接查详情；也可按**乐团名/活动名**搜索(出对应角色) |
| compress | bool | 否 | 输出格式为PNG还是JPEG(false为PNG) |

按ID查询或模糊搜索唯一命中时出角色详情图，下方附各服信息行；命中多个出角色列表图。

## 活动 (event)

Tomori提供活动查询、活动歌榜、活动推荐曲与活动榜线服务，以下为相关端点:

**活动查询** 
`POST /searchEvent` 注意fuzzySearchResult与text只能二选一输入
| 变量名 | 种类/可用参数 | 是否必选 | 说明 |
| --- | --- | --- | --- |
| displayedServerList | 'tw' / 'jp' / 'kr' / 'en'（单个或数组） | 否 | 查询的游戏服务器，按输入顺序取首个收录该活动的服 |
| fuzzySearchResult | FuzzySearchResult | 否 | 经`/fuzzySearch`端点模糊搜索的结果 |
| text | string | 否 | 搜索文本；纯数字字符串时按活动ID直接查详情；也可按**乐团/角色/卡池/卡片/歌曲**搜索(出相关活动)；支持「进行中」等状态词与日期串 |
| compress | bool | 否 | 输出格式为PNG还是JPEG(false为PNG) |

渲染模式：回退链上找到收录该活动的服时出活动丰富详情图；模糊搜索命中多个活动出活动列表图；四个服都没有该活动时出多服组合表(缺的服显示「未收录」占位)，全都没有才返回「该活动不存在」。

**活动歌榜** 
`POST /eventSongRanking` 单服(用户动态数据)
| 变量名 | 种类/可用参数 | 是否必选 | 说明 |
| --- | --- | --- | --- |
| displayedServerList | 'tw' / 'jp' / 'kr' / 'en'（单个或数组） | 否 | 查询的游戏服务器，取首个；不传用默认服 |
| id / eventId | int | 否 | 活动ID，两者同义；不传时取该服当前开放的活动 |
| rank | int (10/100/1000/5000/10000) | 否 | 榜线档位，取「到该名次为止的10名」(如rank=100取第91~100名)，不传即前10 |
| compress | bool | 否 | 输出格式为PNG还是JPEG(false为PNG) |

一张图画出该活动每个乐曲的榜单(名次/玩家名/综合力/出分)。上游每曲榜固定只给前100名，数据不支持的档位返回领域错误并列出可用档位，某一曲榜不足该档时只在该段标注。

**活动推荐曲** 
`POST /eventRecommend` 单服
| 变量名 | 种类/可用参数 | 是否必选 | 说明 |
| --- | --- | --- | --- |
| displayedServerList | 'tw' / 'jp' / 'kr' / 'en'（单个或数组） | 否 | 查询的游戏服务器，按输入顺序取首个有该活动(未指定id时为当前活动)的服 |
| id / eventId | int | 否 | 活动ID，两者同义；不传时取当前开放的活动 |
| compress | bool | 否 | 输出格式为PNG还是JPEG(false为PNG) |

一张图三截：击奏live、自由live(各按目标评级SS/S/A/B分段，每段所需综合力最低的前10张)与挑战live(只能选活动挑战曲)，只收HD/EX难度。

**活动榜线** 
`POST /cutoffAll` 单服(用户动态数据，各档分数随时间的折线图)
| 变量名 | 种类/可用参数 | 是否必选 | 说明 |
| --- | --- | --- | --- |
| displayedServerList | 'tw' / 'jp' / 'kr' / 'en'（单个或数组） | 否 | 查询的游戏服务器，取首个；不传用默认服 |
| id / eventId | int / string | 否 | 数字为活动ID；传文本时走模糊搜索(命中多个返回活动列表图) |
| text | string | 否 | 活动模糊搜索文本 |
| fuzzySearchResult | FuzzySearchResult | 否 | 经`/fuzzySearch`端点模糊搜索的结果 |
| rank | int (10/100/1000/5000/10000) | 否 | 只画某一档榜线，不传则画全部支持的档位 |
| compress | bool | 否 | 输出格式为PNG还是JPEG(false为PNG) |

上游没有历史接口，数据由本服务按小时自行采样(配置MongoDB则落库，否则仅存进程内存)。档位按数据适配：上游每曲榜只有前100名，实际可用10/100两档。

## 卡池 (gacha)

Tomori提供游戏卡池查询与抽卡模拟服务，以下为相关端点:

**卡池查询** 
`POST /searchGacha` 支持数字ID直查或文字搜索（gachaId 与 text / fuzzySearchResult 三选一）
| 变量名 | 种类/可用参数 | 是否必选 | 说明 |
| --- | --- | --- | --- |
| displayedServerList | 'tw' / 'jp' / 'kr' / 'en'（单个或数组） | 否 | 按输入顺序取首个收录该卡池的服 |
| gachaId | int | 否 | 卡池ID |
| text | string | 否 | 搜索文本；纯数字字符串按卡池ID处理；也可按**卡片/乐团/角色/活动名**搜索(出相关卡池) |
| fuzzySearchResult | FuzzySearchResult | 否 | 经`/fuzzySearch`端点模糊搜索的结果 |
| compress | bool | 否 | 输出格式为PNG还是JPEG(false为PNG) |

唯一命中出卡池详情图，多命中出卡池列表图。

**抽卡模拟** 
`POST /gachaSimulate` 单服
| 变量名 | 种类/可用参数 | 是否必选 | 说明 |
| --- | --- | --- | --- |
| displayedServerList | 'tw' / 'jp' / 'kr' / 'en'（单个或数组） | 否 | 查询的游戏服务器，取首个；不传用默认服 |
| times | int | 否 | 抽卡次数，默认10，上限10000 |
| gachaId | int | 否 | 卡池ID，不传时取该服当前开放卡池 |
| compress | bool | 否 | 输出格式为PNG还是JPEG(false为PNG) |

按真实概率模拟(含UP权重)，10连保底；不超过10次逐个展示，超过则计数汇总。

## 账号 (player)

Tomori提供玩家账号档案查询服务，以下为相关端点:

**账号查询** 
`POST /searchPlayer` 单服(用户动态数据)
| 变量名 | 种类/可用参数 | 是否必选 | 说明 |
| --- | --- | --- | --- |
| playerId | number / string | 是 | 玩家ID，数字与纯数字字符串都接受 |
| displayedServerList | 'tw' / 'jp' / 'kr' / 'en'（单个或数组） | 否 | 查询的游戏服务器，取首个；不传时按ID首位推断(2→tw、3→en、4→kr) |
| compress | bool | 否 | 输出格式为PNG还是JPEG(false为PNG) |

输出玩家档案图(最爱卡面大图 + 服名 + 名称/等级/应援数/经验，玩家自制profile card有则附上)。JP没有ID前缀规则，必须显式传`jp`。

**数据源与能力边界**

| 配置 | 数据源 | 能查到谁 |
| --- | --- | --- |
| 设了 `MOENOTES_API_BASE` + `MOENOTES_API_KEY` | 自建网关 moenotes-api | 任意玩家 |
| 未配置（默认） | 站点公开接口 | 仅「已在 [bdon.moe/account](https://bdon.moe/account) 添加并验证游戏账号、且个人主页设为公开」的账号，其余一律 404 |

站点路径的限制来自上游设计（站点自己的玩家主页也走同一接口）。查不到时报错会优先引导玩家去绑定并公开主页；想让任意玩家 ID 可查，请自建网关：见 [../gateway/README.md](../gateway/README.md)。

## 贴纸 (stamp)

Tomori提供贴纸查询服务，以下为相关端点:

**查询** 
`POST /getStampImage`
| 变量名 | 种类/可用参数 | 是否必选 | 说明 |
| --- | --- | --- | --- |
| displayedServerList | 'tw' / 'jp' / 'kr' / 'en'（单个或数组） | 否 | 按输入顺序取首个收录该贴纸(有搜索结果)的服 |
| stampId | int / string | 否 | 贴纸ID，数字与纯数字字符串都接受，直出贴纸原图 |
| text | string | 否 | 搜索文本，与fuzzySearchResult二选一；支持贴纸名、**角色名、团体名、活动名** |
| fuzzySearchResult | FuzzySearchResult | 否 | 经`/fuzzySearch`端点模糊搜索的结果 |
| stampType | 'all' / 'character' / 'band' | 否 | 关键词只认哪一类名称，默认all(贴纸名/角色名/团体名都认) |
| compress | bool | 否 | 输出格式为PNG还是JPEG(false为PNG) |

传stampId时直出官方贴纸原图；传text或fuzzySearchResult时模糊搜索，与stampId都不传时列出该服全部贴纸，两者都出列表图(带ID与名称)，结果多时按`STAMPS_PER_PAGE`分页返回多张图。

## 模糊搜索 (fuzzySearch)

**搜索** 
`POST /fuzzySearch`
| 变量名 | 种类/可用参数 | 是否必选 | 说明 |
| --- | --- | --- | --- |
| text | string | 是 | 搜索文本 |

返回`{status:'success', data: FuzzySearchResult}`(类型键 → ID数组)，可直接作为其它端点的fuzzySearchResult字段传入。

各实体端点的文字搜索（自信息与关联维度、优先级、匹配细则）见 [fuzzySearch.md](fuzzySearch.md)；均为多命中出该种类的列表图，唯一命中出端点的单查结果。

## 社区 (friend / keyword / station)

以下端点需要启用数据库(ENABLE_DB=true 且MongoDB可用)，否则统一返回404占位`{status:'fail', data:'错误: 服务器未启用数据库'}`。写操作均为弱鉴权：以自报`userId`(QQ号)为准，没有访问鉴权。

**上传交友信息** 
`POST /friend/upload`
| 变量名 | 种类/可用参数 | 是否必选 | 说明 |
| --- | --- | --- | --- |
| userId | string | 是 | 上传者QQ号，按此upsert，一人一条 |
| userName | string (1-32) | 是 | 上传者昵称 |
| playerId | string (纯数字，1-15位) | 是 | 游戏ID |
| server | 'tw' / 'jp' / 'kr' / 'en' | 是 | 游戏服务器(兼容别名'hk-tw-mo'/'hk') |
| avatarUrl | string (≤512) | 否 | 头像地址，仅`https://` + qlogo.cn域可拉取 |

**删除交友信息** 
`POST /friend/delete`
| 变量名 | 种类/可用参数 | 是否必选 | 说明 |
| --- | --- | --- | --- |
| userId | string | 是 | 上传者QQ号 |

**交友列表** 
`POST /friend/list`
| 变量名 | 种类/可用参数 | 是否必选 | 说明 |
| --- | --- | --- | --- |
| compress | bool | 否 | 输出格式为PNG还是JPEG(false为PNG) |

出列表图(头像 + QQ名 + QQ号 + 游戏ID + 服务器)，分页返回。

**上传关键词** 
`POST /keyword/upload` 为角色/角色卡/支援卡/歌曲/乐团挂检索别名
| 变量名 | 种类/可用参数 | 是否必选 | 说明 |
| --- | --- | --- | --- |
| userId | string (1-32) | 是 | 上传者QQ号 |
| entityType | 'character' / 'card' / 'supportCard' / 'song' / 'band' | 是 | 关键词挂载的实体类型 |
| entityId | int (≥1) | 是 | 实体ID |
| keyword | string (1-32) | 是 | 关键词原文 |

上传时查重：同类型可多实体共用、不可跨类型共用、不得与任何实体名/别名重合、同一实体不可重复上传（详见 [fuzzySearch.md](fuzzySearch.md)）。

**删除关键词** 
`POST /keyword/delete` 参数同`/keyword/upload`，只能删自己(`userId`相同)上传的关键词

**上传车牌** 
`POST /station/submitRoomNumber` 同房号重复提交即刷新有效期
| 变量名 | 种类/可用参数 | 是否必选 | 说明 |
| --- | --- | --- | --- |
| number | int | 是 | 房间号 |
| rawMessage | string (1-500) | 是 | 原始消息文本 |
| platform | string | 是 | 来源平台，onebot/red/chronocat/llonebot/napcat归一为qq |
| userId | string (1-32) | 是 | 上传者QQ号 |
| userName | string (1-64) | 是 | 上传者昵称 |
| time | int | 是 | 消息时间，秒/毫秒都接受并自动归一 |
| avatarUrl | string (≤512) | 否 | 头像地址 |

**车站查询** 
`GET|POST /station/queryAllRoom` 无参数，返回未过期房间的JSON列表`{status:'success', data:[…]}`

**车站列表图** 
`POST /roomList`
| 变量名 | 种类/可用参数 | 是否必选 | 说明 |
| --- | --- | --- | --- |
| roomList | 数组(≤200项) | 否 | tsugu兼容的现成房间列表，传入则直接渲染不查库；每项number/rawMessage/userId必填，source/userName/time/avatarUrl可选 |
| compress | bool | 否 | 输出格式为PNG还是JPEG(false为PNG) |

不传roomList时查询本服务数据库的未过期房间出图。

## 服务状态 (health)

**状态查询** 
`GET /health` 无参数，返回JSON：ok、defaultServer、servers、各服dataVersion/resourceVersion(regions)、playerGateway是否已配置、运行时长(upTimeS)。