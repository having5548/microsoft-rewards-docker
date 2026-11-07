import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const { parsePointsFromCardText } = await import('../src/core/browser.js');

test('可领取卡片文本能正确解析千分位积分', () => {
  // 线上真实文本（React 渲染后 innerText 的分行形式）
  assert.equal(parsePointsFromCardText('可领取\n\n1,012\n\n领取'), 1012);
  assert.equal(parsePointsFromCardText('可领取 |  | 1,012 |  | 领取'), 1012);
  assert.equal(parsePointsFromCardText('可领取 26,323 领取'), 26323);
  assert.equal(parsePointsFromCardText('可领取\n42\n领取'), 42);
  assert.equal(parsePointsFromCardText('可领取\n\n0\n\n领取'), 0);
  assert.equal(parsePointsFromCardText('可领取'), 0);
  assert.equal(parsePointsFromCardText(''), 0);
  assert.equal(parsePointsFromCardText(null), 0);
});

test('领取逻辑不再出现五轮死循环，且直接按「领取积分」定位确认按钮', () => {
  const source = fs.readFileSync(new URL('../src/core/browser.js', import.meta.url), 'utf-8');
  assert.equal(source.includes('rounds < 5'), false, '旧的 5 轮循环必须移除，否则会反复触发领取');
  // 不能先取 [role=dialog].first()：页面上可能有可见但为空的 dialog 容器，取错就点不到按钮
  assert.ok(source.includes('filter({ hasText: /领取积分/ })'), '必须直接定位「领取积分」按钮');
  assert.equal(source.includes(".locator('[role=\"dialog\"], [role=\"alertdialog\"]').first()"), false, '不要再用 .first() 取弹窗');
  assert.ok(source.includes('parsePointsFromCardText'), '数值必须走统一的千分位解析');
  assert.ok(source.includes('for (let attempt = 1; attempt <= 2'), '最多只允许两轮尝试');
});
