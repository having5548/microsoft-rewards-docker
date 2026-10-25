import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// 项目根目录：基于模块位置推导，不依赖 process.cwd()。
// 这样即使从别的目录执行 `node /app/src/index.js`，数据目录也不会跑偏。
export const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// MSR_DATA_DIR 允许把数据目录指到别处（单测隔离用；容器里仍走默认的 /app/data）
export const DATA_DIR = process.env.MSR_DATA_DIR
  ? path.resolve(process.env.MSR_DATA_DIR)
  : path.join(PROJECT_ROOT, 'data');

/**
 * 原子写入：先写同目录下的临时文件，再 rename 覆盖目标。
 * 避免进程在写入途中被 kill 时留下被截断的 JSON（会导致配置/统计全部丢失）。
 */
export function writeFileAtomic(filePath, content, options = {}) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const tmpPath = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
  try {
    fs.writeFileSync(tmpPath, content, options);
    fs.renameSync(tmpPath, filePath);
  } catch (e) {
    try {
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    } catch {}
    throw e;
  }
}

/**
 * 给一个可能永远不返回的 Promise 加硬超时。
 * 用于浏览器 context.close() 这类在进程卡死时可能永久挂起的操作。
 */
export function withTimeout(promise, timeoutMs, message = '操作超时') {
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), Math.max(1, Number(timeoutMs) || 1));
    timer.unref?.();
  });
  return Promise.race([Promise.resolve(promise), timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}
