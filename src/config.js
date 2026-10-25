import fs from 'fs';
import path from 'path';
import { DATA_DIR, writeFileAtomic } from './fsUtil.js';
import { removeBrowserSession } from './core/browserSession.js';
import { webIdentityKey } from './core/accountIdentity.js';
import { normalizeProxyUrl, safeProxyId } from './core/proxy.js';
import { analyzeCookie } from './core/cookieAssistant.js';
import { RUN_HOURS, buildTimeSlot, normalizeRunHours } from './core/scheduleWindow.js';

const CONFIG_FILE = path.join(DATA_DIR, 'config.json');

// GET /api/config 不再向前端下发凭据明文；前端保存时回传该占位符表示「保持不变」
export const SECRET_PLACEHOLDER = '__MSR_SECRET_KEEP__';
export const SECRET_CLEAR = '__MSR_SECRET_CLEAR__';
const SECRET_ACCOUNT_FIELDS = ['cookie', 'authCodeUrl', 'refreshToken', 'accessToken'];

const DEFAULT_CONFIG = {
  accounts: [
    {
      id: 'acc_1',
      name: '默认账号',
      order: 1,
      enabled: true,
      cookie: '',
      authCodeUrl: '',
      refreshToken: '',
      accessToken: '',
      tokenTime: 0,
      webIdentityKey: '',
      credentialUpdatedAt: 0,
      identityChangedAt: 0,
      proxyMode: 'direct',
      proxyId: '',
      runHours: [9],
      timeSlot: {
        startHour: 9,
        endHour: 10,
        randomDelayMin: 10,
        durationHours: 1
      },
      authDiagnosis: null
    }
  ],
  account: {
    cookie: '',
    authCodeUrl: '',
    refreshToken: '',
    accessToken: '',
    tokenTime: 0
  },
  network: {
    useProxy: false,
    proxyUrl: '',
    proxies: [],
    defaultProxyId: '',
    lockRegion: true
  },
  tasks: {
    sign: true,
    read: true,
    search: true,
    promos: true,
    desktopApp: true,
    dailySet: true,
    searchIntervalSec: 60,  // 全局搜索节奏：每次搜索基础间隔（秒）
    searchJitterSec: 60,    // 全局搜索节奏：每次随机浮动（秒，只会延后）
    searchStagnantLimit: 5, // 停滞保护：连续多少次搜索官网进度不涨就主动停手
    searchApi: 'baidu.official', // 'offline' | 'baidu.official' | 'hot.nntool.cc' | 'hot.cnxiaobai.com'
    searchEngineMode: 'browser', // 'browser' (Playwright 真机拟人) | 'http' (轻量HTTP)
    accountGapSec: 180, // 多账号自动化连续执行时的安全隔离间隔（秒，默认 180 秒即 3 分钟）
    keepRunning: true // 全部完成后，手动再次执行时是否仍完整跑一遍（定时任务每账号每天只排一次）
  },
  schedule: {
    enabled: true,
    cron: '*/25 * * * *'
  },
  notify: {
    wework: '',
    dingding: '',
    feishu: '',
    pushme: '',
    bark: '',
    telegram: {
      botToken: '',
      chatId: ''
    },
    // QQ 机器人（官方 OpenAPI v2）：AppID + AppSecret + 目标 OpenID
    qqBot: {
      appId: '',
      clientSecret: '',
      openidType: 'group', // group=群聊 group_openid | user=私聊 user_openid | channel=频道 channel_id
      openid: ''
    }
  },
  ui: {
    theme: 'dark'
  },
  visual: {
    bgEnabled: true,
    bgStyle: 'grainient',
    colorTheme: 'aurora',
    bgSpeed: 1.0,
    bgNoise: 25,
    mouseTurbulence: 100,
    cardOpacity: 65,
    cardBlur: 20,
    borderGlow: 100,
    liquidSheen: 100,
    mouseFollow: true,
    rimSpread: 34,
    cardTilt: true
  },
  server: {
    port: 5308,
    authPassword: ''
  }
};

class ConfigManager {
  constructor() {
    this.config = null;
    this.ensureDataDir();
    this.load();
  }

  ensureDataDir() {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
  }

  extractUserNameFromCookie(cookie = '') {
    if (!cookie) return '';
    // 尝试从 WLS=C=...&N=<URL 编码后的用户名> 提取用户名
    const wlsMatch = cookie.match(/WLS=[^;]*?N=([^;&]+)/i);
    if (wlsMatch) {
      try {
        return decodeURIComponent(wlsMatch[1]);
      } catch {}
    }
    return '';
  }

  load() {
    try {
      if (fs.existsSync(CONFIG_FILE)) {
        const raw = fs.readFileSync(CONFIG_FILE, 'utf-8');
        const parsed = JSON.parse(raw);
        this.config = this.mergeDeep(structuredClone(DEFAULT_CONFIG), parsed);
        // 平滑迁移旧版单账号数据到 accounts 列表
        this.migrateLegacyAccount(parsed);
        // 旧版只有一套 proxyUrl；新版使用可增删的代理节点列表
        this.migrateProxySettings();
        // 旧版默认时段（6-10 / 10-14 / 14-18 / 18-22）迁移到新默认时段
        this.migrateTimeSlots();
        this.migrateRunHours();
        this.migrateSearchRhythm();
      } else {
        this.config = structuredClone(DEFAULT_CONFIG);
        this.save();
      }
    } catch (e) {
      console.error('[Config] 读取配置文件失败，将使用默认配置:', e.message);
      this.config = structuredClone(DEFAULT_CONFIG);
    }
    return this.config;
  }

  getDefaultTimeSlot(index = 0) {
    return buildTimeSlot(this.getDefaultRunHours(index));
  }

  getDefaultRunHours(index = 0) {
    return [RUN_HOURS[index % RUN_HOURS.length]];
  }

  migrateLegacyAccount(parsed) {
    if (!Array.isArray(parsed.accounts) || parsed.accounts.length === 0) {
      const legacy = parsed.account || {};
      const extractedName = this.extractUserNameFromCookie(legacy.cookie);
      this.config.accounts = [
        {
          id: 'acc_1',
          name: extractedName ? `主账号 (${extractedName})` : '主账号',
          enabled: true,
          cookie: legacy.cookie || '',
          authCodeUrl: legacy.authCodeUrl || '',
          refreshToken: legacy.refreshToken || '',
          accessToken: legacy.accessToken || '',
          tokenTime: legacy.tokenTime || 0,
          timeSlot: this.getDefaultTimeSlot(0)
        }
      ];
      this.save();
    } else {
      this.config.accounts = parsed.accounts.map((acc, i) => ({
        ...acc,
        timeSlot: acc.timeSlot || this.getDefaultTimeSlot(i)
      }));
    }

    // 同步第一个账号到 config.account 以保持向后兼容
    if (this.config.accounts.length > 0) {
      const first = this.config.accounts[0];
      this.config.account = {
        cookie: first.cookie || '',
        authCodeUrl: first.authCodeUrl || '',
        refreshToken: first.refreshToken || '',
        accessToken: first.accessToken || '',
        tokenTime: first.tokenTime || 0
      };
    }
  }

  /**
   * 把旧版默认时段迁移到新版默认时段（9-13 / 13-17 / 17-21 / 21-次日01）。
   * 只迁移「仍是旧默认值」的账号；用户手动设置过的自定义时段保持原样，
   * 避免升级后把用户有意配置的作息覆盖掉。
   */
  migrateTimeSlots() {
    const LEGACY_DEFAULTS = new Map([
      ['6-10', { startHour: 9, endHour: 13 }],
      ['10-14', { startHour: 13, endHour: 17 }],
      ['14-18', { startHour: 17, endHour: 21 }],
      ['18-22', { startHour: 21, endHour: 1 }]
    ]);
    if (!Array.isArray(this.config.accounts)) return;

    let changed = false;
    for (const acc of this.config.accounts) {
      const slot = acc?.timeSlot;
      if (!slot || slot.startHour === undefined) continue;
      const next = LEGACY_DEFAULTS.get(`${Number(slot.startHour)}-${Number(slot.endHour)}`);
      if (!next) continue;
      acc.timeSlot = {
        ...slot,
        startHour: next.startHour,
        endHour: next.endHour
      };
      changed = true;
    }
    if (changed) this.save();
  }

  /**
   * v1.8.3 起每个账号使用 9:00-22:00 的 14 个一小时档位。
   * 旧版四小时窗口取其开始小时作为默认档位。
   */
  migrateRunHours() {
    let changed = false;
    (this.config.accounts || []).forEach((acc, index) => {
      const legacyHour = Number(acc.timeSlot?.startHour);
      const fallbackHour = RUN_HOURS.includes(legacyHour)
        ? legacyHour
        : this.getDefaultRunHours(index)[0];
      const runHours = normalizeRunHours(acc.runHours, [fallbackHour]);
      const timeSlot = buildTimeSlot(runHours);
      if (JSON.stringify(acc.runHours) !== JSON.stringify(runHours)) {
        acc.runHours = runHours;
        changed = true;
      }
      if (JSON.stringify(acc.timeSlot) !== JSON.stringify(timeSlot)) {
        acc.timeSlot = timeSlot;
        changed = true;
      }
    });
    if (changed) this.save();
  }

  migrateSearchRhythm() {
    const tasks = this.config.tasks;
    if (!tasks) return;
    if (Number(tasks.searchIntervalSec) === 180 && Number(tasks.searchJitterSec) === 30) {
      tasks.searchIntervalSec = 60;
      tasks.searchJitterSec = 60;
      this.save();
    }
  }

  normalizeProxyRecords(records = [], existingRecords = []) {
    if (!Array.isArray(records)) throw new Error('代理配置格式无效');
    if (records.length > 20) throw new Error('最多保存 20 套代理配置');

    const existingById = new Map(
      (Array.isArray(existingRecords) ? existingRecords : [])
        .filter(item => item?.id)
        .map(item => [item.id, item])
    );
    const usedIds = new Set();

    return records.map((item, index) => {
      const source = item && typeof item === 'object' ? item : {};
      const url = normalizeProxyUrl(source.url || source.proxyUrl || '');
      if (!url) throw new Error(`第 ${index + 1} 套代理缺少地址`);

      let id = safeProxyId(source.id);
      if (!id || usedIds.has(id)) {
        const existing = existingById.get(source.id);
        id = safeProxyId(existing?.id) || `proxy_${Date.now()}_${index}_${Math.random().toString(36).slice(2, 7)}`;
      }
      while (usedIds.has(id)) {
        id = `proxy_${Date.now()}_${index}_${Math.random().toString(36).slice(2, 7)}`;
      }
      usedIds.add(id);

      return {
        id,
        name: String(source.name || `代理 ${index + 1}`).trim().slice(0, 60) || `代理 ${index + 1}`,
        url
      };
    });
  }

  /**
   * 把旧版单代理配置迁移为代理列表，并补齐账号的代理策略字段。
   * 该方法可重复执行，不改变用户已选择的代理。
   */
  migrateProxySettings() {
    if (!this.config.network || typeof this.config.network !== 'object') {
      this.config.network = {};
    }
    const network = this.config.network;
    const before = JSON.stringify({
      proxies: network.proxies,
      defaultProxyId: network.defaultProxyId,
      proxyUrl: network.proxyUrl,
      accounts: (this.config.accounts || []).map(acc => [acc.proxyMode, acc.proxyId])
    });

    let proxies = [];
    if (Array.isArray(network.proxies) && network.proxies.length > 0) {
      try {
        proxies = this.normalizeProxyRecords(network.proxies, network.proxies);
      } catch (e) {
        console.error('[Config] 代理配置迁移失败，将忽略无效节点:', e.message);
      }
    }

    if (proxies.length === 0 && network.proxyUrl) {
      try {
        proxies = [{
          id: 'proxy_legacy',
          name: '原有代理',
          url: normalizeProxyUrl(network.proxyUrl)
        }];
      } catch {}
    }

    network.proxies = proxies;
    if (!proxies.some(item => item.id === network.defaultProxyId)) {
      network.defaultProxyId = proxies[0]?.id || '';
    }
    const defaultProxy = proxies.find(item => item.id === network.defaultProxyId) || null;
    network.proxyUrl = defaultProxy?.url || '';
    if (!defaultProxy) network.useProxy = false;

    for (const acc of this.config.accounts || []) {
      const mode = ['inherit', 'direct', 'proxy'].includes(acc.proxyMode)
        ? acc.proxyMode
        : (acc.proxyId ? 'proxy' : 'direct');
      acc.proxyMode = mode;
      acc.proxyId = mode === 'proxy' && proxies.some(item => item.id === acc.proxyId)
        ? acc.proxyId
        : '';
      if (mode === 'proxy' && !acc.proxyId) acc.proxyMode = 'direct';
    }

    const after = JSON.stringify({
      proxies: network.proxies,
      defaultProxyId: network.defaultProxyId,
      proxyUrl: network.proxyUrl,
      accounts: (this.config.accounts || []).map(acc => [acc.proxyMode, acc.proxyId])
    });
    if (before !== after) this.save();
  }

  getProxies() {
    this.migrateProxySettings();
    return this.get().network?.proxies || [];
  }

  findProxy(proxyId) {
    if (!proxyId) return null;
    return this.getProxies().find(item => item.id === proxyId) || null;
  }

  getDefaultProxy() {
    this.migrateProxySettings();
    const network = this.get().network || {};
    return this.findProxy(network.defaultProxyId);
  }

  getAccountProxyMode(acc) {
    if (['inherit', 'direct', 'proxy'].includes(acc?.proxyMode)) return acc.proxyMode;
    return acc?.proxyId ? 'proxy' : 'direct';
  }

  /**
   * 返回账号最终生效的代理。指定代理缺失时按直连处理，绝不静默回退到全局，
   * 避免用户以为账号 A 走了专用节点，实际却共用默认出口。
   */
  getEffectiveProxy(acc) {
    const mode = this.getAccountProxyMode(acc);
    if (mode === 'direct') return null;
    if (mode === 'proxy') return this.findProxy(acc?.proxyId);
    const network = this.get().network || {};
    if (!network.useProxy) return null;
    return this.getDefaultProxy();
  }

  setNetworkProxyConfig(data = {}) {
    const network = this.get().network || (this.get().network = {});
    const proxies = this.normalizeProxyRecords(data.proxies || [], network.proxies || []);
    const defaultProxyId = proxies.some(item => item.id === data.defaultProxyId)
      ? data.defaultProxyId
      : (proxies[0]?.id || '');
    const defaultProxy = proxies.find(item => item.id === defaultProxyId) || null;

    network.proxies = proxies;
    network.defaultProxyId = defaultProxyId;
    network.proxyUrl = defaultProxy?.url || '';
    network.useProxy = data.useProxy === undefined ? !!network.useProxy : data.useProxy === true;
    if (!defaultProxy) network.useProxy = false;
    if (data.lockRegion !== undefined) network.lockRegion = data.lockRegion !== false;

    for (const acc of this.config.accounts || []) {
      if (acc.proxyMode === 'proxy' && !proxies.some(item => item.id === acc.proxyId)) {
        acc.proxyMode = 'direct';
        acc.proxyId = '';
      }
    }

    this.save();
    return { network: this.get().network, accounts: this.get().accounts };
  }

  save() {
    try {
      this.ensureDataDir();
      // 保持 config.account 与 accounts[0] 同步
      if (Array.isArray(this.config.accounts) && this.config.accounts.length > 0) {
        const first = this.config.accounts[0];
        this.config.account = {
          cookie: first.cookie || '',
          authCodeUrl: first.authCodeUrl || '',
          refreshToken: first.refreshToken || '',
          accessToken: first.accessToken || '',
          tokenTime: first.tokenTime || 0
        };
      }
      // 原子写入 + 权限收紧（配置里含明文 Cookie / Refresh Token）
      writeFileAtomic(CONFIG_FILE, JSON.stringify(this.config, null, 2), { encoding: 'utf-8', mode: 0o600 });
      try {
        fs.chmodSync(CONFIG_FILE, 0o600);
      } catch {}
      return true;
    } catch (e) {
      console.error('[Config] 保存配置文件失败:', e.message);
      return false;
    }
  }

  get() {
    if (!this.config) {
      this.load();
    }
    return this.config;
  }

  getAccounts() {
    const cfg = this.get();
    const list = cfg.accounts || [];
    return list.slice().sort((a, b) => {
      const orderA = Number.isFinite(Number(a.order)) ? Number(a.order) : 999;
      const orderB = Number.isFinite(Number(b.order)) ? Number(b.order) : 999;
      return orderA - orderB;
    });
  }

  getAccount(accountId) {
    const accounts = this.getAccounts();
    if (!accountId) return accounts[0] || null;
    return accounts.find(a => a.id === accountId) || accounts[0] || null;
  }

  /**
   * 精确查找账号，找不到返回 null。
   * 注意：getAccount() 在 id 不存在时会回退到第一个账号，写入类操作必须用这个方法，
   * 否则一个不存在的 id 会静默改到第一个账号上（历史 bug：配置向导换 Token 覆盖主账号）。
   */
  findAccount(accountId) {
    if (!accountId) return null;
    return this.getAccounts().find(a => a.id === accountId) || null;
  }

  /**
   * 解析账号：不传 id 时返回第一个账号（兼容单账号调用），
   * 传了 id 则必须精确命中，否则返回 null。
   * 所有「按 id 操作某个账号」的地方都应该用这个，而不是 getAccount()。
   */
  resolveAccount(accountId) {
    if (!accountId) return this.getAccounts()[0] || null;
    return this.findAccount(accountId);
  }

  applyCredentialMetadata(acc, existing = null, options = {}) {
    if (!acc || typeof acc !== 'object') return acc;
    const now = Math.max(
      Date.now(),
      Number(existing?.credentialUpdatedAt || 0) + 1,
      Number(existing?.identityChangedAt || 0) + 1
    );
    const previousCookie = existing?.cookie || '';
    const previousKey = existing?.webIdentityKey || webIdentityKey(previousCookie);
    const nextKey = webIdentityKey(acc.cookie || '');
    const cookieChanged = !!existing && String(acc.cookie || '') !== String(previousCookie);
    const tokenChanged = !!existing && (
      String(acc.refreshToken || '') !== String(existing.refreshToken || '')
      || String(acc.authCodeUrl || '') !== String(existing.authCodeUrl || '')
    );
    const credentialChanged = !existing || cookieChanged || tokenChanged;

    acc.webIdentityKey = nextKey;
    acc.credentialUpdatedAt = options.preserveDiagnosis === true
      ? Number(existing?.credentialUpdatedAt || 0)
      : (credentialChanged ? now : Number(existing?.credentialUpdatedAt || 0));
    acc.identityChangedAt = Number(existing?.identityChangedAt || 0);
    if (existing && cookieChanged && previousKey !== nextKey) {
      acc.identityChangedAt = now;
    }

    if (options.preserveDiagnosis === true) {
      acc.authDiagnosis = existing?.authDiagnosis || null;
    } else if (credentialChanged) {
      // 新 Cookie/Token 尚未完成配对校验，不能沿用旧凭据的“有效”结论。
      acc.authDiagnosis = null;
    } else {
      acc.authDiagnosis = existing?.authDiagnosis || null;
    }
    return acc;
  }

  /**
   * 规范化账号 Cookie 再落库。
   *
   * 目的：把用户各种粘贴形态（完整串 / JSON 导出 / Safari 表格 / 只贴了 `_U` 的值）
   * 统一成标准 Cookie 串，并在能安全推导时补上 `_U`。
   * 解析失败（比如只贴了一个 token 值）时**原样保留**用户输入，绝不静默丢弃 ——
   * 诊断信息由 /api/auth/prepare-cookie 与账号体检负责告知。
   */
  normalizeAccountCookie(cookieRaw, existingCookie = '') {
    if (typeof cookieRaw !== 'string' || !cookieRaw) return { cookie: cookieRaw || '', analysis: null };
    if (cookieRaw === SECRET_PLACEHOLDER || cookieRaw === SECRET_CLEAR) {
      return { cookie: cookieRaw, analysis: null };
    }
    const analysis = analyzeCookie(cookieRaw, { existingCookie });
    return { cookie: analysis.cookie || cookieRaw, analysis };
  }

  upsertAccount(accountData) {
    const cfg = this.get();
    if (!Array.isArray(cfg.accounts)) cfg.accounts = [];

    const id = accountData.id || `acc_${Date.now()}`;
    const idx = cfg.accounts.findIndex(a => a.id === id);
    const preserveDiagnosis = accountData.preserveDiagnosis === true;

    // 如果没有填名字但有 cookie，尝试提取名字
    let name = accountData.name;
    if (!name && accountData.cookie) {
      const extracted = this.extractUserNameFromCookie(accountData.cookie);
      name = extracted ? `账号 (${extracted})` : `账号 ${cfg.accounts.length + 1}`;
    }

    if (idx !== -1) {
      const existing = cfg.accounts[idx];
      const legacyHour = Number(accountData.timeSlot?.startHour);
      const requestedHours = accountData.runHours !== undefined
        ? accountData.runHours
        : (RUN_HOURS.includes(legacyHour) ? [legacyHour] : existing.runHours);
      const runHours = normalizeRunHours(requestedHours, this.getDefaultRunHours(idx));
      const timeSlot = buildTimeSlot(runHours);
      const order = accountData.order !== undefined ? Number(accountData.order) : (existing.order || idx + 1);
      const mergedSecrets = { ...accountData };
      for (const field of SECRET_ACCOUNT_FIELDS) {
        if (mergedSecrets[field] === SECRET_CLEAR || mergedSecrets[field] === null) {
          mergedSecrets[field] = '';
        } else if (mergedSecrets[field] === SECRET_PLACEHOLDER || mergedSecrets[field] === '') {
          mergedSecrets[field] = existing[field] || '';
        }
        delete mergedSecrets[`has${field.charAt(0).toUpperCase()}${field.slice(1)}`];
      }
      const updatedAccount = {
        ...existing,
        ...mergedSecrets,
        name: name || existing.name,
        order,
        runHours,
        timeSlot
      };
      delete updatedAccount.preserveDiagnosis;
      // Cookie 先规范化再算凭据指纹：否则「只贴了 _U」这类输入会算出错误的身份指纹
      const normalized = this.normalizeAccountCookie(updatedAccount.cookie, existing.cookie || '');
      updatedAccount.cookie = normalized.cookie;
      this.applyCredentialMetadata(updatedAccount, existing, { preserveDiagnosis });
      cfg.accounts[idx] = updatedAccount;
      if (cfg.accounts[idx].enabled === false) {
        if (!cfg.accounts[idx].pausedAt) cfg.accounts[idx].pausedAt = Date.now();
      } else {
        delete cfg.accounts[idx].pausedAt;
      }
    } else {
      const newIdx = cfg.accounts.length;
      const legacyHour = Number(accountData.timeSlot?.startHour);
      const requestedHours = accountData.runHours !== undefined
        ? accountData.runHours
        : (RUN_HOURS.includes(legacyHour) ? [legacyHour] : this.getDefaultRunHours(newIdx));
      const runHours = normalizeRunHours(requestedHours, this.getDefaultRunHours(newIdx));
      const timeSlot = buildTimeSlot(runHours);
      const order = accountData.order !== undefined ? Number(accountData.order) : (newIdx + 1);
      const newAccount = {
        id,
        name: name || `账号 ${newIdx + 1}`,
        order,
        enabled: accountData.enabled !== false,
        pausedAt: accountData.enabled === false ? Date.now() : undefined,
        cookie: accountData.cookie || '',
        authCodeUrl: accountData.authCodeUrl || '',
        refreshToken: accountData.refreshToken || '',
        accessToken: accountData.accessToken || '',
        tokenTime: accountData.tokenTime || 0,
        proxyMode: ['inherit', 'direct', 'proxy'].includes(accountData.proxyMode) ? accountData.proxyMode : 'direct',
        proxyId: accountData.proxyMode === 'proxy' ? (accountData.proxyId || '') : '',
        runHours,
        timeSlot,
        authDiagnosis: accountData.authDiagnosis || null
      };
      const normalized = this.normalizeAccountCookie(newAccount.cookie, '');
      newAccount.cookie = normalized.cookie;
      this.applyCredentialMetadata(newAccount, null);
      cfg.accounts.push(newAccount);
    }

    this.save();
    return this.getAccount(id);
  }

  /**
   * 暂停/恢复账号。
   *
   * 暂停只改变自动执行开关，绝不清理 Cookie、Token、统计或浏览器会话。
   * 手动体检与手动刷新进度由调用方显式允许，不属于这里的自动执行范围。
   */
  setAccountEnabled(accountId, enabled) {
    const acc = this.findAccount(accountId);
    if (!acc) return null;
    acc.enabled = !!enabled;
    if (acc.enabled) {
      delete acc.pausedAt;
    } else {
      acc.pausedAt = Date.now();
    }
    this.save();
    return acc;
  }

  deleteAccount(accountId) {
    const cfg = this.get();
    if (!Array.isArray(cfg.accounts)) return false;
    if (cfg.accounts.length <= 1) {
      throw new Error('至少需要保留一个账号');
    }
    const before = cfg.accounts.length;
    cfg.accounts = cfg.accounts.filter(a => a.id !== accountId);
    if (cfg.accounts.length === before) return false;
    // 账号被删掉后，它的浏览器会话（含登录 Cookie）不应该继续留在磁盘上
    removeBrowserSession(accountId);
    this.save();
    return true;
  }

  update(partial) {
    if (!this.config) {
      this.load();
    }

    // 先深拷贝：mergeDeep 会改写传入对象，直接操作会把 express 的 req.body 也改掉
    const patch = structuredClone(partial || {});

    // 如果更新的是单账号字段 account，同步更新到第一个账号或指定账号
    if (patch.account && Array.isArray(this.config.accounts) && this.config.accounts.length > 0) {
      const targetId = patch.accountId || this.config.accounts[0].id;
      const idx = this.config.accounts.findIndex(a => a.id === targetId);
      if (idx !== -1) {
        Object.assign(this.config.accounts[idx], patch.account);
      }
    }

    if (Array.isArray(patch.accounts)) {
      if (patch.accounts.length === 0) {
        // 保护：前端 currentConfig 未加载完成时会上报空数组，
        // 直接覆盖会把所有账号连同 Cookie/Token 一起清空。
        console.error('[Config] 拒绝空的 accounts 更新，已保留原有账号');
      } else {
        // 前端拿到的是脱敏后的账号列表，回传占位符时保留服务端原值
        this.config.accounts = patch.accounts.map((acc, idx) => {
          const existing = this.config.accounts.find(a => a.id === acc.id) || this.config.accounts[idx] || {};
          const merged = { ...acc };
          for (const field of SECRET_ACCOUNT_FIELDS) {
            if (merged[field] === SECRET_CLEAR || merged[field] === null) {
              merged[field] = '';
            } else if (merged[field] === SECRET_PLACEHOLDER || merged[field] === '') {
              // 占位符或空值都视为「未改动」：前端不会拿到明文，也就不可能回传明文
              merged[field] = existing[field] || '';
            }
            // 去掉 getPublicConfig() 附加的 hasXxx 派生标记，避免污染落盘配置
            delete merged[`has${field.charAt(0).toUpperCase()}${field.slice(1)}`];
          }
          const legacyHour = Number(merged.timeSlot?.startHour);
          const fallbackHours = RUN_HOURS.includes(legacyHour)
            ? [legacyHour]
            : this.getDefaultRunHours(idx);
          merged.runHours = normalizeRunHours(merged.runHours, fallbackHours);
          merged.timeSlot = buildTimeSlot(merged.runHours);
          const normalized = this.normalizeAccountCookie(merged.cookie, existing.cookie || '');
          merged.cookie = normalized.cookie;
          this.applyCredentialMetadata(merged, existing);
          if (merged.enabled === false) {
            if (!merged.pausedAt) merged.pausedAt = Date.now();
          } else {
            delete merged.pausedAt;
          }
          return merged;
        });
      }
      delete patch.accounts;
    }

    this.config = this.mergeDeep(this.config, patch);
    if (patch.network && !Array.isArray(patch.network.proxies) && patch.network.proxyUrl) {
      // 配置向导仍提交单地址；将其写入默认节点，但保留配置中心里的其他节点。
      const network = this.config.network;
      const existingDefault = (network.proxies || []).find(item => item.id === network.defaultProxyId);
      const url = normalizeProxyUrl(patch.network.proxyUrl);
      const target = existingDefault || { id: `proxy_${Date.now()}`, name: '向导代理' };
      target.url = url;
      network.proxies = [
        ...(network.proxies || []).filter(item => item.id !== target.id),
        target
      ];
      network.defaultProxyId = target.id;
    }
    this.migrateProxySettings();
    this.save();
    return this.config;
  }

  /**
   * 保存一次账号体检结果（供账号卡片展示有效/失效与上次检测时间）
   */
  recordAuthDiagnosis(accountId, diagnosis) {
    const acc = this.findAccount(accountId);
    if (!acc) return null;
    acc.authDiagnosis = {
      checkedAt: Date.now(),
      credentialUpdatedAt: Number(acc.credentialUpdatedAt || 0),
      webIdentityKey: acc.webIdentityKey || '',
      cookieValid: !!diagnosis.cookieValid,
      tokenValid: !!diagnosis.tokenValid,
      overallValid: !!diagnosis.overallValid,
      warning: !!diagnosis.warning,
      warningMessage: diagnosis.warningMessage || '',
      balance: Number(diagnosis.balance || 0),
      cookieMessage: diagnosis.cookieMessage || '',
      tokenMessage: diagnosis.tokenMessage || ''
    };
    this.save();
    return acc.authDiagnosis;
  }

  /**
   * 生成用于下发到前端的脱敏配置（凭据替换为占位符，但保留是否有值的标记）
   */
  getPublicConfig() {
    const cfg = structuredClone(this.get());
    if (Array.isArray(cfg.accounts)) {
      cfg.accounts = cfg.accounts.map(acc => {
        for (const field of SECRET_ACCOUNT_FIELDS) {
          acc[`has${field.charAt(0).toUpperCase()}${field.slice(1)}`] = !!acc[field];
          acc[field] = acc[field] ? SECRET_PLACEHOLDER : '';
        }
        return acc;
      });
    }
    if (cfg.account && typeof cfg.account === 'object') {
      for (const field of SECRET_ACCOUNT_FIELDS) {
        cfg.account[field] = cfg.account[field] ? SECRET_PLACEHOLDER : '';
      }
    }
    return cfg;
  }

  mergeDeep(target, source) {
    if (!source || typeof source !== 'object') return target;
    for (const key of Object.keys(source)) {
      if (source[key] instanceof Object && !Array.isArray(source[key]) && key in target) {
        Object.assign(source[key], this.mergeDeep(target[key], source[key]));
      }
    }
    Object.assign(target || {}, source);
    return target;
  }
}

export const configManager = new ConfigManager();
export default configManager;
