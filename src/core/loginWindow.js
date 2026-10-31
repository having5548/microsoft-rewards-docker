/**
 * 微软账号登录窗口：在容器里开一个**可见**的 Chromium，让用户通过 WebUI 内嵌的
 * noVNC 自己登录微软账号，然后由后端直接把完整 Cookie 抓下来写进配置。
 *
 * 为什么要这么做：让用户自己从 F12 里复制 Cookie 是这套系统最容易出错的环节——
 * 复制漏项、只复制了某个值、复制到别的域名下、Safari 格式带制表符……
 * 最后表现出来就是「刚刷新的 Cookie 也提示已过期」。浏览器里登录过的 Cookie
 * 是完整且自洽的，直接抓下来最不容易错。
 *
 * 设计约束：
 *   - 与积分任务的 Chromium 共用 browserSlotLock，登录期间不跑任何自动任务，
 *     避免两个 Chromium 同时跑把 NAS 内存打满；
 *   - 复用账号自己的代理出口（带认证的 SOCKS5 走 localProxyBridge）；
 *   - 登录态用持久化 profile 保存，超时/关闭后再次打开不需要重新输密码；
 *   - 所有生命周期出口都释放锁与定时器，不留下「窗口关了但浏览器还在跑」的僵尸。
 */
import fs from 'fs';
import path from 'path';
import { chromium } from 'patchright-core';
import configManager from '../config.js';
import logger from '../logger.js';
import authManager from './auth.js';
import { DATA_DIR, withTimeout } from '../fsUtil.js';
import { browserSlotLock } from './contextLock.js';
import { findChromiumExecutable } from './chromiumExecutable.js';
import { prepareBrowserProxy } from './localProxyBridge.js';
import { PC_USER_AGENT, SEC_CH_UA, PLATFORM } from './fingerprint.js';
import {
  analyzeCookie,
  buildCookieString,
  describeCookieProblem,
  isMicrosoftHost
} from './cookieAssistant.js';

const PROFILE_ROOT = path.join(DATA_DIR, 'login-profile');
const POLL_INTERVAL_MS = 1500;
const DEFAULT_TIMEOUT_MIN = 30;
/** 登录成功后需要停留这么久，等微软把 identity cookie 全部种完再保存 */
const SETTLE_MS = 1500;
const LOGIN_HOME_URL = 'https://cn.bing.com';
const LOGIN_STARTUP_ID = `new-${process.pid}-${Date.now()}`;

export const LOGIN_WINDOW_URL = '/novnc/vnc.html?autoconnect=1&resize=scale&path=websockify';

/** 参与登录窗口 Cookie 采集的域名（含微软账号站点本身） */
const LOGIN_COOKIE_DOMAINS = [
  'bing.com',
  'microsoft.com',
  'live.com',
  'msn.com',
  'microsoftonline.com',
  'windows.net',
  'office.com'
];

function safeAccountId(accountId) {
  return String(accountId || 'default').replace(/[^A-Za-z0-9_-]/g, '_');
}

function loginTimeoutMin() {
  // EPIC_LOGIN_TIMEOUT_MIN 是旧版（Epic 登录窗口）留下的环境变量名，
  // 这里保留兼容，避免老用户的 compose 升级后突然失去自动关闭保护。
  const raw = Number(process.env.LOGIN_WINDOW_TIMEOUT_MIN || process.env.EPIC_LOGIN_TIMEOUT_MIN || DEFAULT_TIMEOUT_MIN);
  if (!Number.isFinite(raw)) return DEFAULT_TIMEOUT_MIN;
  if (raw === 0) return 0; // 0 = 不自动关闭
  return Math.max(1, Math.min(180, raw));
}

class LoginWindow {
  constructor() {
    this.context = null;
    this.page = null;
    this.accountId = null;
    this.startedAt = 0;
    this.timer = null;
    this.timeoutTimer = null;
    this.lastAction = '';
    this.loggedIn = false;
    this.cookieCount = 0;
    this.hasU = false;
    this.userName = '';
    this.missing = [];
    this.slotOwner = null;
    this.closing = false;
    this.proxyBridge = null;
    this.openPromise = null;
    this.closePromise = null;
  }

  isOpen() {
    return !!this.context;
  }

  getState() {
    return {
      active: this.isOpen(),
      accountId: this.accountId,
      url: this.isOpen() ? LOGIN_WINDOW_URL : '',
      loggedIn: this.loggedIn,
      cookieCount: this.cookieCount,
      hasU: this.hasU,
      userName: this.userName,
      missing: this.missing,
      lastAction: this.lastAction,
      startedAt: this.startedAt,
      elapsedSec: this.startedAt ? Math.round((Date.now() - this.startedAt) / 1000) : 0,
      timeoutMin: loginTimeoutMin()
    };
  }

  /** 启动可见浏览器并打开微软登录页 */
  async open(accountId = null) {
    if (this.closePromise) await this.closePromise;
    if (this.openPromise) {
      if (this.pendingAccountId !== accountId) throw new Error('登录窗口正在为另一个账号启动，请等待当前启动完成');
      return { ...(await this.openPromise), alreadyOpen: true };
    }
    if (this.isOpen()) {
      if (this.accountId !== accountId) throw new Error('登录窗口已被另一个账号占用，请先关闭当前窗口');
      return { ...this.getState(), alreadyOpen: true };
    }

    this.pendingAccountId = accountId;
    this.openPromise = this.openInternal(accountId);
    try {
      return await this.openPromise;
    } finally {
      this.openPromise = null;
      this.pendingAccountId = null;
    }
  }

  async openInternal(accountId) {
    const execPath = findChromiumExecutable();
    if (!execPath) {
      throw new Error('未检测到 Chromium / Edge 浏览器内核，无法打开登录窗口（容器里应设置 CHROMIUM_PATH=/usr/bin/chromium）');
    }
    if (process.platform === 'linux' && !process.env.DISPLAY) {
      throw new Error('当前进程没有可用的图形显示（DISPLAY 为空），无法打开可见浏览器。请在容器里启用可见浏览器（MSR_VISIBLE=1，需 Xvfb），或改用「粘贴完整 Cookie」的方式。');
    }

    const acc = accountId ? configManager.findAccount(accountId) : null;
    if (accountId && !acc) throw new Error('账号不存在');

    const sessionAccountId = accountId || `${LOGIN_STARTUP_ID}-${Date.now()}`;
    const owner = `ms-login:${sessionAccountId}:${Date.now()}`;
    const gotSlot = await browserSlotLock.acquire(owner, 5000);
    if (!gotSlot) {
      throw new Error('浏览器正被积分任务占用，请等当前任务结束（或先停止任务）再打开登录窗口');
    }
    this.slotOwner = owner;

    const profileDir = path.join(PROFILE_ROOT, safeAccountId(sessionAccountId));
    fs.mkdirSync(profileDir, { recursive: true });

    try {
      const accountProxy = acc ? configManager.getEffectiveProxy(acc) : null;
      this.proxyBridge = await prepareBrowserProxy(accountProxy?.url || '');
      const browserProxy = this.proxyBridge?.proxy || null;

      this.lastAction = '正在启动浏览器...';
      this.context = await chromium.launchPersistentContext(profileDir, {
        executablePath: execPath,
        headless: false,
        viewport: null,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--no-first-run',
          '--no-default-browser-check',
          '--window-position=0,0',
          '--window-size=1366,768',
          '--lang=zh-CN'
        ],
        userAgent: PC_USER_AGENT,
        locale: 'zh-CN',
        timezoneId: 'Asia/Shanghai',
        extraHTTPHeaders: {
          'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
          'sec-ch-ua': SEC_CH_UA,
          'sec-ch-ua-mobile': '?0',
          'sec-ch-ua-platform': PLATFORM.clientHint
        },
        ...(browserProxy ? { proxy: browserProxy } : {})
      });

      this.accountId = accountId || null;
      this.sessionAccountId = sessionAccountId;
      this.startedAt = Date.now();
      this.loggedIn = false;
      this.cookieCount = 0;
      this.hasU = false;
      this.userName = '';
      this.missing = [];
      this.closing = false;

      this.context.on('close', () => {
        // 页面被关掉（用户关窗口 / 浏览器崩溃）时也要把状态和锁清干净
        if (!this.closing) this.cleanup('browser-closed');
      });

      this.page = this.context.pages()[0] || await this.context.newPage();

      this.startPolling();
      this.armTimeout();

      // 首屏导航**不阻塞接口返回**：容器在 NAS 上、走代理时 rewards.bing.com 可能十几秒
      // 才 domcontentloaded，接口要是等它，前端就会长时间停在「启动中」看不到画面。
      // 这里立刻把状态返回去，小窗先连上（noVNC 拿到的是 X 显示，不依赖页面加载），
      // 页面加载完成后再由轮询把提示文案更新回来。
      this.lastAction = '正在打开 cn.bing.com 登录页...';
      this.page.goto(LOGIN_HOME_URL, {
        waitUntil: 'domcontentloaded',
        timeout: 45000
      }).then(() => {
        if (this.isOpen() && !this.loggedIn) {
          this.lastAction = 'cn.bing.com 已打开，请在小窗里登录微软账号';
        }
      }).catch((e) => {
        if (this.isOpen()) {
          this.lastAction = `页面加载较慢（${e.message}），可以在小窗里手动刷新或直接登录`;
        }
      });

      logger.log('🌐', `已打开微软账号登录窗口${acc ? `（账号 ${acc.name}）` : ''}，请在窗口中完成登录`, '', acc?.name);
      return this.getState();
    } catch (e) {
      await this.cleanup('open-failed');
      throw e;
    }
  }

  startPolling() {
    this.stopPolling();
    const tick = async () => {
      if (!this.context || this.closing) return;
      try {
        const cookies = await this.context.cookies();
        const microsoftCookies = cookies.filter(item => {
          const domain = String(item.domain || '').replace(/^\./, '');
          return LOGIN_COOKIE_DOMAINS.some(d => domain === d || domain.endsWith(`.${d}`));
        });
        const map = new Map();
        // 先放 bing 域，再放其它域（同名时 bing 优先）
        const sorted = microsoftCookies.slice().sort((a, b) => {
          const score = (item) => (String(item.domain || '').includes('bing.com') ? 0 : 1);
          return score(a) - score(b);
        });
        for (const item of sorted) {
          const name = String(item.name || '').trim();
          if (!name || name === '_EDGE_S') continue;
          if (map.has(name)) continue;
          map.set(name, String(item.value ?? ''));
        }
        this.cookieCount = map.size;
        this.hasU = !!(map.get('_U') || '').trim();
        this.missing = ['_U', 'MUID', 'RPSSecAuth'].filter(name => !map.has(name));
        this.loggedIn = map.size > 0 && this.hasU;
        this.lastAction = this.loggedIn
          ? `已检测到登录态（${map.size} 个 Cookie），若刚刚登录请停留 2 秒再点保存`
          : `等待登录...（当前 ${map.size} 个 Cookie${map.size ? '，尚未拿到 _U' : ''}）`;
        if (this.loggedIn && !this.userName) {
          const wls = String(map.get('WLS') || '');
          const match = wls.match(/N=([^&;]+)/);
          if (match) {
            try { this.userName = decodeURIComponent(match[1]); } catch { this.userName = match[1]; }
          }
        }
      } catch (e) {
        this.lastAction = `读取登录状态失败: ${e.message}`;
      }
    };
    tick();
    this.timer = setInterval(tick, POLL_INTERVAL_MS);
    this.timer.unref?.();
  }

  stopPolling() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  armTimeout() {
    this.clearTimeout();
    const minutes = loginTimeoutMin();
    if (minutes <= 0) return;
    this.timeoutTimer = setTimeout(() => {
      logger.log('⏰', `登录窗口已打开超过 ${minutes} 分钟，自动关闭`);
      this.close('timeout');
    }, minutes * 60000);
    this.timeoutTimer.unref?.();
  }

  clearTimeout() {
    if (this.timeoutTimer) {
      clearTimeout(this.timeoutTimer);
      this.timeoutTimer = null;
    }
  }

  /** 把当前浏览器里的 Cookie 抓成配置用的 Cookie 串 */
  async readCookieString() {
    if (!this.context) throw new Error('登录窗口没有打开');
    const cookies = await this.context.cookies();
    const map = new Map();
    const sorted = cookies
      .filter(item => isMicrosoftHost(`https://${String(item.domain || '').replace(/^\./, '')}/`))
      .sort((a, b) => {
        const score = (item) => (String(item.domain || '').includes('bing.com') ? 0 : 1);
        return score(a) - score(b);
      });
    for (const item of sorted) {
      const name = String(item.name || '').trim();
      if (!name || name === '_EDGE_S') continue;
      if (map.has(name)) continue;
      map.set(name, String(item.value ?? ''));
    }
    return buildCookieString(map);
  }

  /**
   * 保存：抓 Cookie → 规范化 → 真实校验 → 写进账号。
   * 校验不通过时**不关闭**窗口，让用户继续在窗口里处理（比如还要过验证码）。
   */
  async save(accountId) {
    if (!this.context) throw new Error('登录窗口没有打开，请先点「打开登录窗口」');
    if (accountId && this.accountId && accountId !== this.accountId) {
      throw new Error('当前浏览器登录窗口属于另一个账号，请先关闭后再重试');
    }
    const targetId = accountId || this.accountId;
    const acc = targetId ? configManager.findAccount(targetId) : null;
    if (targetId && !acc) throw new Error('账号不存在');

    this.lastAction = '正在读取浏览器 Cookie...';
    const rawCookie = await this.readCookieString();
    if (!rawCookie) throw new Error('浏览器里还没有任何 Cookie，请先完成登录');

    const analysis = analyzeCookie(rawCookie, {
      existingCookie: acc?.cookie || '',
      autoAddU: true
    });
    if (!analysis.hasU) {
      this.lastAction = '尚未检测到 _U，登录可能还没完成';
      return {
        valid: false,
        cookie: analysis.cookie,
        hasU: false,
        missing: analysis.missing,
        message: '还没有拿到 _U 这个身份 Cookie，请确认已经登录成功（页面右上角出现你的头像/积分）后再点保存。'
      };
    }

    this.lastAction = '正在用这套 Cookie 校验登录态...';
    const status = await authManager.checkCookieStatus(analysis.cookie, targetId || undefined);

    if (!status.valid) {
      this.lastAction = '校验未通过，窗口保持打开';
      return {
        valid: false,
        cookie: analysis.cookie,
        hasU: true,
        missing: analysis.missing,
        message: `${status.message}${status.message?.includes('缺少') ? '' : `（${describeCookieProblem(analysis)}）`}`
      };
    }

    // 校验通过才落库
    const saved = configManager.upsertAccount({
      id: targetId || undefined,
      name: acc ? undefined : (status.userName ? `账号 (${status.userName})` : undefined),
      cookie: analysis.cookie
    });

    logger.log('🟢', `已从登录窗口保存 Cookie：${describeCookieProblem(analysis)}${status.balance ? `，当前积分 ${status.balance}` : ''}`, '', saved?.name);
    await this.close('saved');

    return {
      valid: true,
      accountId: saved?.id || targetId || '',
      cookie: analysis.cookie,
      hasU: true,
      cookieCount: analysis.cookieCount,
      added: analysis.added,
      missing: analysis.missing,
      balance: status.balance,
      userName: status.userName,
      message: `登录成功${status.userName ? `（${status.userName}）` : ''}，已获取 ${analysis.cookieCount} 个 Cookie${analysis.added.length ? `，自动补齐 ${analysis.added.join('、')}` : ''}${status.balance ? `，当前积分 ${status.balance}` : ''}`
    };
  }

  async close(reason = 'manual') {
    if (this.closePromise) return this.closePromise;
    if (!this.context) return { closed: false };
    const context = this.context;
    this.closing = true;
    const closing = (async () => {
      try {
        await withTimeout(context.close(), 15000, '关闭登录浏览器超时');
      } catch (e) {
        logger.log('🟡', `关闭登录窗口时出现异常: ${e.message}`);
      } finally {
        if (this.context === context) this.cleanup(reason);
      }
      return { closed: true, reason };
    })();
    this.closePromise = closing;
    try {
      return await closing;
    } finally {
      if (this.closePromise === closing) this.closePromise = null;
    }
  }

  /** 只清理状态与资源，不抛错 */
  cleanup(reason = '') {
    this.stopPolling();
    this.clearTimeout();
    try { this.context = null; } catch {}
    this.page = null;
    this.accountId = null;
    this.sessionAccountId = null;
    this.startedAt = 0;
    this.loggedIn = false;
    this.cookieCount = 0;
    this.hasU = false;
    this.missing = [];
    this.closing = false;
    if (this.proxyBridge) {
      try { this.proxyBridge.close(); } catch {}
      this.proxyBridge = null;
    }
    if (this.slotOwner) {
      browserSlotLock.release(this.slotOwner);
      this.slotOwner = null;
    }
    if (reason === 'timeout') {
      logger.log('⏰', '登录窗口已自动关闭');
    }
  }
}

export const loginWindow = new LoginWindow();
export default loginWindow;
