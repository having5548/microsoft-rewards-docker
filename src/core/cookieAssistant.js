/**
 * Cookie 助手：把「用户粘贴的一坨东西」变成可用、可诊断的 Cookie 串。
 *
 * 背景（真实踩过的坑）：用户从浏览器里复制 Cookie 时，经常发生这些事——
 *   1. 只复制了**某一个** Cookie 的值（比如 `_U` 或某个 200 字符的 token），
 *      没有 `名=值` 结构。这种输入永远不可能构成登录态，但旧代码会原样写进配置，
 *      然后每次体检都报「Cookie 已过期」，用户反复刷新 Cookie 也没用。
 *   2. 从 Safari / Edge 的表格里复制，带换行和制表符，或者带 `Cookie:` 前缀。
 *   3. 用了 Cookie-Editor 之类的扩展导出成 JSON 数组。
 *   4. 漏掉了 `_U` —— 页面能打开、积分能读，但必应搜索不计分。
 *
 * 这里统一处理上面四种情况，并把「缺了什么」变成明确的中文提示，
 * 而不是一句含糊的「已过期」。
 */

/** 只有这些域名才允许附带微软账号 Cookie（防止把凭据发给第三方推送渠道） */
export const MICROSOFT_COOKIE_DOMAINS = [
  'bing.com',
  'microsoft.com',
  'live.com',
  'msn.com',
  'microsoftonline.com',
  'microsoftonline.cn',
  'windows.net',
  'office.com',
  'sharepoint.com',
  'microsoft365.com'
];

export function isMicrosoftHost(url) {
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    return MICROSOFT_COOKIE_DOMAINS.some(d => hostname === d || hostname.endsWith(`.${d}`));
  } catch {
    return false;
  }
}

/** 缺了它，必应搜索一定不计分 */
export const CRITICAL_COOKIE_NAMES = ['_U'];
/** 缺了它，登录态会不完整（rewards 页面可能直接跳登录） */
export const IMPORTANT_COOKIE_NAMES = ['MUID', 'RPSSecAuth', 'WLS'];
/** 有则更好，用于交叉校验身份 */
export const RECOMMENDED_COOKIE_NAMES = ['SRCHUSR', 'SRCHUID', 'SRCHD', 'SRCHHPGUSR', 'ANON', 'NAP', 'SRCHHPGUSR'];

/** Cookie 属性名，粘贴 Set-Cookie 头时会混进来，不能当成 Cookie 本身 */
const COOKIE_ATTRIBUTES = new Set([
  'path', 'domain', 'expires', 'max-age', 'secure', 'httponly', 'samesite', 'priority', 'partitioned'
]);

const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** 单个 token 值：≥20 位的 base64 / URL-safe 字符，且不含 = 与 ; */
const TOKEN_VALUE_RE = /^[A-Za-z0-9_\-+/=.]{20,}$/;

export function looksLikeGuid(value) {
  return GUID_RE.test(String(value || '').trim());
}

/**
 * 解析任意粘贴形态为 { name -> value } 的 Map。
 * 永远不抛错：解析不出来就返回空 Map，由上层给出可读提示。
 */
export function parseCookiePairs(raw) {
  const map = new Map();
  if (raw === undefined || raw === null) return map;

  if (typeof raw === 'object') {
    // 直接给对象 / 数组（Cookie-Editor 导出）
    return pairsFromJson(raw);
  }

  let text = String(raw).trim();
  if (!text) return map;

  // 先去掉包裹引号，再去 `Cookie:` 前缀：两种形态可能同时出现（从浏览器里连引号一起复制）
  for (let i = 0; i < 2; i++) {
    if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
      text = text.slice(1, -1).trim();
    }
    if (/^cookie\s*:/i.test(text)) {
      text = text.replace(/^cookie\s*:\s*/i, '').trim();
      continue;
    }
    break;
  }

  // JSON 导出
  if (text.startsWith('[') || text.startsWith('{')) {
    try {
      return pairsFromJson(JSON.parse(text));
    } catch {
      // 不是 JSON，继续按 Cookie 串解析
    }
  }

  // 换行 / 制表符（含 Safari、Excel 表格复制）规整成 `;` 分隔
  text = text
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => {
      if (line.includes('\t')) {
        const cols = line.split('\t').map(item => item.trim());
        // 表格里常见三列：名称 值 域
        if (cols.length >= 2 && !cols[0].includes('=')) {
          return `${cols[0]}=${cols[1]}`;
        }
      }
      return line;
    })
    .join('; ');

  for (const part of text.split(';')) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const name = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (!name || COOKIE_ATTRIBUTES.has(name.toLowerCase())) continue;
    map.set(name, value);
  }
  return map;
}

function pairsFromJson(source) {
  const map = new Map();
  const entries = Array.isArray(source)
    ? source
    : Object.entries(source).map(([name, value]) => ({ name, value }));
  for (const item of entries) {
    if (!item || typeof item !== 'object') continue;
    const name = String(item.name || item.key || '').trim();
    const value = item.value === undefined || item.value === null ? '' : String(item.value);
    if (!name || COOKIE_ATTRIBUTES.has(name.toLowerCase())) continue;
    map.set(name, value);
  }
  return map;
}

export function buildCookieString(pairs) {
  const source = pairs instanceof Map ? pairs : new Map(Object.entries(pairs || {}));
  return Array.from(source.entries())
    .filter(([name]) => name && !COOKIE_ATTRIBUTES.has(name.toLowerCase()))
    .map(([name, value]) => `${name}=${value}`)
    .join('; ');
}

/**
 * 从其它 Cookie 里反推 `_U`。
 *
 * Bing 的 `_U` 是账号的匿名 GUID，同一个 GUID 还会出现在 `SRCHUID`（`V=2&GUID=...`）
 * 与 `_EDGE_S`（`...&GUID=...`）里。两边都取到且一致时才认为可信，
 * 只有一处命中就放弃 —— 宁可提示用户重新登录，也不要注入一个错的 `_U`
 * 让搜索计到别的身份上。
 */
export function deriveUnderscoreU(pairs) {
  const fromCookie = pairs.get('_U');
  if (looksLikeGuid(fromCookie)) return { value: fromCookie.trim(), source: '_U' };

  const extract = (name) => {
    const raw = pairs.get(name);
    if (!raw) return '';
    const match = String(raw).match(/[?&]GUID=([0-9a-f-]{36})/i);
    return match ? match[1] : '';
  };
  const candidates = [
    ['SRCHUID', extract('SRCHUID')],
    ['_EDGE_S', extract('_EDGE_S')],
    ['SRCHHPGUSR', extract('SRCHHPGUSR')]
  ].filter(([, value]) => looksLikeGuid(value));

  if (candidates.length === 0) return { value: '', source: '' };
  const first = candidates[0][1];
  const allSame = candidates.every(([, value]) => value.toLowerCase() === first.toLowerCase());
  if (!allSame) return { value: '', source: '', conflict: candidates.map(([name]) => name) };
  return { value: first, source: candidates.map(([name]) => name).join('/') };
}

/**
 * 分析一份粘贴的 Cookie，返回可直接落盘的完整串与诊断信息。
 *
 * @param {string|object} raw 用户输入
 * @param {object} options
 * @param {boolean} options.autoAddU 缺少 `_U` 时是否尝试从其它 Cookie 推导（默认 true）
 * @param {string} options.existingCookie 已有 Cookie，用于「只填了一个值」时合并
 */
export function analyzeCookie(raw, options = {}) {
  const autoAddU = options.autoAddU !== false;
  const existingCookie = options.existingCookie || '';
  const existingPairs = existingCookie ? parseCookiePairs(existingCookie) : new Map();

  let text = raw === undefined || raw === null ? '' : String(raw).trim();
  for (let i = 0; i < 2; i++) {
    if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
      text = text.slice(1, -1).trim();
      continue;
    }
    if (/^cookie\s*:/i.test(text)) {
      text = text.replace(/^cookie\s*:\s*/i, '').trim();
      continue;
    }
    break;
  }

  const result = {
    cookie: '',
    added: [],
    missing: [],
    criticalMissing: [],
    importantMissing: [],
    singleValue: false,
    bareGuid: false,
    error: ''
  };

  if (!text) {
    result.error = 'Cookie 为空';
    return result;
  }

  // 单值：没有 `名=值` 结构，也不是 JSON。这是「一直显示已过期」最常见的原因。
  const hasStructure = text.includes('=') || text.startsWith('[') || text.startsWith('{') || text.includes(';');
  if (!hasStructure) {
    if (looksLikeGuid(text)) {
      // 用户只贴了 `_U` 的值本身：这是可以做对的情况
      result.bareGuid = true;
    } else if (TOKEN_VALUE_RE.test(text) || text.length >= 12) {
      result.singleValue = true;
      result.error = '这只是一个 Cookie 的值，不是完整的 Cookie 串。需要形如 `_U=...; MUID=...; RPSSecAuth=...` 的整串：请打开 https://rewards.bing.com/dashboard ，按 F12 → Console 执行 `document.cookie`，把输出整串复制过来。';
      return result;
    } else {
      result.error = '无法识别的 Cookie 内容，请粘贴完整的 `名=值; 名=值` 串';
      return result;
    }
  }

  const pairs = result.bareGuid ? new Map(existingPairs) : parseCookiePairs(text);
  if (result.bareGuid) {
    pairs.set('_U', text.trim());
    result.added.push('_U');
  }

  // 只贴了 `_U=xxx` 一个新值、而账号里原本有完整 Cookie：合并而不是整体替换，
  // 否则用户以为「刷新了 _U」，其实把 MUID / RPSSecAuth 全丢了。
  const looksLikeSinglePair = !result.bareGuid
    && text.includes('=')
    && !text.includes(';')
    && pairs.size === 1;
  if (looksLikeSinglePair && existingPairs.size > 1) {
    for (const [name, value] of pairs.entries()) existingPairs.set(name, value);
    for (const [name, value] of existingPairs.entries()) pairs.set(name, value);
  }

  // 自动补 `_U`
  if (autoAddU && !looksLikeGuid(pairs.get('_U'))) {
    const derived = deriveUnderscoreU(pairs);
    if (derived.value) {
      pairs.set('_U', derived.value);
      result.added.push('_U');
      result.derivedUFrom = derived.source;
    } else if (derived.conflict) {
      result.uConflictFrom = derived.conflict;
    }
  }

  result.cookie = buildCookieString(pairs);
  result.pairs = pairs;
  result.names = Array.from(pairs.keys());
  result.missing = [
    ...CRITICAL_COOKIE_NAMES.filter(name => !pairs.has(name)),
    ...IMPORTANT_COOKIE_NAMES.filter(name => !pairs.has(name))
  ];
  result.criticalMissing = CRITICAL_COOKIE_NAMES.filter(name => !pairs.has(name));
  result.importantMissing = IMPORTANT_COOKIE_NAMES.filter(name => !pairs.has(name));
  result.hasU = pairs.has('_U') && !!pairs.get('_U');
  result.cookieCount = pairs.size;
  return result;
}

/** 把分析结果转成一句能直接显示给用户的中文说明 */
export function describeCookieProblem(analysis) {
  if (!analysis) return '';
  if (analysis.error) return analysis.error;
  if (analysis.uConflictFrom?.length) {
    return `Cookie 里 ${analysis.uConflictFrom.join(' / ')} 携带的用户 GUID 互相不一致，无法安全地自动补 _U，请重新从浏览器复制完整 Cookie`;
  }
  const hints = [];
  if (analysis.criticalMissing?.length) {
    hints.push(`缺少 ${analysis.criticalMissing.join('、')}（必应搜索不会计分）`);
  }
  if (analysis.importantMissing?.length) {
    hints.push(`缺少 ${analysis.importantMissing.join('、')}（登录态可能不完整）`);
  }
  if (analysis.added?.length) {
    hints.push(`已自动补齐 ${analysis.added.join('、')}`);
  }
  return hints.length ? `Cookie 共 ${analysis.cookieCount} 项：${hints.join('；')}` : `Cookie 共 ${analysis.cookieCount} 项，关键项齐全`;
}

export default { analyzeCookie, describeCookieProblem, parseCookiePairs, buildCookieString, deriveUnderscoreU, isMicrosoftHost, MICROSOFT_COOKIE_DOMAINS };
