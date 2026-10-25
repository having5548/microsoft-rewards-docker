import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import {
  createLocalSocksProxyBridge,
  prepareBrowserProxy
} from '../src/core/localProxyBridge.js';

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve(server.address().port);
    });
  });
}

function closeServer(server) {
  if (!server?.listening) return Promise.resolve();
  server.closeAllConnections?.();
  return new Promise(resolve => server.close(() => resolve()));
}

function createAuthenticatedSocks5Server(expectedUser, expectedPassword) {
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    socket.on('error', () => {});

    let buffer = Buffer.alloc(0);
    let stage = 'greeting';
    let tunnel = null;

    const parse = () => {
      for (;;) {
        if (stage === 'tunnel') {
          if (buffer.length && tunnel) {
            tunnel.write(buffer);
            buffer = Buffer.alloc(0);
          }
          return;
        }

        if (stage === 'greeting') {
          if (buffer.length < 2) return;
          const methodCount = buffer[1];
          if (buffer.length < 2 + methodCount) return;
          const methods = buffer.subarray(2, 2 + methodCount);
          buffer = buffer.subarray(2 + methodCount);
          if (!methods.includes(2)) {
            socket.end(Buffer.from([5, 255]));
            return;
          }
          socket.write(Buffer.from([5, 2]));
          stage = 'auth';
          continue;
        }

        if (stage === 'auth') {
          if (buffer.length < 2) return;
          const userLength = buffer[1];
          if (buffer.length < 2 + userLength + 1) return;
          const passwordLength = buffer[2 + userLength];
          const total = 2 + userLength + 1 + passwordLength;
          if (buffer.length < total) return;
          const user = buffer.subarray(2, 2 + userLength).toString();
          const password = buffer.subarray(3 + userLength, total).toString();
          buffer = buffer.subarray(total);
          if (user !== expectedUser || password !== expectedPassword) {
            socket.end(Buffer.from([1, 1]));
            return;
          }
          socket.write(Buffer.from([1, 0]));
          stage = 'request';
          continue;
        }

        if (buffer.length < 4) return;
        const addressType = buffer[3];
        let offset = 4;
        let host = '';
        if (addressType === 1) {
          if (buffer.length < offset + 4 + 2) return;
          host = [...buffer.subarray(offset, offset + 4)].join('.');
          offset += 4;
        } else if (addressType === 3) {
          if (buffer.length < offset + 1) return;
          const length = buffer[offset];
          offset += 1;
          if (buffer.length < offset + length + 2) return;
          host = buffer.subarray(offset, offset + length).toString();
          offset += length;
        } else if (addressType === 4) {
          if (buffer.length < offset + 16 + 2) return;
          const parts = [];
          for (let i = 0; i < 16; i += 2) {
            parts.push(buffer.readUInt16BE(offset + i).toString(16));
          }
          host = parts.join(':');
          offset += 16;
        } else {
          socket.end(Buffer.from([5, 8, 0, 1, 0, 0, 0, 0, 0, 0]));
          return;
        }

        const port = buffer.readUInt16BE(offset);
        buffer = buffer.subarray(offset + 2);
        const upstream = net.connect(port, host, () => {
          socket.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0]));
          stage = 'tunnel';
          tunnel = upstream;
          upstream.pipe(socket);
          socket.pipe(upstream);
          parse();
        });
        upstream.on('error', () => socket.destroy());
        return;
      }
    };

    socket.on('data', (chunk) => {
      if (stage === 'tunnel') return;
      buffer = Buffer.concat([buffer, chunk]);
      parse();
    });
  });

  return {
    server,
    close() {
      for (const socket of sockets) socket.destroy();
      return closeServer(server);
    }
  };
}

function requestThroughProxy(proxyPort, targetUrl) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port: proxyPort,
      method: 'GET',
      path: targetUrl,
      headers: { host: new URL(targetUrl).host }
    }, (res) => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({
        status: res.statusCode,
        body: Buffer.concat(chunks).toString()
      }));
    });
    req.on('error', reject);
    req.end();
  });
}

function connectThroughProxy(proxyPort, targetPort) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port: proxyPort,
      method: 'CONNECT',
      path: `127.0.0.1:${targetPort}`
    });
    req.on('connect', (res, socket) => {
      if (res.statusCode !== 200) {
        reject(new Error(`CONNECT failed with ${res.statusCode}`));
        socket.destroy();
        return;
      }
      socket.write('GET /tunnel HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n');
      const chunks = [];
      socket.on('data', chunk => chunks.push(chunk));
      socket.on('end', () => resolve({
        status: res.statusCode,
        body: Buffer.concat(chunks).toString()
      }));
      socket.on('error', reject);
    });
    req.on('error', reject);
    req.end();
  });
}

test('带认证 SOCKS5 会通过本地桥接支持 HTTP 与 CONNECT', async (t) => {
  const target = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain', Connection: 'close' });
    res.end(`target:${req.url}`);
  });
  const targetPort = await listen(target);
  const socks = createAuthenticatedSocks5Server('bridge-user', 'bridge-pass');
  const socksPort = await listen(socks.server);
  const bridge = await createLocalSocksProxyBridge(
    `socks5h://bridge-user:bridge-pass@127.0.0.1:${socksPort}`
  );
  t.after(async () => {
    await bridge.close();
    await socks.close();
    await closeServer(target);
  });

  assert.equal(bridge.bridged, true);
  assert.match(bridge.proxy.server, /^http:\/\/127\.0\.0\.1:\d+$/);
  const proxyPort = Number(new URL(bridge.proxy.server).port);

  const plain = await requestThroughProxy(proxyPort, `http://127.0.0.1:${targetPort}/plain`);
  assert.equal(plain.status, 200);
  assert.match(plain.body, /target:\/plain/);

  const tunneled = await connectThroughProxy(proxyPort, targetPort);
  assert.equal(tunneled.status, 200);
  assert.match(tunneled.body, /target:\/tunnel/);
});

test('无需桥接的代理仍直接交给 Chromium', async (t) => {
  const httpProxy = await prepareBrowserProxy('http://user:pass@127.0.0.1:7890');
  const socksWithoutAuth = await prepareBrowserProxy('socks5h://127.0.0.1:1080');
  t.after(async () => {
    await httpProxy.close();
    await socksWithoutAuth.close();
  });

  assert.equal(httpProxy.bridged, false);
  assert.equal(httpProxy.proxy.server, 'http://127.0.0.1:7890');
  assert.equal(socksWithoutAuth.bridged, false);
  assert.equal(socksWithoutAuth.proxy.server, 'socks5://127.0.0.1:1080');
});
