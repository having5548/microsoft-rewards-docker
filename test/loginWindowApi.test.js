import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'msr-login-api-'));
process.env.MSR_DATA_DIR = tmpDir;

const { default: configManager } = await import('../src/config.js');
const { createServer } = await import('../src/web/server.js');
const { default: scheduler } = await import('../src/scheduler.js');
const { parseCookiePairs } = await import('../src/core/cookieAssistant.js');

const GUID_A = 'a1b2c3d4-1111-2222-3333-444455556666';

async function withServer(fn) {
  const app = createServer();
  const server = app.listen(0);
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn(base);
  } finally {
    scheduler.stop();
    await new Promise(resolve => server.close(resolve));
  }
}

const post = (base, url, body) => fetch(`${base}${url}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body)
}).then(r => r.json());

test('登录窗口状态接口在未打开时返回 active=false', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/auth/login-window`).then(r => r.json());
    assert.equal(res.success, true);
    assert.equal(res.data.active, false);
    assert.equal(res.data.loggedIn, false);
  });
});

test('prepare-cookie 能把完整 Cookie 串识别为可用', async () => {
  await withServer(async (base) => {
    const res = await post(base, '/api/auth/prepare-cookie', {
      cookie: `_U=${GUID_A}; MUID=deadbeef; RPSSecAuth=r1`
    });
    assert.equal(res.success, true);
    assert.equal(res.data.ok, true);
    assert.equal(res.data.hasU, true);
    assert.equal(res.data.cookieCount, 3);
    assert.equal(res.data.criticalMissing.length, 0, '关键项 _U 必须齐');
    // WLS 属于「重要但不致命」，缺了只给提示
    assert.deepEqual(res.data.importantMissing, ['WLS']);
  });
});

test('prepare-cookie 对「只贴了一个值」给出明确原因，而不是含糊的已过期', async () => {
  await withServer(async (base) => {
    const res = await post(base, '/api/auth/prepare-cookie', {
      cookie: '1lgcBhmg5CpmbbovoIBS1DXR7g1sEW4c7bfnkJ1DWdpBicRB1PojT1OIf-7yev7TksrV0rF2KToaWarxzIJyN4grk7oOJ_im2RQ5YGhelqRz7mmGUw47IzVSihRIUz313kFWqZLW7K'
    });
    assert.equal(res.data.ok, false);
    assert.equal(res.data.singleValue, true);
    assert.match(res.data.message, /只是一个 Cookie 的值/);
  });
});

test('缺少 _U 但能从 SRCHUID / _EDGE_S 交叉验证时会自动补齐', async () => {
  await withServer(async (base) => {
    const res = await post(base, '/api/auth/prepare-cookie', {
      cookie: `MUID=m1; SRCHUID=V=2&GUID=${GUID_A}&dmnchg=1; _EDGE_S=mkt=zh-cn&GUID=${GUID_A}`
    });
    assert.equal(res.data.hasU, true);
    assert.deepEqual(res.data.added, ['_U']);
    assert.equal(parseCookiePairs(res.data.cookie).get('_U'), GUID_A);
  });
});

test('保存账号时 Cookie 会被规范化后落库，并把诊断回给前端', async () => {
  await withServer(async (base) => {
    const created = await post(base, '/api/accounts', {
      name: '规范化测试账号',
      cookie: `MUID=m1; SRCHUID=V=2&GUID=${GUID_A}&dmnchg=1; _EDGE_S=mkt=zh-cn&GUID=${GUID_A}`
    });
    assert.equal(created.success, true);
    assert.equal(created.data.hasU, true);
    assert.ok(created.data.cookieAdded.includes('_U'));

    // 落库后的 Cookie 里必须真的带上 _U（否则必应搜索不计分）
    const saved = configManager.findAccount(created.data.id);
    assert.ok(saved, '账号应已写入配置');
    assert.equal(parseCookiePairs(saved.cookie).get('_U'), GUID_A);
    assert.equal(parseCookiePairs(saved.cookie).get('MUID'), 'm1');
  });
});

test('保存「只有一个值」的 Cookie 时原样保留用户输入，并给出可读提示', async () => {
  await withServer(async (base) => {
    const raw = 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-abcdefghijklmnop';
    const created = await post(base, '/api/accounts', { name: '单值测试账号', cookie: raw });
    assert.equal(created.success, true);
    assert.equal(created.data.hasU, false);
    assert.match(created.data.cookieMessage, /只是一个 Cookie 的值/);
    const saved = configManager.findAccount(created.data.id);
    assert.equal(saved.cookie, raw, '不能静默丢弃用户粘贴的内容');
  });
});
