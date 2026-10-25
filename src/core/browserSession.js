/**
 * 每个账号持久化一份浏览器会话（Cookie + localStorage + sessionStorage）。
 *
 * 为什么需要它：以前每次任务都是「全新 context + 临时注入 Cookie」，
 * 等于一个刚装好的浏览器里凭空出现登录态，Cookie 之外的 localStorage 全丢，
 * 这在反爬视角下是很不自然的状态。把会话存下来复用，浏览器看起来更像同一台机器。
 *
 * 两条安全约束：
 *   1. 写回时剔除 .bing.com 的 `_U` Cookie。`_U` 是账号身份标识，
 *      一旦上一轮残留的旧值被带进下一轮，就会出现「串号 / 被重定向到登录页」。
 *      Cookie 里配置的 `_U` 每次启动都会重新注入，所以剔除不会影响计分。
 *   2. 会话文件绑定账号凭据指纹。Cookie/Token 换成了别的账号时，旧会话直接作废，
 *      避免把 A 账号的浏览器状态带到 B 账号上。
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { DATA_DIR, writeFileAtomic } from '../fsUtil.js';

export const SESSION_DIR = path.join(DATA_DIR, 'sessions');

/** 会被剔除的身份类 Cookie（域名匹配 .bing.com 及子域） */
const IDENTITY_COOKIE_NAMES = new Set(['_U']);

function safeAccountId(accountId) {
  return String(accountId || 'unknown').replace(/[^A-Za-z0-9_-]/g, '_');
}

export function sessionFilePath(accountId) {
  return path.join(SESSION_DIR, `${safeAccountId(accountId)}.json`);
}

function cookieValue(cookie = '', name = '') {
  const pattern = new RegExp(`(?:^|[;\\s])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}=([^;\\r\\n]*)`, 'i');
  const match = String(cookie || '').match(pattern);
  return match ? match[1].trim() : '';
}

/**
 * 账号身份指纹：只使用稳定的网页身份字段。
 *
 * OAuth 的 accessToken / refreshToken 会周期性轮换，authCodeUrl 也是一次性值，
 * 绝不能放进指纹里，否则每次 Token 续期都会误判为“换了账号”，把正常的浏览器
 * 会话丢掉，反而增加风控暴露面。
 */
export function accountIdentityKey(acc) {
  if (!acc) return '';
  const material = [
    acc.id || '',
    cookieValue(acc.cookie, '_U'),
    cookieValue(acc.cookie, 'MUID'),
    cookieValue(acc.cookie, 'WLS')
  ].join('\u0000');
  // 极端情况下 Cookie 里没有稳定身份字段：用账号 id + 完整 Cookie 兜底，
  // 仍不会因为 Token 轮换而失效。
  if (!cookieValue(acc.cookie, '_U') && !cookieValue(acc.cookie, 'MUID') && !cookieValue(acc.cookie, 'WLS')) {
    return crypto.createHash('sha256').update(`${material}\u0000${acc.cookie || ''}`).digest('hex');
  }
  return crypto.createHash('sha256').update(material).digest('hex');
}

/**
 * 剥离身份类 Cookie。返回新的 storageState，不修改入参。
 */
export function sanitizeStorageState(state) {
  if (!state || typeof state !== 'object') return state;
  const cookies = Array.isArray(state.cookies) ? state.cookies : [];
  return {
    ...state,
    cookies: cookies.filter((cookie) => !IDENTITY_COOKIE_NAMES.has(cookie?.name))
  };
}

/**
 * 读取该账号上次保存的会话。文件不存在、内容损坏或凭据指纹不匹配时返回 null
 * （视为「没有历史会话」，调用方回退到全新 context）。
 */
export function readBrowserSession(acc) {
  if (!acc?.id) return null;
  const file = sessionFilePath(acc.id);
  if (!fs.existsSync(file)) return null;

  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
    if (!parsed || typeof parsed !== 'object' || !parsed.storageState) return null;

    const expected = accountIdentityKey(acc);
    if (parsed.identityKey !== expected) {
      // 凭据变了，说明这是另一个账号（或重新登录过）的旧状态，直接丢弃。
      return { stale: true, reason: 'account-credentials-changed' };
    }

    const storageState = sanitizeStorageState(parsed.storageState);
    const cookieCount = Array.isArray(storageState.cookies) ? storageState.cookies.length : 0;
    if (cookieCount === 0) return null;
    return { storageState, savedAt: parsed.savedAt || 0 };
  } catch {
    // 损坏的会话文件不应该让整个任务失败，忽略它按全新会话跑。
    return { stale: true, reason: 'session-file-corrupted' };
  }
}

/**
 * 写回会话。始终剔除身份 Cookie，权限 0600。
 */
export function writeBrowserSession(acc, storageState) {
  if (!acc?.id || !storageState) return false;
  const sanitized = sanitizeStorageState(storageState);
  const payload = {
    version: 1,
    accountId: acc.id,
    identityKey: accountIdentityKey(acc),
    savedAt: Date.now(),
    storageState: sanitized
  };
  try {
    writeFileAtomic(sessionFilePath(acc.id), JSON.stringify(payload), {
      encoding: 'utf-8',
      mode: 0o600
    });
    try {
      fs.chmodSync(sessionFilePath(acc.id), 0o600);
    } catch {}
    return true;
  } catch {
    return false;
  }
}

/** 账号被删除时清掉它的会话文件 */
export function removeBrowserSession(accountId) {
  const file = sessionFilePath(accountId);
  try {
    if (fs.existsSync(file)) fs.unlinkSync(file);
    return true;
  } catch {
    return false;
  }
}
