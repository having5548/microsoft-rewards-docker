import test from 'node:test';
import assert from 'node:assert/strict';

const {
  SearchStagnationGuard,
  normalizeStagnantLimit,
  STAGNANT_LIMIT_DEFAULT,
  STAGNANT_LIMIT_MAX
} = await import('../src/core/searchStagnation.js');

test('进度持续增长时永远不触发停滞', () => {
  const guard = new SearchStagnationGuard(3);
  for (let progress = 10; progress < 30; progress += 3) {
    assert.equal(guard.observe(progress).stagnant, false);
  }
  assert.equal(guard.stagnantCount, 0);
});

test('连续达到阈值次没有增长才触发停滞', () => {
  const guard = new SearchStagnationGuard(3);
  guard.observe(60); // 基准
  assert.equal(guard.observe(60).stagnant, false, '第 1 次不涨还不该停');
  assert.equal(guard.observe(60).stagnant, false, '第 2 次不涨还不该停');
  const last = guard.observe(60);
  assert.equal(last.stagnant, true, '第 3 次不涨应当触发停滞保护');
  assert.equal(last.bestProgress, 60);
  assert.equal(last.stagnantCount, 3);
});

test('中途涨过一次，计数归零重新计算', () => {
  const guard = new SearchStagnationGuard(2);
  guard.observe(60);
  assert.equal(guard.observe(60).stagnant, false);
  assert.equal(guard.observe(63).stagnant, false, '涨了就说明额度还没到顶');
  assert.equal(guard.stagnantCount, 0);
  assert.equal(guard.observe(63).stagnant, false);
  assert.equal(guard.observe(63).stagnant, true);
});

test('进度倒退不算增长，也不清空计数', () => {
  const guard = new SearchStagnationGuard(2);
  guard.observe(60);
  assert.equal(guard.observe(57).stagnant, false);
  assert.equal(guard.stagnantCount, 1);
  assert.equal(guard.bestProgress, 60, '最高水位不应该被更低的读数拉下来');
});

test('官网没返回进度时不判定，避免一次读不到就误停', () => {
  const guard = new SearchStagnationGuard(1);
  assert.equal(guard.observe(null).stagnant, false);
  assert.equal(guard.observe(undefined).stagnant, false);
  assert.equal(guard.observe(NaN).stagnant, false);
  assert.equal(guard.stagnantCount, 0);
});

test('阈值会被夹到合法区间', () => {
  assert.equal(normalizeStagnantLimit(0), 1);
  assert.equal(normalizeStagnantLimit(-5), 1);
  assert.equal(normalizeStagnantLimit(999), STAGNANT_LIMIT_MAX);
  assert.equal(normalizeStagnantLimit('abc'), STAGNANT_LIMIT_DEFAULT);
  assert.equal(normalizeStagnantLimit(undefined), STAGNANT_LIMIT_DEFAULT);
  assert.equal(normalizeStagnantLimit(7), STAGNANT_LIMIT_MAX);
});
