import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'msr-fixes-174-'));
process.env.MSR_DATA_DIR = tmpDir;

const { default: configManager } = await import('../src/config.js');
const { default: rewardsApi, RewardsApi } = await import('../src/core/api.js');
const { default: networkClient } = await import('../src/network.js');
const { default: authManager } = await import('../src/core/auth.js');
const { TaskManager } = await import('../src/core/taskManager.js');
const { default: browserManager } = await import('../src/core/browser.js');
const { browserSlotLock } = await import('../src/core/contextLock.js');
const { accountNamesLikelyMatch, isBalanceMismatch } = await import('../src/core/accountIdentity.js');
const { createServer } = await import('../src/web/server.js');
const { default: scheduler } = await import('../src/scheduler.js');

test('网页端余额与移动端余额明显不一致时判定为 Token 绑定错误', () => {
  assert.equal(isBalanceMismatch(450, 663), true);
  assert.equal(isBalanceMismatch(450, 470), false, '小幅同步延迟不应误报');
  assert.equal(isBalanceMismatch(0, 663), true, '新账号 0 分但 Token 属于有积分旧账号时必须识别');
  assert.equal(isBalanceMismatch(null, 663), false, '网页余额未读取时不能把 null 当成 0');
  assert.equal(accountNamesLikelyMatch('张三 李四', '张三'), true);
  assert.equal(accountNamesLikelyMatch('张三 李四', '李四 张三'), true);
  assert.equal(accountNamesLikelyMatch('alice@example.com', 'alice@another.com'), true);
  assert.equal(accountNamesLikelyMatch('alice@example.com', '爱丽丝'), null);
  assert.equal(accountNamesLikelyMatch('alice', 'bob'), false);
});

test('getBalance 优先使用网页 Cookie 余额，避免错误 Token 覆盖当前账号余额', async () => {
  const api = new RewardsApi();
  api.getWebBalance = async () => 450;
  api.getMobileBalance = async () => 663;
  assert.equal(await api.getBalance(), 450);
});

test('getAppCheckInStatus 优先使用 dashboard 的权威连签状态', async () => {
  const api = new RewardsApi();
  api.getRewardsInfo = async () => ({
    streaks: { bingapp: { completedDays: 6, currentDay: 6, isCurrentDayCompleted: true } }
  });
  const origRequest = networkClient.request;
  networkClient.request = async () => { throw new Error('不应回退到旧 /earn 解析'); };
  try {
    const status = await api.getAppCheckInStatus();
    assert.equal(status.completedDays, 6);
    assert.equal(status.isCurrentDayCompleted, true);
  } finally {
    networkClient.request = origRequest;
  }
});

test('移动端 Token 绑定校验会拦住错误账号，避免签到算到别人头上', async () => {
  const tm = new TaskManager();
  const origRefresh = authManager.refreshToken;
  const origMobile = rewardsApi.getMobileSnapshot;
  authManager.refreshToken = async () => true;
  rewardsApi.getMobileSnapshot = async () => ({ balance: 663, userName: '' });
  try {
    const binding = await tm.checkMobileAccountBinding({ id: 'acc_174', name: '测试账号' }, 450);
    assert.equal(binding.tokenOk, true);
    assert.equal(binding.mismatch, true);
    assert.match(binding.message, /其他账号/);
  } finally {
    authManager.refreshToken = origRefresh;
    rewardsApi.getMobileSnapshot = origMobile;
  }
});

test('Token 用户与 Cookie 用户不一致时，即使双方余额都是 0 也拒绝配对', async () => {
  const tm = new TaskManager();
  const origRefresh = authManager.refreshToken;
  const origMobile = rewardsApi.getMobileSnapshot;
  authManager.refreshToken = async () => true;
  rewardsApi.getMobileSnapshot = async () => ({ balance: 0, userName: 'Other User' });
  try {
    const binding = await tm.checkMobileAccountBinding({
      id: 'acc_174_name',
      name: '名称校验',
      cookie: '_U=WEB; WLS=C=1&N=Current%20User'
    }, 0);
    assert.equal(binding.tokenOk, true);
    assert.equal(binding.mismatch, true);
    assert.equal(binding.verified, false);
    assert.match(binding.message, /Token 用户/);
  } finally {
    authManager.refreshToken = origRefresh;
    rewardsApi.getMobileSnapshot = origMobile;
  }
});

test('配置向导换取 Token 使用草稿模式，不在取消前创建半成品账号', async () => {
  const origRequest = networkClient.request;
  networkClient.request = async () => ({
    access_token: 'DRAFT_ACCESS_TOKEN',
    refresh_token: 'DRAFT_REFRESH_TOKEN'
  });
  try {
    await authManager.exchangeCodeForToken('https://login.live.com/oauth20_desktop.srf?code=draft-174', 'acc_draft_174', {
      name: '草稿账号',
      order: 99,
      persist: false
    });
    assert.equal(configManager.findAccount('acc_draft_174'), null, '草稿阶段不能写入配置');
  } finally {
    networkClient.request = origRequest;
  }
});

test('Daily Set 卡片动作只执行 dailyset 卡片，不再误跑打孔卡', async () => {
  const accountId = 'acc_daily_set_174';
  configManager.upsertAccount({ id: accountId, name: 'DailySet 测试', cookie: 'MOCK_COOKIE' });
  const tm = new TaskManager();
  const origDiscover = rewardsApi.discoverCards;
  const origClaim = rewardsApi.claimCard;
  const origQuest = rewardsApi.getQuestPunchCards;
  const origDelay = rewardsApi.randomDelay;
  const origSync = tm.syncAccountOfficialStatus;
  const claimed = [];
  rewardsApi.discoverCards = async () => ([
    { offerId: 'Gamification_DailySet_1', hash: 'h1', points: 10, category: 'dailyset', title: 'Daily 1' },
    { offerId: 'Promo_1', hash: 'h2', points: 5, category: 'promo', title: 'Promo 1' }
  ]);
  rewardsApi.claimCard = async (card) => { claimed.push(card.offerId); return true; };
  rewardsApi.getQuestPunchCards = async () => { throw new Error('Daily Set 不应触碰打孔卡'); };
  rewardsApi.randomDelay = async () => {};
  tm.syncAccountOfficialStatus = async () => tm.ensureAccountStats(accountId);
  try {
    const result = await tm.runTaskAction(accountId, 'dailySet');
    assert.deepEqual(claimed, ['Gamification_DailySet_1']);
    assert.equal(result.hadFailure, false);
    assert.ok(result.details.some(x => x.includes('Daily 1')));
  } finally {
    rewardsApi.discoverCards = origDiscover;
    rewardsApi.claimCard = origClaim;
    rewardsApi.getQuestPunchCards = origQuest;
    rewardsApi.randomDelay = origDelay;
    tm.syncAccountOfficialStatus = origSync;
  }
});



test('Chromium 浏览器 close 卡死时仍会释放资源锁', async () => {
  browserManager.closeTimeoutMs = 30;
  const owner = `chromium-test-close-${Date.now()}`;
  assert.equal(browserSlotLock.tryAcquire(owner), true);
  browserManager.slotHeld = true;
  browserManager.slotOwner = owner;
  browserManager.context = { close: () => new Promise(() => {}) };
  browserManager.browser = { close: () => new Promise(() => {}) };

  const started = Date.now();
  await browserManager.closeBrowser();
  assert.ok(Date.now() - started < 1000, '浏览器 close 卡死不能永久占住资源锁');
  assert.equal(browserManager.slotHeld, false);
  assert.equal(browserSlotLock.isBusy(), false);
  assert.equal(browserManager.getStatus().status, 'idle');
});


test('noVNC 内嵌页使用 /novnc/websockify 时也能正确转发', async () => {
  let proxiedPath = '';
  const dummy = http.createServer((req, res) => {
    proxiedPath = req.url;
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok');
  });
  await new Promise(resolve => dummy.listen(0, '127.0.0.1', resolve));
  const prevNovncPort = process.env.NOVNC_PORT;
  process.env.NOVNC_PORT = String(dummy.address().port);
  const app = createServer();
  const server = app.listen(0);
  await new Promise(resolve => server.once('listening', resolve));
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/novnc/websockify?token=1`);
    assert.equal(res.status, 200);
    assert.equal(proxiedPath, '/websockify?token=1');
  } finally {
    await new Promise(resolve => server.close(resolve));
    await new Promise(resolve => dummy.close(resolve));
    if (prevNovncPort === undefined) delete process.env.NOVNC_PORT;
    else process.env.NOVNC_PORT = prevNovncPort;
  }
});
