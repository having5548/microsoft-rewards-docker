import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { findChromiumExecutable } = await import('../src/core/chromiumExecutable.js');

test('Chromium 路径优先采用显式配置', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'msr-chromium-'));
  const executable = path.join(tmp, 'chromium');
  fs.writeFileSync(executable, '');
  assert.equal(findChromiumExecutable({ CHROMIUM_PATH: executable }), executable);
});

test('显式配置失效时回退到已安装的 Edge/Chrome', () => {
  // 不再写死候选清单：不同平台/不同 Edge 版本的安装路径不一样
  // （Windows 新版本在 Program Files (x86)\Microsoft\Edge\Application，
  //  旧版本在 "Microsoft Edge\Application"），测试只验证「拿到的路径真实存在」。
  const found = findChromiumExecutable({ CHROMIUM_PATH: '/definitely/missing/chromium' });
  if (found === null) return; // 这台机器确实没装任何 Chromium 系浏览器
  assert.equal(fs.existsSync(found), true, '回退路径必须真实存在');
});
