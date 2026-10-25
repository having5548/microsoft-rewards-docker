import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'msr-credential-identity-'));
process.env.MSR_DATA_DIR = tmpDir;

const { default: configManager } = await import('../src/config.js');
const { default: rewardsApi } = await import('../src/core/api.js');
const { default: authManager } = await import('../src/core/auth.js');
const { default: networkClient } = await import('../src/network.js');
const { default: taskManager, TaskManager } = await import('../src/core/taskManager.js');
const { createServer } = await import('../src/web/server.js');
const { default: scheduler } = await import('../src/scheduler.js');

test.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

test('Cookie 网页身份变化时清空旧账号诊断与进度', () => {
  const accountId = 'acc_identity_switch';
  configManager.upsertAccount({
    id: accountId,
    name: '旧账号',
    cookie: '_U=OLD_USER; MUID=1',
    refreshToken: 'RT-OLD'
  });
  const taskManager = new TaskManager();
  const before = taskManager.ensureAccountStats(accountId);
  const oldIdentityKey = before.webIdentityKey;
  before.balance = 900;
  before.stamps = { progress: 8, max: 12 };
  before.tasks.search = {
    ...before.tasks.search,
    progress: 30,
    max: 60,
    points: 30,
    done: false
  };
  configManager.recordAuthDiagnosis(accountId, {
    cookieValid: true,
    tokenValid: true,
    overallValid: true,
    warning: false,
    balance: 900
  });

  configManager.upsertAccount({
    id: accountId,
    name: '新账号',
    cookie: '_U=NEW_USER; MUID=2'
  });
  const updated = configManager.findAccount(accountId);
  assert.ok(updated.identityChangedAt > 0, '换网页账号必须记录身份变更时间');
  assert.notEqual(updated.webIdentityKey, oldIdentityKey, '新 _U 必须产生新的身份指纹');
  assert.equal(updated.authDiagnosis, null, '新凭据不能继承旧账号的体检结论');

  const reset = taskManager.ensureAccountStats(accountId);
  assert.equal(reset.name, '新账号');
  assert.equal(reset.balance, 0);
  assert.deepEqual(reset.stamps, { progress: 0, max: 12 });
  assert.equal(reset.tasks.search.max, 0, '新账号必须等待官网重新返回 15/30/60 配额');
  assert.equal(reset.webIdentityKey, updated.webIdentityKey);
});

test('PC 搜索只接受官网返回的 15/30/60 等级配额', async (t) => {
  const taskManager = new TaskManager();
  const originalGetRewardsInfo = rewardsApi.getRewardsInfo;
  t.after(() => {
    rewardsApi.getRewardsInfo = originalGetRewardsInfo;
  });

  const account = { id: 'acc_quota', name: '配额测试', cookie: '_U=QUOTA_USER' };
  rewardsApi.getRewardsInfo = async () => ({
    pc: { progress: 3, max: 15 },
    webBalance: 0
  });
  const member = await taskManager.getSearchReadiness(account);
  assert.equal(member.ok, true);
  assert.deepEqual(member.tier, { code: 'member', label: '会员', max: 15 });

  rewardsApi.getRewardsInfo = async () => ({
    pc: { progress: 3, max: 45 },
    webBalance: 0
  });
  const unknown = await taskManager.getSearchReadiness(account);
  assert.equal(unknown.ok, false);
  assert.match(unknown.reason, /未知搜索配额 45/);

  rewardsApi.getRewardsInfo = async () => ({ pc: null, webBalance: 0 });
  const missing = await taskManager.getSearchReadiness(account);
  assert.equal(missing.ok, false);
  assert.match(missing.reason, /未返回当日搜索等级配额/);

  const noCookieIdentity = await taskManager.getSearchReadiness({
    ...account,
    cookie: 'MUID=1'
  });
  assert.equal(noCookieIdentity.ok, false);
  assert.match(noCookieIdentity.reason, /_U/);
});

test('仅重新导入 Token 时清除旧阻断，但保留同一网页账号的进度', () => {
  const accountId = 'acc_token_reimport';
  configManager.upsertAccount({
    id: accountId,
    name: 'Token 重导测试',
    cookie: '_U=TOKEN_USER; MUID=TOKEN',
    refreshToken: 'RT-OLD'
  });
  const taskManager = new TaskManager();
  const before = taskManager.ensureAccountStats(accountId);
  before.stamps = { progress: 4, max: 12 };
  before.tasks.search = {
    ...before.tasks.search,
    progress: 12,
    max: 30,
    points: 12,
    done: false
  };
  before.executionBlockReason = '旧 Token 绑定错误';
  taskManager.saveStats();

  configManager.upsertAccount({
    id: accountId,
    refreshToken: 'RT-NEW',
    accessToken: 'AT-NEW',
    tokenTime: Date.now()
  });
  const after = taskManager.ensureAccountStats(accountId);
  assert.equal(after.executionBlockReason, undefined);
  assert.deepEqual(after.stamps, { progress: 4, max: 12 }, 'Token 更换不应清空同一 Cookie 账号的网页进度');
  assert.equal(after.tasks.search.max, 30, 'Token 更换不应重置官网已确认的搜索等级');
});

test('移动端 Token 异常不阻断 Cookie 与官网配额都正常的 PC 搜索', async (t) => {
  const accountId = 'acc_mobile_only_warning';
  configManager.upsertAccount({
    id: accountId,
    name: '移动端异常但网页正常',
    cookie: '_U=WEB_OK; WLS=C=1&N=Test',
    refreshToken: 'BAD_MOBILE_TOKEN'
  });
  configManager.recordAuthDiagnosis(accountId, {
    cookieValid: true,
    tokenValid: false,
    overallValid: false,
    warning: true,
    warningMessage: '移动端 Token 实际绑定到其他账号'
  });
  const account = configManager.findAccount(accountId);
  const taskManager = new TaskManager();
  assert.equal(taskManager.getHardAccountBlockReason(account), '');
  assert.match(taskManager.getAccountBlockReason(account), /Token/);

  const originalGetRewardsInfo = rewardsApi.getRewardsInfo;
  rewardsApi.getRewardsInfo = async () => ({
    pc: { progress: 3, max: 15 },
    webBalance: 0
  });
  t.after(() => {
    rewardsApi.getRewardsInfo = originalGetRewardsInfo;
  });
  const readiness = await taskManager.getSearchReadiness(account);
  assert.equal(readiness.ok, true);
  assert.equal(readiness.tier.code, 'member');
});

test('Cookie 体检可从 dashboard 读取配额，并保留印章 0/12', async (t) => {
  const originalRequest = networkClient.request;
  networkClient.request = async ({ url }) => {
    if (url.includes('/dashboard')) {
      return `
<script>{"pointsCounters":{"pc":{"max":30,"progress":6},"totalPoints":0}}</script>
<div aria-label="收集的印章" aria-valuemax="12" aria-valuenow="0"></div>`;
    }
    return '<html><body>loading</body></html>';
  };
  t.after(() => {
    networkClient.request = originalRequest;
  });

  const status = await authManager.checkCookieStatus('_U=COOKIE_TEST; MUID=1', null);
  assert.equal(status.valid, true);
  assert.equal(status.searchReady, true);
  assert.equal(status.pcSearch, '6/30');
  assert.deepEqual(status.stamps, { progress: 0, max: 12 });
});

test('测试候选 Cookie 不会把余额或印章写进当前账号统计', async (t) => {
  const accountId = 'acc_cookie_preview';
  configManager.upsertAccount({
    id: accountId,
    name: '候选 Cookie 测试',
    cookie: '_U=SAVED_USER'
  });
  const savedStats = taskManager.ensureAccountStats(accountId);
  savedStats.balance = 20;
  savedStats.stamps = { progress: 3, max: 12 };
  taskManager.saveStats();

  const originalCheck = authManager.checkCookieStatus;
  authManager.checkCookieStatus = async () => ({
    valid: true,
    balance: 999,
    stamps: { progress: 11, max: 12 },
    searchReady: true,
    message: '候选 Cookie 有效'
  });
  const app = createServer();
  const server = app.listen(0);
  await new Promise(resolve => server.once('listening', resolve));
  try {
    const result = await fetch(`http://127.0.0.1:${server.address().port}/api/auth/test-cookie`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accountId, cookie: '_U=OTHER_USER' })
    }).then(r => r.json());
    assert.equal(result.success, true);
    assert.equal(result.data.balance, 999);
    const unchanged = taskManager.ensureAccountStats(accountId);
    assert.equal(unchanged.balance, 20);
    assert.deepEqual(unchanged.stamps, { progress: 3, max: 12 });
  } finally {
    authManager.checkCookieStatus = originalCheck;
    scheduler.stop();
    await new Promise(resolve => server.close(resolve));
  }
});
