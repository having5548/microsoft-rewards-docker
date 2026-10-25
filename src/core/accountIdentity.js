import crypto from 'crypto';

export function cookieValue(cookie = '', name = '') {
  const escaped = String(name || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (!escaped) return '';
  const match = String(cookie || '').match(new RegExp(`(?:^|[;\\s])${escaped}=([^;\\r\\n]*)`, 'i'));
  return match ? match[1].trim() : '';
}

/**
 * 网页账号身份指纹。_U 是 Bing / Rewards 的登录身份 Cookie，
 * 同一账号重新抓取 Cookie 时通常保持不变，切换账号时一定变化。
 */
export function webIdentityKey(cookie = '') {
  const userId = cookieValue(cookie, '_U');
  if (!userId) return '';
  return crypto.createHash('sha256').update(userId).digest('hex');
}

/**
 * 中国大陆 Rewards 搜索等级配额：会员 15、银牌 30、金牌 60。
 * 未知值仍然保留官网原始配额，不用固定等级覆盖。
 */
export function searchTierFromMax(max) {
  const quota = Number(max);
  if (!Number.isFinite(quota) || quota <= 0) return null;
  if (quota === 15) return { code: 'member', label: '会员', max: 15 };
  if (quota === 30) return { code: 'silver', label: '银牌', max: 30 };
  if (quota === 60) return { code: 'gold', label: '金牌', max: 60 };
  return { code: 'unknown', label: '未知等级', max: quota };
}

export function extractAccountDisplayName(payload) {
  const candidates = [
    payload?.userName,
    payload?.displayName,
    payload?.name,
    payload?.email,
    payload?.user?.userName,
    payload?.user?.displayName,
    payload?.user?.name,
    payload?.user?.email,
    payload?.profile?.userName,
    payload?.profile?.displayName,
    payload?.profile?.name,
    payload?.account?.userName,
    payload?.account?.displayName,
    payload?.account?.name
  ];
  return candidates
    .map(value => String(value || '').trim())
    .find(Boolean) || '';
}

export function accountNamesLikelyMatch(left, right) {
  const normalize = (value) => String(value || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/[._-]+/g, '');
  const a = normalize(left);
  const b = normalize(right);
  if (!a || !b) return null;
  if (a === b) return true;
  const aIsEmail = a.includes('@');
  const bIsEmail = b.includes('@');
  if (aIsEmail !== bIsEmail) return null;
  if (aIsEmail && bIsEmail) {
    const localA = a.split('@')[0];
    const localB = b.split('@')[0];
    return localA === localB;
  }
  if (/[\u4e00-\u9fff]/.test(a) || /[\u4e00-\u9fff]/.test(b)) {
    const sortedA = Array.from(a).sort().join('');
    const sortedB = Array.from(b).sort().join('');
    if (sortedA === sortedB) return true;
  }
  return Math.min(a.length, b.length) >= 2 && (a.includes(b) || b.includes(a));
}

/**
 * 网页端 Cookie 与移动端 Token 是否明显属于不同账号。
 * DAPI 与网页端偶尔有同步延迟，所以只把超过 100 分的差异视为绑定错误。
 */
export function isBalanceMismatch(webBalance, mobileBalance, threshold = 100) {
  if (webBalance === null || webBalance === undefined || webBalance === ''
    || mobileBalance === null || mobileBalance === undefined || mobileBalance === '') {
    return false;
  }
  const web = Number(webBalance);
  const mobile = Number(mobileBalance);
  return Number.isFinite(web) && Number.isFinite(mobile)
    && web >= 0 && mobile >= 0
    && Math.abs(web - mobile) > Math.max(0, Number(threshold) || 0);
}
