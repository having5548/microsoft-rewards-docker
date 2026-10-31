import fs from 'fs';
import { EventEmitter } from 'events';
// patchright-core 是 playwright-core 的补丁分支（API 完全一致），
// 它从协议层修掉了 Playwright 最容易被识别的自动化特征：
// CDP 的 Runtime.enable / Console.enable 泄漏、--enable-automation 启动参数、
// navigator.webdriver 等。--disable-blink-features=AutomationControlled 由它自动加上，
// 所以下面不再重复传这个参数。
import { chromium } from 'patchright-core';
import logger from '../logger.js';
import rewardsApi from './api.js';
import configManager from '../config.js';
import { browserSlotLock } from './contextLock.js';
import { readBrowserSession, writeBrowserSession } from './browserSession.js';
import { SearchStagnationGuard } from './searchStagnation.js';
import { cookieValue } from './accountIdentity.js';
import {
  isQuestSubtaskCompleted,
  parseQuestProgress,
  classifyQuestAction,
  questSubtaskKey,
  isDailyQuestSubtask,
  isQuestSubtaskCoolingDown,
  buildQuestSubtaskUpdate
} from './questStatus.js';
import { withTimeout } from '../fsUtil.js';
import {
  PC_USER_AGENT,
  SEC_CH_UA,
  PLATFORM,
  CHROME_MAJOR,
  buildUserAgentMetadata
} from './fingerprint.js';
import { findChromiumExecutable } from './chromiumExecutable.js';
import { prepareBrowserProxy } from './localProxyBridge.js';
import { sanitizeCookiesForBrowser } from './cookieAssistant.js';

export function classifyBingLoginState(signals = {}) {
  const userName = [signals.idN, signals.idA, signals.idName]
    .map(value => String(value || '').trim())
    .find(Boolean) || null;
  const signInVisible = signals.signInVisible === true;
  return {
    userName,
    signInVisible,
    isGuest: !userName && signInVisible,
    status: userName ? 'logged-in' : (signInVisible ? 'guest' : 'unknown'),
    cookieHasU: signals.cookieHasU === true
  };
}

class BrowserManager extends EventEmitter {
  constructor() {
    super();
    this.browser = null;
    this.context = null;
    this.page = null;
    this.shouldStop = false;
    // 是否持有浏览器资源锁（由 launchBrowser/closeBrowser 维护）
    this.slotHeld = false;
    this.slotOwner = null;
    this.closeTimeoutMs = Math.max(10, Number(process.env.BROWSER_CLOSE_TIMEOUT_MS) || 15000);
    // 当前绑定的账号（会话持久化需要它来定位文件与校验凭据指纹）
    this.sessionAccount = null;
    this.proxyBridge = null;
    this.state = {
      status: 'idle', // 'idle' | 'starting' | 'navigating' | 'typing' | 'dwelling' | 'waiting' | 'stopped'
      activeAccountId: null,
      activeAccountName: '未启动',
      currentQuery: '',
      searchCount: 0,
      totalTarget: 0,
      nextSearchIn: 0,
      memoryMB: 0,
      lastAction: '浏览器当前处于空闲休眠状态 (0 内存占用)',
      lastUpdate: Date.now()
    };
  }

  getExecutablePath() {
    return findChromiumExecutable();
  }

  updateState(partial) {
    Object.assign(this.state, partial);
    this.state.lastUpdate = Date.now();
    this.emit('status', this.state);
  }

  getStatus() {
    return this.state;
  }

  parseCookies(cookieStr, defaultDomain = '.bing.com') {
    if (!cookieStr || typeof cookieStr !== 'string') return [];
    const list = [];
    const parts = cookieStr.split(/[;\r\n]+/);
    for (const part of parts) {
      const trimmed = part.trim();
      if (!trimmed) continue;
      let name = '', value = '';
      if (trimmed.includes('\t') && !trimmed.includes('=')) {
        const cols = trimmed.split('\t');
        name = cols[0].trim();
        value = cols[1].trim();
      } else {
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx > 0) {
          name = trimmed.slice(0, eqIdx).trim();
          value = trimmed.slice(eqIdx + 1).trim();
        }
      }
      if (name && name !== '_EDGE_S') {
        if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
          value = value.slice(1, -1);
        }
        list.push({
          name,
          value,
          domain: defaultDomain,
          path: '/'
        });
      }
    }
    return list;
  }

  async launchBrowser(acc) {
    const execPath = this.getExecutablePath();
    if (!execPath) {
      throw new Error('未检测到 Chromium 或 Edge 浏览器内核，请确保安装了 Chromium');
    }
    if (this.slotHeld) {
      throw new Error('浏览器实例已经启动，不能并发启动第二个实例');
    }

    // 抢浏览器资源锁：登录窗口与积分任务共用同一把锁，避免两个 Chromium 同时跑把 NAS 内存打满
    const slotOwner = `rewards-browser:${acc?.id || 'default'}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
    const gotSlot = await browserSlotLock.acquire(slotOwner, 180000);
    if (!gotSlot) {
      throw new Error('浏览器资源正被其它任务占用（账号登录窗口或另一个搜索流程），请稍后重试');
    }
    this.slotHeld = true;
    this.slotOwner = slotOwner;

    this.updateState({
      status: 'starting',
      activeAccountId: acc?.id || 'acc_1',
      activeAccountName: acc?.name || '当前账号',
      memoryMB: 180,
      lastAction: '正在初始化无头浏览器 Chromium 引擎...'
    });

    let browser = null;
    try {
      browser = await chromium.launch({
        executablePath: execPath,
        headless: true,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-gpu',
          '--no-first-run',
          '--no-default-browser-check'
        ]
      });

      // 镜像里的 Chromium 主版本如果和指纹常量脱节，这里提醒维护者同步，
      // 否则会重新出现「UA 版本 ≠ 真实引擎版本」的矛盾。
      const realMajor = String(browser.version() || '').split('.')[0];
      if (realMajor && realMajor !== CHROME_MAJOR) {
        logger.log('🟡', `镜像内 Chromium 主版本为 ${realMajor}，但指纹常量 CHROME_MAJOR=${CHROME_MAJOR}，建议同步更新 src/core/fingerprint.js`);
      }

      // 复用该账号上一轮的浏览器会话（Cookie + localStorage）。
      // 凭据换过账号时 readBrowserSession 会判定为过期并返回 null，自动回退到全新会话。
      const stored = readBrowserSession(acc);
      const storageState = stored?.storageState || null;
      const accountProxy = configManager.getEffectiveProxy(acc);
      const proxyBridge = await prepareBrowserProxy(accountProxy?.url || '');
      this.proxyBridge = proxyBridge;
      const browserProxy = proxyBridge?.proxy || null;
      if (proxyBridge?.bridged) {
        logger.log('🌐', '已启用 SOCKS5 认证兼容桥接（仅监听 127.0.0.1）', '', acc?.name);
      }
      if (stored?.stale) {
        logger.log('🟡', `已丢弃该账号的旧浏览器会话（${stored.reason}），本次使用全新会话`, '', acc?.name);
      } else if (storageState) {
        const savedDays = stored.savedAt
          ? ((Date.now() - stored.savedAt) / 86400000).toFixed(1)
          : '?';
        logger.log('🔐', `已复用该账号的浏览器会话（${storageState.cookies.length} 个 Cookie，保存于 ${savedDays} 天前）`, '', acc?.name);
      }

      const context = await browser.newContext({
        userAgent: PC_USER_AGENT,
        viewport: { width: 1366, height: 768 },
        locale: 'zh-CN',
        timezoneId: 'Asia/Shanghai',
        // 浏览器一定会带的客户端提示；Playwright 的 userAgent 选项不会设置它们，
        // 不补的话 UA 说 Chrome/150 而 Sec-CH-UA 说真实版本，等于自相矛盾。
        extraHTTPHeaders: {
          'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
          'sec-ch-ua': SEC_CH_UA,
          'sec-ch-ua-mobile': '?0',
          'sec-ch-ua-platform': PLATFORM.clientHint
        },
        ...(browserProxy ? { proxy: browserProxy } : {}),
        ...(storageState ? { storageState } : {})
      });

      // 说明：这里刻意不再用 Object.defineProperty(navigator, 'webdriver', ...) 去「抹平」webdriver。
      // 配合 --disable-blink-features=AutomationControlled，Chromium 原生就返回 false，
      // 而那段 init script 会在 navigator 实例上凭空造出一个自有属性 getter ——
      // 真实浏览器上没有这个自有属性，反而成了更明显的自动化特征。

      // 无 GPU 的无头环境里 WebGL 会暴露 SwiftShader（软件渲染），
      // 与「Windows 桌面 Chrome」的身份矛盾，这里改成常见的核显标识。
      await context.addInitScript(() => {
        const VENDOR = 'Google Inc. (Intel)';
        const RENDERER = 'ANGLE (Intel, Intel(R) UHD Graphics 630 (0x00003E9B) Direct3D11 vs_5_0 ps_5_0, D3D11)';
        const patch = (proto) => {
          if (!proto || !proto.getParameter) return;
          const orig = proto.getParameter;
          proto.getParameter = function (p) {
            if (p === 37445) return VENDOR;  // UNMASKED_VENDOR_WEBGL
            if (p === 37446) return RENDERER; // UNMASKED_RENDERER_WEBGL
            return orig.call(this, p);
          };
          proto.getParameter.toString = () => orig.toString();
        };
        try {
          patch(window.WebGLRenderingContext && WebGLRenderingContext.prototype);
          patch(window.WebGL2RenderingContext && WebGL2RenderingContext.prototype);
        } catch {}
      });

      // 注入当前账号的完整 Cookie。
      // Playwright 的 addCookies 是整批走 CDP 的：只要有一条非法（值里带 `;`、换行、
      // 名称带分号、域名带斜杠，或单条 name+value 超过 4096 字节 —— 微软的 RPSSecAuth /
      // ESTSAUTH 很容易顶到上限），整批都会被拒，报 `Invalid cookie fields`，
      // 于是单次测搜 / 打卡会直接卡死在「正在准备浏览器」这一步。
      // 这里先净化（能修的修、修不了的跳过并记日志），再批量注入；批量仍失败就逐条兜底。
      if (acc?.cookie) {
        const { accepted, rejected } = sanitizeCookiesForBrowser(
          this.parseCookies(acc.cookie, '.bing.com')
        );
        if (rejected.length > 0) {
          const detail = rejected.map(item => `${item.name}（${item.reason}）`).join('、');
          logger.log('🟡', `有 ${rejected.length} 个 Cookie 无法注入浏览器，已跳过：${detail}`, '', acc?.name);
          if (rejected.some(item => item.name === '_U')) {
            logger.log('🔴', '被跳过的 Cookie 里包含 _U：本轮搜索不会关联到账号，请改用「打开登录窗口自动获取 Cookie」重新取一份', '', acc?.name);
          }
        }
        if (accepted.length > 0) {
          try {
            await context.addCookies(accepted);
          } catch (e) {
            let okCount = 0;
            for (const cookie of accepted) {
              try {
                await context.addCookies([cookie]);
                okCount += 1;
              } catch {}
            }
            logger.log('🟡', `批量注入 Cookie 失败（${e.message}），已改为逐条注入，成功 ${okCount}/${accepted.length} 条`, '', acc?.name);
            if (okCount === 0) throw e;
          }
        }
      }

      this.browser = browser;
      this.context = context;
      this.sessionAccount = acc || null;
      return { browser, context };
    } catch (e) {
      const proxyBridge = this.proxyBridge;
      this.proxyBridge = null;
      // 启动过程中失败也必须把锁还回去，否则后续所有浏览器任务都会被卡住
      try {
        if (browser) {
          await withTimeout(Promise.resolve().then(() => browser.close()), this.closeTimeoutMs, '浏览器启动失败后的清理超时').catch(() => {});
        }
        await proxyBridge?.close().catch(() => {});
      } finally {
        this.releaseBrowserSlot();
      }
      throw e;
    }
  }

  releaseBrowserSlot() {
    if (!this.slotHeld) return;
    const owner = this.slotOwner;
    this.slotHeld = false;
    this.slotOwner = null;
    if (owner) browserSlotLock.release(owner);
  }

  /**
   * 新建页面并立即对齐指纹。
   *
   * Playwright 的 `newContext({ userAgent })` 只改 UA 头，不会改 Sec-CH-UA
   * 与 navigator.platform。这里用 CDP 的 setUserAgentOverride 把
   * UA / 客户端提示 / 平台一次性设成同一套身份（比在 JS 里覆写原型链更不易被识别，
   * 因为它保持原生实现，不留下 JS getter 特征）。
   */
  async createPage(context) {
    const page = await context.newPage();
    try {
      const cdp = await context.newCDPSession(page);
      await cdp.send('Emulation.setUserAgentOverride', {
        userAgent: PC_USER_AGENT,
        // 注意：CDP 的 acceptLanguage 是「语言列表」，不能带 q 权重，
        // 否则 navigator.languages 会变成 ["zh-CN","zh;q=0.9"] 这种畸形值。
        acceptLanguage: 'zh-CN,zh',
        platform: PLATFORM.navigator,
        userAgentMetadata: buildUserAgentMetadata()
      });
      // 保持会话引用，避免被回收后覆盖失效
      if (!this.cdpSessions) this.cdpSessions = [];
      this.cdpSessions.push(cdp);
    } catch (e) {
      // 指纹对齐失败不应该让整个任务挂掉，降级继续（只是可能留下版本不一致）
      logger.log('🟡', `浏览器指纹对齐失败，本次以默认指纹继续: ${e.message}`);
    }
    return page;
  }

  /**
   * 把当前浏览器状态（Cookie + localStorage）写回磁盘，供下次执行复用。
   *
   * 只在任务确实跑成功的路径上调用：失败路径写回会把半残的会话固化下来，
   * 反而让下一轮从一开始就处于坏状态。
   */
  async commitBrowserSession() {
    if (!this.context || !this.sessionAccount) return false;
    try {
      const state = await this.context.storageState();
      const cookieCount = Array.isArray(state?.cookies) ? state.cookies.length : 0;
      const ok = writeBrowserSession(this.sessionAccount, state);
      if (ok) {
        logger.log('💾', `浏览器会话已保存（${cookieCount} 个 Cookie），下次执行将复用`, '', this.sessionAccount.name);
      }
      return ok;
    } catch (e) {
      logger.log('🟡', `浏览器会话保存失败: ${e.message}`, '', this.sessionAccount?.name);
      return false;
    }
  }

  async closeBrowser() {
    const proxyBridge = this.proxyBridge;
    this.proxyBridge = null;
    try {
      if (this.context) {
        await withTimeout(Promise.resolve().then(() => this.context.close()), this.closeTimeoutMs, '关闭浏览器上下文超时').catch(() => {});
      }
      if (this.browser) {
        await withTimeout(Promise.resolve().then(() => this.browser.close()), this.closeTimeoutMs, '关闭浏览器进程超时').catch(() => {});
      }
    } catch {}
    try {
      this.browser = null;
      this.context = null;
      this.page = null;
      this.cdpSessions = [];
      this.sessionAccount = null;
    } finally {
      await proxyBridge?.close().catch(() => {});
      this.releaseBrowserSlot();
      this.updateState({
        status: 'idle',
        activeAccountId: null,
        activeAccountName: '未启动',
        currentQuery: '',
        nextSearchIn: 0,
        memoryMB: 0,
        lastAction: '浏览器已彻底关闭，内存完全释放 (0 内存占用)'
      });
    }
  }

  delay(ms) {
    return new Promise(r => setTimeout(r, ms));
  }

  /**
   * 读取 Bing 首页的登录态。这里只返回诊断信息，不修改页面。
   */
  async getBingLoginState(page) {
    try {
      const signals = await page.evaluate(() => {
        const textOf = (selector) => (document.querySelector(selector)?.textContent || '').trim();
        const signInBtn = document.querySelector('#id_s, #id_l, a[href*="account.live.com"], a[href*="login.live.com"]');
        return {
          idN: textOf('#id_n'),
          idA: textOf('#id_a'),
          idName: textOf('.id_name'),
          signInVisible: !!signInBtn,
          cookieHasU: /(?:^|;\s*)_U=/.test(document.cookie || '')
        };
      });
      return classifyBingLoginState(signals);
    } catch {
      return { userName: null, signInVisible: false, isGuest: false, status: 'unknown', cookieHasU: false };
    }
  }

  /**
   * 在指定页面执行一次真实搜索，并返回可验证的诊断结果。
   *
   * 关键点：必须确认页面真的进入了 /search 结果页，而不是只在首页输入了文字。
   * 这类“输入成功但没提交”的情况正是搜索不计分的常见来源。
   */
  async performHumanSearch(page, options = {}) {
    const {
      query = '',
      navigateHome = true,
      allowExistingQuery = true,
      logAccountName = ''
    } = options;
    if (!page) throw new Error('搜索页面未就绪');

    if (navigateHome) {
      await page.goto('https://cn.bing.com', { waitUntil: 'domcontentloaded', timeout: 25000 });
      await this.delay(rewardsApi.randomRange(1000, 1800));
    }

    const login = await this.getBingLoginState(page);
    if (login.isGuest) {
      throw new Error('必应搜索页处于游客态，已停止搜索，避免空跑不计分');
    } else if (login.userName) {
      logger.log('👤', `必应搜索登录态确认: ${login.userName}`, '', logAccountName);
    } else {
      logger.log('🟡', '未能从页面确认必应登录用户名，将继续依赖 Cookie 身份与官网计分回读', '', logAccountName);
    }

    const currentUrl = String(page.url() || '');
    const hasExistingQuery = allowExistingQuery && /\/search\?/i.test(currentUrl) && /[?&]q=/i.test(currentUrl);

    if (!hasExistingQuery) {
      if (!query) throw new Error('缺少搜索关键词');
      const searchInputSelector = '#sb_form_q';
      await page.waitForSelector(searchInputSelector, { timeout: 10000 });
      await page.click(searchInputSelector);
      await this.delay(200);
      await page.fill(searchInputSelector, '');
      for (const char of query) {
        await page.type(searchInputSelector, char, { delay: rewardsApi.randomRange(50, 110) });
      }
      await this.delay(350);
      await page.keyboard.press('Enter');
    }

    const submitted = await Promise.race([
      page.waitForURL(/\/search\?/i, { timeout: 15000 }).then(() => true).catch(() => false),
      page.waitForSelector('#b_results', { timeout: 15000 }).then(() => true).catch(() => false)
    ]);
    await page.waitForTimeout(rewardsApi.randomRange(2500, 4500));
    await page.mouse.wheel(0, rewardsApi.randomRange(350, 800)).catch(() => {});
    await this.delay(rewardsApi.randomRange(2500, 4500));

    const finalUrl = String(page.url() || '');
    if (/login\.live\.com|account\.live\.com/i.test(finalUrl)) {
      throw new Error('搜索被重定向到微软登录页，Cookie 登录态已失效');
    }
    const title = await page.title().catch(() => '');
    const resultCount = await page.locator('#b_results li.b_algo, #b_results li.b_ans').count().catch(() => 0);
    const searchSubmitted = submitted || (/\/search\?/i.test(finalUrl) && /[?&]q=/i.test(finalUrl));

    return {
      success: searchSubmitted,
      query,
      finalUrl,
      title,
      resultCount,
      searchSubmitted,
      login
    };
  }

  /**
   * 单次测试搜索 (仅搜 1 次，检验按键输入流与积分变化，完全安全无冷冻风险)
   */
  async singleTestSearch(acc) {
    const accName = acc?.name || '当前账号';
    logger.log('🔍', `启动无头浏览器执行「单次安全验证搜索」...`, '', accName);

    if (acc?.cookie && !cookieValue(acc.cookie, '_U')) {
      throw new Error(`当前账号 [${accName}] 的 Cookie 缺少 _U，已拒绝搜索；请重新抓取完整 Cookie`);
    }
    if (!acc?.cookie) {
      throw new Error(`当前账号 [${accName}] 未配置网页 Cookie，无法执行搜索`);
    }

    try {
      this.shouldStop = false;
      const { browser, context } = await this.launchBrowser(acc);
      const page = await this.createPage(context);
      this.page = page;

      this.updateState({
        status: 'navigating',
        lastAction: '正在访问微软必应首页 (cn.bing.com)...'
      });

      const query = await rewardsApi.getHotSearchWord();
      this.updateState({
        status: 'typing',
        currentQuery: query,
        searchCount: 1,
        totalTarget: 1,
        lastAction: `正在模拟真人键盘打字键入: "${query}"...`
      });

      logger.log('⌨️', `拟人键盘打字检索: "${query}"`, '', accName);

      this.updateState({
        status: 'dwelling',
        lastAction: '按下 Enter 提交搜索，等待真实搜索结果页...'
      });
      const searchResult = await this.performHumanSearch(page, {
        query,
        navigateHome: true,
        logAccountName: accName
      });
      if (!searchResult.searchSubmitted) {
        throw new Error('搜索未进入 Bing 结果页，无法确认搜索已提交');
      }

      logger.log('✅', `单次搜索完成，正在验证积分与配额...`, '', accName);
      await this.commitBrowserSession();
      await this.closeBrowser();

      return {
        success: true,
        query,
        message: `单次搜索已提交！检索词: "${query}"，是否计分以官网进度为准`,
        searchResult
      };
    } catch (e) {
      logger.log('🔴', `单次测试搜索失败: ${e.message}`, '', accName);
      await this.closeBrowser();
      throw e;
    }
  }

  /**
   * 平缓拉长模式：按全局「搜索节奏」设置（基础间隔 ± 随机浮动）完成 PC 搜索。
   * 搜索预算硬性限制为 40 分钟，为 0-10 分钟随机启动与其他任务预留时间。
   */
  async runPacedSearch(acc, neededPoints, options = {}) {
    const accName = acc?.name || '当前账号';
    const {
      onProgress = null,
      probeProgress = null,
      stagnantLimit = 5,
      initialProgress = null,
      probeDelayMs = 12000
    } = options;
    const totalSearches = Math.max(1, Math.min(Math.ceil(neededPoints / 3), 20));

    // 停滞保护：连续 N 次搜索官网进度都不涨，说明搜索额度已到顶或账号正在被限流，
    // 继续搜只会白白增加风控暴露面。达到阈值就主动停手，把本轮当部分完成收尾。
    const stagnation = new SearchStagnationGuard(stagnantLimit);
    if (Number.isFinite(Number(initialProgress))) {
      stagnation.observe(Number(initialProgress));
    }

    // 全局搜索节奏（配置中心「任务与防风控」→ 搜索节奏设置）
    const cfg = configManager.get();
    const clamp = (v, min, max) => Math.max(min, Math.min(max, v));
    // 安全下限：基础间隔 ≥ 60 秒、随机浮动 ≥ 30 秒，避免过于密集触发风控
    const wantedIntervalSec = clamp(Number(cfg.tasks?.searchIntervalSec ?? 60) || 60, 60, 120);
    const jitterSec = clamp(Number(cfg.tasks?.searchJitterSec ?? 60) || 60, 30, 60);
    // 40 分钟搜索上限：1 小时档位还要为启动随机和其他任务留出余量
    const MAX_WINDOW_SEC = 40 * 60;
    const perSearchBudget = Math.floor(MAX_WINDOW_SEC / totalSearches);
    const intervalSec = Math.max(60, Math.min(wantedIntervalSec, perSearchBudget - jitterSec));
    // 随机浮动为「只延后」的叠加模型：单次实际等待 = 基础间隔 + 0~浮动 秒
    const estimatedSec = totalSearches * (intervalSec + Math.floor(jitterSec / 2));
    const worstSec = totalSearches * (intervalSec + jitterSec);
    if (intervalSec < wantedIntervalSec) {
      logger.log('⚠️', `为保证 ${totalSearches} 次搜索在 40 分钟内完成，本次间隔已自动压缩为 ${intervalSec} 秒 + 0~${jitterSec} 秒浮动`, '', accName);
    }

    if (acc?.cookie && !cookieValue(acc.cookie, '_U')) {
      throw new Error(`当前账号 [${accName}] 的 Cookie 缺少 _U，已拒绝搜索；请在配置中心重新导入完整 Cookie`);
    }
    if (!acc?.cookie) {
      throw new Error(`当前账号 [${accName}] 未配置网页 Cookie，无法执行搜索`);
    }

    logger.log('🖥️', `启动 Playwright 拟人真机搜索：需补足 ${neededPoints} 分 → ${totalSearches} 次搜索，间隔 ${intervalSec} 秒 + 0~${jitterSec} 秒浮动，预计约 ${(estimatedSec/60).toFixed(0)} 分钟（最长 ${(worstSec/60).toFixed(0)} 分钟，上限 40 分钟）`, '', accName);

    this.shouldStop = false;
    let completed = 0;
    let stoppedByStagnation = false;
    let lastOfficialProgress = Number.isFinite(Number(initialProgress)) ? Number(initialProgress) : null;
    let lastSearchResult = null;

    try {
      const { browser, context } = await this.launchBrowser(acc);
      const page = await this.createPage(context);
      this.page = page;

      for (let i = 0; i < totalSearches; i++) {
        if (this.shouldStop) {
          logger.log('🛑', `搜索流程被用户手动中断`, '', accName);
          break;
        }

        const query = await rewardsApi.getHotSearchWord();
        completed++;

        this.updateState({
          status: 'navigating',
          currentQuery: query,
          searchCount: completed,
          totalTarget: totalSearches,
          pointsNeeded: neededPoints,
          nextSearchIn: 0,
          lastAction: `[第 ${completed}/${totalSearches} 轮] 正在打开必应主页...`
        });

        this.updateState({
          status: 'typing',
          lastAction: `[第 ${completed}/${totalSearches} 轮] 正在模拟真人键盘键入: "${query}"...`
        });

        logger.log('🔍', `[搜索 ${completed}/${totalSearches}] 键入关键词: "${query}"`, '', accName);

        this.updateState({
          status: 'dwelling',
          lastAction: `[第 ${completed}/${totalSearches} 轮] 按下 Enter，浏览搜索结果中...`
        });
        lastSearchResult = await this.performHumanSearch(page, {
          query,
          navigateHome: true,
          logAccountName: accName
        });
        if (!lastSearchResult.searchSubmitted) {
          logger.log('🟡', `第 ${completed}/${totalSearches} 次搜索没有进入结果页，本轮停止继续搜索`, '', accName);
          stoppedByStagnation = true;
          break;
        }

        // 给微软计分系统留出异步写入时间，再读官网真实进度。
        await this.delay(Math.max(5000, Number(probeDelayMs) || 12000));
        let official = null;
        if (typeof probeProgress === 'function') {
          try {
            official = await probeProgress();
          } catch {}
        }

        let delta = 0;
        if (Number.isFinite(Number(official))) {
          official = Number(official);
          if (lastOfficialProgress === null) {
            lastOfficialProgress = official;
          } else {
            delta = official - lastOfficialProgress;
            lastOfficialProgress = official;
          }
          const result = stagnation.observe(official);
          if (result.stagnant) {
            stoppedByStagnation = true;
            logger.log(
              '🛑',
              `连续 ${result.stagnantCount} 次搜索官网进度没有增加（停留在 ${result.bestProgress} 分），判定搜索额度已到顶或账号搜索未计分，主动停止本轮搜索以免继续空跑`,
              '',
              accName
            );
          }
        }

        // 进度只回调官网读数；读不到时传 null，绝不按“每次 +3”伪造增长。
        if (typeof onProgress === 'function') {
          try {
            onProgress(completed, totalSearches, {
              officialProgress: Number.isFinite(Number(official)) ? Number(official) : null,
              delta,
              searchResult: lastSearchResult
            });
          } catch {}
        }
        if (stoppedByStagnation) break;

        // 如果已经是最后一次，不等待
        if (i === totalSearches - 1) break;

        // 计算下一次搜索的拟人休眠时间（基础间隔 + 0~浮动 秒）
        const waitSec = intervalSec + rewardsApi.randomRange(0, jitterSec);
        logger.log('⏳', `拟人呼吸间隔休眠：${(waitSec / 60).toFixed(1)} 分钟后执行第 ${completed + 1} 次搜索...`, '', accName);

        // 逐秒倒计时更新，便于 WebUI 前端实时显示倒计时
        for (let s = waitSec; s > 0; s--) {
          if (this.shouldStop) break;
          this.updateState({
            status: 'waiting',
            nextSearchIn: s,
            lastAction: `拟人呼吸休眠中 (倒计时 ${String(Math.floor(s/60)).padStart(2,'0')}:${String(s%60).padStart(2,'0')})`
          });
          await this.delay(1000);
        }
      }

      await this.commitBrowserSession();
      await this.closeBrowser();
      if (stoppedByStagnation) {
        logger.log('🛑', `账号 [${accName}] 因官网进度停滞结束，本轮共执行 ${completed} 次检索（未打满的额度留到下一轮）`, '', accName);
      } else {
        logger.log('🎉', `账号 [${accName}] 拟人平缓搜索完成！共执行 ${completed} 次检索`, '', accName);
      }
      return {
        completed,
        officialProgress: lastOfficialProgress,
        stoppedByStagnation,
        lastSearchResult
      };
    } catch (e) {
      logger.log('🔴', `拟人搜索流程发生异常: ${e.message}`, '', accName);
      await this.closeBrowser();
      throw e;
    }
  }

  stop() {
    this.shouldStop = true;
    this.updateState({ status: 'stopped', lastAction: '正在中止浏览器任务...' });
  }

  /**
   * 扫描打孔卡页面上的子任务。
   * 返回稳定的动作类型、进度和冷却判断所需信息。
   */
  async scanQuestSubtasks(page) {
    const rawItems = await page.evaluate(() => {
      const headings = [...document.querySelectorAll('h3')].filter(h => {
        const t = (h.innerText || '').trim();
        return t && !t.includes('条款和条件') && !t.includes('Terms');
      });
      const items = [];
      for (let i = 0; i < headings.length; i++) {
        const h = headings[i];
        let container = h;
        for (let depth = 0; depth < 8 && container?.parentElement; depth++) {
          container = container.parentElement;
          if (container === document.body) break;
          if (container.querySelectorAll('h3').length > 1) break;
          if (container.querySelectorAll('a[href], button').length > 0) break;
        }
        if (!container) continue;

        const rawText = container.innerText || '';
        const hasSuccessIcon = !!container.querySelector(
          '[class*="bg-statusSuccessRewardsBg"], [class*="statusSuccessRewards"], [data-testid*="complete" i]'
        );
        const hasEmptyCircle = !!container.querySelector('[class*="border-ctrlChoiceBaseStrokeRest"]');
        const hasLockIcon = !!container.querySelector('[class*="Lock"], [class*="lock"], [aria-label*="锁定"], [aria-label*="Locked"]');
        const links = [...container.querySelectorAll('a[href], button')].filter(a => {
          if (a.closest('header') || a.closest('footer')) return false;
          const href = a.getAttribute('href') || '';
          if (/\/account\/general|\/rewards\/about|\/rewards\/faq|\/rewards\/redeem/i.test(href)) return false;
          return true;
        });
        if (links.length === 0) continue;

        const link = links[0];
        const disabled = link.getAttribute('aria-disabled') === 'true'
          || link.getAttribute('data-disabled') === 'true'
          || link.disabled === true;
        link.setAttribute('data-msr-subtask', String(i + 1));
        items.push({
          index: i + 1,
          title: (h.innerText || '').trim(),
          actionText: (link.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 80),
          href: link.getAttribute('href') || '',
          tag: link.tagName,
          rawText,
          hasSuccessIcon,
          hasEmptyCircle,
          hasLockIcon,
          disabled
        });
      }
      return items;
    });

    return (rawItems || []).map(item => {
      const progress = parseQuestProgress(item.rawText);
      const kind = classifyQuestAction(item);
      const completed = isQuestSubtaskCompleted(item);
      const locked = item.disabled || item.hasLockIcon;
      return {
        ...item,
        progress,
        kind,
        completed,
        locked,
        key: questSubtaskKey({
          href: item.href,
          title: item.title,
          actionText: item.actionText,
          kind
        })
      };
    });
  }

  /**
   * 执行一个打孔卡子任务。
   *
   * 搜索类动作必须真正提交一次 Bing 搜索；外部浏览类动作只做安全的停留和滚动。
   * 函数不判断是否完成，完成与否统一由调用方回读页面进度决定。
   */
  async executeQuestSubtaskAction(context, page, quest, target, accName = '') {
    const beforeUrl = String(page.url() || '');
    const popupPromise = context.waitForEvent('page', { timeout: 7000 }).catch(() => null);
    let clicked = false;
    try {
      await page.click(`[data-msr-subtask="${target.index}"]`, { timeout: 8000 });
      clicked = true;
    } catch (e) {
      if (target.href && /^https?:\/\//i.test(target.href)) {
        const fallback = await context.newPage().catch(() => null);
        if (fallback) {
          await fallback.goto(target.href, { waitUntil: 'domcontentloaded', timeout: 25000 }).catch(() => {});
          await this.delay(rewardsApi.randomRange(2500, 4500));
          await fallback.close().catch(() => {});
          clicked = true;
        }
      }
      if (!clicked) throw e;
    }

    const popup = await Promise.race([popupPromise, this.delay(2500).then(() => null)]);
    let landingPage = popup || null;
    if (!landingPage) {
      const afterUrl = String(page.url() || '');
      if (afterUrl !== beforeUrl) landingPage = page;
    }
    if (landingPage) {
      await landingPage.waitForLoadState('domcontentloaded', { timeout: 20000 }).catch(() => {});
      await this.delay(rewardsApi.randomRange(1500, 2500));
    }

    let searchResult = null;
    if (target.kind === 'search') {
      let searchPage = landingPage;
      const landingUrl = String(searchPage?.url?.() || '');
      const isBing = /^https?:\/\/(?:[^/]+\.)?bing\.com\//i.test(landingUrl);
      if (!searchPage || !isBing) {
        searchPage = await this.createPage(context);
        await searchPage.goto('https://cn.bing.com', { waitUntil: 'domcontentloaded', timeout: 25000 });
        await this.delay(1200);
      }
      const query = await rewardsApi.getHotSearchWord();
      searchResult = await this.performHumanSearch(searchPage, {
        query,
        navigateHome: false,
        allowExistingQuery: true,
        logAccountName: accName
      });
      await this.delay(rewardsApi.randomRange(5000, 8000));
      if (searchPage !== page && !searchPage.isClosed?.()) {
        await searchPage.close().catch(() => {});
      }
    } else if (landingPage) {
      await landingPage.mouse.wheel(0, rewardsApi.randomRange(350, 800)).catch(() => {});
      await this.delay(rewardsApi.randomRange(3500, 6000));
      if (landingPage !== page && !landingPage.isClosed?.()) {
        await landingPage.close().catch(() => {});
      }
    } else {
      await this.delay(rewardsApi.randomRange(2500, 4000));
    }

    // 回到打孔卡页面，等待官网写入状态后再由调用方扫描。
    await page.goto(quest.url, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    await this.delay(rewardsApi.randomRange(2500, 4500));
    return { searchResult };
  }

  /**
   * 完成任务区打孔卡 (Quest Punch Card)
   *
   * 这类任务（如「十月必看五大亮点」、「A 50-point Halloween treat」）
   * 包含激活按钮、多日搜索、立即可做的专题页面浏览或测验。
   * 机制重构：
   * 1. 自动识别页面内的「Activate quest（激活活动）」站内按钮，无需外链跳转；
   * 2. 循环遍历该打孔卡内「所有已解锁且尚未完成」的子活动，依序逐个完成；
   * 3. 避免以往因第一个子任务未满额（如 5 天打卡）而死锁拦截后续可用子任务的问题。
   */
  async runQuestPunchCards(acc, quests = []) {
    const accName = acc?.name || '当前账号';
    const pending = (quests || []).filter(q => q && !q.done);
    if (pending.length === 0) return { attempted: 0, completed: 0, details: [], subtaskUpdates: {} };

    let attempted = 0;
    let completed = 0;
    const completedSteps = [];
    const subtaskUpdates = {};

    try {
      this.shouldStop = false;
      const { context } = await this.launchBrowser(acc);
      const page = await this.createPage(context);
      this.page = page;

      for (const quest of pending) {
        if (this.shouldStop) break;

        const questName = quest.title || quest.questId || '任务打孔卡';
        this.updateState({
          status: 'navigating',
          lastAction: `正在检查任务打孔卡「${questName}」...`
        });

        try {
          await page.goto(quest.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
          await this.delay(2500);
          const pageTitle = (await page.title().catch(() => '')) || questName;
          const displayName = pageTitle.replace(/\s*[–-]\s*Microsoft Rewards\s*$/i, '').trim() || questName;

          const runtimeState = quest.runtimeState && typeof quest.runtimeState === 'object'
            ? quest.runtimeState
            : {};
          const attemptedThisRun = new Set();
          let roundAttempted = 0;

          while (!this.shouldStop && roundAttempted < 20) {
            const subtasks = await this.scanQuestSubtasks(page);
            const progressScoreBefore = subtasks.reduce((sum, item) => sum + Number(item.progress?.progress || 0), 0);
            const target = subtasks.find(item => {
              if (item.completed || item.locked) return false;
              if (attemptedThisRun.has(item.key)) return false;
              if (isQuestSubtaskCoolingDown(runtimeState[item.key])) return false;
              return true;
            });

            if (!target) {
              if (roundAttempted === 0) {
                logger.log('💤', `打孔卡「${displayName}」当前无待做任务、已全部完成或在冷却中，跳过`, '', accName);
              }
              break;
            }

            roundAttempted++;
            attempted++;
            attemptedThisRun.add(target.key);
            const stepLabel = target.title || target.actionText || `第 ${target.index} 项`;
            const progressBefore = target.progress?.progress ?? null;
            logger.log(
              '🧩',
              `执行打孔卡「${displayName}」子任务 [${target.index}]: ${stepLabel} (${target.actionText}, ${target.kind})`,
              '',
              accName
            );
            this.updateState({
              status: 'dwelling',
              lastAction: `正在完成打孔卡子任务: ${stepLabel}`
            });

            let actionResult = {};
            try {
              actionResult = await this.executeQuestSubtaskAction(context, page, quest, target, accName);
            } catch (e) {
              logger.log('🟡', `打孔卡子任务操作失败: ${stepLabel}：${e.message}`, '', accName);
            }

            // 回读页面后再判断，点击/新标签页本身不算完成。
            const afterSubtasks = await this.scanQuestSubtasks(page);
            const afterTarget = afterSubtasks.find(item => item.key === target.key)
              || afterSubtasks.find(item => item.title === target.title && item.kind === target.kind);
            const progressScoreAfter = afterSubtasks.reduce((sum, item) => sum + Number(item.progress?.progress || 0), 0);
            const progressAfter = afterTarget?.progress?.progress ?? (progressScoreAfter > progressScoreBefore ? progressScoreAfter : null);
            const advanced = !!afterTarget && (
              afterTarget.completed
              || (progressBefore !== null && progressAfter !== null && progressAfter > progressBefore)
            ) || progressScoreAfter > progressScoreBefore;
            const activated = target.kind === 'activate' && !!afterTarget && afterTarget.kind !== 'activate';
            const daily = isDailyQuestSubtask(target);
            const cooldownMs = advanced
              ? (daily ? 24 * 60 * 60 * 1000 : 0)
              : (target.kind === 'search' ? 24 * 60 * 60 * 1000 : (target.kind === 'visit' ? 2 * 60 * 60 * 1000 : 6 * 60 * 60 * 1000));
            const result = advanced ? 'advanced' : (activated ? 'activated' : 'no-change');
            subtaskUpdates[target.key] = buildQuestSubtaskUpdate({
              previous: runtimeState[target.key] || null,
              result,
              progressBefore,
              progressAfter,
              cooldownMs
            });

            if (advanced) {
              completed++;
              completedSteps.push({
                questId: quest.questId,
                title: displayName,
                stepName: stepLabel,
                at: Date.now(),
                progressAfter,
                kind: target.kind,
                verified: true
              });
              logger.log('✅', `打孔卡「${displayName}」子任务官网已确认: ${stepLabel}`, '', accName);
            } else if (activated) {
              logger.log('✅', `打孔卡「${displayName}」已激活，继续检查是否出现搜索任务`, '', accName);
            } else {
              logger.log(
                '🟡',
                `打孔卡「${displayName}」子任务已尝试但官网未变化，已进入冷却: ${stepLabel}`,
                '',
                accName
              );
            }

            await this.delay(rewardsApi.randomRange(1500, 3000));
          }
        } catch (e) {
          logger.log('🟡', `打孔卡「${questName}」处理失败: ${e.message}`, '', accName);
        }
      }

      await this.commitBrowserSession();
      await this.closeBrowser();
    } catch (e) {
      logger.log('🔴', `打孔卡任务流程异常: ${e.message}`, '', accName);
      await this.closeBrowser();
    }

    return { attempted, completed, details: completedSteps, subtaskUpdates };
  }

  /**
   * 打开 rewards.bing.com/dashboard 领取待领取的额外积分
   */
  async claimDashboardPoints(acc) {
    const accName = acc?.name || '当前账号';
    const execPath = this.getExecutablePath();
    if (!execPath) return 0;

    let claimed = 0;
    try {
      const { context } = await this.launchBrowser(acc);
      const page = await this.createPage(context);
      await page.goto('https://rewards.bing.com/dashboard', { waitUntil: 'domcontentloaded', timeout: 45000 });
      // React 页面按需渲染：等待目标按钮出现，不使用固定 3.5 秒阻塞。
      await page.locator('button, [role="button"]').filter({ hasText: /可领取|领取额外积分|领取积分|claim|collect/i }).first().waitFor({ state: 'visible', timeout: 12000 }).catch(() => {});

      // 必须精确锁定 button，不能使用 div:has-text，否则会命中最外层的整个页面根 div 导致点击无效
      const cardBtn = page.locator('button, [role="button"]').filter({ hasText: /可领取|领取额外积分|领取积分|claim|collect/i }).first();
      if ((await cardBtn.count()) > 0) {
        const text = await cardBtn.innerText().catch(() => '');
        const m = text.match(/(?:可领取|领取积分|claim|collect)[\s\S]*?(\d+)/i) || text.match(/(\d+)/);
        const pts = m ? parseInt(m[1], 10) : 0;
        if (pts > 0) {
          logger.log('🎁', `账号 [${accName}] 发现 ${pts} 点待领取积分，正在触发自动领取...`, '', accName);
          await cardBtn.scrollIntoViewIfNeeded().catch(() => {});
          await cardBtn.click({ timeout: 6000 });

          let hasMore = true;
          let rounds = 0;
          while (hasMore && rounds < 5) {
            rounds++;
            const confirmBtn = page.locator('div[role="dialog"] button, div[role="dialog"] [role="button"], button').filter({ hasText: /领取积分|确认领取|立即领取|claim|collect/i }).first();
            if ((await confirmBtn.count()) > 0 && await confirmBtn.isVisible().catch(() => false)) {
              await confirmBtn.click({ timeout: 5000 }).catch(() => {});
              const successText = page.locator('text=/已领取|领取成功|已完成|claimed|collected/i').first();
              const hidden = cardBtn.waitFor({ state: 'hidden', timeout: 7000 }).catch(() => {});
              const success = successText.waitFor({ state: 'visible', timeout: 7000 }).catch(() => {});
              await Promise.race([hidden, success]);
              const afterText = await cardBtn.innerText().catch(() => '');
              const bodyText = await page.locator('body').innerText().catch(() => '');
              if (/已领取|领取成功|已完成|claimed|collected/i.test(`${afterText} ${bodyText}`) || !(await cardBtn.isVisible().catch(() => true))) {
                claimed = pts;
              } else if (rounds < 2) {
                // 微软偶尔丢掉第一次点击，短暂退避后只重试一次，避免反复触发风控。
                await this.delay(800);
                await cardBtn.click({ timeout: 5000 }).catch(() => {});
              }
            } else {
              hasMore = false;
            }
          }
          if (claimed > 0) {
            logger.log('🎉', `账号 [${accName}] 成功领取待领积分 +${claimed} 分！`, '', accName);
          }
        }
      }
      await this.commitBrowserSession();
      await this.closeBrowser();
    } catch (e) {
      logger.log('🟡', `账号 [${accName}] 领取待领积分异常: ${e.message}`, '', accName);
      await this.closeBrowser();
    }
    return claimed;
  }
}

export const browserManager = new BrowserManager();
export default browserManager;
