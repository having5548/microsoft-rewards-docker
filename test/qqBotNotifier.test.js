import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'msr-qqbot-test-'));
process.env.MSR_DATA_DIR = tmpDir;

const { Notifier } = await import('../src/core/notifier.js');
const { default: networkClient } = await import('../src/network.js');

/**
 * 把 networkClient.request 换成假实现，记录每次调用的 URL / headers / body。
 * 测试不联网，也不去碰真实的 QQ 接口。
 */
function stubNetwork(handler) {
  const calls = [];
  const original = networkClient.request.bind(networkClient);
  networkClient.request = async (options) => {
    calls.push(options);
    return handler(options, calls.length);
  };
  return {
    calls,
    restore() { networkClient.request = original; }
  };
}

const SETTINGS = {
  appId: '102030405',
  clientSecret: 'secret-xyz',
  openidType: 'group',
  openid: 'GROUP_OPENID_1'
};

test('QQ 机器人：换取 token 后发群消息，第二次复用缓存的 token', async () => {
  const notifier = new Notifier();
  notifier.clearQQBotToken('102030405');
  const stub = stubNetwork((options) => {
    if (options.url.includes('getAppAccessToken')) {
      return { access_token: 'tok-1', expires_in: 7200 };
    }
    return { id: 'MSG_1', timestamp: '2026-10-25T10:00:00+08:00' };
  });

  try {
    await notifier.sendQQBot(SETTINGS, '测试标题', '正文');

    const tokenCall = stub.calls[0];
    assert.match(tokenCall.url, /bots\.qq\.com\/app\/getAppAccessToken/);
    assert.deepEqual(JSON.parse(tokenCall.data), { appId: '102030405', clientSecret: 'secret-xyz' });

    const msgCall = stub.calls[1];
    assert.match(msgCall.url, /\/v2\/groups\/GROUP_OPENID_1\/messages$/);
    assert.equal(msgCall.headers.Authorization, 'QQBot tok-1');
    const body = JSON.parse(msgCall.data);
    assert.equal(body.msg_type, 0);
    assert.match(body.content, /测试标题/);

    // 第二次发送不应再换 token
    await notifier.sendQQBot(SETTINGS, '第二次', '正文');
    assert.equal(stub.calls.filter(c => c.url.includes('getAppAccessToken')).length, 1, 'token 必须被缓存');
  } finally {
    stub.restore();
  }
});

test('QQ 机器人：私聊目标打到 /v2/users/{openid}/messages', async () => {
  const notifier = new Notifier();
  notifier.clearQQBotToken('102030405');
  const stub = stubNetwork((options) => options.url.includes('getAppAccessToken')
    ? { access_token: 'tok-2', expires_in: 7200 }
    : { id: 'MSG_2' });
  try {
    await notifier.sendQQBot({ ...SETTINGS, openidType: 'user', openid: 'USER_1' }, 't', 'c');
    const msgCall = stub.calls[1];
    assert.match(msgCall.url, /\/v2\/users\/USER_1\/messages$/);
  } finally {
    stub.restore();
  }
});

test('QQ 机器人：err_code 非 0 时抛出带错误码的异常', async () => {
  const notifier = new Notifier();
  notifier.clearQQBotToken('102030405');
  const stub = stubNetwork((options) => options.url.includes('getAppAccessToken')
    ? { access_token: 'tok-3', expires_in: 7200 }
    : { err_code: 40034005, message: '主动消息额度不足' });
  try {
    await assert.rejects(
      () => notifier.sendQQBot(SETTINGS, 't', 'c'),
      /40034005/
    );
  } finally {
    stub.restore();
  }
});

test('QQ 机器人：缺少 AppID / AppSecret / OpenID 时直接报配置不完整', async () => {
  const notifier = new Notifier();
  await assert.rejects(
    () => notifier.sendQQBot({ appId: '', clientSecret: '', openid: '' }, 't', 'c'),
    /配置不完整/
  );
});

test('QQ 机器人：换 token 失败时给出可操作的提示', async () => {
  const notifier = new Notifier();
  notifier.clearQQBotToken('bad-app');
  const stub = stubNetwork(() => ({ code: 100016, message: 'invalid appid' }));
  try {
    await assert.rejects(
      () => notifier.sendQQBot({ ...SETTINGS, appId: 'bad-app' }, 't', 'c'),
      /获取 QQ 机器人 access_token 失败/
    );
  } finally {
    stub.restore();
  }
});
