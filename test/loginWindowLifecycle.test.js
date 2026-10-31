import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'msr-login-lifecycle-'));
process.env.MSR_DATA_DIR = dataDir;
process.env.DISPLAY = process.env.DISPLAY || ':test';

const { default: loginWindow } = await import('../src/core/loginWindow.js');

test('并发打开登录窗口返回同一个启动结果', async () => {
  const original = loginWindow.openInternal;
  let calls = 0;
  let release;
  loginWindow.openInternal = async (accountId) => {
    calls += 1;
    await new Promise(resolve => { release = resolve; });
    return { active: true, accountId };
  };
  try {
    const first = loginWindow.open('acc-a');
    const second = loginWindow.open('acc-a');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(calls, 1);
    release();
    const [a, b] = await Promise.all([first, second]);
    assert.equal(a.accountId, 'acc-a');
    assert.equal(b.accountId, 'acc-a');
    assert.equal(b.alreadyOpen, true);
  } finally {
    loginWindow.openInternal = original;
  }
});

test('不同账号不能复用同一个登录窗口', async () => {
  const original = loginWindow.openInternal;
  loginWindow.openInternal = async (accountId) => ({ active: true, accountId });
  try {
    await loginWindow.open('acc-a');
    loginWindow.context = {};
    await assert.rejects(loginWindow.open('acc-b'), /另一个账号/);
  } finally {
    loginWindow.context = null;
    loginWindow.accountId = null;
    loginWindow.openInternal = original;
  }
});

test('空目标账号的并发打开也使用同一启动操作', async () => {
  const original = loginWindow.openInternal;
  let release;
  let calls = 0;
  loginWindow.openInternal = async () => {
    calls += 1;
    await new Promise(resolve => { release = resolve; });
    return { active: true, accountId: null };
  };
  try {
    const first = loginWindow.open(null);
    const second = loginWindow.open(null);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(calls, 1);
    release();
    await Promise.all([first, second]);
  } finally {
    loginWindow.openInternal = original;
  }
});
