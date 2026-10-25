const SUPPORTED_PROXY_PROTOCOLS = new Set([
  'http:',
  'https:',
  'socks:',
  'socks4:',
  'socks5:',
  'socks5h:'
]);

/**
 * 代理地址统一在这里校验与规范化，避免网络请求、浏览器上下文和配置接口
 * 各自接受不同的格式。未写协议的地址按 HTTP 代理处理。
 */
export function normalizeProxyUrl(raw) {
  const input = String(raw || '').trim();
  if (!input) return '';

  let parsed;
  try {
    parsed = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(input) ? input : `http://${input}`);
  } catch {
    throw new Error('代理地址格式无效');
  }

  if (!SUPPORTED_PROXY_PROTOCOLS.has(parsed.protocol)) {
    throw new Error('代理协议仅支持 HTTP、HTTPS、SOCKS4、SOCKS5');
  }
  if (!parsed.hostname) {
    throw new Error('代理地址缺少主机名');
  }

  parsed.hash = '';
  parsed.search = '';
  return parsed.toString().replace(/\/$/, '');
}

/**
 * Playwright 的 proxy 选项不接受把账号密码直接塞进 server 字段，
 * 这里拆成 server / username / password。
 */
export function toBrowserProxy(raw) {
  const normalized = normalizeProxyUrl(raw);
  if (!normalized) return null;

  const parsed = new URL(normalized);
  let protocol = parsed.protocol;
  if (protocol === 'socks:' || protocol === 'socks5h:') protocol = 'socks5:';

  const proxy = {
    server: `${protocol}//${parsed.hostname}${parsed.port ? `:${parsed.port}` : ''}`
  };
  if (parsed.username) proxy.username = decodeURIComponent(parsed.username);
  if (parsed.password) proxy.password = decodeURIComponent(parsed.password);
  return proxy;
}

export function safeProxyId(raw, fallback = '') {
  const value = String(raw || '').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80);
  return value || fallback;
}
