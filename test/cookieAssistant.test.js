import test from 'node:test';
import assert from 'node:assert/strict';
import {
  analyzeCookie,
  buildCookieString,
  parseCookiePairs,
  deriveUnderscoreU,
  looksLikeGuid,
  describeCookieProblem
} from '../src/core/cookieAssistant.js';

const GUID_A = 'a1b2c3d4-1111-2222-3333-444455556666';
const GUID_B = 'ffffffff-aaaa-bbbb-cccc-dddddddddddd';

test('完整 Cookie 串原样保留顺序与取值', () => {
  const raw = `_U=${GUID_A}; MUID=8B0F1F0F1F0F1F0F1F0F1F0F1F0F1F0F; RPSSecAuth=abc; SRCHUSR=DOB=20250101`;
  const result = analyzeCookie(raw);
  assert.equal(result.error, '');
  assert.equal(result.hasU, true);
  assert.equal(result.cookieCount, 4);
  assert.match(result.cookie, /_U=a1b2c3d4/);
  assert.equal(result.added.length, 0);
});

test('Safari / Excel 表格复制（制表符分隔）能被解析', () => {
  const raw = `_U\t${GUID_A}\nMUID\t1122334455667788`;
  const pairs = parseCookiePairs(raw);
  assert.equal(pairs.get('_U'), GUID_A);
  assert.equal(pairs.get('MUID'), '1122334455667788');
});

test('Cookie-Editor 导出的 JSON 数组能被解析', () => {
  const raw = JSON.stringify([
    { name: '_U', value: GUID_A, domain: '.bing.com' },
    { name: 'MUID', value: 'deadbeef' },
    { name: 'path', value: '/' }
  ]);
  const pairs = parseCookiePairs(raw);
  assert.equal(pairs.get('_U'), GUID_A);
  assert.equal(pairs.get('MUID'), 'deadbeef');
  assert.equal(pairs.has('path'), false, 'Cookie 属性不能被当成 Cookie 本身');
});

test('带 Cookie: 前缀与包裹引号的输入也能解析', () => {
  const pairs = parseCookiePairs(`"Cookie: _U=${GUID_A}; MUID=abc"`);
  assert.equal(pairs.get('_U'), GUID_A);
  assert.equal(pairs.get('MUID'), 'abc');
});

test('单个 Cookie 的值（不是整串）会被明确拒绝，而不是静默存进去', () => {
  const raw = '1lgcBhmg5CpmbbovoIBS1DXR7g1sEW4c7bfnkJ1DWdpBicRB1PojT1OIf-7yev7TksrV0rF2KToaWarxzIJyN4grk7oOJ_im2RQ5YGhelqRz7mmGUw47IzVSihRIUz313kFWqZLW7K-ou68vJ7flN8dnlxpYSySzeIawKwKJYOv3jC9JVFp4v4cqhoXU_-EuHFEoIC3oIn9efphEzWfIFJA';
  const result = analyzeCookie(raw);
  assert.equal(result.singleValue, true);
  assert.match(result.error, /只是一个 Cookie 的值/);
  assert.equal(result.cookie, '');
});

test('只贴 _U 的 GUID 时会合并进已有 Cookie，而不是整体替换', () => {
  const existing = `_U=${GUID_B}; MUID=m1; RPSSecAuth=r1; SRCHUSR=DOB=20250101`;
  const result = analyzeCookie(GUID_A, { existingCookie: existing });
  assert.equal(result.bareGuid, true);
  assert.equal(parseCookiePairs(result.cookie).get('_U'), GUID_A);
  assert.equal(parseCookiePairs(result.cookie).get('MUID'), 'm1', '不能把原有 Cookie 丢掉');
  assert.equal(parseCookiePairs(result.cookie).get('RPSSecAuth'), 'r1');
});

test('只贴一对 _U=... 时也与已有 Cookie 合并', () => {
  const existing = `MUID=m1; RPSSecAuth=r1`;
  const result = analyzeCookie(`_U=${GUID_A}`, { existingCookie: existing });
  const pairs = parseCookiePairs(result.cookie);
  assert.equal(pairs.get('_U'), GUID_A);
  assert.equal(pairs.get('MUID'), 'm1');
});

test('缺少 _U 时从 SRCHUID 与 _EDGE_S 交叉推导，且只有两者一致才采用', () => {
  const agree = parseCookiePairs(`MUID=m1; SRCHUID=V=2&GUID=${GUID_A}&dmnchg=1; _EDGE_S=mkt=zh-cn&GUID=${GUID_A}&ui=zh`);
  const derived = deriveUnderscoreU(agree);
  assert.equal(derived.value, GUID_A);

  const conflict = parseCookiePairs(`SRCHUID=V=2&GUID=${GUID_A}&dmnchg=1; _EDGE_S=mkt=zh-cn&GUID=${GUID_B}`);
  const conflicted = deriveUnderscoreU(conflict);
  assert.equal(conflicted.value, '', '互相矛盾时不能猜');
  assert.deepEqual(conflicted.conflict, ['SRCHUID', '_EDGE_S']);
});

test('自动补 _U 会体现在 added 里并可被描述', () => {
  const raw = `MUID=m1; SRCHUID=V=2&GUID=${GUID_A}&dmnchg=1; _EDGE_S=mkt=zh-cn&GUID=${GUID_A}`;
  const result = analyzeCookie(raw);
  assert.equal(result.hasU, true);
  assert.deepEqual(result.added, ['_U']);
  assert.match(describeCookieProblem(result), /已自动补齐 _U/);
});

test('GUID 冲突时不自动补 _U，并给出可读原因', () => {
  const raw = `MUID=m1; SRCHUID=V=2&GUID=${GUID_A}; _EDGE_S=mkt=zh-cn&GUID=${GUID_B}`;
  const result = analyzeCookie(raw);
  assert.equal(result.hasU, false);
  assert.deepEqual(result.criticalMissing, ['_U']);
  assert.match(describeCookieProblem(result), /互相不一致/);
});

test('构建 Cookie 串会跳过空名与属性名', () => {
  const cookie = buildCookieString(new Map([
    ['_U', GUID_A],
    ['path', '/'],
    ['MUID', 'm1']
  ]));
  assert.equal(cookie, `_U=${GUID_A}; MUID=m1`);
});

test('looksLikeGuid 只接受标准 GUID', () => {
  assert.equal(looksLikeGuid(GUID_A), true);
  assert.equal(looksLikeGuid('not-a-guid'), false);
});
