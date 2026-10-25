/**
 * 判断打孔卡子任务是否已经完成。
 *
 * 不能只看文案：例如“开始搜索”的描述里会写“(1/5 天已完成)”，
 * 但子任务本身仍未完成。页面的成功图标 / 空圆圈才是可靠状态。
 */
export function isQuestSubtaskCompleted({ hasSuccessIcon = false, hasEmptyCircle = false, rawText = '' } = {}) {
  if (hasSuccessIcon) return true;
  if (hasEmptyCircle) return false;
  return /(^|\n)\s*(已完成|Complete|Completed)\s*($|\n)/i.test(String(rawText || ''));
}

/**
 * 从子任务文案中提取形如 1/5、3 / 8 的进度。
 * 只用于展示和动作后对比，不能据此推断整个子任务已经完成。
 */
export function parseQuestProgress(text = '') {
  const match = String(text || '').match(/(\d+)\s*\/\s*(\d+)/);
  if (!match) return null;
  const progress = Number(match[1]);
  const max = Number(match[2]);
  if (!Number.isFinite(progress) || !Number.isFinite(max) || max <= 0) return null;
  return { progress, max, done: progress >= max };
}

/**
 * 打孔卡子任务动作分类。
 *
 * 判断顺序很重要：同一个卡片可能同时出现“Bing”和“继续搜索”，
 * 必须优先识别为搜索动作，才能在点击后真正提交一次搜索。
 */
export function classifyQuestAction({ title = '', actionText = '', rawText = '' } = {}) {
  const titleText = String(title || '');
  const action = String(actionText || '');
  const all = `${titleText}\n${action}\n${rawText || ''}`;
  if (/activate|激活/i.test(`${action}\n${titleText}`)) return 'activate';
  if (/搜索|search|bing/i.test(`${action}\n${titleText}`)) return 'search';
  if (/测验|答题|quiz|trivia|question/i.test(`${action}\n${titleText}`)) return 'quiz';
  if (/观看|了解|试用|探索|查看|打开|watch|visit|try|explore|learn/i.test(`${action}\n${titleText}`)) return 'visit';
  if (/领取|reward|redeem|claim/i.test(`${action}\n${titleText}`)) return 'reward';
  return 'unknown';
}

function normalizeKeyPart(value = '') {
  return String(value || '').trim().replace(/\s+/g, ' ').slice(0, 160);
}

/**
 * 子任务稳定键：优先 href，其次标题 + 动作文案。
 * 不使用 DOM 序号，避免页面重排后把冷却状态套到别的任务上。
 */
export function questSubtaskKey({ href = '', title = '', actionText = '', kind = 'unknown' } = {}) {
  const hrefPart = normalizeKeyPart(href);
  if (hrefPart) return `${kind}|href:${hrefPart}`;
  return `${kind}|text:${normalizeKeyPart(title)}|${normalizeKeyPart(actionText)}`;
}

export function isDailyQuestSubtask({ kind = '', rawText = '' } = {}) {
  if (kind === 'search') return true;
  return /24\s*小时|每天|每日|daily|streak|连续/i.test(String(rawText || ''));
}

export function isQuestSubtaskCoolingDown(state, now = Date.now()) {
  const until = Number(state?.cooldownUntil || 0);
  return Number.isFinite(until) && until > now;
}

export function buildQuestSubtaskUpdate({
  previous = null,
  result = 'no-change',
  progressBefore = null,
  progressAfter = null,
  now = Date.now(),
  cooldownMs = 0
} = {}) {
  return {
    ...(previous && typeof previous === 'object' ? previous : {}),
    lastAttemptAt: now,
    lastResult: result,
    lastProgressBefore: progressBefore,
    lastProgressAfter: progressAfter,
    lastVerifiedAt: result === 'advanced' ? now : (previous?.lastVerifiedAt || 0),
    cooldownUntil: cooldownMs > 0 ? now + cooldownMs : 0,
    attempts: Math.max(0, Number(previous?.attempts || 0)) + 1
  };
}
