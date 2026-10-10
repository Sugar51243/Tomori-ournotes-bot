/**
 * 校验通知模块（直连数据库 API，不经过网页那层）。
 *
 *   cd database && node --env-file=.env scripts/verify-notifications.mjs
 *
 * 重点验的是**「一条信息只发一次通知」那条唯一键真的挡得住** ——
 * 这是这一块唯一靠读代码看不出来的东西，得让数据库自己说话。
 *
 * 收件人用的是故意编的 id（不存在的人），插出来的行不会出现在任何真实用户的列表里；
 * 这个模块没有删除接口，只能这样避免污染真实数据。测试自己会把基线清干净，
 * 所以**可以反复跑**。
 */

const PORT = process.env.DB_API_PORT ?? '3004';
const HOST = process.env.DB_API_LOCATION || '127.0.0.1';
/** 令牌表的格式是 `名字=令牌,名字=令牌`（见 config.ts 的 parseTokens），取第一个名字后面的部分 */
const TOKEN = (String(process.env.DB_API_TOKENS ?? '').split(',')[0] ?? '').split('=').pop().trim();
const BASE = `http://${HOST}:${PORT}/v1`;

if (!TOKEN) {
    console.error('✗ 没读到 DB_API_TOKENS，确认是用 --env-file=.env 跑的');
    process.exit(1);
}

/** 编出来的收件人：不存在的人，插进去也不会打扰谁 */
const GHOST = 999999999;
const GHOST_ACTOR = 999999998;
/** 每次跑换一个 postId：唯一键是 (user,post,comment)，这样不会撞上上次跑留下的行 */
const POST = Date.now() % 2000000000;

let failed = 0;
function check(label, ok, detail = '') {
    console.log(`${ok ? '  ✓' : '  ✗'} ${label}${detail ? `  (${detail})` : ''}`);
    if (!ok) failed++;
}

async function call(module, op, params) {
    const res = await fetch(`${BASE}/${module}/${op}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
        body: JSON.stringify(params ?? {}),
    });
    const text = await res.text();
    let payload;
    try {
        payload = JSON.parse(text);
    } catch {
        throw new Error(`${op}: HTTP ${res.status} 非 JSON 响应: ${text.slice(0, 200)}`);
    }
    if (!payload.ok) throw new Error(`${op}: ${payload.error?.code} ${payload.error?.message}`);
    return payload.data;
}

const create = (kind, commentId) =>
    call('notifications', 'createNotification', {
        userId: GHOST,
        actorId: GHOST_ACTOR,
        kind,
        postId: POST,
        commentId,
    });
/** countUnread 回的是 `{ unread }`，扒成数字断言才写得干净 */
const unread = async () => (await call('notifications', 'countUnread', { userId: GHOST })).unread;
const readAll = () => call('notifications', 'markAllRead', { userId: GHOST });

async function main() {
    console.log(`① 表在不在（post=${POST}）`);
    // 先清干净，测试才可重复跑
    await readAll();
    check('countUnread 能跑通（说明表在）', (await unread()) === 0);

    console.log('② 写一条通知');
    check('写进去了', (await create('mention', 555001)).created === true);
    check('未读 +1', (await unread()) === 1);

    console.log('③ 同一条信息再写一次 —— 唯一键应该挡住');
    // 连 kind 都不一样，仍旧不该多出一行
    check('没有多出一行', (await create('reply', 555001)).created === false);
    check('未读数没有跟着涨', (await unread()) === 1);

    console.log('④ 换一条评论（不同来源）就该是新的一条');
    check('新来源写了进去', (await create('reply', 555002)).created === true);
    check('未读 +1', (await unread()) === 2);

    console.log('⑤ 帖子级通知（commentId = 0）同样去重');
    check('第一条进去了', (await create('mention', 0)).created === true);
    check('第二条被挡住（0 不是 NULL，唯一键照样生效）', (await create('mention', 0)).created === false);
    check('未读 +1', (await unread()) === 3);

    console.log('⑥ 列表读得出来');
    const list = await call('notifications', 'listNotifications', { userId: GHOST, limit: 100, offset: 0 });
    const mine = list.items.filter(it => it.postId === POST);
    check('三条来源各一行，没有重复', mine.length === 3, `本次 ${mine.length} 条`);
    check('unread 与 countUnread 一致', list.unread === (await unread()), `${list.unread} vs ${await unread()}`);
    check('按 id 倒序', list.items.every((it, i, arr) => i === 0 || arr[i - 1].id > it.id));

    console.log('⑦ 标记已读');
    const one = await call('notifications', 'markRead', { userId: GHOST, ids: [mine[0].id] });
    check('改了一条', one.changed === 1, JSON.stringify(one));
    // user_id 一起进 WHERE 才算数：随便一个不存在的 id 不该改得动任何东西
    const foreign = await call('notifications', 'markRead', { userId: GHOST, ids: [1] });
    check('不属于自己的 id 改不动', foreign.changed === 0, JSON.stringify(foreign));
    check('未读 -1', (await unread()) === 2);

    console.log('⑧ 一键已读');
    check('改动数等于剩余未读', (await readAll()).changed === 2);
    check('未读清零', (await unread()) === 0);
    check('再点一次是 0（幂等）', (await readAll()).changed === 0);

    console.log(failed ? `\n✗ ${failed} 项没通过` : '\n✓ 全部通过');
    process.exit(failed ? 1 : 0);
}

main().catch(e => {
    console.error('✗', e.message);
    process.exit(1);
});
