import fs from 'fs';
import path from 'path';
import cron from 'node-cron';
import configManager from './config.js';
import logger from './logger.js';
import taskManager from './core/taskManager.js';
import { DATA_DIR, writeFileAtomic } from './fsUtil.js';
import {
  MAX_START_DELAY_MINUTES,
  RUN_HOURS,
  RUN_WINDOW_MINUTES,
  normalizeRunHours,
  selectRunHour
} from './core/scheduleWindow.js';

const PLAN_FILE = path.join(DATA_DIR, 'schedule_plan.json');
const PLAN_VERSION = 2;

class Scheduler {
  constructor() {
    this.job = null;
    this.plannedDailyRuns = {};
    this.loadPlans();
  }

  loadPlans() {
    try {
      if (fs.existsSync(PLAN_FILE)) {
        const raw = fs.readFileSync(PLAN_FILE, 'utf-8');
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') {
          this.plannedDailyRuns = parsed;
        }
      }
    } catch {}
  }

  savePlans() {
    try {
      writeFileAtomic(PLAN_FILE, JSON.stringify(this.plannedDailyRuns, null, 2), {
        encoding: 'utf-8',
        mode: 0o600
      });
    } catch {}
  }

  getTodayNum() {
    const d = new Date();
    return Number(`${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`);
  }

  /**
   * 当前时刻距离窗口起点的分钟数（支持跨零点窗口，如 22:00 - 02:00）。
   * 返回值 < 0 表示还没进入窗口。
   */
  minutesIntoWindow(startMin, wraps, nowMin) {
    return wraps
      ? (nowMin >= startMin ? nowMin - startMin : 1440 - startMin + nowMin)
      : (nowMin - startMin);
  }

  initTodayPlan() {
    const today = this.getTodayNum();
    this.ensureDayPlans(today, true);

    // 只清理历史日期，保留今天与预排的明天
    const todayKey = String(today);
    for (const key of Object.keys(this.plannedDailyRuns)) {
      if (key < todayKey) delete this.plannedDailyRuns[key];
    }
    this.savePlans();
  }

  /**
   * 为指定日期生成各账号的当日计划（已存在则跳过）。
   * isToday=true 时，若当前已在窗口内则把偏移推到「现在之后」，避免中途启动立刻开跑。
   */
  ensureDayPlans(dateNum, isToday) {
    const key = String(dateNum);
    if (!this.plannedDailyRuns[key]) {
      this.plannedDailyRuns[key] = {};
    }
    const plans = this.plannedDailyRuns[key];
    const now = new Date();
    const nowMin = now.getHours() * 60 + now.getMinutes();

    const accounts = configManager.getAccounts().filter(a => a.enabled !== false);
    for (let i = 0; i < accounts.length; i++) {
      const acc = accounts[i];
      const existingPlan = plans[acc.id];
      if (existingPlan?.version === PLAN_VERSION) continue;
      if (existingPlan?.executed === true) {
        existingPlan.version = PLAN_VERSION;
        continue;
      }
      if (existingPlan) delete plans[acc.id];

      const runHours = normalizeRunHours(acc.runHours, configManager.getDefaultRunHours(i));
      const selected = selectRunHour(runHours, { isToday, nowMin });
      const startMin = selected.hour * 60;
      const endMin = startMin + RUN_WINDOW_MINUTES;
      const offset = selected.expired
        ? 0
        : Math.floor(Math.random() * (MAX_START_DELAY_MINUTES + 1));

      plans[acc.id] = {
        version: PLAN_VERSION,
        runHour: selected.hour,
        startMin,
        endMin,
        wraps: false,
        windowLength: RUN_WINDOW_MINUTES,
        offset,
        expired: selected.expired,
        executed: false
      };
    }
    this.savePlans();
  }

  /** 日期编号（YYYYMMDD）偏移若干天 */
  shiftDateNum(dateNum, deltaDays) {
    const d = new Date(
      Math.floor(dateNum / 10000),
      Math.floor((dateNum % 10000) / 100) - 1,
      dateNum % 100,
      12, 0, 0, 0
    );
    d.setDate(d.getDate() + deltaDays);
    return Number(`${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`);
  }

  /** 某天计划的绝对执行时间戳（窗口起点日 + 偏移分钟） */
  planTimestamp(dateNum, plan, baseDayOffset = 0) {
    const base = new Date(
      Math.floor(dateNum / 10000),
      Math.floor((dateNum % 10000) / 100) - 1,
      dateNum % 100
    );
    if (baseDayOffset) base.setDate(base.getDate() + baseDayOffset);
    return base.getTime() + (plan.startMin + plan.offset) * 60000;
  }

  /**
   * 供 WebUI 展示：每个账号距下次自动执行的倒计时。
   * 返回 { [accountId]: { status, minutesUntil, nextRunAt, windowStart, windowEnd } }
   * status: scheduled(已排定) / imminent(即将启动)
   *         / no-credential(未配凭据) / disabled(账号停用) / schedule-off(定时关闭)
   */
  getNextRunInfo() {
    const cfg = configManager.get();
    const scheduleEnabled = cfg.schedule?.enabled !== false;
    const today = this.getTodayNum();
    const tomorrow = this.shiftDateNum(today, 1);

    if (scheduleEnabled) {
      this.initTodayPlan();
      // 预排明天：这样「今日已完成」的账号也能给出确切的下次执行倒计时
      this.ensureDayPlans(tomorrow, false);
    }

    const now = new Date();
    const nowMin = now.getHours() * 60 + now.getMinutes();
    const todayPlans = this.plannedDailyRuns[String(today)] || {};
    const tomorrowPlans = this.plannedDailyRuns[String(tomorrow)] || {};
    const fmt = (m) => `${String(Math.floor((((m % 1440) + 1440) % 1440) / 60)).padStart(2, '0')}:${String(((m % 60) + 60) % 60).padStart(2, '0')}`;
    const result = {};

    configManager.getAccounts().forEach((acc, index) => {
      const runHours = normalizeRunHours(acc.runHours, configManager.getDefaultRunHours(index));
      const firstRunHour = runHours[0];
      const info = {
        status: 'unknown',
        minutesUntil: null,
        nextRunAt: null,
        windowStart: fmt(firstRunHour * 60),
        windowEnd: fmt((firstRunHour + 1) * 60)
      };

      if (acc.enabled === false) {
        info.status = 'disabled';
      } else if (!acc.cookie && !acc.refreshToken) {
        info.status = 'no-credential';
      } else if (!scheduleEnabled) {
        info.status = 'schedule-off';
      } else {
        const todayPlan = todayPlans[acc.id];
        const tomorrowPlan = tomorrowPlans[acc.id];
        let nextAt = null;

        if (todayPlan && !todayPlan.executed && !todayPlan.expired) {
          const plannedAt = this.planTimestamp(today, todayPlan, 0);
          if (plannedAt > now.getTime()) {
            nextAt = plannedAt;
          } else {
            const nowOffset = this.minutesIntoWindow(todayPlan.startMin, todayPlan.wraps, nowMin);
            const inWindow = nowOffset >= 0 && nowOffset < todayPlan.windowLength;
            if (inWindow) nextAt = now.getTime(); // 窗口内，调度器下一分钟启动
          }
        }
        if (nextAt === null && tomorrowPlan) {
          nextAt = this.planTimestamp(tomorrow, tomorrowPlan, 0);
        }

        const displayPlan = (todayPlan && !todayPlan.expired) ? todayPlan : tomorrowPlan;
        if (displayPlan) {
          info.windowStart = fmt(displayPlan.startMin);
          info.windowEnd = fmt(displayPlan.endMin);
        }

        if (nextAt !== null) {
          info.nextRunAt = nextAt;
          info.minutesUntil = Math.max(0, Math.round((nextAt - now.getTime()) / 60000));
          info.status = info.minutesUntil <= 0 ? 'imminent' : 'scheduled';
        }
      }
      result[acc.id] = info;
    });

    return result;
  }

  start() {
    this.stop();
    const cfg = configManager.get();
    if (!cfg.schedule?.enabled) {
      logger.log('⏸️', '后台自动定时巡检当前已禁用');
      return;
    }

    // 每分钟检查一次拟人化时段调度
    this.job = cron.schedule('* * * * *', async () => {
      if (taskManager.running) return;

      const today = this.getTodayNum();
      this.initTodayPlan();

      const now = new Date();
      const nowMin = now.getHours() * 60 + now.getMinutes();
      const todayPlans = this.plannedDailyRuns[today] || {};

      const accounts = configManager.getAccounts().filter(a => a.enabled !== false);
      for (const acc of accounts) {
        if (!acc.cookie && !acc.refreshToken) continue;

        const plan = todayPlans[acc.id];
        if (!plan || plan.executed || plan.expired) continue;

        // 距离窗口起点的分钟数（跨零点窗口也能正确计算）
        const nowOffset = this.minutesIntoWindow(plan.startMin, plan.wraps, nowMin);

        const inWindow = nowOffset >= 0 && nowOffset < plan.windowLength;
        if (inWindow && nowOffset >= plan.offset) {
          plan.executed = true;
          this.savePlans();
          const fmt = (m) => `${String(Math.floor((m % 1440) / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
          logger.log('⏰', `到达账号 [${acc.name}] 小时窗口 (${fmt(plan.startMin)} - ${fmt(plan.endMin)}，今日随机命中 ${fmt(plan.startMin + plan.offset)})，启动打卡...`, '', acc.name);
          try {
            await taskManager.runAll(false, acc.id);
          } catch (e) {
            logger.log('🔴', `定时任务执行异常: ${e.message}`, '', acc.name);
          }
          break; // 一次只启动一个账号，保持单队列
        }
      }
    });

    logger.log('🟢', `后台小时窗口调度引擎已就绪 (${RUN_HOURS[0]}:00-${RUN_HOURS[RUN_HOURS.length - 1] + 1}:00，共 ${RUN_HOURS.length} 个一小时档位，每档 0-${MAX_START_DELAY_MINUTES} 分钟随机启动)`);
  }

  stop() {
    if (this.job) {
      this.job.stop();
      this.job = null;
    }
  }

  restart() {
    this.start();
  }
}

export const scheduler = new Scheduler();
export default scheduler;
