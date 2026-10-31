import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const indexHtml = fs.readFileSync(new URL('../src/web/public/index.html', import.meta.url), 'utf-8');
const appJs = fs.readFileSync(new URL('../src/web/public/app.js', import.meta.url), 'utf-8');
const packageJson = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf-8'));
const serverJs = fs.readFileSync(new URL('../src/web/server.js', import.meta.url), 'utf-8');
const styleCss = fs.readFileSync(new URL('../src/web/public/style.css', import.meta.url), 'utf-8');
const appleCss = fs.readFileSync(new URL('../src/web/public/apple-overrides.css', import.meta.url), 'utf-8');
const webglJs = fs.readFileSync(new URL('../src/web/public/webgl-bg.js', import.meta.url), 'utf-8');

test('v1.7.7 删除顶部重复编辑按钮，只保留任务清单编辑入口', () => {
  assert.equal(indexHtml.includes('id="btn-edit-active-account"'), false);
  assert.equal(appJs.includes("getElementById('btn-edit-active-account')"), false);
  assert.equal(indexHtml.includes('id="btn-edit-current-account-header"'), true);
});

test('登录窗口首屏使用 cn.bing.com，积分搜索入口保持独立', () => {
  const loginWindowJs = fs.readFileSync(new URL('../src/core/loginWindow.js', import.meta.url), 'utf-8');
  assert.ok(loginWindowJs.includes("LOGIN_HOME_URL = 'https://cn.bing.com'"));
  assert.ok(indexHtml.includes('https://rewards.bing.com/dashboard'));
  assert.equal(indexHtml.includes('浏览器 cn.bing.com 的完整 Cookie'), false);
});

test('Apple 风格覆盖层已加载并包含移动端布局约束', () => {
  assert.ok(indexHtml.includes('apple-overrides.css'));
  assert.match(appleCss, /--apple-bg: #f5f5f7/);
  assert.match(appleCss, /--apple-blue: #0071e3/);
  assert.match(appleCss, /@media \(max-width: 760px\)/);
  assert.doesNotMatch(appleCss, /bg-gradient|shadow-2xl|shadow-inner/);
});

test('发布版本号在 package 与 Web 服务端保持一致', () => {
  const escaped = packageJson.version.replace(/\./g, '\\.');
  assert.match(serverJs, new RegExp(`const CURRENT_VERSION = '${escaped}';`));
});

test('任务区使用移动端签到与三组 7 日连续进度', () => {
  assert.equal(indexHtml.includes('每日双端签入'), false);
  assert.equal(indexHtml.includes('移动端签到 (双端签入)'), false);
  assert.equal(indexHtml.includes('移动端签到</label>'), true);
  assert.equal(appJs.includes('dual-endpoint-item'), false);
  assert.match(appJs, /必应搜索连续打卡/);
  assert.match(appJs, /每日连续打卡活动/);
  assert.match(appJs, /移动端连续打卡/);
  assert.match(appJs, /TASK_PRIORITY[\s\S]*search: 10[\s\S]*dailySet: 20[\s\S]*sign: 30/);
});

test('液态玻璃视觉包含 WebGL2 背景、统一卡片材质与配置项', () => {
  assert.match(indexHtml, /id="bg-webgl-canvas"/);
  assert.match(indexHtml, /id="tab-appearance"/);
  assert.match(styleCss, /\.glass-surface\.glass-surface/);
  assert.match(styleCss, /--glass-opacity/);
  assert.match(webglJs, /#version 300 es/);
  assert.match(webglJs, /renderSilk/);
  assert.match(webglJs, /renderGrainient/);
  assert.match(webglJs, /renderVeil/);
  assert.match(webglJs, /renderSoftAurora/);
  assert.match(webglJs, /renderPrism/);
});

test('界面固定夜间模式并修复下拉菜单深色可读性', () => {
  assert.equal(indexHtml.includes('data-theme-val="light"'), false);
  assert.equal(indexHtml.includes('id="cfg-ui-theme" value="dark"'), true);
  assert.equal(styleCss.includes('[data-theme="light"]'), false);
  assert.match(styleCss, /\.form-select option[\s\S]*background: #111827/);
  assert.match(styleCss, /\.stamp-grid-item\.collected[\s\S]*#FFD84D/);
});

test('鼠标只驱动边框高光角度，不再生成跟随光斑', () => {
  assert.match(appJs, /--pointer-angle/);
  assert.match(appJs, /Math\.atan2\(normY, normX\) \* 180 \/ Math\.PI \+ 90/);
  assert.equal(appJs.includes('--mouse-x'), false);
  assert.equal(styleCss.includes('--mouse-x'), false);
  assert.match(styleCss, /conic-gradient\([\s\S]*--pointer-angle/);
});

test('账号汇总完整展开迷你印章并优化任务卡与统计块排版', () => {
  assert.match(indexHtml, /id="stamps-account-list"/);
  assert.match(appJs, /renderAccountStampsList/);
  const stampsBlock = styleCss.match(/\.stamps-account-list\s*\{([\s\S]*?)\}/)?.[1] || '';
  assert.match(stampsBlock, /max-height:\s*none/);
  assert.match(stampsBlock, /overflow:\s*visible/);
  assert.doesNotMatch(stampsBlock, /overflow-y:\s*auto/);
  assert.match(styleCss, /\.task-card-featured[\s\S]*min-height: 0/);
  assert.match(styleCss, /\.acc-stat-box[\s\S]*border-radius: 10px/);
});

test('首页汇总展示逐账号积分明细，历史图只在汇总视图且位于监控卡片之前', () => {
  assert.match(indexHtml, /id="earned-account-breakdown"/);
  assert.match(indexHtml, /id="balance-account-breakdown"/);
  assert.match(indexHtml, /id="claimable-account-breakdown"/);
  assert.match(appJs, /renderHeroAccountBreakdown/);
  const historyIndex = indexHtml.indexOf('id="history-card-section"');
  const monitorIndex = indexHtml.indexOf('id="browser-monitor-card"');
  assert.ok(historyIndex > 0 && historyIndex < monitorIndex);
  assert.match(appJs, /historyCard\.style\.display = isAllMode \? 'flex' : 'none'/);
});

test('四张 Hero 卡共用标签与明细结构，账号概览避免轮询时重复重建', () => {
  assert.match(indexHtml, /id="stat-streak"/);
  assert.match(styleCss, /\.hero-label-row[\s\S]*min-height: 24px/);
  assert.match(appJs, /accountsOverviewRenderSignature/);
  assert.match(appJs, /signature === accountsOverviewRenderSignature/);
});

// 页签栏随 Epic 功能一起移除了（只剩微软积分一个视图，再放一排页签没有意义），
// 所以这里只断言仍然存在的胶囊元素。
test('账号切换与工具栏操作统一使用胶囊圆角', () => {
  assert.match(styleCss, /\.header-actions \.btn[\s\S]*border-radius: 999px/);
  assert.match(styleCss, /\.account-chip[\s\S]*border-radius: 999px/);
  assert.match(styleCss, /\.chip-add[\s\S]*border-radius: 999px/);
  assert.match(styleCss, /\.ms-toolbar-actions \.btn[\s\S]*border-radius: 999px/);
});

test('网络配置支持多代理卡片、逐项测试与账号独立出口', () => {
  assert.match(indexHtml, /id="proxy-list"/);
  assert.match(indexHtml, /id="btn-add-proxy"/);
  assert.match(indexHtml, /id="cfg-account-proxy-mode"/);
  assert.match(indexHtml, /id="cfg-account-proxy-id"/);
  assert.match(appJs, /data-proxy-action="test"/);
  assert.match(appJs, /data-proxy-action="save"/);
  assert.match(appJs, /data-proxy-action="delete"/);
  assert.match(appJs, /当前访问 IP/);
  assert.match(styleCss, /\.proxy-card-fields[\s\S]*grid-template-columns/);
});

test('配置向导与新增账号会先确认代理再发起凭据会话', () => {
  assert.match(indexHtml, /1\. 网络出口[\s\S]*2\. 移动端授权[\s\S]*3\. 网页端 Cookie/);
  assert.match(indexHtml, /id="guide-btn-save-network"/);
  assert.match(indexHtml, /id="guide-account-proxy-mode"/);
  assert.match(indexHtml, /id="quick-add-proxy-mode"/);
  assert.match(indexHtml, /id="quick-add-proxy-id"/);
  assert.match(appJs, /async function saveGuideNetworkSettings/);
  assert.match(appJs, /guideNetworkConfirmed/);
  assert.match(appJs, /readProxySelection\('guide-account-proxy-mode', 'guide-account-proxy-id'\)/);
  assert.match(appJs, /proxy: proxySelection/);
  assert.match(appJs, /proxyMode: proxySelection\.mode/);
});

test('账号运行时间使用 9:00-22:00 的 14 个勾选档位', () => {
  assert.match(indexHtml, /id="cfg-run-hours"/);
  assert.match(indexHtml, /id="guide-run-hours"/);
  assert.match(indexHtml, /id="quick-add-run-hours"/);
  assert.match(appJs, /const RUN_HOURS = Array\.from\(\{ length: 14 \}/);
  assert.match(appJs, /function renderRunHourGrid/);
  assert.match(appJs, /randomDelayMin: 10/);
  assert.match(styleCss, /\.run-hour-grid[\s\S]*grid-template-columns/);
  assert.match(indexHtml, /id="cfg-search-interval"[^>]*value="60"/);
  assert.match(indexHtml, /id="cfg-search-jitter"[^>]*value="60"/);
});

test('配置保存保持窗口打开，时间档位展示其他账号占用', () => {
  assert.match(indexHtml, /id="settings-save-status"/);
  const saveStart = appJs.indexOf('async function saveSettingsFromModal');
  const saveEnd = appJs.indexOf('async function saveGuideNetworkSettings', saveStart);
  const saveFunction = appJs.slice(saveStart, saveEnd);
  assert.ok(saveStart > 0 && saveEnd > saveStart);
  assert.equal(saveFunction.includes("closeModal('settings-modal')"), false);
  assert.match(appJs, /function buildRunHourOccupancy/);
  assert.match(appJs, /已被以下账号占用/);
  assert.match(styleCss, /\.run-hour-option\.is-occupied/);
});

test('账号代理策略默认选择直连', () => {
  assert.match(indexHtml, /id="guide-account-proxy-mode"[\s\S]*?<option value="direct" selected>/);
  assert.match(indexHtml, /id="cfg-account-proxy-mode"[\s\S]*?<option value="direct" selected>/);
  assert.match(indexHtml, /id="quick-add-proxy-mode"[\s\S]*?<option value="direct" selected>/);
  assert.match(appJs, /proxyMode: 'direct'/);
});

test('全局网络支持直连与默认代理二选一，向导测试使用选中节点', () => {
  assert.match(indexHtml, /id="cfg-global-direct"[^>]*value="direct"[^>]*checked/);
  assert.match(indexHtml, /type="radio"[^>]*id="cfg-use-proxy"[^>]*value="proxy"/);
  assert.match(appJs, /function isGlobalProxyEnabled/);
  assert.match(appJs, /function setGlobalProxyEnabled/);
  assert.match(appJs, /function resolveGuideProxyTestTarget/);
  assert.match(appJs, /proxyUrl: proxy\.url/);
  assert.match(appJs, /proxyUrl: target\.proxyUrl/);
});
