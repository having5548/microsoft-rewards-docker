import http from 'http';
import net from 'net';
import { SocksClient } from 'socks';
import { SocksProxyAgent } from 'socks-proxy-agent';
import { normalizeProxyUrl, toBrowserProxy } from './proxy.js';

const DEFAULT_SOCKS_PORT = 1080;
const CONNECT_TIMEOUT_MS = 15000;

function parseTargetAuthority(authority, defaultPort) {
  const value = String(authority || '').trim();
  if (!value) throw new Error('代理目标为空');

  let host = '';
  let portText = '';
  if (value.startsWith('[')) {
    const closingBracket = value.indexOf(']');
    if (closingBracket < 0) throw new Error('代理目标 IPv6 地址无效');
    host = value.slice(1, closingBracket);
    portText = value.slice(closingBracket + 1).replace(/^:/, '');
  } else {
    const colon = value.lastIndexOf(':');
    if (colon > 0 && value.indexOf(':') === colon) {
      host = value.slice(0, colon);
      portText = value.slice(colon + 1);
    } else {
      host = value;
    }
  }

  const port = Number(portText || defaultPort);
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('代理目标地址或端口无效');
  }
  return { host, port };
}

function parseSocks5Upstream(raw) {
  const normalized = normalizeProxyUrl(raw);
  if (!normalized) return null;
  const parsed = new URL(normalized);
  const protocol = parsed.protocol.toLowerCase();
  if (protocol !== 'socks5:' && protocol !== 'socks5h:') return null;

  const username = decodeURIComponent(parsed.username || '');
  const password = decodeURIComponent(parsed.password || '');
  if (!username && !password) return null;

  return {
    url: normalized,
    host: parsed.hostname.replace(/^\[|\]$/g, ''),
    port: Number(parsed.port || DEFAULT_SOCKS_PORT),
    username,
    password
  };
}

function proxyErrorResponse(statusCode = 502) {
  const label = statusCode === 504 ? 'Gateway Timeout' : 'Bad Gateway';
  return `HTTP/1.1 ${statusCode} ${label}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`;
}

/**
 * Chromium 不支持带用户名密码的 SOCKS5。这里启动一个只监听回环地址的
 * HTTP 代理，把浏览器的无认证连接转成带认证的 SOCKS5 上游连接。
 */
export async function createLocalSocksProxyBridge(raw, options = {}) {
  const upstream = parseSocks5Upstream(raw);
  if (!upstream) return null;

  const connectTimeoutMs = Math.max(1000, Number(options.connectTimeoutMs) || CONNECT_TIMEOUT_MS);
  const agent = new SocksProxyAgent(upstream.url, { keepAlive: true });
  const sockets = new Set();
  let closed = false;

  const track = (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    return socket;
  };

  const connectUpstream = (host, port) => SocksClient.createConnection({
    proxy: {
      host: upstream.host,
      port: upstream.port,
      type: 5,
      userId: upstream.username,
      password: upstream.password
    },
    command: 'connect',
    destination: { host, port },
    timeout: connectTimeoutMs
  });

  const server = http.createServer((req, res) => {
    let target;
    try {
      target = new URL(req.url);
      if (target.protocol !== 'http:') throw new Error('仅支持 HTTP 请求');
    } catch {
      res.writeHead(400, { Connection: 'close' });
      res.end();
      return;
    }

    const headers = { ...req.headers, host: target.host };
    delete headers['proxy-authorization'];
    delete headers['proxy-connection'];

    const outbound = http.request({
      hostname: target.hostname.replace(/^\[|\]$/g, ''),
      port: Number(target.port || 80),
      method: req.method,
      path: `${target.pathname || '/'}${target.search || ''}`,
      headers,
      agent
    }, (upstreamRes) => {
      res.writeHead(upstreamRes.statusCode || 502, upstreamRes.headers);
      upstreamRes.pipe(res);
    });

    outbound.setTimeout(connectTimeoutMs, () => {
      outbound.destroy(new Error('代理请求超时'));
    });
    outbound.on('error', (error) => {
      if (!res.headersSent) {
        const timedOut = /超时|timeout/i.test(error?.message || '');
        res.writeHead(timedOut ? 504 : 502, { Connection: 'close' });
      }
      res.end();
    });
    req.once('aborted', () => outbound.destroy());
    req.pipe(outbound);
  });

  server.on('connect', async (req, clientSocket, head) => {
    clientSocket.pause();
    clientSocket.on('error', () => {});
    track(clientSocket);

    let upstreamSocket = null;
    try {
      const target = parseTargetAuthority(req.url, 443);
      const connection = await connectUpstream(target.host, target.port);
      upstreamSocket = connection.socket;
      upstreamSocket.setNoDelay(true);
      clientSocket.setNoDelay(true);
      track(upstreamSocket);

      if (clientSocket.destroyed) {
        upstreamSocket.destroy();
        return;
      }

      clientSocket.write('HTTP/1.1 200 Connection Established\r\nProxy-Agent: msr-local-bridge\r\n\r\n');
      if (head?.length) upstreamSocket.write(head);

      upstreamSocket.on('error', () => clientSocket.destroy());
      clientSocket.on('close', () => upstreamSocket.destroy());
      upstreamSocket.pipe(clientSocket);
      clientSocket.pipe(upstreamSocket);
      clientSocket.resume();
    } catch (error) {
      upstreamSocket?.destroy();
      if (!clientSocket.destroyed) {
        const timedOut = /timeout|timed out|超时/i.test(error?.message || '');
        clientSocket.end(proxyErrorResponse(timedOut ? 504 : 502));
      }
    }
  });

  server.on('clientError', (error, socket) => {
    if (!socket.destroyed) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
  });

  await new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(0, '127.0.0.1');
  });

  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    agent.destroy();
    throw new Error('无法启动本地代理桥接服务');
  }

  return {
    bridged: true,
    upstream: `${upstream.host}:${upstream.port}`,
    proxy: { server: `http://127.0.0.1:${address.port}` },
    async close() {
      if (closed) return;
      closed = true;
      for (const socket of sockets) socket.destroy();
      sockets.clear();
      await new Promise((resolve) => server.close(() => resolve()));
      agent.destroy();
    }
  };
}

/**
 * 返回 Playwright 可用的代理参数。只有“带认证的 SOCKS5”需要本地桥接；
 * HTTP/HTTPS 代理和无需认证的 SOCKS5 仍由 Chromium 原生处理。
 */
export async function prepareBrowserProxy(raw) {
  if (!raw) return null;
  const bridge = await createLocalSocksProxyBridge(raw);
  if (bridge) return bridge;
  return {
    bridged: false,
    proxy: toBrowserProxy(raw),
    async close() {}
  };
}
