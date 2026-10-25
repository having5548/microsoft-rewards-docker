import fs from 'fs';
import path from 'path';

const CHROMIUM_CANDIDATES = [
  // Linux (Debian/Ubuntu/Alpine)
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  // macOS
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  // Windows：新版本 Edge 装在 Program Files (x86)\Microsoft\Edge\Application，
  // 旧版本（以及部分离线安装包）在 "Microsoft Edge\Application"，两个都要覆盖，
  // 否则 Windows 上会误报「未检测到浏览器内核」。
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files (x86)\\Microsoft Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'
];

/** 用户级安装位置（Chrome 默认装在 %LOCALAPPDATA%，而不是 Program Files） */
function userLocalCandidates(env = process.env) {
  const list = [];
  if (env.LOCALAPPDATA) {
    list.push(path.join(env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe'));
    list.push(path.join(env.LOCALAPPDATA, 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
  }
  return list;
}

/**
 * Find an installed Chromium-family browser without downloading Playwright's
 * bundled Chromium. Docker pins CHROMIUM_PATH, while desktop installs use the
 * first known Edge/Chrome location.
 */
export function findChromiumExecutable(env = process.env) {
  const configured = String(env.CHROMIUM_PATH || '').trim();
  if (configured && fs.existsSync(configured)) return configured;
  const candidates = [...CHROMIUM_CANDIDATES, ...userLocalCandidates(env)];
  return candidates.find(candidate => {
    try {
      return fs.existsSync(candidate);
    } catch {
      return false;
    }
  }) || null;
}
