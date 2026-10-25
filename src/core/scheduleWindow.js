export const RUN_HOURS = Array.from({ length: 14 }, (_, index) => index + 9);
export const RUN_WINDOW_MINUTES = 60;
export const MAX_START_DELAY_MINUTES = 10;

export function normalizeRunHours(value, fallback = [9]) {
  const values = Array.isArray(value) ? value : (value === undefined ? [] : [value]);
  const valid = [...new Set(values
    .map(item => Number(item))
    .filter(item => Number.isInteger(item) && RUN_HOURS.includes(item)))]
    .sort((a, b) => a - b);
  if (valid.length > 0) return valid;
  return normalizeRunHours(fallback, [9]);
}

export function buildTimeSlot(runHours) {
  const [startHour] = normalizeRunHours(runHours);
  return {
    startHour,
    endHour: (startHour + 1) % 24,
    randomDelayMin: MAX_START_DELAY_MINUTES,
    durationHours: 1
  };
}

/**
 * 每天只在最早可用的已勾选小时档启动一次。
 * 当天若已经错过该档的 10 分钟启动宽限，则顺延到下一个已勾选档位。
 */
export function selectRunHour(runHours, { isToday = false, nowMin = 0 } = {}) {
  const hours = normalizeRunHours(runHours);
  if (!isToday) return { hour: hours[0], expired: false };
  const available = hours.find(hour => nowMin <= hour * 60 + MAX_START_DELAY_MINUTES);
  if (available !== undefined) return { hour: available, expired: false };
  return { hour: hours[hours.length - 1], expired: true };
}
