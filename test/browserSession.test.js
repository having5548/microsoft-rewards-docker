import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 用独立数据目录，避免测试污染真实 data/
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'msr-session-'));
process.env.MSR_DATA_DIR = tmpDir;

const {
  readBrowserSession,
  writeBrowserSession,
  removeBrowserSession,
  sanitizeStorageState,
  sessionFilePath,
  accountIdentityKey
} = await import('../src/core/browserSession.js');

const ACCOUNT = { id: 'acc_1', name: '测试账号', cookie: 'A=1; _U=abc', refreshToken: 'rt-1' };

function sampleState() {
  return {
    cookies: [
      { name: '_U', value: 'abc', domain: '.bing.com', path: '/' },
      { name: 'SRCHHPGUSR', value: 'x', domain: '.bing.com', path: '/' },
      { name: 'MUID', value: 'y', domain: '.bing.com', path: '/' }
    ],
    origins: [{ origin: 'https://cn.bing.com', localStorage: [{ name: 'k', value: 'v' }] }]
  };
}

test('写回会话时剔除 _U 身份 Cookie，其余 Cookie 与 localStorage 保留', () => {
  const sanitized = sanitizeStorageState(sampleState());
  assert.deepEqual(
    sanitized.cookies.map((c) => c.name),
    ['SRCHHPGUSR', 'MUID'],
    '_U 必须被剔除：上一轮残留的 _U 会把下一轮带到别的账号身份上'
  );
  assert.equal(sanitized.origins.length, 1, 'localStorage 属于会话的一部分，应当保留');
});

test('会话可以往返读写，且落盘文件里不含 _U', () => {
  assert.equal(writeBrowserSession(ACCOUNT, sampleState()), true);
  const raw = fs.readFileSync(sessionFilePath(ACCOUNT.id), 'utf-8');
  assert.ok(!raw.includes('"_U"'), '磁盘上的会话文件不允许出现 _U');

  const read = readBrowserSession(ACCOUNT);
  assert.ok(read?.storageState, '凭据未变时应能读回会话');
  assert.deepEqual(read.storageState.cookies.map((c) => c.name), ['SRCHHPGUSR', 'MUID']);
});

// Windows 上 fs.chmod 只切换只读位，stat 出来恒为 0o666，无法表达 0600。
// 这条断言只在 POSIX 上有意义（生产环境是 Linux 容器），Windows 开发机跳过。
test('会话文件权限为 0600', { skip: process.platform === 'win32' ? 'Windows 不支持 POSIX 权限位' : false }, () => {
  writeBrowserSession(ACCOUNT, sampleState());
  const mode = fs.statSync(sessionFilePath(ACCOUNT.id)).mode & 0o777;
  assert.equal(mode, 0o600, '会话文件含登录 Cookie，必须仅属主可读写');
});

test('凭据换成别的账号后，旧会话直接作废', () => {
  writeBrowserSession(ACCOUNT, sampleState());
  const other = { ...ACCOUNT, cookie: 'A=2; _U=zzz' };
  assert.notEqual(accountIdentityKey(ACCOUNT), accountIdentityKey(other));
  const read = readBrowserSession(other);
  assert.equal(read?.stale, true);
  assert.equal(read?.reason, 'account-credentials-changed');
  assert.equal(read?.storageState, undefined, '换账号时不能把旧会话交给新账号');
});

test('会话文件损坏时忽略，不抛异常', () => {
  fs.mkdirSync(path.dirname(sessionFilePath('acc_2')), { recursive: true });
  fs.writeFileSync(sessionFilePath('acc_2'), '{ not json');
  const read = readBrowserSession({ id: 'acc_2', cookie: 'A=1' });
  assert.equal(read?.stale, true);
  assert.equal(read?.reason, 'session-file-corrupted');
});

test('没有历史会话时返回 null', () => {
  assert.equal(readBrowserSession({ id: 'acc_missing', cookie: 'A=1' }), null);
});

test('删除账号会清掉它的会话文件', () => {
  writeBrowserSession(ACCOUNT, sampleState());
  assert.equal(fs.existsSync(sessionFilePath(ACCOUNT.id)), true);
  removeBrowserSession(ACCOUNT.id);
  assert.equal(fs.existsSync(sessionFilePath(ACCOUNT.id)), false);
});
