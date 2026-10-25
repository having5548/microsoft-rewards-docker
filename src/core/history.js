import fs from 'fs';
import path from 'path';
import { DATA_DIR, writeFileAtomic } from '../fsUtil.js';

const HISTORY_FILE = path.join(DATA_DIR, 'history.json');

class HistoryManager {
  constructor() {
    // 内存缓存 + 延迟落盘：旧实现每次 saveStats 都会把 history.json
    // 全量读改写「账号数 + 1」次，一次账号执行有 30+ 次 saveStats，
    // 在 NAS 上会造成明显的无谓磁盘写入。
    this.cache = null;
    this.dirty = false;
    this.flushTimer = null;
    this.ensureFile();
  }

  ensureFile() {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    if (!fs.existsSync(HISTORY_FILE)) {
      fs.writeFileSync(HISTORY_FILE, JSON.stringify({ accounts: {}, global: {} }, null, 2), 'utf-8');
    }
  }

  load() {
    if (this.cache) return this.cache;
    try {
      this.ensureFile();
      const raw = fs.readFileSync(HISTORY_FILE, 'utf-8');
      const data = JSON.parse(raw);
      if (!data.accounts || typeof data.accounts !== 'object') {
        data.accounts = {};
      }
      if (!data.global || typeof data.global !== 'object') {
        data.global = {};
      }
      this.cache = data;
      return this.cache;
    } catch {
      this.cache = { accounts: {}, global: {} };
      return this.cache;
    }
  }

  save(data) {
    try {
      this.ensureFile();
      writeFileAtomic(HISTORY_FILE, JSON.stringify(data, null, 2), { encoding: 'utf-8', mode: 0o600 });
      this.dirty = false;
    } catch (e) {
      console.error('[History] 保存历史记录失败:', e.message);
    }
  }

  /** 标记有改动，延迟合并落盘（默认 5 秒内的多次改动只写一次） */
  scheduleFlush(delayMs = 5000) {
    this.dirty = true;
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flush();
    }, delayMs);
    this.flushTimer.unref?.();
  }

  /** 立即落盘（进程退出前调用，避免丢掉最后几秒的记录） */
  flush() {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (!this.dirty || !this.cache) return;
    this.save(this.cache);
  }

  formatDate(d) {
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  getDayLabel(d) {
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${month}-${day}`;
  }

  getWeekday(d) {
    const days = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
    return days[d.getDay()];
  }

  /**
   * 读取单个账号的历史，并修复旧版本在当天后续同步时写坏的 0。
   *
   * 修复只在「原记录为 0，且余额相对上一条有效记录确实增长」时进行；
   * 用余额差回填比用任务积分求和更准确（活动卡片积分可能包含未到账项目）。
   */
  getAccountHistory(accountId) {
    const raw = this.load().accounts?.[accountId] || {};
    const result = {};
    let previousBalance = 0;

    for (const dateStr of Object.keys(raw).sort()) {
      const rec = raw[dateStr];
      if (!rec || typeof rec !== 'object') continue;
      const balance = Number(rec.balance || 0);
      let earned = Math.max(0, Number(rec.earned || 0));
      let earnedInferred = false;

      if (earned === 0 && previousBalance > 0 && balance > previousBalance) {
        earned = balance - previousBalance;
        earnedInferred = true;
      }

      result[dateStr] = {
        ...rec,
        earned,
        ...(earnedInferred ? { earnedInferred: true } : {})
      };
      if (balance > 0) previousBalance = balance;
    }

    return result;
  }

  /** 获取指定日期之前最近一条有效余额，用于校准今日起始余额。 */
  getLatestBalanceBefore(accountId, beforeDate) {
    const raw = this.load().accounts?.[accountId] || {};
    for (const dateStr of Object.keys(raw).sort().reverse()) {
      if (dateStr >= beforeDate) continue;
      const balance = Number(raw[dateStr]?.balance || 0);
      if (balance > 0) return balance;
    }
    return 0;
  }

  /**
   * 从各账号的任务项汇总真实积分分解。
   * 旧实现按固定模板把 earned 拆成「签到10/阅读30/搜索(earned-80)/活动集30/Quiz10」，
   * 属于编造数据——历史图表悬停看到的明细与真实情况完全无关。
   */
  breakdownFromStats(statsAccounts = {}) {
    const merged = new Map();
    for (const accStat of Object.values(statsAccounts || {})) {
      for (const t of Object.values(accStat?.tasks || {})) {
        const points = Number(t?.points || 0);
        if (!t?.name || points <= 0) continue;
        const cur = merged.get(t.name) || { name: t.name, icon: t.icon || '📌', points: 0 };
        cur.points += points;
        merged.set(t.name, cur);
      }
    }
    return Array.from(merged.values()).sort((a, b) => b.points - a.points);
  }

  /**
   * 记录特定账号的当日账单
   */
  recordAccountDay(accountId, dateStr, data) {
    const history = this.load();
    if (!history.accounts[accountId]) {
      history.accounts[accountId] = {};
    }
    const previous = history.accounts[accountId][dateStr] || {};
    const incomingEarned = Math.max(0, Number(data.earned || 0));
    const incomingBalance = Number(data.balance || 0);
    const incomingBreakdown = Array.isArray(data.breakdown) ? data.breakdown : [];
    history.accounts[accountId][dateStr] = {
      date: dateStr,
      timestamp: Date.now(),
      // 今日积分只增不减，避免晚间的补偿同步用错误 0 覆盖白天已确认的积分。
      earned: Math.max(Math.max(0, Number(previous.earned || 0)), incomingEarned),
      balance: incomingBalance > 0 ? incomingBalance : Number(previous.balance || 0),
      breakdown: incomingBreakdown.length > 0
        ? incomingBreakdown
        : (Array.isArray(previous.breakdown) ? previous.breakdown : [])
    };
    this.scheduleFlush();
  }

  /**
   * 记录全局汇总账单
   */
  recordGlobalDay(dateStr, data) {
    const history = this.load();
    const previous = history.global[dateStr] || {};
    const incomingEarned = Math.max(0, Number(data.earned || 0));
    const incomingBalance = Number(data.balance || 0);
    const incomingBreakdown = Array.isArray(data.breakdown) ? data.breakdown : [];
    history.global[dateStr] = {
      date: dateStr,
      timestamp: Date.now(),
      earned: Math.max(Math.max(0, Number(previous.earned || 0)), incomingEarned),
      balance: incomingBalance > 0 ? incomingBalance : Number(previous.balance || 0),
      breakdown: incomingBreakdown.length > 0
        ? incomingBreakdown
        : (Array.isArray(previous.breakdown) ? previous.breakdown : [])
    };
    this.scheduleFlush();
  }

  /**
   * 获取历史记录（支持特定账号与全局汇总）
   */
  getHistory(days = 7, accountId = 'all', taskManagerStats = {}) {
    const history = this.load();
    const result = [];
    const now = new Date();
    const isAll = !accountId || accountId === 'all';

    // 确定当前账号或全局当前状态
    let currentBalance = 0;
    let currentEarned = 0;
    let accountHistoryMap = {};
    const statsAccounts = taskManagerStats.accounts || {};
    const accountNameOf = (id) => statsAccounts[id]?.name || id;

    if (isAll) {
      // 汇总模式的当前值必须是“各账号相加”，不能回退到旧版顶层字段（那只是主账号自己的值）
      const hasAccounts = Object.keys(statsAccounts).length > 0;
      const sumEarned = Object.values(statsAccounts).reduce((a, s) => a + Number(s?.earned || 0), 0);
      const sumBalance = Object.values(statsAccounts).reduce((a, s) => a + Number(s?.balance || 0), 0);
      currentEarned = taskManagerStats.summary?.totalEarned ?? (hasAccounts ? sumEarned : Number(taskManagerStats.earned || 0));
      currentBalance = taskManagerStats.summary?.totalBalance ?? (hasAccounts ? sumBalance : Number(taskManagerStats.balance || 0));
    } else {
      const accSt = taskManagerStats.accounts?.[accountId] || taskManagerStats;
      currentBalance = accSt.balance || 0;
      currentEarned = accSt.earned || 0;
      accountHistoryMap = this.getAccountHistory(accountId);
    }

    for (let i = days - 1; i >= 0; i--) {
      const targetDate = new Date(now.getTime() - i * 86400000);
      const dateKey = this.formatDate(targetDate);
      const dayLabel = this.getDayLabel(targetDate);
      const weekday = i === 0 ? '今天' : this.getWeekday(targetDate);

      if (isAll) {
        // 汇总模式：始终以“各账号当天记录相加”为准，并附带每个账号的明细
        let dayEarned = 0;
        let dayBalance = 0;
        let foundAny = false;
        const accountsBreakdown = [];

        for (const [accId, accHist] of Object.entries(history.accounts || {})) {
          const rec = this.getAccountHistory(accId)?.[dateKey];
          if (!rec) continue;
          const earned = Number(rec.earned || 0);
          const balance = Number(rec.balance || 0);
          dayEarned += earned;
          dayBalance += balance;
          accountsBreakdown.push({ id: accId, name: accountNameOf(accId), earned, balance });
          foundAny = true;
        }

        // 没有任何账号记录时，才退回旧版全局汇总记录
        if (!foundAny && history.global?.[dateKey]) {
          dayEarned = Number(history.global[dateKey].earned || 0);
          dayBalance = Number(history.global[dateKey].balance || 0);
          foundAny = true;
        }

        if (i === 0) {
          // 今天用各账号实时统计之和，保证与首页 Hero 数值一致
          const liveBreakdown = Object.entries(statsAccounts).map(([id, s]) => ({
            id,
            name: s?.name || accountNameOf(id),
            earned: Number(s?.earned || 0),
            balance: Number(s?.balance || 0)
          }));
          result.push({
            date: dateKey,
            dayLabel,
            weekday,
            earned: currentEarned,
            balance: currentBalance,
            accounts: liveBreakdown,
            // 今日分解用各账号任务项的真实积分汇总，不再套用固定模板
            breakdown: this.breakdownFromStats(statsAccounts)
          });
        } else if (foundAny) {
          const recordedGlobal = history.global?.[dateKey];
          result.push({
            date: dateKey,
            dayLabel,
            weekday,
            earned: dayEarned,
            balance: dayBalance,
            accounts: accountsBreakdown,
            breakdown: Array.isArray(recordedGlobal?.breakdown) ? recordedGlobal.breakdown : []
          });
        } else {
          // 没有真实记录时返回 0，不编造「预估趋势」——伪造的历史数字会误导用户
          result.push({
            date: dateKey,
            dayLabel,
            weekday,
            earned: 0,
            balance: 0,
            breakdown: []
          });
        }
      } else {
        // 单账号独立模式：只返回该账号自己的账单
        if (i === 0) {
          const recordedToday = accountHistoryMap[dateKey];
          result.push({
            date: dateKey,
            dayLabel,
            weekday,
            earned: currentEarned,
            balance: currentBalance,
            breakdown: (Array.isArray(recordedToday?.breakdown) && recordedToday.breakdown.length > 0)
              ? recordedToday.breakdown
              : this.breakdownFromStats({ [accountId]: statsAccounts[accountId] || taskManagerStats })
          });
        } else if (accountHistoryMap[dateKey]) {
          result.push({
            ...accountHistoryMap[dateKey],
            dayLabel,
            weekday
          });
        } else {
          // 没有真实记录时返回 0，不编造历史数字
          result.push({
            date: dateKey,
            dayLabel,
            weekday,
            earned: 0,
            balance: 0,
            breakdown: []
          });
        }
      }
    }

    return result;
  }
}

export const historyManager = new HistoryManager();
export default historyManager;
