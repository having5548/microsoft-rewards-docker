import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'msr-v1710-'));
process.env.MSR_DATA_DIR = tmpDir;

const { classifyBingLoginState } = await import('../src/core/browser.js');
const { default: networkClient } = await import('../src/network.js');
const { default: rewardsApi } = await import('../src/core/api.js');

test('Bing 登录检测优先识别真实用户名，不被空的 .id_name 误判为游客', () => {
  const state = classifyBingLoginState({
    idN: '张三',
    idA: '',
    idName: '',
    signInVisible: true,
    cookieHasU: true
  });
  assert.equal(state.userName, '张三');
  assert.equal(state.status, 'logged-in');
  assert.equal(state.isGuest, false);
});

test('Duolingo 打孔卡按 href 关联标题，不会被同月 FY27 月度卡误标完成', async () => {
  const html = `
    <script>self.__next_f.push([1,"a:\\"href\\":\\"/earn/quest/WW_pcparent_FY27_Duolingo3M_punchcard\\",\\"img\\":{\\"alt\\":\\"通过 Microsoft Rewards 解锁免费 Super Duolingo\\"},\\"progress\\":{\\"children\\":\\"0/6 个任务\\"}"])</script>
    <script>self.__next_f.push([1,"b:\\"href\\":\\"/earn/quest/ENWW_pcparent_FY27_BingMonthlyPC_Oct_punchcard\\",\\"img\\":{\\"alt\\":\\"十月必看五大亮点：服饰、玩具、手机、超值优惠和AI设备\\"},\\"progress\\":{\\"children\\":\\"5/5 个任务\\"}"])</script>
  `;
  const origRequest = networkClient.request;
  networkClient.request = async () => html;
  try {
    const quests = await rewardsApi.getQuestPunchCards();
    const duolingo = quests.find(q => q.questId === 'WW_pcparent_FY27_Duolingo3M_punchcard');
    assert.ok(duolingo, '必须识别出 Duolingo 打孔卡');
    assert.match(duolingo.title, /Super Duolingo/);
    assert.equal(duolingo.done, false);
    assert.equal(duolingo.progress, 0);
    assert.equal(duolingo.max, 6);

    const monthly = quests.find(q => q.questId === 'ENWW_pcparent_FY27_BingMonthlyPC_Oct_punchcard');
    assert.ok(monthly, '同页月度卡仍应被识别');
    assert.match(monthly.title, /十月必看五大亮点/);
    assert.equal(monthly.done, true);
  } finally {
    networkClient.request = origRequest;
  }
});
