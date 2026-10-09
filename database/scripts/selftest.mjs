// 冒烟自检: 对一个运行中的数据库 API 实例检查鉴权与协议形状。
//   DB_API_URL=http://127.0.0.1:3004 DB_API_TEST_TOKEN=<任一有效令牌> node scripts/selftest.mjs
// 只读检查(除 cutoff.metaSet 外不写业务数据), 可用于部署后验证。
import assert from 'node:assert/strict';

const BASE = (process.env.DB_API_URL ?? 'http://127.0.0.1:3004').replace(/\/+$/, '');
const TOKEN = process.env.DB_API_TEST_TOKEN ?? '';

async function call(path, { method = 'POST', token, body, raw } = {}) {
    const res = await fetch(`${BASE}${path}`, {
        method,
        headers: {
            ...(body !== undefined || method === 'POST' ? { 'Content-Type': 'application/json' } : {}),
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    if (raw) return { status: res.status, body: await res.text() };
    return { status: res.status, body: await res.json().catch(() => undefined) };
}

const results = [];
async function check(name, fn) {
    try {
        await fn();
        results.push(`  PASS  ${name}`);
    } catch (e) {
        results.push(`  FAIL  ${name}\n        ${e.message}`);
        process.exitCode = 1;
    }
}

await check('存活端点 /health 可用', async () => {
    const r = await call('/health', { method: 'GET' });
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
});

await check('自检端点 /api/health 可用且含两库状态', async () => {
    const r = await call('/api/health', { method: 'GET' });
    assert.equal(r.status, 200);
    assert.ok(r.body.services?.mysql && r.body.services?.mongo, '缺少 services.mysql/mongo');
});

await check('无令牌 → 401 UNAUTHENTICATED', async () => {
    const r = await call('/v1/cutoff/ping', { body: {} });
    assert.equal(r.status, 401);
    assert.equal(r.body?.error?.code, 'UNAUTHENTICATED');
});

await check('错误令牌 → 401 UNAUTHENTICATED', async () => {
    const r = await call('/v1/cutoff/ping', { token: 'definitely-wrong', body: {} });
    assert.equal(r.status, 401);
    assert.equal(r.body?.error?.code, 'UNAUTHENTICATED');
});

if (!TOKEN) {
    console.log(results.join('\n'));
    console.log('\n(未提供 DB_API_TEST_TOKEN, 跳过需要令牌的检查)');
    process.exit(process.exitCode ?? 0);
}

await check('正确令牌 → cutoff.ping 正常', async () => {
    const r = await call('/v1/cutoff/ping', { token: TOKEN, body: {} });
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
});

await check('未知 op → 404 NOT_FOUND', async () => {
    const r = await call('/v1/cutoff/noSuchOp', { token: TOKEN, body: {} });
    assert.equal(r.status, 404);
    assert.equal(r.body?.error?.code, 'NOT_FOUND');
});

await check('参数校验错误 → 400 VALIDATION', async () => {
    const r = await call('/v1/cutoff/load', { token: TOKEN, body: { eventId: 1 } }); // 缺 server
    assert.equal(r.status, 400);
    assert.equal(r.body?.error?.code, 'VALIDATION');
});

await check('meta 读写往返', async () => {
    const key = 'selftest_probe';
    const set = await call('/v1/cutoff/metaSet', { token: TOKEN, body: { key, value: '1' } });
    assert.equal(set.body.ok, true);
    const get = await call('/v1/cutoff/metaGet', { token: TOKEN, body: { key } });
    assert.equal(get.body.data.value, '1');
});

console.log(results.join('\n'));
console.log(process.exitCode ? '\n自检未通过' : '\n自检全部通过');
