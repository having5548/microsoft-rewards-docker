import test from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeCookiesForBrowser } from '../src/core/cookieAssistant.js';

const ok = (name, value, extra = {}) => ({ name, value, domain: '.bing.com', path: '/', ...extra });

test('正常 Cookie 全部通过，并补齐缺失的 path 与 domain', () => {
  const { accepted, rejected } = sanitizeCookiesForBrowser([
    ok('_U', 'a1b2c3d4-1111-2222-3333-444455556666'),
    { name: 'MUID', value: 'ABC123' },
    ok('SRCHUSR', 'DOB=20250101&T=1')
  ]);
  assert.equal(rejected.length, 0);
  assert.equal(accepted.length, 3);
  assert.equal(accepted[1].path, '/');
  assert.equal(accepted[1].domain, '.bing.com');
});

test('值里带分号会被拒绝——这是 CDP Invalid cookie fields 的第一大原因', () => {
  const { accepted, rejected } = sanitizeCookiesForBrowser([ok('RPSSecAuth', 'abc;def')]);
  assert.equal(accepted.length, 0);
  assert.equal(rejected[0].name, 'RPSSecAuth');
  assert.match(rejected[0].reason, /分号|控制字符/);
});

test('值里带换行 / 制表符会被拒绝', () => {
  const { rejected } = sanitizeCookiesForBrowser([
    ok('A', 'x\ny'),
    ok('B', 'x\ty'),
    ok('C', 'x\ry')
  ]);
  assert.deepEqual(rejected.map(r => r.name).sort(), ['A', 'B', 'C']);
});

test('单条超过 4096 字节会被拒绝（RPSSecAuth / ESTSAUTH 常见）', () => {
  const { accepted, rejected } = sanitizeCookiesForBrowser([ok('ESTSAUTH', 'A'.repeat(4100))]);
  assert.equal(accepted.length, 0);
  assert.match(rejected[0].reason, /4096/);
});

test('名称带分号 / 等号 / 空名称会被拒绝', () => {
  const { rejected } = sanitizeCookiesForBrowser([
    ok('A;B', 'v'),
    ok('A=B', 'v'),
    ok('', 'v'),
    ok('A B', 'v')
  ]);
  assert.equal(rejected.length, 4);
});

test('域名带斜杠或没有点会被拒绝', () => {
  const { rejected } = sanitizeCookiesForBrowser([
    ok('A', 'v', { domain: '.bing.com/x' }),
    ok('B', 'v', { domain: 'localhost' })
  ]);
  assert.equal(rejected.length, 2);
  assert.equal(rejected[0].reason, '域名无效');
});

test('值尾部空白会被去掉后接受（浏览器本来也不保留）', () => {
  const { accepted, rejected } = sanitizeCookiesForBrowser([ok('A', 'value   ')]);
  assert.equal(rejected.length, 0);
  assert.equal(accepted[0].value, 'value');
});

test('null / 非对象项不会让整批崩掉', () => {
  const { accepted, rejected } = sanitizeCookiesForBrowser([null, undefined, 'x', ok('A', 'v')]);
  assert.equal(accepted.length, 1);
  assert.equal(rejected.length, 3);
});

test('被拒绝的项里能看出是否包含 _U（用于给出「搜索不会计分」的告警）', () => {
  const { rejected } = sanitizeCookiesForBrowser([ok('_U', 'x'.repeat(4200)), ok('MUID', 'm1')]);
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].name, '_U');
});
