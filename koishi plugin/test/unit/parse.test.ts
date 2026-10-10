import { describe, expect, it } from 'vitest'
import { DEFAULT_DIFFICULTY_ID, MESSAGES } from '../../src/config'
import {
  parseArgs,
  parseBindSelector,
  parseDeckArgs,
  parseEventArgs,
  parseGachaArgs,
  parseKeywordType,
  parsePlayerArgs,
  parseRoomInput,
  toInteger,
  type ParseOptions,
  type ParsedArgs,
} from '../../src/parse'
import { SERVER_LIST, parseServer, parseServerLoose, serverDisplay, serversDisplay } from '../../src/server'

/** 断言解析成功并返回结果，失败时把错误文案带出来便于定位 */
function ok(raw: string | undefined, options: ParseOptions = {}): ParsedArgs {
  const parsed = parseArgs(raw, options)
  if (!parsed.ok) throw new Error(`期望解析成功，实际失败：${parsed.error}`)
  return parsed
}

const SONG = { allow: ['difficulty', 'mirror', 'speed', 'server'] as const }
const TEXT_ONLY = { allow: ['server'] as const }

describe('parseArgs：基础', () => {
  it('没有修饰词时整串都是查询词', () => {
    expect(ok('诗超绊', SONG)).toMatchObject({ text: '诗超绊', servers: [], difficultyId: DEFAULT_DIFFICULTY_ID })
    expect(ok('  诗超绊   ', SONG)).toMatchObject({ text: '诗超绊' })
  })

  it('空输入不炸', () => {
    expect(ok('', SONG)).toMatchObject({ text: '', servers: [] })
    expect(ok(undefined, SONG)).toMatchObject({ text: '' })
  })

  it('不开启的修饰词类别一律当查询词', () => {
    // 查曲不认难度，所以 ex 是歌名的一部分
    expect(ok('诗超绊 ex', TEXT_ONLY)).toMatchObject({ text: '诗超绊 ex', difficultyId: DEFAULT_DIFFICULTY_ID })
  })
})

describe('parseArgs：难度 / 镜像 / 速度', () => {
  it('难度认短码与全名，顺序无关', () => {
    expect(ok('诗超绊 ex', SONG)).toMatchObject({ text: '诗超绊', difficultyId: 3, explicitDifficulty: true })
    expect(ok('诗超绊 EASY', SONG)).toMatchObject({ text: '诗超绊', difficultyId: 0 })
    expect(ok('诗超绊 normal', SONG)).toMatchObject({ text: '诗超绊', difficultyId: 1 })
    expect(ok('诗超绊 hd', SONG)).toMatchObject({ text: '诗超绊', difficultyId: 2 })
    expect(ok('诗超绊 expert', SONG)).toMatchObject({ text: '诗超绊', difficultyId: 3 })
  })

  it('镜像修饰词：镜像 / mirror / -m', () => {
    expect(ok('100008 ex -m', SONG)).toMatchObject({ text: '100008', difficultyId: 3, mirror: true })
    expect(ok('诗超绊 镜像', SONG)).toMatchObject({ text: '诗超绊', mirror: true })
    expect(ok('诗超绊 mirror', SONG)).toMatchObject({ text: '诗超绊', mirror: true })
    expect(ok('诗超绊 -M', SONG)).toMatchObject({ text: '诗超绊', mirror: true })
  })

  it('修饰词顺序无关', () => {
    expect(ok('诗超绊 镜像 ex', SONG)).toMatchObject({ text: '诗超绊', difficultyId: 3, mirror: true })
    expect(ok('100008 镜像 ez', SONG)).toMatchObject({ text: '100008', difficultyId: 0, mirror: true })
  })

  it('速度认粘连与分开两种写法', () => {
    expect(ok('诗超绊 ex 速度7.5', SONG)).toMatchObject({ text: '诗超绊', difficultyId: 3, noteSpeed: 7.5 })
    expect(ok('诗超绊 流速10', SONG)).toMatchObject({ text: '诗超绊', noteSpeed: 10 })
    expect(ok('诗超绊 speed3.25', SONG)).toMatchObject({ text: '诗超绊', noteSpeed: 3.25 })
    expect(ok('诗超绊 速度 7.5', SONG)).toMatchObject({ text: '诗超绊', noteSpeed: 7.5 })
  })

  it('速度越界直接报错，不去发必然 400 的请求', () => {
    expect(parseArgs('诗超绊 速度13', SONG)).toEqual({ ok: false, error: MESSAGES.invalidNoteSpeed })
    expect(parseArgs('诗超绊 速度0.5', SONG)).toEqual({ ok: false, error: MESSAGES.invalidNoteSpeed })
    expect(parseArgs('诗超绊 速度 20', SONG)).toEqual({ ok: false, error: MESSAGES.invalidNoteSpeed })
  })

  it('「速度」后面没有数字时不算修饰词，落回查询词', () => {
    expect(ok('诗超绊 速度', SONG)).toMatchObject({ text: '诗超绊 速度', noteSpeed: undefined })
  })

  it('sp 是 Our Notes 不存在的难度，明确报错', () => {
    expect(parseArgs('诗超绊 sp', SONG)).toEqual({ ok: false, error: MESSAGES.unsupportedSpecial })
    expect(parseArgs('诗超绊 special', SONG)).toEqual({ ok: false, error: MESSAGES.unsupportedSpecial })
  })

  it('没有空格粘连的写法也认（"诗超绊ex"）', () => {
    expect(ok('诗超绊ex', SONG)).toMatchObject({ text: '诗超绊', difficultyId: 3, explicitDifficulty: true })
    expect(parseArgs('诗超绊sp', SONG)).toEqual({ ok: false, error: MESSAGES.unsupportedSpecial })
  })
})

describe('parseArgs：服务器', () => {
  it('按 token 分类，与位置无关', () => {
    expect(ok('迷星叫 jp', TEXT_ONLY)).toMatchObject({ text: '迷星叫', servers: ['jp'] })
    expect(ok('jp 迷星叫', TEXT_ONLY)).toMatchObject({ text: '迷星叫', servers: ['jp'] })
    // 尾部剥离在这里会给错答案（会丢掉 tw 还拿 jp 去搜）
    expect(ok('tw jp', { ...TEXT_ONLY, keepQuery: false })).toMatchObject({ text: '', servers: ['tw', 'jp'] })
  })

  it('去重并按固定顺序排列', () => {
    expect(ok('诗超绊 jp tw jp', TEXT_ONLY)).toMatchObject({ text: '诗超绊', servers: ['tw', 'jp'] })
  })

  it('认别名', () => {
    expect(ok('诗超绊 日服', TEXT_ONLY)).toMatchObject({ servers: ['jp'] })
    expect(ok('诗超绊 hk-tw-mo', TEXT_ONLY)).toMatchObject({ servers: ['tw'] })
    expect(ok('诗超绊 国际服', TEXT_ONLY)).toMatchObject({ servers: ['en'] })
    expect(ok('诗超绊 韩服', TEXT_ONLY)).toMatchObject({ servers: ['kr'] })
  })

  it('servers 为空表示「用户没说」，解析器不塞默认值', () => {
    expect(ok('诗超绊', TEXT_ONLY)).toMatchObject({ servers: [] })
  })

  it('不开启 server 时，服务器词也是查询词', () => {
    expect(ok('诗超绊 jp', { allow: [] })).toMatchObject({ text: '诗超绊 jp', servers: [] })
  })
})

describe('parseArgs：keepQuery', () => {
  it('只输一个修饰词时当成查询词，而不是剥成空串', () => {
    // 否则用户既搜不到东西，也拿不到「缺查询词」的提示
    expect(ok('ex', SONG)).toMatchObject({ text: 'ex', difficultyId: DEFAULT_DIFFICULTY_ID, explicitDifficulty: false })
    expect(ok('镜像', SONG)).toMatchObject({ text: '镜像', mirror: false })
  })

  it('多个 token 全被剥光时（且 keepQuery）text 为空，由调用方给提示', () => {
    expect(ok('速度 7.5', SONG)).toMatchObject({ text: '', noteSpeed: 7.5 })
  })

  it('keepQuery=false 时允许剥成空串', () => {
    expect(ok('jp', { allow: ['server'], keepQuery: false })).toMatchObject({ text: '', servers: ['jp'] })
    expect(ok('', { allow: ['server'], keepQuery: false })).toMatchObject({ text: '' })
  })
})

describe('parseArgs：卡种 / 贴纸', () => {
  it('卡种认中文与英文别名', () => {
    expect(ok('高松灯 角色卡', { allow: ['cardKind'] })).toMatchObject({ text: '高松灯', cardKind: 'member' })
    expect(ok('高松灯 留影', { allow: ['cardKind'] })).toMatchObject({ text: '高松灯', cardKind: 'support' })
    expect(ok('高松灯 AUTO', { allow: ['cardKind'] })).toMatchObject({ text: '高松灯', cardKind: 'auto' })
  })

  it('贴纸范围与「全部」', () => {
    const opts: ParseOptions = { allow: ['stampScope', 'stampAll', 'server'], keepQuery: false }
    expect(ok('高松灯 角色 jp', opts)).toMatchObject({ text: '高松灯', stampScope: 'character', servers: ['jp'] })
    expect(ok('MyGO 团体', opts)).toMatchObject({ text: 'MyGO', stampScope: 'band' })
    expect(ok('全部 tw', opts)).toMatchObject({ text: '', stampAll: true, servers: ['tw'] })
    expect(ok('all', opts)).toMatchObject({ text: '', stampAll: true })
    // 不在范围表里的词是关键词的一部分
    expect(ok('高松灯 生日', opts)).toMatchObject({ text: '高松灯 生日', stampScope: undefined })
  })
})

describe('server 工具', () => {
  it('SERVER_LIST 是固定的四服顺序', () => {
    expect([...SERVER_LIST]).toEqual(['tw', 'jp', 'kr', 'en'])
  })

  it('parseServer 认短码与常见别名', () => {
    expect(parseServer('TW')).toBe('tw')
    expect(parseServer('hk-tw-mo')).toBe('tw')
    expect(parseServer('台服')).toBe('tw')
    expect(parseServer('日服')).toBe('jp')
    expect(parseServer('国际服')).toBe('en')
    expect(parseServer('韩服')).toBe('kr')
    expect(parseServer('火星服')).toBeUndefined()
    expect(parseServer(undefined)).toBeUndefined()
  })

  it('单字「日」「韩」只在宽松版里认', () => {
    expect(parseServer('日')).toBeUndefined()
    expect(parseServerLoose('日')).toBe('jp')
    expect(parseServerLoose('韩')).toBe('kr')
  })

  it('展示名与并列文案', () => {
    expect(serverDisplay('tw')).toBe('港澳台服')
    expect(serverDisplay('未知')).toBe('未知')
    expect(serversDisplay(['tw', 'jp'])).toBe('港澳台服、日服')
  })
})

describe('parseRoomInput', () => {
  it('拆出房号与备注', () => {
    expect(parseRoomInput('123456 上车')).toEqual({ room: '123456', number: 123456, note: '上车', raw: '123456 上车' })
    expect(parseRoomInput('12345 来')).toMatchObject({ room: '12345', number: 12345, note: '来' })
  })

  it('接受 7 位房间号（Our Notes 的房间号长度）', () => {
    expect(parseRoomInput('1234567 上车')).toEqual({ room: '1234567', number: 1234567, note: '上车', raw: '1234567 上车' })
    expect(parseRoomInput('1234567')).toMatchObject({ room: '1234567', number: 1234567, note: '' })
  })

  it('没有备注也能用', () => {
    expect(parseRoomInput('123456')).toMatchObject({ room: '123456', number: 123456, note: '' })
  })

  it('保留前导 0（rawMessage 用原文，不丢信息）', () => {
    expect(parseRoomInput('012345 上车')).toMatchObject({ room: '012345', number: 12345, raw: '012345 上车' })
    expect(parseRoomInput('0123456 上车')).toMatchObject({ room: '0123456', number: 123456 })
  })

  it('位数不对就拒绝，而不是悄悄截断', () => {
    // 参考项目会把超长数字截断后发出去，这里必须挡住
    expect(parseRoomInput('12345678 上车')).toBeUndefined()
    expect(parseRoomInput('1234 上车')).toBeUndefined()
    expect(parseRoomInput('')).toBeUndefined()
    expect(parseRoomInput('abc')).toBeUndefined()
  })

  it('房号后面紧跟字母也拒绝（避免 1234567abc 被当成合法房号）', () => {
    expect(parseRoomInput('123456abc')).toBeUndefined()
    expect(parseRoomInput('1234567abc')).toBeUndefined()
  })
})

describe('parseKeywordType', () => {
  it('认中文与英文写法，且「角色」与「角色卡」是两个不同的实体类型', () => {
    expect(parseKeywordType('歌曲')).toBe('song')
    expect(parseKeywordType('song')).toBe('song')
    expect(parseKeywordType('角色')).toBe('character')
    expect(parseKeywordType('角色卡')).toBe('card')
    expect(parseKeywordType('成员卡')).toBe('card')
    expect(parseKeywordType('支援卡')).toBe('supportCard')
    expect(parseKeywordType('留影')).toBe('supportCard')
    expect(parseKeywordType('SUPPORTCARD')).toBe('supportCard')
    expect(parseKeywordType('乐团')).toBe('band')
    expect(parseKeywordType('band')).toBe('band')
  })

  it('认不出来返回 undefined', () => {
    expect(parseKeywordType('火星')).toBeUndefined()
    expect(parseKeywordType(undefined)).toBeUndefined()
  })
})

describe('parseEventArgs', () => {
  it('数字按出现顺序排队：第一个是名次，第二个是活动 ID', () => {
    expect(parseEventArgs('100', true)).toEqual({ rank: 100, id: undefined })
    expect(parseEventArgs('100 1', true)).toEqual({ rank: 100, id: 1 })
    expect(parseEventArgs('10 10', true)).toEqual({ rank: 10, id: 10 })
    expect(parseEventArgs('5000 123', true)).toEqual({ rank: 5000, id: 123 })
  })

  it('数字含义不随取值漂移 —— 这正是从「查档位表」改成按顺序的原因', () => {
    // 旧写法下 100 会因「在档位表里」被认成名次、1 被认成活动；
    // 而 1 不在表里时两个数的含义会整个对调。现在两个方向都只有一个规则。
    expect(parseEventArgs('100 1', true)).toEqual({ rank: 100, id: 1 })
    expect(parseEventArgs('1 100', true)).toEqual({ rank: 1, id: 100 })
  })

  it('ycxall（allowTier=false）不占名次，第一个数字就是活动 ID', () => {
    expect(parseEventArgs('100', false)).toEqual({ rank: undefined, id: 100 })
    expect(parseEventArgs('1', false)).toEqual({ rank: undefined, id: 1 })
  })

  it('空输入合法（名次与活动都可选，省略即用当前活动）', () => {
    expect(parseEventArgs('', true)).toEqual({ rank: undefined, id: undefined })
    expect(parseEventArgs(undefined, true)).toEqual({ rank: undefined, id: undefined })
    expect(parseEventArgs('  ', false)).toEqual({ rank: undefined, id: undefined })
  })

  it('活动可以写名字，与数字 ID 同义且位置无关', () => {
    expect(parseEventArgs('100 夏日祭', true)).toEqual({ rank: 100, id: '夏日祭' })
    expect(parseEventArgs('夏日祭', true)).toEqual({ rank: undefined, id: '夏日祭' })
    expect(parseEventArgs('夏日祭 100', true)).toEqual({ rank: 100, id: '夏日祭' })
    expect(parseEventArgs('100 MyGO 夏日祭', true)).toEqual({ rank: 100, id: 'MyGO 夏日祭' })
    expect(parseEventArgs('夏日祭', false)).toEqual({ rank: undefined, id: '夏日祭' })
  })

  it('活动 ID 与活动名同时给、或多出数字，一律算非法而不是猜一个', () => {
    expect(parseEventArgs('100 1 2', true)).toBeUndefined()
    expect(parseEventArgs('100 1 夏日祭', true)).toBeUndefined()
    expect(parseEventArgs('1 2', false)).toBeUndefined()
    expect(parseEventArgs('夏日祭 100', false)).toBeUndefined()
  })
})

describe('parseGachaArgs', () => {
  it('空输入 → 默认 10 连、不指定卡池（后端取当前开放卡池）', () => {
    expect(parseGachaArgs('')).toEqual({ times: 10, gacha: undefined })
    expect(parseGachaArgs(undefined)).toEqual({ times: 10, gacha: undefined })
  })

  it('第一个数字是次数，第二个数字是卡池 ID', () => {
    expect(parseGachaArgs('30')).toEqual({ times: 30, gacha: undefined })
    expect(parseGachaArgs('30 2')).toEqual({ times: 30, gacha: 2 })
  })

  it('卡池也能写名字，名字不占数字位（位置无关）', () => {
    expect(parseGachaArgs('10 夏日祭')).toEqual({ times: 10, gacha: '夏日祭' })
    expect(parseGachaArgs('夏日祭')).toEqual({ times: 10, gacha: '夏日祭' })
    expect(parseGachaArgs('夏日祭 10')).toEqual({ times: 10, gacha: '夏日祭' })
    expect(parseGachaArgs('10 MyGO 夏日祭')).toEqual({ times: 10, gacha: 'MyGO 夏日祭' })
  })

  it('次数为 0、参数过多或 ID 与名字混排，一律算非法', () => {
    expect(parseGachaArgs('0')).toBeUndefined()
    expect(parseGachaArgs('1 2 3')).toBeUndefined()
    expect(parseGachaArgs('10 夏日祭 2')).toBeUndefined()
  })
})

describe('parsePlayerArgs（查玩家 / 发名片 / b25）', () => {
  it('空输入合法：省略玩家 ID = 用绑定里的默认账号', () => {
    expect(parsePlayerArgs('')).toEqual({ ok: true, playerId: undefined, page: undefined })
    expect(parsePlayerArgs(undefined)).toEqual({ ok: true, playerId: undefined, page: undefined })
  })

  it('裸数字是玩家 ID', () => {
    expect(parsePlayerArgs('2000000000')).toEqual({ ok: true, playerId: '2000000000', page: undefined })
  })

  it('多写一个数字就报错，不猜用哪个', () => {
    expect(parsePlayerArgs('2000000000 3000000000')).toEqual({ ok: false, error: MESSAGES.playerIdOnlyOne })
  })

  it('非数字查询词（服务器已被剥走的场景）按玩家 ID 报错', () => {
    expect(parsePlayerArgs('诗超绊')).toEqual({ ok: false, error: MESSAGES.invalidPlayerId })
    expect(parsePlayerArgs('2000000000 abc')).toEqual({ ok: false, error: MESSAGES.invalidPlayerId })
  })

  it('默认不收页码 —— 裸数字只可能是玩家 ID', () => {
    // 发名片 2 与「页2」必须能区分开，所以不带 allowPage 时 2 就是玩家 ID
    expect(parsePlayerArgs('2')).toEqual({ ok: true, playerId: '2', page: undefined })
  })

  it('发名片收页码：页2 / 第2页 / p2 / page2 都认', () => {
    const page2 = { ok: true, playerId: undefined, page: 2 }
    expect(parsePlayerArgs('页2', { allowPage: true })).toEqual(page2)
    expect(parsePlayerArgs('第2页', { allowPage: true })).toEqual(page2)
    expect(parsePlayerArgs('p2', { allowPage: true })).toEqual(page2)
    expect(parsePlayerArgs('page2', { allowPage: true })).toEqual(page2)
    expect(parsePlayerArgs('2000000000 页3', { allowPage: true }))
      .toEqual({ ok: true, playerId: '2000000000', page: 3 })
  })

  it('页码只认带「页 / p」的写法，写法不完整或多写都报错', () => {
    expect(parsePlayerArgs('页', { allowPage: true })).toEqual({ ok: false, error: MESSAGES.invalidPlayerPage })
    expect(parsePlayerArgs('页0', { allowPage: true })).toEqual({ ok: false, error: MESSAGES.invalidPlayerPage })
    expect(parsePlayerArgs('页1 第2页', { allowPage: true })).toEqual({ ok: false, error: MESSAGES.playerPageOnlyOne })
  })
})

describe('parseDeckArgs（组卡）', () => {
  it('空输入合法：默认模式交给后端（auto）、玩家用绑定', () => {
    expect(parseDeckArgs('')).toEqual({ ok: true, playerId: undefined, eventId: undefined, mode: undefined })
    expect(parseDeckArgs(undefined)).toEqual({ ok: true, playerId: undefined, eventId: undefined, mode: undefined })
  })

  it('模式词：常规 / 活动 / 自动', () => {
    expect(parseDeckArgs('常规')).toMatchObject({ mode: 'normal' })
    expect(parseDeckArgs('普通')).toMatchObject({ mode: 'normal' })
    expect(parseDeckArgs('活动')).toEqual({ ok: true, mode: 'event' })
    expect(parseDeckArgs('自动')).toMatchObject({ mode: 'auto' })
    expect(parseDeckArgs('normal')).toMatchObject({ mode: 'normal' })
  })

  it('活动 ID 只跟在「活动」后面（分开写或粘连都认）', () => {
    expect(parseDeckArgs('活动 123')).toEqual({ ok: true, playerId: undefined, eventId: 123, mode: 'event' })
    expect(parseDeckArgs('活动123')).toEqual({ ok: true, playerId: undefined, eventId: 123, mode: 'event' })
    expect(parseDeckArgs('活动 123 2000000000'))
      .toEqual({ ok: true, playerId: '2000000000', eventId: 123, mode: 'event' })
    expect(parseDeckArgs('2000000000 活动'))
      .toEqual({ ok: true, playerId: '2000000000', eventId: undefined, mode: 'event' })
  })

  it('其余裸数字是玩家 ID，最多一个', () => {
    expect(parseDeckArgs('2000000000')).toEqual({ ok: true, playerId: '2000000000', eventId: undefined, mode: undefined })
    expect(parseDeckArgs('常规 2000000000')).toMatchObject({ playerId: '2000000000', mode: 'normal' })
    expect(parseDeckArgs('2000000000 3000000000')).toEqual({ ok: false, error: MESSAGES.deckArgsUsage })
  })

  it('认不出的词、互相打架的模式、重复活动 ID 一律报用法', () => {
    expect(parseDeckArgs('高松灯')).toEqual({ ok: false, error: MESSAGES.deckArgsUsage })
    expect(parseDeckArgs('常规 活动')).toEqual({ ok: false, error: MESSAGES.deckArgsUsage })
    expect(parseDeckArgs('活动 1 活动 2')).toEqual({ ok: false, error: MESSAGES.deckArgsUsage })
  })
})

describe('parseBindSelector（默认玩家 / 解除绑定）', () => {
  it('空输入合法（交给后端报「请用 ID 或序号指定」）', () => {
    expect(parseBindSelector(undefined)).toEqual({})
    expect(parseBindSelector('  ')).toEqual({})
  })

  it('1~3 位数字按列表序号，更长的按玩家 ID', () => {
    expect(parseBindSelector('2')).toEqual({ index: 2 })
    expect(parseBindSelector('999')).toEqual({ index: 999 })
    expect(parseBindSelector('1000')).toEqual({ playerId: '1000' })
    expect(parseBindSelector('2000000000')).toEqual({ playerId: '2000000000' })
  })

  it('序号从 1 起，0 与其它写法都算非法', () => {
    expect(parseBindSelector('0')).toBeUndefined()
    expect(parseBindSelector('-1')).toBeUndefined()
    expect(parseBindSelector('abc')).toBeUndefined()
    expect(parseBindSelector('1 2')).toBeUndefined()
  })
})

describe('toInteger', () => {
  it('接受纯数字字符串与整数', () => {
    expect(toInteger('100008')).toBe(100008)
    expect(toInteger(42)).toBe(42)
    expect(toInteger(' 7 ')).toBe(7)
  })

  it('拒绝小数、负号、夹杂字符与非字符串', () => {
    expect(toInteger('1.5')).toBeUndefined()
    expect(toInteger('-1')).toBeUndefined()
    expect(toInteger('12a')).toBeUndefined()
    expect(toInteger(1.5)).toBeUndefined()
    expect(toInteger(undefined)).toBeUndefined()
    expect(toInteger(['1'])).toBeUndefined()
  })
})
