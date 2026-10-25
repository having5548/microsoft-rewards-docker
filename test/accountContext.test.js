import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'msr-ctx-'));
process.env.MSR_DATA_DIR = tmpDir;

const { default: configManager } = await import('../src/config.js');
const { default: networkClient } = await import('../src/network.js');
const { default: authManager } = await import('../src/core/auth.js');
const { default: rewardsApi } = await import('../src/core/api.js');

configManager.update({ accounts: [
  { id: 'acc_1', name: '主账号', enabled: true, cookie: '_U=AAA; WLS=1', accessToken: 'TOKEN_1' },
  { id: 'acc_2', name: '副账号', enabled: true, cookie: '_U=BBB', accessToken: '' }
] });

test('指定账号但没有 Cookie 时，不能回退到主账号 Cookie', () => {
  rewardsApi.setCurrentAccount({ id: 'acc_x', name: '无Cookie账号', cookie: '' });
  assert.equal(networkClient.getActiveCookie(), '', '空 Cookie 必须是空串，而不是 null');
  assert.equal(networkClient.getCookieString('https://rewards.bing.com'), '', '不应回退到 accounts[0]');
});

test('显式指定账号时只使用该账号自己的 Cookie', () => {
  rewardsApi.setCurrentAccount(configManager.findAccount('acc_2'));
  assert.equal(networkClient.getActiveCookie(), '_U=BBB');
  rewardsApi.setCurrentAccount(configManager.findAccount('acc_1'));
  assert.equal(networkClient.getActiveCookie(), '_U=AAA; WLS=1');
});

test('Token 不会跨账号回退', () => {
  // 模拟「主账号刷新成功、副账号 Token 为空」的场景
  authManager.accessToken = 'TOKEN_1';
  assert.equal(authManager.getAccessToken('acc_1'), 'TOKEN_1');
  assert.equal(authManager.getAccessToken('acc_2'), null, '副账号没有 Token 时必须返回 null，不能借用主账号的');
  assert.equal(authManager.getAccessToken('not_exist'), null, '不存在的账号 id 必须返回 null');
});

test('setCurrentAccount 会同步日志账号前缀', async () => {
  const { default: logger } = await import('../src/logger.js');
  rewardsApi.setCurrentAccount(configManager.findAccount('acc_2'));
  assert.equal(logger.getAccountContext(), '副账号');
  const snap = rewardsApi.snapshotAccountContext();
  rewardsApi.setCurrentAccount(configManager.findAccount('acc_1'));
  assert.equal(logger.getAccountContext(), '主账号');
  rewardsApi.restoreAccountContext(snap);
  assert.equal(logger.getAccountContext(), '副账号', '快照还原必须把日志前缀也还原');
  assert.equal(networkClient.getActiveCookie(), '_U=BBB');
});
