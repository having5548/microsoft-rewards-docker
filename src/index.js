import configManager from './config.js';
import logger from './logger.js';
import scheduler from './scheduler.js';
import historyManager from './core/history.js';
import loginWindow from './core/loginWindow.js';
import { createServer } from './web/server.js';

async function bootstrap() {
  console.log(`
  ==============================================================
  🎁 Microsoft Rewards 微软积分全能自动化助手 (Docker/WebUI版)
  ==============================================================
  `);

  const cfg = configManager.get();
  const port = process.env.PORT || cfg.server?.port || 5308;

  const app = createServer();

  const server = app.listen(port, '0.0.0.0', () => {
    logger.log('🚀', `Web 控制台已启动，请在浏览器访问: http://localhost:${port}`);
    logger.log('💡', '如果是 NAS 或 VPS 部署，请访问: http://<服务器局域网或公网IP>:' + port);
  });

  // 将 noVNC WebSocket 升级请求转发到容器内部 websockify。
  // 注意：升级握手不经过 Express，所以这里要显式复用 Basic 鉴权，
  // 否则设置了 authPassword 也能直接连上 WebSocket 操作浏览器。
  if (app.locals?.novncProxy) {
    server.on('upgrade', (req, socket, head) => {
      const requestUrl = String(req.url || '');
      const isNovncPath = requestUrl.startsWith('/novnc/websockify');
      if (!requestUrl.startsWith('/websockify') && !isNovncPath) {
        socket.destroy();
        return;
      }
      const authorized = typeof app.locals.isBasicAuthSatisfied === 'function'
        ? app.locals.isBasicAuthSatisfied(req)
        : true;
      if (!authorized) {
        socket.write(
          'HTTP/1.1 401 Unauthorized\r\n' +
          'WWW-Authenticate: Basic realm="Microsoft Rewards", charset="UTF-8"\r\n' +
          'Connection: close\r\n\r\n'
        );
        socket.destroy();
        return;
      }
      if (isNovncPath) {
        req.url = req.url.replace(/^\/novnc/, '');
      }
      app.locals.novncProxy.ws(req, socket, head);
    });
  }

  // 启动后台定时任务
  scheduler.start();

  // 优雅退出
  const shutdown = () => {
    logger.log('🛑', '正在安全退出服务...');
    scheduler.stop();
    // 登录窗口可能还占着一个 Chromium：不主动关掉，容器可能要等到 SIGKILL 才退出
    loginWindow.close('shutdown').catch(() => {});
    // 历史记录现在是「内存缓存 + 延迟落盘」，退出前必须冲一次，否则会丢最后几秒的记录
    historyManager.flush();
    server.close(() => {
      process.exit(0);
    });
    // SSE 日志流会保持长连接，server.close() 单独调用可能永远等不到回调，
    // 导致容器收到 SIGTERM 后迟迟无法退出。主动断开所有连接。
    server.closeAllConnections?.();
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

bootstrap().catch(err => {
  console.error('服务启动失败:', err);
  process.exit(1);
});
