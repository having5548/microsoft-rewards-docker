import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'msr-fixes176-'));
process.env.MSR_DATA_DIR = tmpDir;

const { default: configManager } = await import('../src/config.js');
const { default: rewardsApi } = await import('../src/core/api.js');
const { TaskManager } = await import('../src/core/taskManager.js');

test('体检恢复后旧 executionBlockReason 会被实时校验自动清除', async (t) => {
  const accountId = 'acc_recovery_176';
  configManager.upsertAccount({
    id: accountId,
    name: '测试账号恢复',
    cookie: 'COOKIE',
    refreshToken: 'REFRESH_TOKEN',
    accessToken: 'ACCESS_TOKEN',
    tokenTime: Date.now()
  });
  configManager.recordAuthDiagnosis(accountId, {
    cookieValid: true,
    tokenValid: true,
    overallValid: true,
    warning: false,
    warningMessage: '',
    balance: 516,
    cookieMessage: '',
    tokenMessage: ''
  });

  const taskManager = new TaskManager();
  const stats = taskManager.ensureAccountStats(accountId);
  stats.executionBlockReason = '移动端 Token 实际绑定到其他账号（Token 余额 669，网页端余额 508）';
  taskManager.saveStats();

  const originalGetRewardsInfo = rewardsApi.getRewardsInfo;
  const originalCheckStreak = rewardsApi.checkStreak;
  const originalCheckBinding = taskManager.checkMobileAccountBinding;

  rewardsApi.getRewardsInfo = async () => ({
    balance: 516,
    pc: { progress: 6, max: 30 },
    readMax: 30,
    readProgress: 3,
    claimablePoints: 0,
    quests: [],
    streaks: {
      bingapp: {
        completedDays: 1,
        activitiesCompleted: 1,
        activitiesTotal: 1,
        isCurrentDayCompleted: true
      }
    }
  });
  rewardsApi.checkStreak = async () => ({});
  taskManager.checkMobileAccountBinding = async () => ({
    tokenOk: true,
    mobileBalance: 516,
    mismatch: false,
    message: ''
  });

  t.after(() => {
    rewardsApi.getRewardsInfo = originalGetRewardsInfo;
    rewardsApi.checkStreak = originalCheckStreak;
    taskManager.checkMobileAccountBinding = originalCheckBinding;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  await taskManager.syncAccountOfficialStatus(configManager.findAccount(accountId), { owned: true });

  assert.equal(
    taskManager.ensureAccountStats(accountId).executionBlockReason,
    undefined,
    '实时校验确认 Token 已恢复后，不能再保留历史运行阻断标记'
  );
});
