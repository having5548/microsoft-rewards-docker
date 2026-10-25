import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'msr-points-summary-'));
process.env.MSR_DATA_DIR = tmpDir;

const { default: historyManager } = await import('../src/core/history.js');
const { TaskManager } = await import('../src/core/taskManager.js');

function localDate(offsetDays = 0) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return historyManager.formatDate(d);
}

function localDateNum(offsetDays = 0) {
  return Number(localDate(offsetDays).replaceAll('-', ''));
}

test('历史记录同一天内只增不减，晚间的 0 不能覆盖白天已确认积分', () => {
  const accountId = 'acc_monotonic_earned';
  const date = localDate();
  historyManager.recordAccountDay(accountId, date, {
    earned: 112,
    balance: 781,
    breakdown: [{ name: '必应 PC 搜索任务', icon: '🔍', points: 30 }]
  });
  historyManager.recordAccountDay(accountId, date, { earned: 0, balance: 781, breakdown: [] });

  const record = historyManager.load().accounts[accountId][date];
  assert.equal(record.earned, 112);
  assert.equal(record.breakdown.length, 1, '后续空分解不能抹掉已记录明细');
});

test('旧历史中的错误 0 会按相邻日余额差回填', () => {
  const accountId = 'acc_backfill_earned';
  const records = [
    { date: localDate(-3), earned: 95, balance: 330 },
    { date: localDate(-2), earned: 0, balance: 425 },
    { date: localDate(-1), earned: 0, balance: 669 }
  ];
  for (const record of records) {
    historyManager.recordAccountDay(accountId, record.date, record);
  }

  const map = historyManager.getAccountHistory(accountId);
  assert.equal(map[records[1].date].earned, 95, '10-15 实际新增应为 425 - 330');
  assert.equal(map[records[1].date].earnedInferred, true);
  assert.equal(map[records[2].date].earned, 244, '10-16 实际新增应为 669 - 425');
});

test('全部账号汇总会采用回填后的账号积分，而不是旧全局 0', () => {
  const accountId = 'acc_backfill_summary';
  historyManager.recordAccountDay(accountId, localDate(-5), { earned: 95, balance: 330 });
  historyManager.recordAccountDay(accountId, localDate(-4), { earned: 0, balance: 425 });

  const list = historyManager.getHistory(6, 'all', {
    accounts: {
      [accountId]: { name: '回填测试账号', balance: 425, earned: 0, tasks: {} }
    },
    summary: { totalBalance: 425, totalEarned: 0 }
  });
  const inferredDay = list.find(item => item.date === localDate(-4));
  assert.equal(inferredDay.earned, 95);
  assert.equal(inferredDay.accounts[0].earned, 95);
});

test('跨日加载会用昨日收盘余额作为今日起始余额', () => {
  const accountId = 'acc_1';
  fs.writeFileSync(path.join(tmpDir, 'stats.json'), JSON.stringify({
    date: localDateNum(-1),
    balance: 669,
    earned: 0,
    accounts: {
      [accountId]: {
        id: accountId,
        name: '主账号',
        balance: 669,
        startBalance: 500,
        startBalanceDate: localDateNum(-1),
        earned: 0,
        tasks: {}
      }
    }
  }), 'utf-8');

  const taskManager = new TaskManager();
  const stats = taskManager.ensureAccountStats(accountId);
  assert.equal(stats.balance, 669);
  assert.equal(stats.startBalance, 669);
  assert.equal(stats.startBalanceDate, localDateNum());
});

test('官网今日积分为 0 时，用昨日收盘余额计算余额差且不回退已有正数', () => {
  const taskManager = new TaskManager();
  const accountId = 'acc_apply_earned';
  const previousDate = localDate(-1);
  historyManager.recordAccountDay(accountId, previousDate, { earned: 0, balance: 669 });
  const stats = {
    id: accountId,
    balance: 781,
    startBalance: 502,
    startBalanceDate: localDateNum(),
    earned: 0,
    earnedSource: ''
  };

  taskManager.applyEarned(stats, 0);
  assert.equal(stats.startBalance, 669, '错误的 502 起点应被昨日收盘余额校准');
  assert.equal(stats.earned, 112);
  assert.equal(stats.earnedSource, 'balance-delta');

  taskManager.applyEarned(stats, 0);
  assert.equal(stats.earned, 112, '后续同步仍返回 0 时不得覆盖正数');
});

test('账号余额没有增长且官网返回 0 时，今日积分保持 0', () => {
  const taskManager = new TaskManager();
  const accountId = 'acc_no_gain_today';
  historyManager.recordAccountDay(accountId, localDate(-1), { earned: 0, balance: 781 });
  const stats = {
    id: accountId,
    balance: 781,
    startBalance: 502,
    startBalanceDate: localDateNum(),
    earned: 0,
    earnedSource: ''
  };

  taskManager.applyEarned(stats, 0);
  assert.equal(stats.startBalance, 781);
  assert.equal(stats.earned, 0);
});
