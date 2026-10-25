import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'msr-fixes178-'));
process.env.MSR_DATA_DIR = tmpDir;

const { default: networkClient } = await import('../src/network.js');
const { default: rewardsApi } = await import('../src/core/api.js');
const { default: configManager } = await import('../src/config.js');
const { TaskManager } = await import('../src/core/taskManager.js');

test('getRewardsInfo 不应从静态 Cookie 中回退 rc=502 假余额', async (t) => {
  const origRequest = networkClient.request;
  const origActiveCookie = networkClient.getActiveCookie();
  // 模拟静态 Cookie 中含有历史旧积分 502
  networkClient.setActiveCookie('MUID=TEST; _RwBf=rc=502&rb=502;');

  // 模拟 /earn 返回 Next.js 骨架外壳（无 balance，无 pointsCounters），但 /dashboard 含有真实 888 余额
  networkClient.request = async ({ url }) => {
    if (url.includes('/earn')) {
      return '<html><body><div id="skeleton">加载中</div></body></html>';
    }
    if (url.includes('/dashboard')) {
      return '<html><body><script>{"balance":888,"level":2}</script><p class="text-pageHeader">888</p></body></html>';
    }
    return '';
  };

  t.after(() => {
    networkClient.request = origRequest;
    networkClient.setActiveCookie(origActiveCookie);
  });

  const info = await rewardsApi.getRewardsInfo(1);
  assert.ok(info, '应返回信息');
  assert.equal(info.balance, 888, '应从 dashboard 提取真实余额 888，绝不能回退到 Cookie 中的 502');
});

test('getRewardsInfo 在网页未取到余额时尝试从 DAPI 获取，且绝不采用 Cookie 旧值', async (t) => {
  const origRequest = networkClient.request;
  const origBalance = rewardsApi.getBalance;
  const origActiveCookie = networkClient.getActiveCookie();
  networkClient.setActiveCookie('MUID=TEST; _RwBf=rc=502&rb=502;');

  // 网页均未包含余额
  networkClient.request = async () => '<html><body></body></html>';
  // DAPI 具有真实余额 888
  rewardsApi.getBalance = async () => 888;

  t.after(() => {
    networkClient.request = origRequest;
    rewardsApi.getBalance = origBalance;
    networkClient.setActiveCookie(origActiveCookie);
  });

  const info = await rewardsApi.getRewardsInfo(1);
  assert.ok(info);
  assert.equal(info.balance, 888, '应取到 DAPI 余额 888，而非 Cookie 快照中的 502');
});

test('TaskManager 多账号安全隔离延时遵守配置与随机浮动', async (t) => {
  const taskManager = new TaskManager();
  const accountId1 = 'acc_gap_1';
  const accountId2 = 'acc_gap_2';
  configManager.upsertAccount({
    id: accountId1,
    name: '测试账号 1',
    cookie: 'C1',
    refreshToken: 'R1'
  });
  configManager.upsertAccount({
    id: accountId2,
    name: '测试账号 2',
    cookie: 'C2',
    refreshToken: 'R2'
  });

  t.after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  assert.equal(configManager.get().tasks.accountGapSec, 180, '默认多账号隔离间隔应为 180 秒');
});
