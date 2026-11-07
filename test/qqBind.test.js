import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const { qqBindManager } = await import('../src/core/qqBind.js');

test('QQ OpenID 绑定：缺 AppID / AppSecret / 频道类型都给出可读提示', async () => {
  await assert.rejects(() => qqBindManager.start({ appId: '', clientSecret: 'x' }), /AppID/);
  await assert.rejects(() => qqBindManager.start({ appId: 'x', clientSecret: '' }), /AppSecret/);
  await assert.rejects(
    () => qqBindManager.start({ appId: 'x', clientSecret: 'y', kind: 'channel' }),
    /channel_id/
  );
});

test('QQ OpenID 绑定：会话有 4 位验证码，取消后不再暴露验证码', async () => {
  const session = await qqBindManager.start({ appId: 'test-app', clientSecret: 'test-secret', kind: 'group' });
  assert.match(session.verifyCode, /^\d{4}$/);
  assert.equal(qqBindManager.getSession(session.bindId).status, 'waiting');

  qqBindManager.cancel(session.bindId);
  const after = qqBindManager.getSession(session.bindId);
  assert.equal(after.status, 'cancelled');
  assert.equal(after.verifyCode, '', '取消后的会话不应再返回验证码');
});

test('QQ OpenID 绑定：未知会话返回 null（接口据此回 404）', () => {
  assert.equal(qqBindManager.getSession('not-a-real-bind-id'), null);
});

test('配置中心提供「自动获取 OpenID」入口，且已移除液态视觉 Tab', () => {
  const html = fs.readFileSync(new URL('../src/web/public/index.html', import.meta.url), 'utf-8');
  const app = fs.readFileSync(new URL('../src/web/public/app.js', import.meta.url), 'utf-8');
  assert.ok(html.includes('id="btn-qq-bind-openid"'), 'QQ 配置区必须有自动获取按钮');
  assert.ok(html.includes('id="qq-bind-status"'), '需要展示验证码与进度');
  assert.ok(app.includes("'/api/notify/qq/bind'"), '前端要调用绑定接口');
  assert.equal(html.includes('data-tab="tab-appearance"'), false, '液态视觉 Tab 应已删除');
});
