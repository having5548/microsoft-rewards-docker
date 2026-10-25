import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'msr-v179-'));
process.env.MSR_DATA_DIR = tmpDir;

const { default: configManager } = await import('../src/config.js');
const { default: authManager } = await import('../src/core/auth.js');
const { default: networkClient } = await import('../src/network.js');
const { default: taskManager, TaskManager } = await import('../src/core/taskManager.js');
const {
  parseQuestProgress,
  classifyQuestAction,
  questSubtaskKey,
  isDailyQuestSubtask,
  isQuestSubtaskCoolingDown,
  buildQuestSubtaskUpdate
} = await import('../src/core/questStatus.js');
const { accountIdentityKey } = await import('../src/core/browserSession.js');

const ROOT = path.resolve(import.meta.dirname, '..');
const TASK_MANAGER_SOURCE = fs.readFileSync(path.join(ROOT, 'src/core/taskManager.js'), 'utf-8');
const APP_SOURCE = fs.readFileSync(path.join(ROOT, 'src/web/public/app.js'), 'utf-8');
const INDEX_SOURCE = fs.readFileSync(path.join(ROOT, 'src/web/public/index.html'), 'utf-8');

test('打孔卡 1/5 搜索任务被识别为可搜索的每日任务', () => {
  const progress = parseQuestProgress('点击下方按钮激活此任务。然后在 14 天中有 5 天使用 Bing 搜索。1/5。');
  assert.deepEqual(progress, { progress: 1, max: 5, done: false });
  assert.equal(classifyQuestAction({
    title: '继续搜索',
    actionText: '继续搜索',
    rawText: '每次搜索必须间隔至少 24 小时'
  }), 'search');
  assert.equal(isDailyQuestSubtask({
    kind: 'search',
    rawText: '每次搜索必须间隔至少 24 小时'
  }), true);
});

test('打孔卡子任务使用稳定键并正确执行冷却', () => {
  const a = questSubtaskKey({ href: '/earn/quest/x', title: '继续搜索', actionText: '继续搜索', kind: 'search' });
  const b = questSubtaskKey({ href: '/earn/quest/x', title: '页面重排后的标题', actionText: '继续搜索', kind: 'search' });
  assert.equal(a, b);
  const now = 1_000_000;
  const state = buildQuestSubtaskUpdate({
    result: 'no-change',
    progressBefore: 1,
    progressAfter: 1,
    now,
    cooldownMs: 24 * 60 * 60 * 1000
  });
  assert.equal(isQuestSubtaskCoolingDown(state, now + 1000), true);
  assert.equal(isQuestSubtaskCoolingDown(state, now + 24 * 60 * 60 * 1000 + 1), false);
});

test('搜索进度不再使用本地 +3 或 max(本地, 官网) 伪造', () => {
  assert.equal(TASK_MANAGER_SOURCE.includes('curSearch + completed * 3'), false);
  assert.equal(TASK_MANAGER_SOURCE.includes('Math.max(official, liveSearch, curSearch)'), false);
  assert.match(TASK_MANAGER_SOURCE, /官网连续未计分/);
});

test('暂停账号保留 Cookie、Token 与统计，只切换 enabled 和 pausedAt', () => {
  const id = 'acc_pause_test';
  configManager.upsertAccount({
    id,
    name: '暂停测试',
    cookie: '_U=PAUSE; MUID=1',
    refreshToken: 'RT-PAUSE',
    accessToken: 'AT-PAUSE',
    tokenTime: Date.now()
  });
  const before = configManager.findAccount(id);
  const paused = configManager.setAccountEnabled(id, false);
  assert.equal(paused.enabled, false);
  assert.ok(paused.pausedAt > 0);
  assert.equal(paused.cookie, before.cookie);
  assert.equal(paused.refreshToken, before.refreshToken);
  assert.equal(paused.accessToken, before.accessToken);

  const resumed = configManager.setAccountEnabled(id, true);
  assert.equal(resumed.enabled, true);
  assert.equal(resumed.pausedAt, undefined);
  assert.equal(resumed.cookie, before.cookie);
});

test('暂停账号自动流程不刷新 Token，也不允许运行任务', async () => {
  const id = 'acc_pause_no_refresh';
  configManager.upsertAccount({
    id,
    name: '暂停不刷新',
    cookie: '_U=PAUSE2',
    refreshToken: 'RT-PAUSE2',
    accessToken: 'AT-PAUSE2',
    tokenTime: 0
  });
  configManager.setAccountEnabled(id, false);

  const originalRequest = networkClient.request;
  let networkCalled = false;
  networkClient.request = async () => {
    networkCalled = true;
    throw new Error('paused account must not call network');
  };
  try {
    const ok = await authManager.refreshToken(false, id);
    assert.equal(ok, false);
    assert.equal(networkCalled, false);
    assert.equal(await taskManager.syncAccountOfficialStatus(configManager.findAccount(id)), null);
    assert.equal(networkCalled, false);
    const tm = new TaskManager();
    await assert.rejects(() => tm.runTaskAction(id, 'search'), /账号已暂停/);
    await assert.rejects(() => tm.runSingleTestSearch(id), /账号已暂停/);
  } finally {
    networkClient.request = originalRequest;
  }
});

test('手动刷新与手动体检使用 allowPaused 例外，自动任务默认不传', () => {
  const serverSource = fs.readFileSync(path.join(ROOT, 'src/web/server.js'), 'utf-8');
  assert.match(serverSource, /syncAccountOfficialStatus\(accCfg, \{ allowPaused: true \}\)/);
  assert.match(serverSource, /syncAllOfficialStatus\(\{ allowPaused: true \}\)/);
  assert.match(serverSource, /testAccount\(targetAccountId, \{/);
  assert.match(serverSource, /allowPaused: options\.allowPaused === true/);
});

test('Token 轮换不会作废浏览器会话，只有网页身份变化才会', () => {
  const base = { id: 'acc_same', cookie: 'A=1; _U=SAME; MUID=M1', refreshToken: 'RT1', accessToken: 'AT1' };
  const rotated = { ...base, refreshToken: 'RT2', accessToken: 'AT2', authCodeUrl: 'new-code' };
  const changedUser = { ...base, cookie: 'A=1; _U=OTHER; MUID=M1' };
  assert.equal(accountIdentityKey(base), accountIdentityKey(rotated));
  assert.notEqual(accountIdentityKey(base), accountIdentityKey(changedUser));
});

test('UI 提供暂停按钮和统一四色状态', () => {
  assert.match(INDEX_SOURCE, /id="btn-toggle-account-header"/);
  assert.match(APP_SOURCE, /function getAccountRuntimeStatus/);
  assert.match(APP_SOURCE, /status-paused/);
  assert.match(APP_SOURCE, /status-running/);
  assert.match(APP_SOURCE, /status-invalid/);
  assert.match(APP_SOURCE, /status-valid/);
});
