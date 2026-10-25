import test from 'node:test';
import assert from 'node:assert/strict';

const { AccountContextLock, accountContextLock, browserSlotLock } = await import('../src/core/contextLock.js');

test('不同持有者互斥，同一持有者可重入', () => {
  const lock = new AccountContextLock();
  assert.equal(lock.tryAcquire('task-run'), true);
  // 另一个持有者必须被挡住（这正是之前 WebUI 抢走账号上下文的根因）
  assert.equal(lock.tryAcquire('web-action'), false);
  // 同一持有者重入应当放行
  assert.equal(lock.tryAcquire('task-run'), true);

  lock.release('task-run');
  assert.equal(lock.isBusy(), true, '重入两次后释放一次仍应持有');
  lock.release('task-run');
  assert.equal(lock.isBusy(), false);
});

test('非持有者释放不会解锁', () => {
  const lock = new AccountContextLock();
  lock.tryAcquire('a');
  lock.release('b');
  assert.equal(lock.isBusy(), true);
  lock.release('a');
  assert.equal(lock.isBusy(), false);
});

test('acquire 带超时，锁被占用时返回 false', async () => {
  const lock = new AccountContextLock();
  lock.tryAcquire('a');
  const ok = await lock.acquire('b', 120);
  assert.equal(ok, false);
  lock.release('a');
  assert.equal(await lock.acquire('b', 120), true);
  lock.release('b');
});

test('账号上下文锁与浏览器资源锁是两把独立的锁', () => {
  assert.notEqual(accountContextLock, browserSlotLock);
  assert.equal(accountContextLock.tryAcquire('task-run'), true);
  // 积分任务持有账号上下文锁时，浏览器锁仍应能独立获取（两者语义不同）
  assert.equal(browserSlotLock.tryAcquire('rewards-browser'), true);
  browserSlotLock.release('rewards-browser');
  accountContextLock.release('task-run');
  assert.equal(accountContextLock.isBusy(), false);
});
