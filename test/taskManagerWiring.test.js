import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync(new URL('../src/core/taskManager.js', import.meta.url), 'utf-8');

// 回归保护：runSingleAccount(accCfg, ...) 里的账号变量叫 accCfg。
// 曾经写成 claimExtraPointsAfterTasks(acc, ...)，一跑到连签/额外积分阶段就抛
// "ReferenceError: acc is not defined"，整轮打卡直接失败（线上 2026-11-01 事故）。
test('runSingleAccount 调用额外积分领取时使用 accCfg 而不是未定义的 acc', () => {
  assert.match(source, /async runSingleAccount\(accCfg,/, 'runSingleAccount 的参数名应为 accCfg');
  assert.ok(
    source.includes('claimExtraPointsAfterTasks(accCfg'),
    '必须把 accCfg 传进去，acc 在该作用域不存在'
  );
  assert.equal(
    source.includes('this.claimExtraPointsAfterTasks(acc,'),
    false,
    'acc 在 runSingleAccount 作用域内未定义，会抛 ReferenceError'
  );
});
