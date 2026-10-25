import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 用独立数据目录，避免测试污染真实 data/
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'msr-history-'));
process.env.MSR_DATA_DIR = tmpDir;

const { default: historyManager } = await import('../src/core/history.js');

test('历史明细只记录真实任务分解，不再套用固定模板', () => {
  historyManager.recordAccountDay('acc_test', '2026-10-15', {
    earned: 137,
    balance: 51355,
    breakdown: [{ name: '必应 PC 搜索', icon: '🔍', points: 60 }]
  });
  const history = historyManager.load();
  const rec = history.accounts.acc_test['2026-10-15'];
  assert.equal(rec.earned, 137);
  assert.deepEqual(rec.breakdown, [{ name: '必应 PC 搜索', icon: '🔍', points: 60 }]);
});

test('没有传入分解时保持为空数组，而不是编造条目', () => {
  historyManager.recordAccountDay('acc_test', '2026-10-14', { earned: 100, balance: 100 });
  const rec = historyManager.load().accounts.acc_test['2026-10-14'];
  assert.deepEqual(rec.breakdown, [], '旧实现会返回「签到10/阅读30/...」这种编造明细');
});

test('breakdownFromStats 只汇总真正拿到分的任务', () => {
  const breakdown = historyManager.breakdownFromStats({
    acc_1: {
      tasks: {
        search: { name: '必应 PC 搜索', icon: '🔍', points: 60 },
        read: { name: '新闻资讯自动阅读', icon: '📖', points: 30 },
        promos: { name: '活动卡片与 Quiz 问答', icon: '🧩', points: 0 }
      }
    },
    acc_2: {
      tasks: {
        search: { name: '必应 PC 搜索', icon: '🔍', points: 12 }
      }
    }
  });
  assert.deepEqual(breakdown, [
    { name: '必应 PC 搜索', icon: '🔍', points: 72 },
    { name: '新闻资讯自动阅读', icon: '📖', points: 30 }
  ]);
});

test('写入是延迟合并的，flush 后才落盘', async () => {
  const file = path.join(tmpDir, 'history.json');
  historyManager.recordGlobalDay('2026-10-15', { earned: 200, balance: 999 });
  const before = JSON.parse(fs.readFileSync(file, 'utf-8'));
  assert.equal(before.global['2026-10-15'], undefined, '未 flush 前不应写盘');

  historyManager.flush();
  const after = JSON.parse(fs.readFileSync(file, 'utf-8'));
  assert.equal(after.global['2026-10-15'].earned, 200);
});

test('getHistory 返回的天数与请求一致，缺失日期返回 0 而不是编造趋势', () => {
  // 用一个从未记录过的账号，保证除今天以外都没有历史
  const list = historyManager.getHistory(3, 'acc_empty', { accounts: { acc_empty: { balance: 10, earned: 0, tasks: {} } } });
  assert.equal(list.length, 3);
  const missing = list[1];
  assert.equal(missing.earned, 0);
  assert.deepEqual(missing.breakdown, []);
});
