/**
 * 搜索停滞保护。
 *
 * 背景：脚本会按「距离打满还差多少分」推算搜索次数。但如果当天搜索额度已经到顶，
 * 或者账号正在被限流，后面的搜索就是纯白跑——一分不加，却持续在向微软发搜索请求。
 * 这既浪费执行窗口，也是最容易把账号推向风控的行为之一。
 *
 * 判定方式：每搜完一次读一次官网真实进度，连续 N 次没有增长就认为额度已到顶，
 * 主动结束本轮搜索，未打满的额度留到下次执行。
 *
 * 官网进度是异步刷新的，偶发一次读不到增长属于正常现象，所以用「连续 N 次」而不是
 * 「一次没涨就停」。N 可在设置里调整（默认 5）。
 */
export const STAGNANT_LIMIT_MIN = 1;
export const STAGNANT_LIMIT_MAX = 5;
export const STAGNANT_LIMIT_DEFAULT = 5;

export function normalizeStagnantLimit(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return STAGNANT_LIMIT_DEFAULT;
  return Math.max(STAGNANT_LIMIT_MIN, Math.min(STAGNANT_LIMIT_MAX, Math.trunc(n)));
}

export class SearchStagnationGuard {
  constructor(limit = STAGNANT_LIMIT_DEFAULT) {
    this.limit = normalizeStagnantLimit(limit);
    // 观察到的最高官网进度；null 表示还没拿到过有效读数
    this.bestProgress = null;
    this.stagnantCount = 0;
  }

  /**
   * 记录一次官网进度读数。
   * 读数为空（官网没返回 / 解析失败）时不做任何判定 —— 宁可继续搜，
   * 也不能因为一次读不到数据就误判为「额度到顶」。
   *
   * @returns {{ stagnant: boolean, bestProgress: number|null, stagnantCount: number }}
   */
  observe(officialProgress) {
    const value = Number(officialProgress);
    if (!Number.isFinite(value)) {
      return { stagnant: false, bestProgress: this.bestProgress, stagnantCount: this.stagnantCount };
    }

    if (this.bestProgress === null || value > this.bestProgress) {
      this.bestProgress = value;
      this.stagnantCount = 0;
    } else {
      this.stagnantCount += 1;
    }

    return {
      stagnant: this.stagnantCount >= this.limit,
      bestProgress: this.bestProgress,
      stagnantCount: this.stagnantCount
    };
  }

  reset() {
    this.bestProgress = null;
    this.stagnantCount = 0;
  }
}
