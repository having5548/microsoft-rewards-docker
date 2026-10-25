// 全局状态
let currentStatus = null;
let currentConfig = null;
let eventSource = null;
let currentHistoryDays = 7;
let currentTheme = 'dark';
let selectedAccountId = 'all'; // 'all' 或具体账号 id (如 'acc_1')
let editingAccountIdInModal = null;
let editingAccountIdInQuickModal = null;
let proxyDrafts = [];
let webConfirmResolver = null;
let microsoftActionPollTimer = null;
// 登录窗口自动获取 Cookie：轮询定时器 / 目标账号 / 目标输入框
let cookieLoginPollTimer = null;
let cookieLoginAccountId = null;
let cookieLoginTargetInput = null;
let appToastTimer = null;
let actionProgressTimer = null;
let lastActionLog = '';
// 前端日志视图的起始时间：点击「清空」后只显示此后的新日志（后端日志不受影响）
let logViewSince = 0;
// 最近一次系统指标（容器 CPU/内存），供浏览器监控卡片复用
let lastSystemMetrics = null;
let diagMode = 'single';
let diagAccountId = null;
let accountsOverviewRenderSignature = '';

// 后端下发的凭据占位符：表示「已配置，内容保持隐藏」
const SECRET_PLACEHOLDER = '__MSR_SECRET_KEEP__';
const SECRET_CLEAR = '__MSR_SECRET_CLEAR__';
// Cookie 输入框统一提示：让人一眼看出要粘贴「整串 名=值; 名=值」，而不是单个值
const COOKIE_INPUT_PLACEHOLDER = '_U=xxx; MUID=yyy; RPSSecAuth=zzz; ...（完整 Cookie 串）';
let guideNetworkConfirmed = false;
let guideDraftAccount = {
  id: '',
  name: '新账号',
  order: 2,
  cookie: '',
  authCodeUrl: '',
  refreshToken: '',
  accessToken: '',
  tokenTime: 0,
  proxyMode: 'direct',
  proxyId: ''
};

document.addEventListener('DOMContentLoaded', () => {
  initTheme();
  initUIEvents();
  initInstantTooltips();
  initLiquidVisuals();
  initLiquidMouseFollower();
  startCountdownTimer();
  fetchStatus();
  fetchSystemMetrics();
  fetchBrowserStatus();
  fetchConfig();
  fetchHistory(7);
  initLogStream();
  checkVersionUpdate();
  setInterval(fetchStatus, 4000); // 4秒轮询一次任务状态
  setInterval(fetchSystemMetrics, 4000); // 4秒轮询硬件与网络延时
  setInterval(fetchBrowserStatus, 2500); // 2.5秒轮询无头浏览器状态
});

// =========================================================================
// 🎨 iOS 液态玻璃风格与 WebGL2 动态背景引擎联动
// =========================================================================

const DEFAULT_VISUAL_CONFIG = {
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
};

const THEME_ACCENT_COLORS = {
  aurora: { rgb: '250, 17, 79', secRgb: '0, 245, 212' },
  sunset: { rgb: '244, 63, 94', secRgb: '245, 158, 11' },
  ocean: { rgb: '2, 132, 199', secRgb: '6, 182, 212' },
  emerald: { rgb: '16, 185, 129', secRgb: '161, 255, 0' },
  monochrome: { rgb: '148, 163, 184', secRgb: '203, 213, 225' }
};

let currentVisualConfig = { ...DEFAULT_VISUAL_CONFIG };

function normalizeColorTheme(theme) {
  const aliases = {
    purple: 'sunset',
    amber: 'sunset',
    titanium: 'monochrome'
  };
  const normalized = aliases[theme] || theme;
  return THEME_ACCENT_COLORS[normalized] ? normalized : 'aurora';
}

function normalizeBgStyle(style) {
  const aliases = {
    fluid: 'silk',
    geometry: 'prism',
    nebula: 'veil',
    cyber: 'prism'
  };
  const normalized = aliases[style] || style;
  return ['silk', 'grainient', 'veil', 'aurora', 'prism'].includes(normalized) ? normalized : 'silk';
}

function getRewardsAppOfficialIconHtml() {
  return `<span class="rewards-app-icon-wrap" aria-hidden="true">
    <span class="rewards-app-icon-fallback">🎁</span>
    <img class="rewards-app-official-icon"
      src="https://bing.com/th?id=OMR.icon-96.png&amp;pid=Rewards"
      alt=""
      loading="lazy"
      referrerpolicy="no-referrer"
      onerror="this.style.display='none'">
  </span>`;
}

function render7DayStreakTrack(streak, fallbackDays, fallbackDone, streakTitle) {
  let completedDays = 0;
  if (streak && typeof streak.completedDays === 'number') {
    completedDays = Number(streak.completedDays || 0);
  } else if (fallbackDays) {
    completedDays = (fallbackDays % 7) || (fallbackDone ? 7 : 0);
  } else if (fallbackDone) {
    completedDays = 1;
  }
  completedDays = Math.min(7, Math.max(0, completedDays));

  const fillPercent = completedDays <= 0 ? 0 : Math.min(100, Math.round(((completedDays - 0.5) / 6.5) * 100));

  let nodesHtml = '';
  for (let d = 1; d <= 6; d++) {
    if (d < completedDays) {
      nodesHtml += `<div class="streak-step-node done-circle" data-tip="第 ${d} 天：已打卡"><span class="step-check">✓</span></div>`;
    } else if (d === completedDays) {
      nodesHtml += `<div class="streak-step-node active-pill" data-tip="第 ${d} 天：已打卡达成"><span class="step-check">✓</span><span class="step-num">${d}</span></div>`;
    } else {
      nodesHtml += `<div class="streak-step-node pending-circle" data-tip="第 ${d} 天：待打卡"></div>`;
    }
  }

  if (completedDays >= 7) {
    nodesHtml += `<div class="streak-step-node goal-pill done" data-tip="第 7 天：连续达成 100 积分大奖！"><span class="step-star">✦</span><span class="step-pts">100</span></div>`;
  } else {
    nodesHtml += `<div class="streak-step-node goal-pill pending" data-tip="第 7 天：达成额外奖励 100 积分"><span class="step-star">✦</span><span class="step-pts">100</span></div>`;
  }

  return `
    <div class="streak-7day-wrap">
      <div class="streak-7day-header">
        <span class="streak-7day-title">${escapeHtml(streakTitle)}</span>
        <span class="streak-7day-badge">已连签 ${completedDays} / 7 天</span>
      </div>
      <div class="streak-7day-rail">
        <div class="streak-7day-line"></div>
        <div class="streak-7day-line-fill" style="width: ${fillPercent}%;"></div>
        ${nodesHtml}
      </div>
    </div>
  `;
}

function renderStampsGrid(stamps) {
  const container = document.getElementById('stamps-grid-track');
  if (!container) return;
  const progress = Number(stamps?.progress || 0);
  const max = Number(stamps?.max || 12) || 12;

  const starPath = 'M12 2 L13.8 7.8 L19.5 8.5 L15.2 12.3 L16.5 18 L12 15 L7.5 18 L8.8 12.3 L4.5 8.5 L10.2 7.8 Z';

  let html = '';
  for (let i = 1; i <= max; i++) {
    const isCollected = i <= progress;
    const isGoal = i === max;
    const tip = isCollected
      ? `第 ${i} 个印章：已集齐`
      : (isGoal ? `第 ${i} 个印章：集满赢取 1,000 积分大奖！` : `第 ${i} 个印章：待集齐`);

    html += `
      <div class="stamp-grid-item ${isCollected ? 'collected' : 'uncollected'}${isGoal ? ' is-goal' : ''}" data-tip="${tip}" aria-label="${tip}">
        <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
          <path d="${starPath}" />
        </svg>
      </div>
    `;
  }
  container.innerHTML = html;
}

function renderAccountStampsList(accounts) {
  const container = document.getElementById('stamps-account-list');
  if (!container) return;
  const starPath = 'M12 2 L13.8 7.8 L19.5 8.5 L15.2 12.3 L16.5 18 L12 15 L7.5 18 L8.8 12.3 L4.5 8.5 L10.2 7.8 Z';

  container.innerHTML = (accounts || []).map(acc => {
    const stamps = acc.stamps || { progress: 0, max: 12 };
    const max = Math.max(1, Number(stamps.max || 12));
    const progress = Math.max(0, Math.min(max, Number(stamps.progress || 0)));
    const dots = Array.from({ length: max }, (_, index) => {
      const day = index + 1;
      return `<span class="mini-stamp ${day <= progress ? 'collected' : 'uncollected'}${day === max ? ' is-goal' : ''}" title="${escapeHtml(acc.name || '账号')}：第 ${day} 个印章${day <= progress ? '已集齐' : '待集齐'}">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="${starPath}"/></svg>
      </span>`;
    }).join('');

    return `
      <div class="stamp-account-row">
        <div class="stamp-account-head">
          <span class="stamp-account-name" title="${escapeHtml(acc.name || '账号')}">${escapeHtml(acc.name || '账号')}</span>
          <span class="stamp-account-count">${progress} / ${max}</span>
        </div>
        <div class="stamp-account-dots">${dots}</div>
      </div>
    `;
  }).join('') || '<div class="stamp-account-empty">暂无账号印章数据</div>';
}

function renderHeroAccountBreakdown(containerId, accounts, valueKey, formatter) {
  const container = document.getElementById(containerId);
  if (!container) return;
  container.innerHTML = (accounts || []).map(acc => {
    const value = Number(acc[valueKey] || 0);
    return `
      <div class="hero-account-row">
        <span class="hero-account-name" title="${escapeHtml(acc.name || '账号')}">${escapeHtml(acc.name || '账号')}</span>
        <span class="hero-account-value">${escapeHtml(formatter(value))}</span>
      </div>
    `;
  }).join('') || '<div class="hero-account-empty">暂无账号数据</div>';
}

function applyVisualConfig(cfg = {}) {
  currentVisualConfig = { ...DEFAULT_VISUAL_CONFIG, ...cfg };
  const v = currentVisualConfig;
  v.colorTheme = normalizeColorTheme(v.colorTheme);
  v.bgStyle = normalizeBgStyle(v.bgStyle);

  // 兼容小数格式归一化为百分比整数
  if (typeof v.cardOpacity === 'number' && v.cardOpacity > 0 && v.cardOpacity <= 1) v.cardOpacity = Math.round(v.cardOpacity * 100);
  if (typeof v.borderGlow === 'number' && v.borderGlow > 0 && v.borderGlow <= 2) v.borderGlow = Math.round(v.borderGlow * 100);
  if (typeof v.liquidSheen === 'number' && v.liquidSheen > 0 && v.liquidSheen <= 2) v.liquidSheen = Math.round(v.liquidSheen * 100);
  if (typeof v.bgNoise === 'number' && v.bgNoise > 0 && v.bgNoise <= 1) v.bgNoise = Math.round(v.bgNoise * 100);
  if (typeof v.mouseTurbulence === 'number' && v.mouseTurbulence > 0 && v.mouseTurbulence <= 2) v.mouseTurbulence = Math.round(v.mouseTurbulence * 100);

  const root = document.documentElement;
  root.style.setProperty('--glass-opacity', (v.cardOpacity / 100).toFixed(2));
  root.style.setProperty('--glass-blur', `${v.cardBlur}px`);
  root.style.setProperty('--border-glow-intensity', (v.borderGlow / 100).toFixed(2));
  root.style.setProperty('--liquid-sheen-intensity', (v.liquidSheen / 100).toFixed(2));
  root.style.setProperty('--rim-half', `${v.rimSpread}deg`);
  root.style.setProperty('--rim-q', `${(v.rimSpread * 0.35).toFixed(1)}deg`);
  root.style.setProperty('--rim-mid', `${(v.rimSpread * 0.72).toFixed(1)}deg`);
  root.style.setProperty('--rim-end', `${(v.rimSpread * 1.9).toFixed(1)}deg`);

  const palette = THEME_ACCENT_COLORS[v.colorTheme] || THEME_ACCENT_COLORS.aurora;
  root.style.setProperty('--accent-glow-rgb', palette.rgb);
  root.style.setProperty('--accent-glow-sec-rgb', palette.secRgb);

  document.body.classList.add('liquid-glass-enabled');
  document.body.classList.toggle('webgl-bg-active', !!v.bgEnabled);
  document.body.classList.toggle('mouse-follow-enabled', !!v.mouseFollow);
  document.body.classList.toggle('card-tilt-enabled', !!v.cardTilt);
  document.body.dataset.visualTheme = v.colorTheme || 'aurora';

  localStorage.setItem('msr_visual_config', JSON.stringify(v));
  enhanceGlassSurfaces();

  if (window.LiquidBg) {
    window.LiquidBg.setEnabled(!!v.bgEnabled);
    window.LiquidBg.setStyle(v.bgStyle);
    window.LiquidBg.setTheme(v.colorTheme || 'aurora');
    window.LiquidBg.setSpeed(Number(v.bgSpeed) || 1.0);
    window.LiquidBg.setNoise((Number(v.bgNoise) || 25) / 100);
    window.LiquidBg.setTurbulence((Number(v.mouseTurbulence) || 100) / 100);
  }

  syncVisualInputs(v);
}

function syncVisualInputs(v) {
  const setVal = (id, val) => { const el = document.getElementById(id); if (el) el.value = val; };
  const setChecked = (id, val) => { const el = document.getElementById(id); if (el) el.checked = !!val; };
  const setText = (id, txt) => { const el = document.getElementById(id); if (el) el.innerText = txt; };

  setVal('cfg-card-opacity', v.cardOpacity);
  setText('val-card-opacity', `${v.cardOpacity}%`);

  setVal('cfg-card-blur', v.cardBlur);
  setText('val-card-blur', `${v.cardBlur}px`);

  setVal('cfg-border-glow', v.borderGlow);
  setText('val-border-glow', `${v.borderGlow}%`);

  setVal('cfg-liquid-sheen', v.liquidSheen);
  setText('val-liquid-sheen', `${v.liquidSheen}%`);

  setVal('cfg-rim-spread', v.rimSpread);
  setText('val-rim-spread', `${v.rimSpread}°`);

  setChecked('cfg-mouse-follow', v.mouseFollow);
  setChecked('cfg-card-tilt', v.cardTilt);

  setChecked('cfg-bg-enabled', v.bgEnabled);
  setVal('cfg-bg-style', v.bgStyle);
  setVal('cfg-color-theme', v.colorTheme);

  setVal('cfg-bg-speed', v.bgSpeed);
  setText('val-bg-speed', `${Number(v.bgSpeed).toFixed(1)}x`);

  setVal('cfg-bg-noise', v.bgNoise);
  setText('val-bg-noise', `${v.bgNoise}%`);

  setVal('cfg-mouse-turb', v.mouseTurbulence);
  setText('val-mouse-turb', `${v.mouseTurbulence}%`);
}

function readVisualInputs() {
  const readNumber = (id, fallback) => {
    const value = Number(document.getElementById(id)?.value);
    return Number.isFinite(value) ? value : fallback;
  };
  return {
    cardOpacity: readNumber('cfg-card-opacity', 65),
    cardBlur: readNumber('cfg-card-blur', 20),
    borderGlow: readNumber('cfg-border-glow', 100),
    liquidSheen: readNumber('cfg-liquid-sheen', 100),
    rimSpread: readNumber('cfg-rim-spread', 34),
    mouseFollow: document.getElementById('cfg-mouse-follow')?.checked ?? true,
    cardTilt: document.getElementById('cfg-card-tilt')?.checked ?? true,
    bgEnabled: document.getElementById('cfg-bg-enabled')?.checked ?? true,
    bgStyle: normalizeBgStyle(document.getElementById('cfg-bg-style')?.value || 'silk'),
    colorTheme: normalizeColorTheme(document.getElementById('cfg-color-theme')?.value || 'aurora'),
    bgSpeed: readNumber('cfg-bg-speed', 1.0),
    bgNoise: readNumber('cfg-bg-noise', 25),
    mouseTurbulence: readNumber('cfg-mouse-turb', 100)
  };
}

function initLiquidVisuals() {
  const saved = localStorage.getItem('msr_visual_config');
  if (saved) {
    try {
      applyVisualConfig(JSON.parse(saved));
    } catch (e) {
      applyVisualConfig(DEFAULT_VISUAL_CONFIG);
    }
  } else {
    applyVisualConfig(DEFAULT_VISUAL_CONFIG);
  }

  const bindRange = (id, valId, unit, key, scale = 1) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener('input', () => {
      const v = el.value;
      const valEl = document.getElementById(valId);
      if (valEl) valEl.innerText = `${v}${unit}`;
      const patch = {};
      patch[key] = scale === 1 ? Number(v) : parseFloat(v);
      applyVisualConfig(patch);
    });
  };

  bindRange('cfg-card-opacity', 'val-card-opacity', '%', 'cardOpacity');
  bindRange('cfg-card-blur', 'val-card-blur', 'px', 'cardBlur');
  bindRange('cfg-border-glow', 'val-border-glow', '%', 'borderGlow');
  bindRange('cfg-liquid-sheen', 'val-liquid-sheen', '%', 'liquidSheen');
  bindRange('cfg-rim-spread', 'val-rim-spread', '°', 'rimSpread');
  bindRange('cfg-bg-speed', 'val-bg-speed', 'x', 'bgSpeed', 0.1);
  bindRange('cfg-bg-noise', 'val-bg-noise', '%', 'bgNoise');
  bindRange('cfg-mouse-turb', 'val-mouse-turb', '%', 'mouseTurbulence');

  const bindCheckbox = (id, key) => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('change', () => {
      const patch = {};
      patch[key] = el.checked;
      applyVisualConfig(patch);
    });
  };

  bindCheckbox('cfg-mouse-follow', 'mouseFollow');
  bindCheckbox('cfg-card-tilt', 'cardTilt');
  bindCheckbox('cfg-bg-enabled', 'bgEnabled');

  const bindSelect = (id, key) => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('change', () => {
      const patch = {};
      patch[key] = el.value;
      applyVisualConfig(patch);
    });
  };

  bindSelect('cfg-bg-style', 'bgStyle');
  bindSelect('cfg-color-theme', 'colorTheme');

  document.getElementById('btn-preset-ios')?.addEventListener('click', () => applyVisualPreset('ios-glass'));
  document.getElementById('btn-preset-aurora')?.addEventListener('click', () => applyVisualPreset('aurora-night'));
  document.getElementById('btn-preset-ocean')?.addEventListener('click', () => applyVisualPreset('deep-ocean'));
  document.getElementById('btn-preset-titanium')?.addEventListener('click', () => applyVisualPreset('matte-titanium'));
  document.getElementById('btn-reset-visual')?.addEventListener('click', () => resetVisualDefaults());
}

function applyVisualPreset(presetName) {
  let patch = {};
  if (presetName === 'ios-glass') {
    patch = {
      cardOpacity: 55,
      cardBlur: 24,
      borderGlow: 120,
      liquidSheen: 120,
      mouseFollow: true,
      rimSpread: 30,
      cardTilt: true,
      bgEnabled: true,
      bgStyle: 'silk',
      colorTheme: 'ocean',
      bgSpeed: 0.8,
      bgNoise: 20,
      mouseTurbulence: 90
    };
  } else if (presetName === 'aurora-night') {
    patch = {
      cardOpacity: 65,
      cardBlur: 20,
      borderGlow: 110,
      liquidSheen: 100,
      mouseFollow: true,
      rimSpread: 34,
      cardTilt: true,
      bgEnabled: true,
      bgStyle: 'veil',
      colorTheme: 'aurora',
      bgSpeed: 1.0,
      bgNoise: 25,
      mouseTurbulence: 100
    };
  } else if (presetName === 'deep-ocean') {
    patch = {
      cardOpacity: 60,
      cardBlur: 22,
      borderGlow: 100,
      liquidSheen: 110,
      mouseFollow: true,
      rimSpread: 42,
      cardTilt: true,
      bgEnabled: true,
      bgStyle: 'grainient',
      colorTheme: 'ocean',
      bgSpeed: 1.2,
      bgNoise: 20,
      mouseTurbulence: 130
    };
  } else if (presetName === 'matte-titanium') {
    patch = {
      cardOpacity: 75,
      cardBlur: 16,
      borderGlow: 80,
      liquidSheen: 60,
      mouseFollow: true,
      rimSpread: 26,
      cardTilt: false,
      bgEnabled: true,
      bgStyle: 'grainient',
      colorTheme: 'monochrome',
      bgSpeed: 0.5,
      bgNoise: 40,
      mouseTurbulence: 50
    };
  }
  applyVisualConfig(patch);
}

function resetVisualDefaults() {
  applyVisualConfig(DEFAULT_VISUAL_CONFIG);
}

const GLASS_SURFACE_SELECTOR = [
  '.header',
  '.account-selector-section',
  '.ms-toolbar',
  '.hero-card',
  '.section-card',
  '.task-card',
  '.account-overview-card',
  '.modal-box',
  '.diag-item-card',
  '.diag-banner',
  '.diag-summary-box',
  '.history-card',
  '.browser-metric-row',
  '.timeline-item',
  '.step-action-box'
].join(',');

function enhanceGlassSurfaces(root = document) {
  if (root?.matches?.(GLASS_SURFACE_SELECTOR)) root.classList.add('glass-surface');
  root?.querySelectorAll?.(GLASS_SURFACE_SELECTOR).forEach(el => el.classList.add('glass-surface'));
}

function initLiquidMouseFollower() {
  enhanceGlassSurfaces();
  let cards = [];
  const updateCardsList = () => {
    enhanceGlassSurfaces();
    cards = Array.from(document.querySelectorAll(GLASS_SURFACE_SELECTOR));
  };

  let observerRaf = 0;
  const observer = new MutationObserver(() => {
    if (observerRaf) return;
    observerRaf = requestAnimationFrame(() => {
      observerRaf = 0;
      updateCardsList();
    });
  });
  observer.observe(document.body, { childList: true, subtree: true });
  updateCardsList();

  let rafPending = false;
  let mouseEvent = null;

  window.addEventListener('mousemove', (e) => {
    mouseEvent = e;
    if (!rafPending) {
      rafPending = true;
      requestAnimationFrame(() => {
        rafPending = false;
        if (!mouseEvent) return;
        const mx = mouseEvent.clientX;
        const my = mouseEvent.clientY;
        const isTiltEnabled = document.body.classList.contains('card-tilt-enabled');

        for (let i = 0; i < cards.length; i++) {
          const card = cards[i];
          const rect = card.getBoundingClientRect();
          if (rect.width === 0 || rect.height === 0) continue;
          const isInside = mx >= rect.left && mx <= rect.right && my >= rect.top && my <= rect.bottom;
          if (
            mx >= rect.left - 350 &&
            mx <= rect.right + 350 &&
            my >= rect.top - 350 &&
            my <= rect.bottom + 350
          ) {
            const relX = mx - rect.left;
            const relY = my - rect.top;
            const normX = (relX / rect.width) * 2 - 1;
            const normY = (relY / rect.height) * 2 - 1;
            const pointerAngle = Math.atan2(normY, normX) * 180 / Math.PI + 90;
            const normalizedAngle = ((pointerAngle % 360) + 360) % 360;
            card.style.setProperty('--pointer-angle', `${normalizedAngle.toFixed(2)}deg`);

            if (isTiltEnabled && isInside) {
              const normX = (relX / rect.width) - 0.5;
              const normY = (relY / rect.height) - 0.5;
              const isLargeSurface = card.matches('.header, .section-card, .modal-box, .account-selector-section, .ms-toolbar');
              const strength = isLargeSurface ? 0.9 : 2.4;
              const lift = isLargeSurface ? 0 : -2;
              const tiltX = -normY * strength;
              const tiltY = normX * strength;
              card.style.transform = `perspective(1100px) rotateX(${tiltX.toFixed(2)}deg) rotateY(${tiltY.toFixed(2)}deg) translateY(${lift}px)`;
            } else if (card.style.transform) {
              card.style.transform = '';
            }
          } else if (card.style.transform) {
            card.style.transform = '';
          }
        }
      });
    }
  }, { passive: true });

  const resetCardTilt = () => {
    for (let i = 0; i < cards.length; i++) {
      cards[i].style.transform = '';
    }
  };
  document.documentElement.addEventListener('mouseleave', resetCardTilt);
  window.addEventListener('blur', resetCardTilt);
}

// 全时段固定夜间模式
function initTheme() {
  applyTheme('dark');
}

function setTheme(_theme, syncServer = false) {
  currentTheme = 'dark';
  localStorage.setItem('ms_rewards_theme', 'dark');
  applyTheme('dark');
  const selectElem = document.getElementById('cfg-ui-theme');
  if (selectElem) selectElem.value = 'dark';
  if (syncServer) {
    fetch('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ui: { theme: 'dark' } })
    }).catch(() => {});
  }
}

function applyTheme() {
  document.documentElement.setAttribute('data-theme', 'dark');
}

// 启动每日刷新剩余时间倒计时 (距离下一次 09:00:00，中国区 Rewards 刷新点)
function startCountdownTimer() {
  function updateTimer() {
    const now = new Date();
    const target = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 9, 0, 0);
    if (target.getTime() <= now.getTime()) {
      target.setDate(target.getDate() + 1);
    }
    const diff = Math.max(0, target.getTime() - now.getTime());
    const hours = String(Math.floor(diff / 3600000)).padStart(2, '0');
    const minutes = String(Math.floor((diff % 3600000) / 60000)).padStart(2, '0');
    const seconds = String(Math.floor((diff % 60000) / 1000)).padStart(2, '0');
    const timerElem = document.getElementById('countdown-timer');
    if (timerElem) {
      timerElem.innerText = `${hours}:${minutes}:${seconds}`;
    }
  }
  updateTimer();
  setInterval(updateTimer, 1000);
}

// ===== 即时悬停提示：替代浏览器原生 title（原生有约 1 秒延迟） =====
let instantTooltipEl = null;
let instantTooltipTarget = null;

function ensureInstantTooltipEl() {
  if (!instantTooltipEl) {
    instantTooltipEl = document.createElement('div');
    instantTooltipEl.className = 'instant-tooltip';
    document.body.appendChild(instantTooltipEl);
  }
  return instantTooltipEl;
}

function showInstantTooltip(target) {
  let text = target.getAttribute('data-tip');
  if (!text && target.hasAttribute('title')) {
    text = target.getAttribute('title');
    target.setAttribute('data-tip', text);
  }
  // 无论走哪条分支都摘掉原生 title，否则约 1 秒后浏览器还会弹出第二套提示
  if (target.hasAttribute('title')) target.removeAttribute('title');
  if (!text) return;

  const el = ensureInstantTooltipEl();
  el.textContent = text;
  el.classList.add('visible');

  const rect = target.getBoundingClientRect();
  const tipRect = el.getBoundingClientRect();
  const left = Math.max(12, Math.min(rect.left + rect.width / 2 - tipRect.width / 2, window.innerWidth - tipRect.width - 12));
  let top = rect.bottom + 8;
  if (top + tipRect.height > window.innerHeight - 8) {
    top = rect.top - tipRect.height - 8;
  }
  el.style.left = `${left}px`;
  el.style.top = `${Math.max(8, top)}px`;
  instantTooltipTarget = target;
}

function hideInstantTooltip() {
  if (instantTooltipEl) instantTooltipEl.classList.remove('visible');
  instantTooltipTarget = null;
}

function initInstantTooltips() {
  document.addEventListener('mouseover', (e) => {
    const target = e.target?.closest?.('[title], [data-tip]');
    if (!target || target === instantTooltipTarget) return;
    showInstantTooltip(target);
  });

  document.addEventListener('mouseout', (e) => {
    const target = e.target?.closest?.('[title], [data-tip]');
    if (!target) return;
    if (e.relatedTarget && target.contains(e.relatedTarget)) return;
    hideInstantTooltip();
  });

  window.addEventListener('scroll', hideInstantTooltip, true);
  window.addEventListener('resize', hideInstantTooltip);
}

function initUIEvents() {
  // 立即运行 & 停止 (支持全局与单账号)
  document.getElementById('btn-run')?.addEventListener('click', runTasks);
  document.getElementById('btn-stop')?.addEventListener('click', stopTasks);
  document.getElementById('btn-run-single-header')?.addEventListener('click', runTasks);
  document.getElementById('btn-toggle-account-header')?.addEventListener('click', toggleSelectedAccount);
  document.getElementById('btn-stop-single-header')?.addEventListener('click', stopTasks);

  // 版本与状态复合胶囊点击检测更新
  document.getElementById('version-status-pill')?.addEventListener('click', handleVersionCheckClick);

  // 历史记录天数切换
  document.getElementById('btn-history-7')?.addEventListener('click', () => switchHistoryDays(7));
  document.getElementById('btn-history-30')?.addEventListener('click', () => switchHistoryDays(30));

  // 顶部快捷测试账号登录
  document.getElementById('btn-check-account').addEventListener('click', () => {
    diagMode = 'single';
    diagAccountId = selectedAccountId !== 'all'
      ? selectedAccountId
      : (currentConfig?.accounts?.[0]?.id || 'acc_1');
    openModal('diag-modal');
    runAccountDiagnosis();
  });
  document.getElementById('btn-close-diag').addEventListener('click', () => closeModal('diag-modal'));
  document.getElementById('btn-confirm-diag').addEventListener('click', () => closeModal('diag-modal'));
  document.getElementById('btn-retest-diag').addEventListener('click', runAccountDiagnosis);

  // 硬件监控指标点击立即刷新
  document.getElementById('sys-metrics-pill')?.addEventListener('click', async () => {
    const pill = document.getElementById('sys-metrics-pill');
    pill?.classList.add('refreshing');
    await fetchSystemMetrics();
    setTimeout(() => pill?.classList.remove('refreshing'), 600);
  });

  // 顶部一键同步微软官网真实状态
  document.getElementById('btn-sync-status')?.addEventListener('click', async () => {
    const btn = document.getElementById('btn-sync-status');
    const origHtml = btn.innerHTML;
    btn.innerHTML = '<span>⏳</span> 同步中...';
    openActionModal('官网同步', '正在从微软官网同步真实任务完成度...', ['锁定账号上下文', '请求官网数据', '解析真实进度', '刷新看板'], 0);
    startActionProgressTicker(12, 88, 8, '正在从微软官网同步真实任务完成度...');
    try {
      const res = await fetch('/api/status/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accountId: selectedAccountId !== 'all' ? selectedAccountId : null, force: true })
      }).then(r => r.json());
      stopActionProgressTicker();
      if (res.success && res.data) {
        currentStatus = res.data;
        renderDashboard(res.data);
        if (res.skipped) {
          updateActionModal({
            progress: 100,
            badge: { text: '已跳过', cls: 'warn' },
            message: res.message || '任务正在执行中，已跳过同步',
            result: '为避免多账号上下文串台，本次同步已安全跳过。'
          });
        } else {
          updateActionModal({
            activeIndex: 4,
            progress: 100,
            badge: { text: '同步完成', cls: 'ok' },
            message: '微软官网真实状态已同步',
            result: buildMicrosoftStatusDetails(res.data)
          });
        }
      }
    } catch (e) {
      stopActionProgressTicker();
      updateActionModal({
        progress: 100,
        badge: { text: '同步异常', cls: 'err' },
        message: e.message,
        result: `同步异常：${e.message}`
      });
    } finally {
      btn.innerHTML = origHtml;
    }
  });

  // 单次安全测试搜索按钮 (真实按键输入，不触发冷冻)
  document.getElementById('btn-trigger-single-search')?.addEventListener('click', async () => {
    const btn = document.getElementById('btn-trigger-single-search');
    const origHtml = btn.innerHTML;
    btn.innerHTML = '<span>⏳</span> 搜索验证中...';
    const targetId = selectedAccountId !== 'all' ? selectedAccountId : (currentConfig?.accounts?.[0]?.id || 'acc_1');
    const targetName = currentConfig?.accounts?.find(a => a.id === targetId)?.name || targetId;
    openActionModal(
      `单次安全测搜 · ${targetName}`,
      '正在准备浏览器并执行一次拟人搜索...',
      ['准备浏览器环境', '校验账号登录态', '执行拟人键盘搜索', '同步积分与配额', '输出测试明细'],
      0
    );
    startMicrosoftActionPolling();
    try {
      const res = await fetch('/api/tasks/single-search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accountId: targetId })
      }).then(r => r.json());
      stopMicrosoftActionPolling();
      if (res.success) {
        updateActionModal({
          activeIndex: 5,
          progress: 100,
          badge: { text: '测试成功', cls: 'ok' },
          message: '单次测试搜索已完成',
          result: `账号：${targetName}\n${res.data.message || '已完成拟人按键输入与积分同步'}\n\n提示：该测试用于验证浏览器登录态与搜索通道，不会替代每日完整搜索配额。`
        });
        fetchStatus();
      } else {
        updateActionModal({
          progress: 100,
          badge: { text: '测试失败', cls: 'err' },
          message: res.message || '搜索测试失败',
          result: `失败原因：${res.message || '未知错误'}`
        });
      }
    } catch (e) {
      stopMicrosoftActionPolling();
      updateActionModal({
        progress: 100,
        badge: { text: '请求异常', cls: 'err' },
        message: e.message,
        result: `请求异常：${e.message}`
      });
    } finally {
      btn.innerHTML = origHtml;
    }
  });

  // 测试词库来源按钮
  document.getElementById('btn-test-search-api')?.addEventListener('click', handleTestSearchApi);
  document.getElementById('btn-close-words-modal')?.addEventListener('click', () => closeModal('search-words-modal'));
  document.getElementById('btn-close-words-modal-btn')?.addEventListener('click', () => closeModal('search-words-modal'));

  // 新建账号弹窗相关
  document.getElementById('btn-add-account-card')?.addEventListener('click', () => openQuickAddAccountModal());
  document.getElementById('btn-close-quick-add')?.addEventListener('click', () => closeModal('account-quick-add-modal'));
  document.getElementById('btn-cancel-quick-add')?.addEventListener('click', () => closeModal('account-quick-add-modal'));
  document.getElementById('btn-save-quick-add')?.addEventListener('click', handleQuickAddAccount);
  document.getElementById('quick-add-proxy-mode')?.addEventListener('change', () => {
    updateQuickAddProxyControls(document.getElementById('quick-add-proxy-id')?.value || '');
  });
  document.getElementById('quick-add-proxy-id')?.addEventListener('change', (e) => {
    updateQuickAddProxyControls(e.target.value);
  });

  // 通用网页确认框
  document.getElementById('btn-web-confirm-ok')?.addEventListener('click', () => resolveWebConfirm(true));
  document.getElementById('btn-web-confirm-cancel')?.addEventListener('click', () => resolveWebConfirm(false));
  document.getElementById('btn-web-confirm-close')?.addEventListener('click', () => resolveWebConfirm(false));

  // 登录窗口自动获取 Cookie（配置中心 / 新建账号 / 配置向导三处共用）
  document.querySelectorAll('.btn-cookie-login').forEach(btn => {
    btn.addEventListener('click', () => {
      openCookieLoginWindow(btn.getAttribute('data-scope') || 'settings', btn.getAttribute('data-target'));
    });
  });
  document.getElementById('btn-novnc-save-cookie')?.addEventListener('click', saveCookieFromLoginWindow);
  document.getElementById('btn-refresh-novnc')?.addEventListener('click', refreshNovncModal);
  document.getElementById('btn-close-novnc')?.addEventListener('click', () => closeCookieLoginWindow(true));
  document.getElementById('btn-close-novnc-btn')?.addEventListener('click', () => closeCookieLoginWindow(true));

  // 通用操作进度弹窗
  document.getElementById('btn-action-modal-close')?.addEventListener('click', closeActionModal);
  document.getElementById('btn-close-action-modal')?.addEventListener('click', closeActionModal);
  document.getElementById('btn-action-modal-background')?.addEventListener('click', () => {
    stopMicrosoftActionPolling();
    stopActionProgressTicker();
    closeModal('action-modal');
  });

  // 向导 Modal (默认创建全新账号，绝不覆盖已有账号)
  document.getElementById('btn-guide').addEventListener('click', openGuideModal);
  document.getElementById('btn-close-guide').addEventListener('click', () => closeModal('guide-modal'));
  document.getElementById('btn-finish-guide').addEventListener('click', () => closeModal('guide-modal'));
  document.getElementById('guide-account-proxy-mode')?.addEventListener('change', () => {
    updateGuideProxyControls(document.getElementById('guide-account-proxy-id')?.value || '');
  });
  document.getElementById('guide-account-proxy-id')?.addEventListener('change', (e) => {
    updateGuideProxyControls(e.target.value);
  });
  document.getElementById('guide-use-proxy')?.addEventListener('change', () => {
    updateGuideProxyControls(document.getElementById('guide-account-proxy-id')?.value || '');
  });
  ['guide-use-proxy', 'guide-proxy-url', 'guide-lock-region', 'guide-account-proxy-mode', 'guide-account-proxy-id'].forEach(id => {
    const el = document.getElementById(id);
    el?.addEventListener('input', () => { guideNetworkConfirmed = false; });
    el?.addEventListener('change', () => { guideNetworkConfirmed = false; });
  });
  document.getElementById('guide-btn-save-network')?.addEventListener('click', saveGuideNetworkSettings);

  // 任务清单栏的快捷编辑当前账号按钮
  document.getElementById('btn-edit-current-account-header')?.addEventListener('click', () => {
    const targetId = selectedAccountId !== 'all' ? selectedAccountId : (currentConfig?.accounts?.[0]?.id || null);
    if (targetId) openQuickAddAccountModal(targetId);
  });
  document.getElementById('btn-quick-clear-cookie')?.addEventListener('click', async () => {
    const ok = await showWebConfirm('确定要清空该账号保存的 Cookie 吗？保存后生效。', '清空 Cookie 确认');
    if (!ok) return;
    quickAddCookieCleared = true;
    const cookieInput = document.getElementById('quick-add-cookie');
    if (cookieInput) {
      cookieInput.value = '（已标记清空，保存后生效）';
      cookieInput.disabled = true;
    }
    const clearBtn = document.getElementById('btn-quick-clear-cookie');
    if (clearBtn) clearBtn.style.display = 'none';
  });

  // 任务列表标题旁的刷新当前账号进度按钮
  document.getElementById('btn-sync-current-account')?.addEventListener('click', async () => {
    const btn = document.getElementById('btn-sync-current-account');
    const origHtml = btn.innerHTML;
    btn.innerHTML = '<span>⏳</span> 同步中...';
    const targetId = selectedAccountId !== 'all' ? selectedAccountId : null;
    const targetName = targetId
      ? (currentConfig?.accounts?.find(a => a.id === targetId)?.name || targetId)
      : '全部账号汇总';
    openActionModal(
      `刷新账号进度 · ${targetName}`,
      '正在从微软官网拉取真实任务进度...',
      ['锁定账号上下文', '请求微软官网数据', '解析任务与积分', '刷新控制台看板'],
      0
    );
    startActionProgressTicker(12, 88, 8, '正在从微软官网拉取真实任务进度...');
    try {
      const res = await fetch('/api/status/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accountId: targetId, force: true })
      }).then(r => r.json());
      stopActionProgressTicker();
      if (res.success) {
        currentStatus = res.data;
        renderDashboard(res.data);
        if (res.skipped) {
          updateActionModal({
            progress: 100,
            badge: { text: '已跳过', cls: 'warn' },
            message: res.message || '任务正在执行中，已跳过同步',
            result: '为避免多账号上下文串台，本次同步已安全跳过。可等待当前任务结束后再刷新。'
          });
        } else {
          updateActionModal({
            activeIndex: 4,
            progress: 100,
            badge: { text: '同步完成', cls: 'ok' },
            message: '微软官网真实进度已同步',
            result: buildMicrosoftStatusDetails(res.data)
          });
        }
      } else {
        updateActionModal({
          progress: 100,
          badge: { text: '同步失败', cls: 'err' },
          message: res.message || '同步失败',
          result: `失败原因：${res.message || '未知错误'}`
        });
      }
    } catch (e) {
      stopActionProgressTicker();
      updateActionModal({
        progress: 100,
        badge: { text: '同步异常', cls: 'err' },
        message: e.message,
        result: `同步异常：${e.message}`
      });
    } finally {
      btn.innerHTML = origHtml;
    }
  });

  // 配置中心 Modal
  document.getElementById('btn-settings').addEventListener('click', () => {
    const saveStatus = document.getElementById('settings-save-status');
    if (saveStatus) {
      saveStatus.className = 'settings-save-status';
      saveStatus.textContent = '';
    }
    populateSettingsForm();
    openModal('settings-modal');
  });
  document.getElementById('btn-close-settings').addEventListener('click', () => closeModal('settings-modal'));
  document.getElementById('btn-cancel-settings').addEventListener('click', () => closeModal('settings-modal'));
  document.getElementById('btn-save-settings').addEventListener('click', saveSettingsFromModal);

  // 配置中心：切换账号编辑
  document.getElementById('cfg-account-select')?.addEventListener('change', (e) => {
    editingAccountIdInModal = e.target.value;
    loadAccountIntoForm(editingAccountIdInModal);
  });
  document.getElementById('btn-modal-add-acc')?.addEventListener('click', () => {
    closeModal('settings-modal');
    openQuickAddAccountModal();
  });
  document.getElementById('btn-modal-del-acc')?.addEventListener('click', handleDeleteCurrentAccountInModal);
  document.getElementById('cfg-account-proxy-mode')?.addEventListener('change', () => {
    updateAccountProxyControls(document.getElementById('cfg-account-proxy-id')?.value || '');
  });
  document.getElementById('cfg-account-proxy-id')?.addEventListener('change', (e) => {
    updateAccountProxyControls(e.target.value);
  });
  document.getElementById('cfg-use-proxy')?.addEventListener('change', () => {
    updateAccountProxyControls(document.getElementById('cfg-account-proxy-id')?.value || '');
  });
  document.getElementById('cfg-global-direct')?.addEventListener('change', () => {
    updateAccountProxyControls(document.getElementById('cfg-account-proxy-id')?.value || '');
  });
  document.getElementById('cfg-default-proxy')?.addEventListener('change', (e) => {
    const selectedId = e.target.value;
    document.querySelectorAll('#proxy-list .proxy-card').forEach(card => {
      const isDefault = card.getAttribute('data-proxy-id') === selectedId;
      card.classList.toggle('is-default', isDefault);
      const badge = card.querySelector('.proxy-default-badge');
      if (isDefault && !badge) {
        const span = document.createElement('span');
        span.className = 'proxy-default-badge';
        span.textContent = '全局默认';
        card.querySelector('.proxy-card-head')?.appendChild(span);
      } else if (!isDefault && badge) {
        badge.remove();
      }
    });
    updateAccountProxyControls(document.getElementById('cfg-account-proxy-id')?.value || '');
  });
  document.getElementById('btn-add-proxy')?.addEventListener('click', () => {
    collectProxyDraftsFromDom();
    const id = `draft_proxy_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    proxyDrafts.push({
      id,
      name: `代理 ${proxyDrafts.length + 1}`,
      url: ''
    });
    const defaultId = getDefaultProxyId() || id;
    renderProxyCards(defaultId);
    renderDefaultProxyOptions(defaultId);
    updateAccountProxyControls(document.getElementById('cfg-account-proxy-id')?.value || '');
    const newCard = document.querySelector(`#proxy-list .proxy-card[data-proxy-id="${id}"]`);
    newCard?.querySelector('[data-proxy-field="url"]')?.focus();
  });
  document.getElementById('proxy-list')?.addEventListener('input', (e) => {
    const card = e.target.closest?.('.proxy-card');
    if (!card) return;
    const id = card.getAttribute('data-proxy-id');
    const draft = proxyDrafts.find(item => item.id === id);
    if (!draft) return;
    const field = e.target.getAttribute('data-proxy-field');
    if (field === 'name' || field === 'url') draft[field] = e.target.value;
    updateAccountProxyControls(document.getElementById('cfg-account-proxy-id')?.value || '');
  });
  document.getElementById('proxy-list')?.addEventListener('click', async (e) => {
    const button = e.target.closest?.('[data-proxy-action]');
    if (!button) return;
    const card = button.closest('.proxy-card');
    const proxyId = card?.getAttribute('data-proxy-id');
    if (!proxyId) return;
    const action = button.getAttribute('data-proxy-action');
    if (action === 'test') await testProxyCard(proxyId);
    if (action === 'save') await saveProxySettingsFromCards();
    if (action === 'delete') await deleteProxyCard(proxyId);
  });

  // 向导换取 Token
  document.getElementById('guide-btn-exchange').addEventListener('click', async () => {
    const input = document.getElementById('guide-code-input').value.trim();
    const resultDiv = document.getElementById('guide-token-result');
    const proxySelection = readProxySelection('guide-account-proxy-mode', 'guide-account-proxy-id');
    if (!guideNetworkConfirmed) {
      resultDiv.innerHTML = '<span style="color:#EF4444;">请先返回第一步保存网络出口。</span>';
      return;
    }
    if (!input) {
      resultDiv.innerHTML = '<span style="color:#EF4444;">请先填入地址栏跳转后的完整 URL</span>';
      return;
    }
    resultDiv.innerHTML = '<span style="color:#38BDF8;">⏳ 正在换取并验证 Token...</span>';
    try {
      guideDraftAccount.authCodeUrl = input;
      // 同步第一步填写的名称与序号，新建账号时一并写入
      guideDraftAccount.name = document.getElementById('guide-account-name')?.value.trim() || guideDraftAccount.name;
      guideDraftAccount.order = parseInt(document.getElementById('guide-account-order')?.value, 10) || guideDraftAccount.order;
      const res = await fetch('/api/auth/exchange-code', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          urlOrCode: input,
          accountId: guideDraftAccount.id,
          name: guideDraftAccount.name,
          order: guideDraftAccount.order,
          draft: true,
          proxy: proxySelection
        })
      }).then(r => r.json());
      if (res.success) {
        guideDraftAccount.accessToken = res.data.accessToken;
        guideDraftAccount.refreshToken = res.data.refreshToken;
        guideDraftAccount.tokenTime = Date.now();
        resultDiv.innerHTML = '<span style="color:#34D399;">✅ Token 换取成功！已绑定至新账号草稿</span>';
      } else {
        resultDiv.innerHTML = `<span style="color:#EF4444;">❌ 换取失败: ${escapeHtml(res.message)}</span>`;
      }
    } catch (e) {
      resultDiv.innerHTML = `<span style="color:#EF4444;">❌ 请求异常: ${escapeHtml(e.message)}</span>`;
    }
  });

  // 向导测试 Cookie
  document.getElementById('guide-btn-test-cookie').addEventListener('click', async () => {
    const cookie = document.getElementById('guide-cookie-input').value.trim();
    const resultDiv = document.getElementById('guide-cookie-result');
    const proxySelection = readProxySelection('guide-account-proxy-mode', 'guide-account-proxy-id');
    if (!guideNetworkConfirmed) {
      resultDiv.innerHTML = '<span style="color:#EF4444;">请先返回第一步保存网络出口。</span>';
      return;
    }
    if (!cookie) {
      resultDiv.innerHTML = '<span style="color:#EF4444;">请先粘贴 Cookie</span>';
      return;
    }
    resultDiv.innerHTML = '<span style="color:#38BDF8;">⏳ 正在请求微软官网验证 Cookie...</span>';
    try {
      guideDraftAccount.cookie = cookie;
      const testRes = await fetch('/api/auth/test-cookie', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cookie, accountId: guideDraftAccount.id, proxy: proxySelection })
      }).then(r => r.json());
      if (testRes.success && testRes.data?.valid) {
        resultDiv.innerHTML = `<span style="color:#34D399;">✅ ${escapeHtml(testRes.data.message)}</span>`;
      } else {
        resultDiv.innerHTML = `<span style="color:#EF4444;">❌ ${escapeHtml(testRes.data?.message || testRes.message || 'Cookie 检测无效')}</span>`;
      }
    } catch (e) {
      resultDiv.innerHTML = `<span style="color:#EF4444;">❌ 检测请求出错: ${escapeHtml(e.message)}</span>`;
    }
  });

  // 向导测试代理与 IP
  document.getElementById('guide-btn-test-proxy').addEventListener('click', async () => {
    const target = resolveGuideProxyTestTarget();
    const resultDiv = document.getElementById('guide-proxy-result');
    if (target.error) {
      resultDiv.innerHTML = `<span style="color:#EF4444;">${escapeHtml(target.error)}</span>`;
      return;
    }
    resultDiv.innerHTML = `<span style="color:#38BDF8;">⏳ 正在检测 ${escapeHtml(target.label)} 的出口 IP 与归属地...</span>`;
    try {
      const res = await fetch('/api/proxy/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ useProxy: target.useProxy, proxyUrl: target.proxyUrl })
      }).then(r => r.json());
      if (res.success) {
        if (res.regionPass) {
          resultDiv.innerHTML = `<span style="color:#34D399;">✅ ${escapeHtml(target.label)} 检测通过，当前出口位于中国大陆 (${escapeHtml(res.region)})<br>${escapeHtml(res.ipInfo)}</span>`;
        } else {
          resultDiv.innerHTML = `<span style="color:#F59E0B;">⚠️ ${escapeHtml(target.label)} 当前出口为非大陆地区 (${escapeHtml(res.region)})！若开启国区保护任务将被自动暂停。<br>${escapeHtml(res.ipInfo)}</span>`;
        }
      } else {
        resultDiv.innerHTML = `<span style="color:#EF4444;">❌ 测试失败: ${escapeHtml(res.message)}</span>`;
      }
    } catch (e) {
      resultDiv.innerHTML = `<span style="color:#EF4444;">❌ 测试异常: ${escapeHtml(e.message)}</span>`;
    }
  });

  // 清空日志：只清空当前页面显示（设置本地时间戳过滤），
  // 后端内存日志与 data/app.log 文件均保留，新日志照常继续显示。
  document.getElementById('btn-clear-logs').addEventListener('click', () => {
    logViewSince = Date.now();
    renderLogs();
  });

  // 配置中心：一键换取/刷新 Token
  document.getElementById('btn-exchange-token')?.addEventListener('click', async () => {
    const input = document.getElementById('cfg-authcode').value.trim();
    const resDiv = document.getElementById('cfg-auth-test-result');
    if (input === SECRET_CLEAR) {
      if (resDiv) resDiv.innerHTML = '<span style="color:#F59E0B;">凭据已标记清空，请先保存配置或重新粘贴授权码后再换取 Token。</span>';
      return;
    }
    if (!input) {
      if (resDiv) resDiv.innerHTML = '<span style="color:#EF4444;">请先在输入框中粘贴包含 code= 的跳转链接</span>';
      openActionModal('缺少授权码', '请先填入包含 code 的链接或授权码。', ['填写授权码', '重新换取 Token'], 0);
      updateActionModal({ progress: 100, badge: { text: '参数缺失', cls: 'warn' } });
      return;
    }
    if (resDiv) resDiv.innerHTML = '<span style="color:#38BDF8;">⏳ 正在向微软官方请求兑换 OAuth Token...</span>';
    const targetId = editingAccountIdInModal || 'acc_1';
    const res = await fetch('/api/auth/exchange-code', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        urlOrCode: input,
        accountId: targetId,
        proxy: readProxySelection('cfg-account-proxy-mode', 'cfg-account-proxy-id')
      })
    }).then(r => r.json());
    if (res.success) {
      if (resDiv) resDiv.innerHTML = '<span style="color:#34D399;">✅ Token 换取并自动保存成功！</span>';
      const refreshEl = document.getElementById('cfg-refresh-token');
      if (refreshEl) {
        refreshEl.value = '********';
        delete refreshEl.dataset.clear;
      }
      document.getElementById('cfg-authcode').placeholder = '已配置授权码（内容已隐藏）';
      document.getElementById('cfg-authcode').value = '';
      fetchConfig();
      fetchStatus();
    } else {
      if (resDiv) resDiv.innerHTML = `<span style="color:#EF4444;">❌ 换取失败: ${escapeHtml(res.message)}</span>`;
    }
  });

  // 配置中心：单独测试已输入或已配置的 Cookie
  document.getElementById('btn-test-modal-cookie')?.addEventListener('click', async () => {
    const input = document.getElementById('cfg-cookie').value.trim();
    const resDiv = document.getElementById('cfg-cookie-test-result');
    const targetId = editingAccountIdInModal || 'acc_1';
    if (input === SECRET_CLEAR) {
      if (resDiv) resDiv.innerHTML = '<span style="color:#F59E0B;">Cookie 已标记清空，请先保存配置或重新粘贴后再测试。</span>';
      return;
    }
    if (resDiv) resDiv.innerHTML = '<span style="color:#38BDF8;">⏳ 正在请求微软官网验证 Cookie 有效性...</span>';
    try {
      const testRes = await fetch('/api/auth/test-cookie', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          cookie: input || SECRET_PLACEHOLDER,
          accountId: targetId,
          proxy: readProxySelection('cfg-account-proxy-mode', 'cfg-account-proxy-id')
        })
      }).then(r => r.json());
      if (testRes.success && testRes.data?.valid) {
        if (resDiv) resDiv.innerHTML = `<span style="color:#34D399;">✅ ${escapeHtml(testRes.data.message)}</span>`;
      } else {
        if (resDiv) resDiv.innerHTML = `<span style="color:#EF4444;">❌ ${escapeHtml(testRes.data?.message || testRes.message || 'Cookie 检测无效')}</span>`;
      }
    } catch (e) {
      if (resDiv) resDiv.innerHTML = `<span style="color:#EF4444;">❌ 检测异常: ${escapeHtml(e.message)}</span>`;
    }
  });

  // 配置中心：清空该账号保存的 Cookie
  document.getElementById('btn-clear-modal-cookie')?.addEventListener('click', async () => {
    const ok = await showWebConfirm('确定要清空该账号保存的 Cookie 吗？保存配置后生效。', '清空 Cookie');
    if (!ok) return;
    const input = document.getElementById('cfg-cookie');
    input.value = SECRET_CLEAR;
    input.placeholder = '已标记清空（点击下方保存配置后生效）';
    const resDiv = document.getElementById('cfg-cookie-test-result');
    if (resDiv) resDiv.innerHTML = '<span style="color:#F59E0B;">⚠️ 已标记清空，请点击弹窗底部「保存配置」使变更落盘</span>';
  });

  // 配置中心：清空该账号保存的授权码与 Token
  document.getElementById('btn-clear-modal-auth')?.addEventListener('click', async () => {
    const ok = await showWebConfirm('确定要清空该账号保存的移动端授权码与 Token 吗？保存配置后生效。', '清空移动端凭据');
    if (!ok) return;
    const input = document.getElementById('cfg-authcode');
    input.value = SECRET_CLEAR;
    input.placeholder = '已标记清空（点击下方保存配置后生效）';
    const refreshEl = document.getElementById('cfg-refresh-token');
    if (refreshEl) {
      refreshEl.value = '';
      refreshEl.dataset.clear = '1';
    }
    const resDiv = document.getElementById('cfg-auth-test-result');
    if (resDiv) resDiv.innerHTML = '<span style="color:#F59E0B;">⚠️ 已标记清空，请点击弹窗底部「保存配置」使变更落盘</span>';
  });

  // 全局点击关闭卡片操作菜单
  document.addEventListener('click', () => {
    document.querySelectorAll('.acc-more-dropdown.show').forEach(m => m.classList.remove('show'));
  });

  // 点击待领积分卡片一键触发领取
  document.getElementById('hero-claimable-card')?.addEventListener('click', async () => {
    const claimBtn = document.getElementById('hero-claim-btn-text');
    const origText = claimBtn ? claimBtn.innerText : '';
    if (claimBtn) claimBtn.innerText = '⏳ 领取中...';
    openActionModal('领取待领积分', '正在向微软官网提交领取请求...', ['锁定账号上下文', '提交领取请求', '刷新积分看板'], 0);
    startActionProgressTicker(15, 88, 9, '正在向微软官网提交领取请求...');
    try {
      const res = await fetch('/api/tasks/claim-points', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accountId: selectedAccountId })
      }).then(r => r.json());
      stopActionProgressTicker();
      if (res.success) {
        updateActionModal({
          activeIndex: 3,
          progress: 100,
          badge: { text: '领取完成', cls: 'ok' },
          message: res.message || '领取请求已完成',
          result: res.message || '领取请求已完成'
        });
        fetchStatus();
      } else {
        updateActionModal({
          progress: 100,
          badge: { text: '领取失败', cls: 'err' },
          message: res.message || '领取失败',
          result: `领取失败：${res.message || '未知错误'}`
        });
      }
    } catch (e) {
      stopActionProgressTicker();
      updateActionModal({
        progress: 100,
        badge: { text: '请求异常', cls: 'err' },
        message: e.message,
        result: `请求异常：${e.message}`
      });
    } finally {
      if (claimBtn) claimBtn.innerText = origText;
    }
  });

  // 配置中心：测试当前账号 (详细展示 Cookie、Code、Token 是否可用)
  document.getElementById('btn-test-account')?.addEventListener('click', async () => {
    const resultDiv = document.getElementById('test-account-result');
    resultDiv.innerHTML = '<span style="color:#38BDF8;">⏳ 正在全面测试当前账号凭据可用性...</span>';
    const targetId = editingAccountIdInModal || 'acc_1';
    const res = await fetch('/api/auth/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        accountId: targetId,
        force: true,
        proxy: readProxySelection('cfg-account-proxy-mode', 'cfg-account-proxy-id')
      })
    }).then(r => r.json());
    if (res.success) {
      const c = res.data.cookie;
      const code = res.data.code;
      const t = res.data.token;
      const net = res.data.network;
      const proxyLabel = net?.proxyUsed
        ? `代理：${escapeHtml(net?.proxy?.name || '指定代理')}`
        : '直连（未使用代理）';
      resultDiv.innerHTML = `
        <div style="background:var(--card-inner); padding:10px 14px; border-radius:10px; border:1px solid var(--border-color); display:flex; flex-direction:column; gap:8px; margin-top:8px;">
          <div><strong>1. 必应网页端 Cookie:</strong> ${c?.valid ? '<span style="color:#34D399; font-weight:700;">✅ 可用</span>' : '<span style="color:#F87171; font-weight:700;">❌ 不可用或失效</span>'} <small style="color:var(--text-sub);">(${escapeHtml(c?.message || '')})</small></div>
          <div><strong>2. 授权码链接 Code:</strong> ${code?.valid ? '<span style="color:#34D399; font-weight:700;">✅ 可用</span>' : '<span style="color:#F59E0B; font-weight:700;">⚠️ 待配置</span>'} <small style="color:var(--text-sub);">(${escapeHtml(code?.message || '')})</small></div>
          <div><strong>3. 移动端 OAuth Token:</strong> ${t?.valid ? '<span style="color:#34D399; font-weight:700;">✅ 可用</span>' : '<span style="color:#F87171; font-weight:700;">❌ 不可用或失效</span>'} <small style="color:var(--text-sub);">(${escapeHtml(t?.message || '')})</small></div>
          <div><strong>4. 当前访问 IP:</strong> <span style="color:#38BDF8; font-weight:700; font-family:ui-monospace,monospace;">${escapeHtml(net?.ip || '未知')}</span> <small style="color:var(--text-sub);">${escapeHtml(net?.location || '归属地未知')}</small></div>
          <div><strong>5. 网络出口:</strong> ${net?.regionPass ? '<span style="color:#34D399; font-weight:700;">✅ 中国大陆 (安全通过)</span>' : '<span style="color:#F59E0B; font-weight:700;">⚠️ 非大陆或地区未知</span>'} <small style="color:var(--text-sub);">${proxyLabel}</small></div>
        </div>
      `;
      fetchStatus();
    } else {
      resultDiv.innerHTML = `<span style="color:#F87171;">测试出错: ${escapeHtml(res.message || '')}</span>`;
    }
  });

  // 配置中心：测试全局默认出口（账号专用代理在各自卡片中测试）
  document.getElementById('btn-test-default-network')?.addEventListener('click', async () => {
    const drafts = collectProxyDraftsFromDom();
    const proxyId = getDefaultProxyId();
    const proxy = drafts.find(item => item.id === proxyId);
    const useProxy = isGlobalProxyEnabled();
    const resultDiv = document.getElementById('test-default-proxy-result');
    if (useProxy && !proxy?.url) {
      resultDiv.innerHTML = '<span style="color:#F59E0B;">请先添加并选择一个全局默认代理。</span>';
      return;
    }
    resultDiv.innerHTML = '<span style="color:#38BDF8;">⏳ 正在测试全局默认出口...</span>';
    const res = await fetch('/api/proxy/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ useProxy, proxyUrl: proxy?.url || '' })
    }).then(r => r.json());
    if (res.success) {
      resultDiv.innerHTML = `<div>${escapeHtml(res.ipInfo)}</div><div>地区检测: ${res.regionPass ? '✅ 通过 (' + escapeHtml(res.region) + ')' : '⚠️ 非国区 (' + escapeHtml(res.region || '未知') + ')'} · ${Number(res.latencyMs || 0)} ms</div>`;
    } else {
      resultDiv.innerHTML = `<div style="color:#EF4444;">测试失败: ${escapeHtml(res.message)}</div>`;
    }
  });

  // 配置中心 Tabs 切换
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
      btn.classList.add('active');
      const targetId = btn.getAttribute('data-tab');
      document.getElementById(targetId)?.classList.add('active');
    });
  });

  // 向导 Steps 切换
  document.querySelectorAll('.step-nav-item').forEach(item => {
    item.addEventListener('click', () => {
      const step = item.getAttribute('data-step');
      switchStep(step);
    });
  });

  // 凭据输入框的显示 / 隐藏切换
  initSecretToggles();
  document.getElementById('cfg-cookie')?.addEventListener('input', updateCookieHint);

  // 账号体检范围（单个 / 全部）
  document.querySelectorAll('#diag-scope-group .diag-scope-btn').forEach(btn => {
    btn.addEventListener('click', () => setDiagMode(btn.getAttribute('data-mode')));
  });
  document.getElementById('diag-account-select')?.addEventListener('change', (e) => {
    diagAccountId = e.target.value;
  });

  // 搜索节奏：输入时实时刷新预估执行时间与 40 分钟搜索预算校验
  document.getElementById('cfg-search-interval')?.addEventListener('input', updateSearchRhythmHint);
  document.getElementById('cfg-search-jitter')?.addEventListener('input', updateSearchRhythmHint);

  initLogsModal();
}

function initSecretToggles() {
  document.querySelectorAll('.secret-toggle').forEach(btn => {
    btn.addEventListener('click', () => {
      const input = document.getElementById(btn.getAttribute('data-target'));
      if (!input) return;
      const show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      btn.textContent = show ? '🙈' : '👁';
      btn.title = show ? '隐藏内容' : '显示内容';
    });
  });
}

// Cookie 提示文案：只暴露「是否已配置」，不暴露内容与长度
function updateCookieHint(hasStoredSecret = null) {
  const hint = document.getElementById('cfg-cookie-hint');
  const input = document.getElementById('cfg-cookie');
  if (!hint || !input) return;
  const hasValue = !!input.value.trim();
  const stored = hasStoredSecret === null
    ? !!currentConfig?.accounts?.find(a => a.id === editingAccountIdInModal)?.hasCookie
    : hasStoredSecret;
  if (hasValue) {
    hint.textContent = '⚠️ Cookie 已修改但尚未保存，保存后生效';
    hint.style.color = '#F59E0B';
  } else if (stored) {
    hint.textContent = '✅ 已配置 Cookie（内容已隐藏，点击右侧眼睛按钮可查看或重新粘贴）';
    hint.style.color = '#34D399';
  } else {
    hint.textContent = 'PC 搜索、每日活动集与桌面任务必备；内容默认隐藏，不会明文展示';
    hint.style.color = '';
  }
}

function switchStep(stepNum, options = {}) {
  const targetStep = Number(stepNum);
  const guideVisible = document.getElementById('guide-modal')?.classList.contains('show');
  if (guideVisible && targetStep >= 2 && !guideNetworkConfirmed && options.force !== true) {
    const result = document.getElementById('guide-proxy-result');
    if (result) {
      result.innerHTML = '<span style="color:#F59E0B;">请先保存网络出口，再继续绑定 Cookie 或 Token，避免真实会话提前从错误 IP 发出。</span>';
    }
    return false;
  }
  document.querySelectorAll('.step-nav-item').forEach(n => n.classList.remove('active'));
  document.querySelectorAll('.step-content').forEach(c => c.classList.remove('active'));
  document.querySelector(`.step-nav-item[data-step="${stepNum}"]`)?.classList.add('active');
  document.getElementById(`step-${stepNum}`)?.classList.add('active');
  return true;
}

function openModal(id) {
  document.getElementById(id)?.classList.add('show');
}

function closeModal(id) {
  document.getElementById(id)?.classList.remove('show');
}

// 内嵌浏览器小窗（容器内 noVNC 画面）：登录窗口与人工接管共用同一套 iframe 逻辑
let novncBaseUrl = '';

function buildNovncUrl(base, stamp) {
  const fallback = `${location.origin}/novnc/vnc.html?autoconnect=1&resize=scale&path=websockify&reconnect=1&reconnect_delay=1000`;
  const url = base || fallback;
  return `${url}${url.includes('?') ? '&' : '?'}_t=${stamp}`;
}

function openNovncModal({ title = '内嵌浏览器', url = '', showSave = false } = {}) {
  const titleEl = document.getElementById('novnc-modal-title');
  if (titleEl) titleEl.innerText = title;
  const saveBtn = document.getElementById('btn-novnc-save-cookie');
  if (saveBtn) saveBtn.style.display = showSave ? 'inline-flex' : 'none';
  novncBaseUrl = url || novncBaseUrl || '';
  const frame = document.getElementById('novnc-frame');
  if (frame) frame.src = buildNovncUrl(novncBaseUrl, Date.now());
  openModal('novnc-modal');
}

function refreshNovncModal() {
  const frame = document.getElementById('novnc-frame');
  if (!frame) return;
  frame.src = buildNovncUrl(novncBaseUrl, Date.now());
}

function closeNovncModal() {
  const frame = document.getElementById('novnc-frame');
  if (frame) frame.src = 'about:blank';
  const saveBtn = document.getElementById('btn-novnc-save-cookie');
  if (saveBtn) saveBtn.style.display = 'none';
  closeModal('novnc-modal');
}

// ===== 页面内轻提示（不阻塞操作，几秒后自动消失） =====
function showToast(message, kind = 'ok') {
  const el = document.getElementById('app-toast');
  if (!el) return;
  el.innerText = message;
  el.className = `app-toast show ${kind}`;
  if (appToastTimer) clearTimeout(appToastTimer);
  appToastTimer = setTimeout(() => {
    el.className = 'app-toast';
    appToastTimer = null;
  }, 3200);
}

// ===== 登录窗口自动获取 Cookie =====
// 复用容器内 noVNC 小窗：在容器里的浏览器登录微软账号，登录态由服务端读出来，再填回表单。

/** 各场景对应的账号 id；新建账号还没有 id，传 null 让服务端按草稿会话处理 */
function resolveCookieLoginAccountId(scope) {
  if (scope === 'settings') return editingAccountIdInModal || null;
  if (scope === 'quick') return editingAccountIdInQuickModal || null;
  if (scope === 'guide') return guideDraftAccount?.id || null;
  return null;
}

function setLoginWindowStatus({ badge, badgeCls, action, cookies, error } = {}) {
  const badgeEl = document.getElementById('login-window-badge');
  if (badgeEl) {
    if (badge) badgeEl.innerText = badge;
    badgeEl.className = `action-badge ${badgeCls || 'idle'}`;
  }
  const actionEl = document.getElementById('login-window-action');
  if (actionEl && action !== undefined) actionEl.innerText = action;
  const cookiesEl = document.getElementById('login-window-cookies');
  if (cookiesEl && cookies !== undefined) cookiesEl.innerText = cookies;
  const errorEl = document.getElementById('login-window-error');
  if (errorEl) {
    errorEl.style.display = error ? 'block' : 'none';
    errorEl.innerText = error || '';
  }
}

function resetLoginWindowSaveButton(disabled = true) {
  const saveBtn = document.getElementById('btn-novnc-save-cookie');
  if (!saveBtn) return;
  saveBtn.innerText = '✅ 保存并填入 Cookie';
  saveBtn.disabled = disabled;
}

function stopCookieLoginPolling() {
  if (cookieLoginPollTimer) {
    clearInterval(cookieLoginPollTimer);
    cookieLoginPollTimer = null;
  }
}

function startCookieLoginPolling() {
  stopCookieLoginPolling();
  const poll = async () => {
    try {
      const res = await fetch('/api/auth/login-window').then(r => r.json());
      if (!res.success) return;
      const d = res.data || {};
      const saveBtn = document.getElementById('btn-novnc-save-cookie');
      if (d.loggedIn) {
        setLoginWindowStatus({
          badge: '已登录',
          badgeCls: 'ok',
          action: d.lastAction || '已检测到登录态，可以点右下角「保存并填入 Cookie」',
          cookies: `已检测到登录态（${Number(d.cookieCount || 0)} 个 Cookie）${d.userName ? ` · ${d.userName}` : ''}`,
          error: ''
        });
      } else {
        setLoginWindowStatus({
          badge: '等待登录',
          badgeCls: 'idle',
          action: d.lastAction || '请在小窗里登录微软账号，登录后停留 3 秒再点保存',
          cookies: d.cookieCount ? `已捕获 ${Number(d.cookieCount)} 个 Cookie，等待出现 _U 登录态` : ''
        });
      }
      if (saveBtn) {
        saveBtn.style.display = 'inline-flex';
        saveBtn.disabled = !d.loggedIn;
      }
      if (d.active === false && !d.loggedIn) {
        stopCookieLoginPolling();
        setLoginWindowStatus({
          badge: '已结束',
          badgeCls: 'warn',
          action: `登录窗口已结束${d.timeoutMin ? `（上限 ${d.timeoutMin} 分钟）` : ''}，请重新打开登录窗口`,
          error: ''
        });
      }
    } catch {}
  };
  poll();
  cookieLoginPollTimer = setInterval(poll, 1000);
}

async function openCookieLoginWindow(scope = 'settings', targetInputId = null) {
  const accountId = resolveCookieLoginAccountId(scope);
  cookieLoginAccountId = accountId;
  cookieLoginTargetInput = targetInputId || null;
  showToast('正在容器内启动登录窗口…', 'info');
  try {
    const res = await fetch('/api/auth/login-window', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(accountId ? { accountId } : {})
    }).then(r => r.json());
    if (!res.success || !res.data?.url) throw new Error(res.message || '登录窗口启动失败');
    cookieLoginAccountId = res.data.accountId || accountId;
    openNovncModal({ title: '微软账号登录窗口', url: res.data.url, showSave: true });
    const statusBar = document.getElementById('login-window-status');
    if (statusBar) statusBar.style.display = 'flex';
    setLoginWindowStatus({
      badge: '等待登录',
      badgeCls: 'idle',
      action: '请在小窗里登录微软账号，登录后停留 3 秒再点右下角保存',
      cookies: '',
      error: ''
    });
    resetLoginWindowSaveButton(true);
    startCookieLoginPolling();
  } catch (e) {
    stopCookieLoginPolling();
    openNovncModal({ title: '微软账号登录窗口', showSave: true });
    const statusBar = document.getElementById('login-window-status');
    if (statusBar) statusBar.style.display = 'flex';
    setLoginWindowStatus({
      badge: '启动失败',
      badgeCls: 'err',
      action: e.message || '登录窗口启动失败',
      cookies: '',
      error: `无法打开登录窗口：${e.message || '未知错误'}`
    });
    resetLoginWindowSaveButton(true);
  }
}

async function saveCookieFromLoginWindow() {
  const saveBtn = document.getElementById('btn-novnc-save-cookie');
  if (saveBtn) {
    saveBtn.disabled = true;
    saveBtn.innerText = '正在读取 Cookie...';
  }
  try {
    const res = await fetch('/api/auth/login-window/save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(cookieLoginAccountId ? { accountId: cookieLoginAccountId } : {})
    }).then(r => r.json());
    if (!res.success) throw new Error(res.message || '保存失败');
    const d = res.data || {};
    if (d.valid === true) {
      const input = cookieLoginTargetInput ? document.getElementById(cookieLoginTargetInput) : null;
      if (input) {
        input.value = d.cookie || '';
        // 触发一次 input 事件，让 Cookie 提示文案等既有逻辑同步刷新
        try {
          input.dispatchEvent(new Event('input', { bubbles: true }));
        } catch {}
      }
      const cookieCount = String(d.cookie || '').split(';').filter(part => part.includes('=')).length;
      await closeCookieLoginWindow(true);
      showToast(`已获取 ${cookieCount} 个 Cookie 并填入`, 'ok');
    } else {
      const missing = Array.isArray(d.missing) ? d.missing : [];
      setLoginWindowStatus({
        badge: '还不能保存',
        badgeCls: 'warn',
        action: d.message || '没有读到完整登录态',
        error: [
          d.message || 'Cookie 不完整',
          missing.length ? `缺少：${missing.join('、')}` : '',
          '请在小窗里登录后停留 3 秒再点保存。'
        ].filter(Boolean).join(' ')
      });
      if (saveBtn) {
        saveBtn.innerText = '✅ 保存并填入 Cookie';
        saveBtn.disabled = false;
      }
    }
  } catch (e) {
    setLoginWindowStatus({
      badge: '保存失败',
      badgeCls: 'err',
      action: e.message || '保存失败',
      error: `读取 Cookie 失败：${e.message || '未知错误'}`
    });
    resetLoginWindowSaveButton(false);
  }
}

async function closeCookieLoginWindow(notifyServer = true) {
  stopCookieLoginPolling();
  cookieLoginTargetInput = null;
  resetLoginWindowSaveButton(true);
  closeNovncModal();
  const statusBar = document.getElementById('login-window-status');
  if (statusBar) statusBar.style.display = 'none';
  setLoginWindowStatus({ badge: '等待登录', badgeCls: 'idle', action: '', cookies: '', error: '' });
  if (notifyServer) {
    try {
      await fetch('/api/auth/login-window/close', { method: 'POST' });
    } catch {}
  }
}

function showWebConfirm(message, title = '请确认') {
  return new Promise((resolve) => {
    const modal = document.getElementById('web-confirm-modal');
    if (!modal) {
      resolve(false);
      return;
    }
    document.getElementById('web-confirm-title').innerText = title;
    document.getElementById('web-confirm-message').innerText = message;
    webConfirmResolver = resolve;
    openModal('web-confirm-modal');
  });
}

function resolveWebConfirm(value) {
  closeModal('web-confirm-modal');
  if (webConfirmResolver) {
    const resolve = webConfirmResolver;
    webConfirmResolver = null;
    resolve(!!value);
  }
}

function setActionSteps(steps, activeIndex = 0) {
  const box = document.getElementById('action-modal-steps');
  if (!box) return;
  box.innerHTML = steps.map((step, idx) => {
    const cls = idx < activeIndex ? 'done' : (idx === activeIndex ? 'active' : '');
    const icon = idx < activeIndex ? '✓' : (idx === activeIndex ? '●' : '○');
    return `<div class="action-step ${cls}"><span>${icon}</span><span>${escapeHtml(step)}</span></div>`;
  }).join('');
}

function appendActionLog(message, force = false) {
  const text = String(message || '').trim();
  if (!text) return;
  if (!force && text === lastActionLog) return;
  lastActionLog = text;
  const box = document.getElementById('action-modal-log');
  if (!box) return;
  box.style.display = 'block';
  const time = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  box.innerText += `${box.innerText ? '\n' : ''}[${time}] ${text}`;
  box.scrollTop = box.scrollHeight;
}

function openActionModal(title, message, steps = [], activeIndex = 0) {
  document.getElementById('action-modal-title').innerText = title;
  document.getElementById('action-modal-message').innerText = message;
  document.getElementById('action-modal-badge').className = 'action-badge idle';
  document.getElementById('action-modal-badge').innerText = '准备中';
  document.getElementById('action-modal-progress').style.width = '0%';
  document.getElementById('action-modal-result').style.display = 'none';
  document.getElementById('action-modal-result').innerText = '';
  const logBox = document.getElementById('action-modal-log');
  if (logBox) {
    logBox.style.display = 'none';
    logBox.innerText = '';
  }
  lastActionLog = '';
  appendActionLog(message, true);
  const backgroundBtn = document.getElementById('btn-action-modal-background');
  if (backgroundBtn) backgroundBtn.style.display = 'inline-flex';
  setActionSteps(steps, activeIndex);
  openModal('action-modal');
}

function updateActionModal({ title, badge, message, progress, activeIndex, result, final } = {}) {
  if (title) document.getElementById('action-modal-title').innerText = title;
  if (badge) {
    const badgeEl = document.getElementById('action-modal-badge');
    badgeEl.innerText = badge.text || badge;
    badgeEl.className = `action-badge ${badge.cls || 'idle'}`;
  }
  if (message) document.getElementById('action-modal-message').innerText = message;
  if (typeof progress === 'number') {
    document.getElementById('action-modal-progress').style.width = `${Math.max(0, Math.min(100, progress))}%`;
  }
  if (typeof activeIndex === 'number') {
    const steps = [...document.querySelectorAll('#action-modal-steps .action-step')];
    steps.forEach((el, idx) => {
      el.classList.toggle('active', idx === activeIndex);
      el.classList.toggle('done', idx < activeIndex);
      const icon = el.querySelector('span');
      if (icon) icon.innerText = idx < activeIndex ? '✓' : (idx === activeIndex ? '●' : '○');
    });
  }
  if (result !== undefined) {
    const resultEl = document.getElementById('action-modal-result');
    resultEl.style.display = 'block';
    resultEl.innerText = result;
    appendActionLog(`结果：${String(result).split('\n')[0]}`);
  }
  if (final === true || progress === 100) {
    const backgroundBtn = document.getElementById('btn-action-modal-background');
    if (backgroundBtn) backgroundBtn.style.display = 'none';
  }
}

function closeActionModal() {
  stopMicrosoftActionPolling();
  stopActionProgressTicker();
  const backgroundBtn = document.getElementById('btn-action-modal-background');
  if (backgroundBtn) backgroundBtn.style.display = 'inline-flex';
  closeModal('action-modal');
}

function stopMicrosoftActionPolling() {
  if (microsoftActionPollTimer) {
    clearInterval(microsoftActionPollTimer);
    microsoftActionPollTimer = null;
  }
}

function stopActionProgressTicker() {
  if (actionProgressTimer) {
    clearInterval(actionProgressTimer);
    actionProgressTimer = null;
  }
}

function startActionProgressTicker(start = 10, max = 90, step = 7, message = '正在执行...') {
  stopActionProgressTicker();
  let progress = start;
  updateActionModal({ progress, message });
  actionProgressTimer = setInterval(() => {
    progress = Math.min(max, progress + step);
    updateActionModal({ progress, message });
  }, 800);
}

function startMicrosoftActionPolling() {
  stopMicrosoftActionPolling();
  const poll = async () => {
    try {
      const res = await fetch('/api/browser/status').then(r => r.json());
      if (!res.success) return;
      const b = res.data || {};
      const total = Number(b.totalTarget || 0);
      const count = Number(b.searchCount || 0);
      const progress = total > 0 ? Math.min(95, Math.max(15, Math.round((count / total) * 85))) : 35;
      const active = ['starting', 'navigating', 'typing', 'dwelling', 'waiting'].includes(b.status);
      updateActionModal({
        progress,
        badge: { text: active ? '执行中' : '准备中', cls: active ? 'ok' : 'idle' },
        message: b.lastAction || '正在执行微软账号操作...'
      });
    } catch {}
  };
  poll();
  microsoftActionPollTimer = setInterval(poll, 1000);
}

function buildMicrosoftStatusDetails(data) {
  const summary = data?.summary || {};
  const stats = data?.stats || {};
  const lines = [
    `今日已增：+${Number(stats.earned ?? summary.totalEarned ?? 0)} 积分`,
    `当前总分：${Number(stats.balance ?? summary.totalBalance ?? 0).toLocaleString()}`,
    `任务达成：${Number(stats.doneTasks ?? summary.doneTasksCount ?? 0)}/${Number(stats.totalTasks ?? summary.totalTasksCount ?? 0)} 项`
  ];
  if (stats.streakDays !== undefined) lines.push(`连续签到：${stats.streakDays} 天`);
  if (summary.accountsList?.length > 1) lines.push(`账号数量：${summary.accountsList.length}`);
  return lines.join('\n');
}

async function runTaskCardAction(accountId, taskKey, taskName = taskKey) {
  let targetId = accountId;
  if (!targetId || targetId === 'all') {
    targetId = currentConfig?.accounts?.[0]?.id || null;
  }
  if (!targetId) {
    openActionModal('无法执行任务', '当前没有可用账号。', ['检查账号列表'], 0);
    updateActionModal({ progress: 100, badge: { text: '无账号', cls: 'err' } });
    return;
  }

  const targetStatus = (currentStatus?.summary?.accountsList || []).find(a => a.id === targetId);
  const accName = targetStatus?.name || currentConfig?.accounts?.find(a => a.id === targetId)?.name || targetId;
  if (targetStatus?.enabled === false) {
    openActionModal('账号已暂停', `账号 [${accName}] 当前已暂停，请先启用后再执行任务。`, ['检查账号状态'], 0);
    updateActionModal({ progress: 100, badge: { text: '已暂停', cls: 'warn' }, result: '暂停账号不会自动执行任务，但数据与凭据仍保留。' });
    return;
  }
  const isSearch = taskKey === 'search';
  openActionModal(
    `${taskName} · ${accName}`,
    `正在执行「${taskName}」一次...`,
    ['检查当前状态', '执行一次任务动作', '刷新官网进度', '输出结果明细'],
    0
  );
  if (isSearch) startMicrosoftActionPolling();
  else startActionProgressTicker(12, 88, 8, `正在执行「${taskName}」一次...`);

  try {
    const res = await fetch('/api/tasks/card-action', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accountId: targetId, taskKey })
    }).then(r => r.json());

    stopMicrosoftActionPolling();
    stopActionProgressTicker();

    if (res.success) {
      const d = res.data || {};
      const before = d.before || {};
      const after = d.after || {};
      const lines = [];
      if (before.max || after.max) {
        lines.push(`进度：${before.progress || 0}/${before.max || 0} → ${after.progress || 0}/${after.max || 0}`);
      }
      if (Array.isArray(d.details) && d.details.length) {
        lines.push(...d.details.map(x => `• ${x}`));
      }
      updateActionModal({
        activeIndex: 4,
        progress: 100,
        badge: {
          text: d.alreadyDone ? '已完成' : (d.hadFailure ? '部分完成' : '执行完成'),
          cls: d.alreadyDone || d.hadFailure ? 'warn' : 'ok'
        },
        message: d.message || '任务动作已完成',
        result: lines.length ? lines.join('\n') : (d.message || '任务动作已完成')
      });
    } else {
      updateActionModal({
        progress: 100,
        badge: { text: '执行失败', cls: 'err' },
        message: res.message || '任务执行失败',
        result: `失败原因：${res.message || '未知错误'}`
      });
    }
  } catch (e) {
    stopMicrosoftActionPolling();
    stopActionProgressTicker();
    updateActionModal({
      progress: 100,
      badge: { text: '执行异常', cls: 'err' },
      message: e.message,
      result: `请求异常：${e.message}`
    });
  } finally {
    fetchStatus();
    fetchHistory(currentHistoryDays);
  }
}

let quickAddCookieCleared = false;

function openQuickAddAccountModal(accountId = null) {
  editingAccountIdInQuickModal = accountId;
  quickAddCookieCleared = false;
  proxyDrafts = cloneProxyDrafts(currentConfig?.network);
  const modalTitle = document.getElementById('quick-add-modal-title');
  const saveBtn = document.getElementById('btn-save-quick-add');
  const nameInput = document.getElementById('quick-add-name');
  const orderInput = document.getElementById('quick-add-order');
  const cookieInput = document.getElementById('quick-add-cookie');
  const authInput = document.getElementById('quick-add-authcode');
  const enabledInput = document.getElementById('quick-add-enabled');
  const cookieHint = document.getElementById('quick-add-cookie-hint');
  const clearCookieBtn = document.getElementById('btn-quick-clear-cookie');
  const proxyModeInput = document.getElementById('quick-add-proxy-mode');

  if (clearCookieBtn) {
    clearCookieBtn.style.display = 'none';
    clearCookieBtn.innerText = '清空已有 Cookie';
  }
  if (cookieInput) cookieInput.disabled = false;

  if (accountId) {
    const acc = currentConfig?.accounts?.find(a => a.id === accountId);
    if (modalTitle) modalTitle.innerText = `编辑微软账号：${acc?.name || accountId}`;
    if (saveBtn) saveBtn.innerText = '保存修改';
    if (nameInput) nameInput.value = acc?.name || '';
    if (orderInput) orderInput.value = acc?.order !== undefined ? acc.order : 1;
    if (enabledInput) enabledInput.checked = acc?.enabled !== false;
    if (proxyModeInput) {
      proxyModeInput.value = ['inherit', 'direct', 'proxy'].includes(acc?.proxyMode)
        ? acc.proxyMode
        : 'direct';
    }
    updateQuickAddProxyControls(acc?.proxyId || '');
    renderRunHourGrid('quick-add-run-hours', acc?.runHours || [acc?.timeSlot?.startHour || 9], {
      excludeAccountId: acc?.id || null
    });
    if (cookieInput) {
      cookieInput.value = '';
      cookieInput.placeholder = acc?.hasCookie
        ? '已配置 Cookie（内容已隐藏，留空保持不变，可直接粘贴新 Cookie 覆盖）'
        : COOKIE_INPUT_PLACEHOLDER;
    }
    if (authInput) {
      authInput.value = '';
      authInput.placeholder = acc?.hasAuthCodeUrl || acc?.hasToken
        ? '已配置移动端凭据（留空保持不变，可粘贴包含 code= 的新跳转链接）'
        : '粘贴包含 code= 的跳转链接（可选）';
    }
    if (cookieHint) cookieHint.innerText = '💡 编辑已有账号时：Cookie 与授权码留空均表示保持原配置不变。';
    if (clearCookieBtn && acc?.hasCookie) {
      clearCookieBtn.style.display = 'inline-block';
    }
  } else {
    const nextOrder = (currentConfig?.accounts?.length || 1) + 1;
    if (modalTitle) modalTitle.innerText = '添加新微软账号';
    if (saveBtn) saveBtn.innerText = '确认创建并添加';
    if (nameInput) nameInput.value = `账号 ${nextOrder}`;
    if (orderInput) orderInput.value = nextOrder;
    if (enabledInput) enabledInput.checked = true;
    if (proxyModeInput) proxyModeInput.value = 'direct';
    updateQuickAddProxyControls('');
    renderRunHourGrid('quick-add-run-hours', [RUN_HOURS[(nextOrder - 1) % RUN_HOURS.length]]);
    if (cookieInput) {
      cookieInput.value = '';
      cookieInput.placeholder = COOKIE_INPUT_PLACEHOLDER;
    }
    if (authInput) {
      authInput.value = '';
      authInput.placeholder = '粘贴包含 code= 的跳转链接（可选）';
    }
    if (cookieHint) cookieHint.innerText = '可选填 Cookie 或授权码，稍后也可随时点击「编辑」补充。';
  }
  openModal('account-quick-add-modal');
}

function openGuideModal() {
  const nextOrder = (currentConfig?.accounts?.length || 1) + 1;
  proxyDrafts = cloneProxyDrafts(currentConfig?.network);
  guideNetworkConfirmed = false;
  guideDraftAccount = {
    id: `acc_${Date.now()}`,
    name: `账号 ${nextOrder}`,
    order: nextOrder,
    cookie: '',
    authCodeUrl: '',
    refreshToken: '',
    accessToken: '',
    tokenTime: 0,
    proxyMode: 'direct',
    proxyId: ''
  };
  const nameInput = document.getElementById('guide-account-name');
  if (nameInput) nameInput.value = guideDraftAccount.name;
  const orderInput = document.getElementById('guide-account-order');
  if (orderInput) orderInput.value = guideDraftAccount.order;
  document.getElementById('guide-code-input').value = '';
  document.getElementById('guide-token-result').innerHTML = '';
  document.getElementById('guide-cookie-input').value = '';
  document.getElementById('guide-cookie-result').innerHTML = '';
  document.getElementById('guide-proxy-result').innerHTML = '';
  document.getElementById('guide-use-proxy').checked = currentConfig?.network?.useProxy === true;
  document.getElementById('guide-proxy-url').value = currentConfig?.network?.proxyUrl || '';
  document.getElementById('guide-lock-region').checked = currentConfig?.network?.lockRegion !== false;
  document.getElementById('guide-account-proxy-mode').value = 'direct';
  document.getElementById('guide-account-proxy-node-group').style.display = 'none';
  renderRunHourGrid('guide-run-hours', [9]);
  document.querySelectorAll('.guide-network-summary').forEach(el => { el.textContent = ''; });
  updateGuideProxyControls('');
  switchStep(1);
  openModal('guide-modal');
}

// 快速新建账号提交
async function handleQuickAddAccount() {
  const isEditing = !!editingAccountIdInQuickModal;
  const name = document.getElementById('quick-add-name')?.value.trim();
  const order = parseInt(document.getElementById('quick-add-order')?.value, 10) || 1;
  const cookieInput = document.getElementById('quick-add-cookie');
  const cookieVal = cookieInput?.value.trim();
  const authCodeUrl = document.getElementById('quick-add-authcode')?.value.trim();
  const enabled = document.getElementById('quick-add-enabled')?.checked !== false;
  const proxySelection = readProxySelection('quick-add-proxy-mode', 'quick-add-proxy-id');
  const runHours = readRunHours('quick-add-run-hours');

  if (!isEditing && !name && !cookieVal) {
    openActionModal('无法保存微软账号', '请至少填写账号备注名称或粘贴 Cookie。', ['填写账号资料', '重新保存'], 0);
    updateActionModal({ progress: 100, badge: { text: '参数缺失', cls: 'warn' } });
    return;
  }
  if (proxySelection.mode === 'proxy' && !proxySelection.proxyId) {
    openActionModal('请选择代理节点', '当前账号选择了指定代理，但尚未选择可用节点。', ['选择代理节点', '重新保存'], 0);
    updateActionModal({ progress: 100, badge: { text: '参数缺失', cls: 'warn' } });
    return;
  }
  if (runHours.length === 0) {
    openActionModal('请选择运行时间', '请至少勾选一个每日运行时间档位。', ['勾选时间档位', '重新保存'], 0);
    updateActionModal({ progress: 100, badge: { text: '参数缺失', cls: 'warn' } });
    return;
  }

  const payload = {
    name: name || (isEditing ? '账号' : '新账号'),
    order,
    enabled,
    proxyMode: proxySelection.mode,
    proxyId: proxySelection.proxyId,
    runHours,
    timeSlot: buildLegacyTimeSlot(runHours)
  };
  if (isEditing) {
    payload.id = editingAccountIdInQuickModal;
  }
  if (quickAddCookieCleared) {
    payload.cookie = SECRET_CLEAR;
  } else if (cookieVal && !cookieVal.startsWith('（已标记清空')) {
    payload.cookie = cookieVal;
  } else if (!isEditing) {
    payload.cookie = '';
  }

  if (authCodeUrl) {
    payload.authCodeUrl = authCodeUrl;
  } else if (!isEditing) {
    payload.authCodeUrl = '';
  }

  try {
    const res = await fetch('/api/accounts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    }).then(r => r.json());

    if (res.success) {
      const msg = isEditing
        ? '账号配置已成功更新！'
        : (res.tokenExchanged ? '账号添加成功，且移动端 Token 已自动换取就绪！' : '账号添加成功！');
      closeModal('account-quick-add-modal');
      // 清空表单
      document.getElementById('quick-add-name').value = '';
      document.getElementById('quick-add-order').value = '';
      document.getElementById('quick-add-cookie').value = '';
      if (document.getElementById('quick-add-cookie')) {
        document.getElementById('quick-add-cookie').disabled = false;
      }
      document.getElementById('quick-add-authcode').value = '';
      editingAccountIdInQuickModal = null;
      const clearedBeforeReset = quickAddCookieCleared;
      quickAddCookieCleared = false;
      selectedAccountId = res.data?.id || (isEditing ? payload.id : 'all');
      fetchStatus();
      fetchConfig();
      openActionModal(
        isEditing ? '账号配置已更新' : '账号添加成功',
        msg,
        ['保存账号资料', '处理登录凭据', '刷新账号列表'],
        3
      );
      updateActionModal({
        progress: 100,
        badge: { text: '已保存', cls: 'ok' },
        result: `账号 [${payload.name}] 已就绪。\n${clearedBeforeReset ? '已清空原 Cookie，请重新配置后再执行任务。' : '如 Cookie 已更新，建议点击「账号状态体检」确认登录态。'}`
      });
    } else {
      openActionModal('账号保存失败', res.message || '保存失败', ['保存账号资料', '校验结果'], 0);
      updateActionModal({ progress: 100, badge: { text: '保存失败', cls: 'err' }, result: `保存失败：${res.message || '未知错误'}` });
    }
  } catch (err) {
    openActionModal('账号保存异常', err.message, ['保存账号资料', '校验结果'], 0);
    updateActionModal({ progress: 100, badge: { text: '请求异常', cls: 'err' }, result: `请求异常：${err.message}` });
  }
}

// 配置中心中删除当前账号
async function handleDeleteCurrentAccountInModal() {
  if (!editingAccountIdInModal) return;
  const ok = await showWebConfirm('确定要删除当前选中的这个账号吗？\n该账号的浏览器会话也会被清理。', '删除微软账号');
  if (!ok) return;

  try {
    const res = await fetch(`/api/accounts/${editingAccountIdInModal}`, { method: 'DELETE' }).then(r => r.json());
    if (res.success) {
      selectedAccountId = 'all';
      fetchConfig();
      fetchStatus();
      closeModal('settings-modal');
      openActionModal('账号已删除', '账号及其浏览器会话已清理。', ['删除账号配置', '清理浏览器会话', '刷新账号列表'], 3);
      updateActionModal({ progress: 100, badge: { text: '已删除', cls: 'ok' } });
    } else {
      openActionModal('账号删除失败', res.message || '删除失败', ['删除账号配置', '校验结果'], 0);
      updateActionModal({ progress: 100, badge: { text: '删除失败', cls: 'err' }, result: `删除失败：${res.message || '未知错误'}` });
    }
  } catch (e) {
    openActionModal('账号删除异常', e.message, ['删除账号配置', '校验结果'], 0);
    updateActionModal({ progress: 100, badge: { text: '删除异常', cls: 'err' }, result: `删除异常：${e.message}` });
  }
}

// 获取状态并渲染大屏
async function fetchStatus() {
  try {
    const res = await fetch(`/api/status?accountId=${selectedAccountId}`).then(r => r.json());
    if (res.success && res.data) {
      currentStatus = res.data;
      renderDashboard(res.data);
    }
  } catch (e) {
    console.error('获取状态失败:', e);
  }
}

// 获取并渲染无头浏览器实时状态监控数据
async function fetchBrowserStatus() {
  try {
    const res = await fetch('/api/browser/status').then(r => r.json());
    if (res.success && res.data) {
      renderBrowserMonitor(res.data);
    }
  } catch {}
}

// 获取并渲染系统硬件与网络实时状态
async function fetchSystemMetrics() {
  try {
    const res = await fetch('/api/system/metrics').then(r => r.json());
    if (res.success && res.data) {
      const d = res.data;
      lastSystemMetrics = d;
      const cpuEl = document.getElementById('metric-cpu');
      const memEl = document.getElementById('metric-mem');
      const pingEl = document.getElementById('metric-ping');
      const pill = document.getElementById('sys-metrics-pill');
      if (cpuEl) cpuEl.innerText = `CPU ${d.cpu}`;
      if (memEl) memEl.innerText = `内存 ${d.procMem}`;
      if (pingEl) pingEl.innerText = `延时 ${d.ping}`;

      if (pill && d.containerDetails) {
        const cd = d.containerDetails;
        const memLine = cd.containerMemory
          ? `🧠 容器内存占用: ${cd.containerMemory} / ${cd.containerMemoryLimit}${cd.containerMemoryPercent !== null ? ` (${cd.containerMemoryPercent}%)` : ''}${cd.containerMemorySource ? ` [来源: ${cd.containerMemorySource}]` : ''}`
          : `🧠 容器内存占用: 读取不到 cgroup，回退为 Node 进程 ${cd.processRss}`;
        const cpuLine = d.cpuIsContainer
          ? `💻 容器 CPU 占用: ${d.cpu}（占单核百分比）`
          : `💻 CPU 占用: ${d.cpu}（宿主机整机，未读到容器 cgroup）`;
        pill.setAttribute('data-tip', `📦 容器运行环境: Node.js ${cd.nodeVersion} on ${cd.platform}\n⏱️ 容器运行时间: ${cd.uptime}\n${memLine}\n🧩 Node 进程 RSS: ${cd.processRss} (堆内存: ${cd.heap})\n${cpuLine}\n🖥️ 宿主机物理内存: ${cd.hostMemory}\n🌐 微软网络延时: ${d.ping}\n🔄 提示: 点击立即刷新`);
      }
    }
  } catch {}
}

let updateInfo = null;
let taskRunning = false;

// 版本与状态复合胶囊的悬停提示（状态 + 是否有新版本，统一在这里合成）
function refreshVersionPillTooltip() {
  const pill = document.getElementById('version-status-pill');
  if (!pill) return;
  const current = updateInfo?.currentVersion || '1.8.6';
  const statusLine = taskRunning
    ? '🟦 系统状态：正在执行自动化任务打卡中…'
    : '🟢 系统状态：后台定时就绪中';
  let text = `${statusLine}\n当前版本：v${current}`;
  if (updateInfo?.hasUpdate) {
    text += `\n\n🚀 发现新版本 v${updateInfo.latestVersion}！\n${updateInfo.releaseTitle || ''}\n点击查看更新日志与升级方式`;
  } else if (updateInfo?.checkFailed) {
    text += `\n\n⚠️ 无法检查更新：${updateInfo.checkError || '连接 GitHub 失败'}\n（这不代表已是最新版本，可稍后重试）`;
  } else {
    text += `\n✅ 已是最新版本`;
  }
  pill.setAttribute('data-tip', text);
}

async function checkVersionUpdate() {
  try {
    const res = await fetch('/api/system/check-update').then(r => r.json());
    if (res.success && res.data) {
      updateInfo = res.data;
      const indicator = document.getElementById('update-indicator');
      const updateText = document.getElementById('update-text');
      const pill = document.getElementById('version-status-pill');
      if (res.data.hasUpdate) {
        if (indicator) indicator.style.display = 'inline-flex';
        if (updateText) updateText.innerText = `发现新版 v${res.data.latestVersion}`;
        if (pill) pill.classList.add('has-update');
      } else if (res.data.checkFailed) {
        // 检查失败不能伪装成「已是最新」，否则用户永远不知道自己是漏检还是真没更新
        if (indicator) indicator.style.display = 'inline-flex';
        if (updateText) updateText.innerText = '更新检查失败';
        if (pill) pill.classList.remove('has-update');
      } else {
        if (indicator) indicator.style.display = 'none';
        if (pill) pill.classList.remove('has-update');
      }
      refreshVersionPillTooltip();
    }
  } catch {}
}

async function handleVersionCheckClick() {
  if (updateInfo?.hasUpdate) {
    const ok = await showWebConfirm(
      `发现新版本 v${updateInfo.latestVersion}（当前 v${updateInfo.currentVersion}）。\n\n更新说明：${updateInfo.releaseTitle || '暂无说明'}\n\n是否前往 GitHub 查看更新日志？`,
      '发现新版本'
    );
    if (ok) {
      window.open(updateInfo.releaseUrl, '_blank');
    }
  } else {
    const failed = updateInfo?.checkFailed;
    openActionModal(
      '版本检查',
      failed
        ? `当前运行版本 v${updateInfo?.currentVersion || '1.8.6'}，但无法连接 GitHub 检查更新。`
        : `当前运行版本 v${updateInfo?.currentVersion || '1.8.6'} 已是最新版本。`,
      ['获取远端版本', '比较版本号', failed ? '检查失败' : '确认无需更新'],
      3
    );
    updateActionModal({
      progress: 100,
      badge: failed ? { text: '检查失败', cls: 'warn' } : { text: '已是最新', cls: 'ok' },
      result: failed
        ? `失败原因：${updateInfo?.checkError || '连接 GitHub 失败'}\n\n常见原因：容器无法直连 api.github.com（国内网络/防火墙），或触发了 GitHub 接口限流。\n这不代表已是最新版本，可稍后重试。`
        : undefined
    });
  }
}

function renderBrowserMonitor(b) {
  const pill = document.getElementById('browser-pill-status');
  const pillText = document.getElementById('browser-pill-text');
  const bmAccount = document.getElementById('bm-account');
  const bmQuery = document.getElementById('bm-query');
  const bmRound = document.getElementById('bm-round');
  const bmCountdown = document.getElementById('bm-countdown');
  const bmMem = document.getElementById('bm-mem');
  const bmAction = document.getElementById('bm-action-text');

  if (!pill) return;

  const isRunning = b.status !== 'idle' && b.status !== 'stopped';
  pill.className = `browser-status-pill ${isRunning ? 'status-running' : 'status-idle'}`;

  const statusMap = {
    idle: '空闲休眠中',
    starting: '正在启动 Chromium...',
    navigating: '打开 Bing 页面中...',
    typing: '正在模拟真人键盘打字...',
    dwelling: '等待页面渲染与滚动...',
    waiting: '拟人呼吸休眠中...',
    stopped: '已停止'
  };

  pillText.innerText = statusMap[b.status] || (isRunning ? '运行中' : '空闲休眠中');
  bmAccount.innerText = b.activeAccountName || '--';
  bmQuery.innerText = b.currentQuery || '--';
  if (bmRound) {
    bmRound.innerText = b.totalTarget > 0 ? `${b.searchCount} / ${b.totalTarget}` : '0 / 0';
    // 说明口径：这里统计的是「本次为补足剩余配额需要跑几轮搜索」，不是总进度
    bmRound.setAttribute('data-tip', b.totalTarget > 0
      ? `本次需补足剩余配额 ${b.pointsNeeded || b.totalTarget * 3} 分，每次搜索约 +3 分，共安排 ${b.totalTarget} 轮；与上方总进度是两个口径`
      : '本次补分搜索轮次');
  }
  bmCountdown.innerText = b.nextSearchIn > 0 ? `${b.nextSearchIn} 秒` : '--';
  // 用容器真实内存（含 Chromium 子进程）替代原来写死的 180MB
  const containerMem = lastSystemMetrics?.procMem;
  bmMem.innerText = containerMem || (isRunning ? `${b.memoryMB || '--'} MB` : '--');
  bmAction.innerText = b.lastAction || '浏览器当前处于空闲休眠状态 (0 内存占用)';
}

// 渲染多账号切换胶囊栏
function renderAccountSelectorBar(summary, runtime = {}) {
  const bar = document.getElementById('account-selector-bar');
  if (!bar || !summary) return;

  const accounts = summary.accountsList || [];
  let html = '';

  // 记录 id → 账号名映射，供日志与打卡明细按账号过滤使用
  accountNameById = {};
  accounts.forEach(acc => { accountNameById[acc.id] = acc.name; });

  // 1. 全部账号汇总胶囊
  const isAllActive = selectedAccountId === 'all';
  html += `
    <button class="account-chip ${isAllActive ? 'active' : ''}" data-acc-id="all">
      <span class="chip-icon">🌐</span>
      <span class="chip-name">全部账号汇总</span>
      <span class="chip-badge">${summary.totalAccounts || 1} 个账号${summary.pausedAccounts ? ` · ${summary.pausedAccounts} 暂停` : ''}</span>
    </button>
  `;

  // 2. 各独立账号胶囊
  accounts.forEach(acc => {
    const isActive = selectedAccountId === acc.id;
    const runtimeStatus = getAccountRuntimeStatus(acc, runtime);
    html += `
      <button class="account-chip ${isActive ? 'active' : ''} ${runtimeStatus.cls}" data-acc-id="${escapeHtml(acc.id)}" data-tip="${escapeHtml(runtimeStatus.tip)}">
        <span class="chip-icon">${runtimeStatus.icon}</span>
        <span class="chip-name">${escapeHtml(acc.name)}</span>
        <span class="chip-sub">${(acc.balance || 0).toLocaleString()} 分</span>
      </button>
    `;
  });

  // 3. 添加账号按钮
  html += `
    <button class="account-chip chip-add" id="btn-add-account-chip">
      <span>➕</span> 添加账号
    </button>
  `;

  bar.innerHTML = html;

  // 绑定切换事件
  bar.querySelectorAll('.account-chip[data-acc-id]').forEach(chip => {
    chip.addEventListener('click', () => {
      selectedAccountId = chip.getAttribute('data-acc-id');
      fetchStatus();
      fetchHistory(currentHistoryDays);
      renderLogs(); // 日志按选中账号实时过滤
    });
  });

  bar.querySelector('#btn-add-account-chip')?.addEventListener('click', () => {
    openQuickAddAccountModal();
  });
}

// 渲染大屏
function renderDashboard(data) {
  const { running, runningAccountId, summary, stats, timeline } = data;

  // 1. 渲染顶部多账号切换胶囊
  if (summary) {
    renderAccountSelectorBar(summary, { running, runningAccountId });
  }

  // 2. 系统运行状态与复合胶囊
  const versionPill = document.getElementById('version-status-pill');
  const btnRun = document.getElementById('btn-run');
  const btnStop = document.getElementById('btn-stop');
  const btnRunSingle = document.getElementById('btn-run-single-header');
  const btnToggleAccount = document.getElementById('btn-toggle-account-header');
  const btnStopSingle = document.getElementById('btn-stop-single-header');

  const isAllMode = selectedAccountId === 'all';
  const selectedAcc = isAllMode ? null : (summary?.accountsList || []).find(a => a.id === selectedAccountId);

  taskRunning = !!running;

  if (running) {
    if (versionPill) {
      versionPill.classList.remove('status-idle');
      versionPill.classList.add('status-running');
    }
    if (btnRun) btnRun.style.display = 'none';
    if (btnStop) btnStop.style.display = 'inline-flex';
    if (btnRunSingle) btnRunSingle.style.display = 'none';
    if (btnStopSingle) btnStopSingle.style.display = 'inline-flex';
  } else {
    if (versionPill) {
      versionPill.classList.remove('status-running');
      versionPill.classList.add('status-idle');
    }
    if (btnRun) btnRun.style.display = 'inline-flex';
    if (btnStop) btnStop.style.display = 'none';
    if (btnRunSingle) btnRunSingle.style.display = isAllMode ? 'none' : 'inline-flex';
    if (btnStopSingle) btnStopSingle.style.display = 'none';
  }

  if (btnToggleAccount) {
    btnToggleAccount.style.display = (!isAllMode && selectedAcc) ? 'inline-flex' : 'none';
    if (selectedAcc) {
      const paused = selectedAcc.enabled === false;
      btnToggleAccount.className = `btn btn-sm ${paused ? 'btn-success' : 'btn-warning'}`;
      btnToggleAccount.innerHTML = paused
        ? '<span>▶️</span> 启用账号'
        : '<span>⏸️</span> 暂停账号';
      btnToggleAccount.setAttribute('data-tip', paused
        ? '启用该账号；下一次任务或手动刷新时会按需更新 Token'
        : '暂停后停止自动任务与自动 Token 刷新，数据、凭据和历史全部保留');
    }
  }

  if (btnRunSingle && selectedAcc) {
    const paused = selectedAcc.enabled === false;
    btnRunSingle.disabled = paused;
    btnRunSingle.style.opacity = paused ? '0.55' : '';
    btnRunSingle.setAttribute('data-tip', paused
      ? '账号已暂停，请先点击「启用账号」'
      : '立即运行当前账号的自动化任务');
  }

  refreshVersionPillTooltip();

  if (btnRunSingle && !isAllMode) {
    btnRunSingle.innerHTML = `<span>▶️</span> 运行当前账号 [${escapeHtml(stats.name || '')}]`;
  }

  // 3. Hero 5 大卡片数据渲染
  const displayEarned = isAllMode ? (summary?.totalEarned || 0) : (stats.earned || 0);
  const displayBalance = isAllMode ? (summary?.totalBalance || 0) : (stats.balance || 0);
  const displayClaimable = isAllMode ? Number(summary?.totalClaimable || 0) : Number(stats.claimablePoints || 0);
  const displayStreak = isAllMode ? (summary?.maxStreak || 0) : (stats.streakDays || 0);
  const stamps = isAllMode ? (summary?.stamps || { progress: 0, max: 12 }) : (stats.stamps || { progress: 0, max: 12 });
  const earnedBreakdown = document.getElementById('earned-account-breakdown');
  const balanceBreakdown = document.getElementById('balance-account-breakdown');
  const claimableBreakdown = document.getElementById('claimable-account-breakdown');

  document.getElementById('stat-earned').innerText = `+${displayEarned}`;
  document.getElementById('stat-balance').innerText = displayBalance.toLocaleString();

  // 卡片 3：待领取额外积分
  const statClaimable = document.getElementById('stat-claimable');
  const statClaimableDesc = document.getElementById('stat-claimable-desc');
  const heroClaimBtn = document.getElementById('hero-claim-btn-text');
  if (statClaimable) {
    statClaimable.innerText = `${displayClaimable} 分`;
    statClaimable.style.color = displayClaimable > 0 ? '#38BDF8' : 'var(--text-muted)';
  }
  if (statClaimableDesc) {
    statClaimableDesc.innerText = displayClaimable > 0
      ? (isAllMode ? `共 ${displayClaimable} 点待领，点击一键领取` : `当前账号有 ${displayClaimable} 点待领，点击领取`)
      : '平台额外赠分均已领取完毕';
  }
  if (heroClaimBtn) {
    heroClaimBtn.innerText = displayClaimable > 0 ? '立即领取 ➜' : '已领完';
    heroClaimBtn.style.opacity = displayClaimable > 0 ? '1' : '0.5';
  }

  const accountCount = summary?.accountsList?.length || 0;
  const allBreakdowns = [earnedBreakdown, balanceBreakdown, claimableBreakdown];
  allBreakdowns.forEach(el => { if (el) el.hidden = !isAllMode; });
  if (isAllMode) {
    renderHeroAccountBreakdown('earned-account-breakdown', summary?.accountsList || [], 'earned', value => `+${value.toLocaleString()}`);
    renderHeroAccountBreakdown('balance-account-breakdown', summary?.accountsList || [], 'balance', value => value.toLocaleString());
    renderHeroAccountBreakdown('claimable-account-breakdown', summary?.accountsList || [], 'claimablePoints', value => `${value.toLocaleString()} 分`);
  }
  const earnedDesc = document.querySelector('#stat-earned + .hero-account-breakdown')?.nextElementSibling;
  const balanceDesc = document.querySelector('#stat-balance + .hero-account-breakdown')?.nextElementSibling;
  if (earnedDesc) {
    earnedDesc.innerText = isAllMode ? `${accountCount} 个账号今日积分明细` : '各项任务自动累计到账';
  }
  if (balanceDesc) {
    balanceDesc.innerText = isAllMode ? `${accountCount} 个账号当前余额明细` : '同步微软平台账户积分';
  }

  document.getElementById('stat-streak').innerText = `${displayStreak} 天`;

  const statStamps = document.getElementById('stat-stamps');
  const statStampsDesc = document.getElementById('stat-stamps-desc');
  const statStampsFill = document.getElementById('stat-stamps-fill');
  const stampsGrid = document.getElementById('stamps-grid-track');
  const stampsAccountList = document.getElementById('stamps-account-list');
  const stampsMiniBar = document.querySelector('.stamps-mini-bar');
  if (statStamps) {
    statStamps.innerText = isAllMode
      ? `${summary?.accountsList?.length || 0} 个账号`
      : `${stamps.progress || 0} / ${stamps.max || 12}`;
  }
  if (statStampsFill) {
    const sMax = Number(stamps.max || 12) || 12;
    const sProg = Number(stamps.progress || 0) || 0;
    const sPct = Math.min(100, Math.max(0, Math.round((sProg / sMax) * 100)));
    statStampsFill.style.width = `${sPct}%`;
  }
  if (statStampsDesc) {
    if (isAllMode) {
      statStampsDesc.innerText = `全部 ${accountCount} 个账号印章进度`;
    } else {
      const diff = Math.max(0, (stamps.max || 12) - (stamps.progress || 0));
      statStampsDesc.innerText = diff > 0 ? `差 ${diff} 个集满 1,000 分大奖` : '1,000 奖励印章已集满！';
    }
  }
  if (stampsGrid) stampsGrid.hidden = isAllMode;
  if (stampsAccountList) stampsAccountList.hidden = !isAllMode;
  if (stampsMiniBar) stampsMiniBar.hidden = isAllMode;
  if (isAllMode) {
    renderAccountStampsList(summary?.accountsList || []);
  } else {
    renderStampsGrid(stamps);
  }

  // 顶部工具条面包屑/范围更新
  const scopeBadge = document.getElementById('ms-toolbar-scope');
  if (scopeBadge) {
    if (isAllMode) {
      scopeBadge.innerHTML = '👥 全部账号汇总';
    } else {
      scopeBadge.innerHTML = `👤 当前账号：${escapeHtml(stats.name || selectedAccountId)}`;
    }
  }

  // 运行按钮提示
  const btnRunIcon = btnRun.querySelector('.icon') || btnRun;
  btnRun.innerHTML = isAllMode ? '<span>▶️</span> 立即执行全部账号' : `<span>▶️</span> 运行当前账号 [${escapeHtml(stats.name || '')}]`;

  // 4. 汇总视图 vs 单账号视图渲染
  const overviewCard = document.getElementById('accounts-overview-card');
  const taskListTitle = document.getElementById('task-list-title');
  const historyTitle = document.getElementById('history-chart-title');
  const historyCard = document.getElementById('history-card-section');

  if (historyTitle) {
    historyTitle.innerText = '每日积分增长历史记录 (全部账号汇总)';
  }
  if (historyCard) historyCard.style.display = isAllMode ? 'flex' : 'none';

  if (isAllMode) {
    // 汇总模式：显示全账号概览卡片矩阵，隐藏单任务清单（避免在汇总下显示误导的任务列表）
    if (overviewCard) {
      overviewCard.style.display = 'flex';
      renderAccountsOverviewGrid(summary?.accountsList || [], { running, runningAccountId, schedule: data.schedule || {} });
    }
    const taskListSection = document.getElementById('task-list-section');
    if (taskListSection) {
      taskListSection.style.display = 'none';
    }
  } else {
    // 单账号模式：隐藏全账号矩阵，聚焦当前选中账号的专属任务清单
    if (overviewCard) {
      overviewCard.style.display = 'none';
    }
    const taskListSection = document.getElementById('task-list-section');
    if (taskListSection) {
      taskListSection.style.display = 'flex';
    }
    if (taskListTitle) {
      taskListTitle.innerText = `账号 [${escapeHtml(stats.name || '')}] 今日自动化任务进度清单`;
    }
  }

  // 「最后更新」时间：单账号取该账号的 lastUpdate，汇总视图取所有账号里最新的一次。
  // 这个元素以前只写在 HTML 里、JS 从来没赋值，所以一直显示 "--"。
  const lastUpdateEl = document.getElementById('last-update-time');
  if (lastUpdateEl) {
    const lastUpdateTs = isAllMode
      ? Math.max(0, ...(summary?.accountsList || []).map(a => Number(a.lastUpdate) || 0))
      : Number(stats.lastUpdate) || 0;
    lastUpdateEl.innerText = lastUpdateTs > 0
      ? `最后更新：${new Date(lastUpdateTs).toLocaleString('zh-CN', { hour12: false })}`
      : '最后更新：--';
  }

function formatPunchCardTooltip(t) {
  const p = Number(t.progress || 0);
  const m = Number(t.max || 1);
  const logs = Array.isArray(t.stepLogs) ? t.stepLogs : [];
  const lines = [
    `📋 ${t.name || '打孔卡'} 推进历史明细 (${p}/${m}):`
  ];
  if (t.expiresText) {
    lines.push(`⏳ ${t.expiresText}`);
  }
  lines.push('───────────────────────');

  for (let s = 1; s <= m; s++) {
    const log = logs.find(l => l.step === s);
    if (log && log.at) {
      const d = new Date(log.at);
      const dateStr = !isNaN(d.getTime())
        ? `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
        : '已完成';
      const label = log.name ? ` · ${log.name}` : '';
      lines.push(`● 第 ${s} 项: ${dateStr} 已完成${label}`);
    } else if (s <= p) {
      lines.push(`● 第 ${s} 项: 已完成`);
    } else if (s === p + 1) {
      lines.push(`○ 第 ${s} 项: 待打卡 / 待解锁`);
    } else {
      lines.push(`○ 第 ${s} 项: 待解锁 (完成上一项后满 24 小时)`);
    }
  }
  return lines.join('\n');
}

  // 5. 渲染任务网格
  const taskGrid = document.getElementById('task-grid');
  taskGrid.innerHTML = '';
  const TASK_PRIORITY = {
    search: 10,
    dailySet: 20,
    sign: 30,
    read: 40,
    promos: 50,
    desktopApp: 60
  };

  const tasksList = Object.entries(stats.tasks || {});
  tasksList.sort((a, b) => {
    const prioA = TASK_PRIORITY[a[0]] || 100;
    const prioB = TASK_PRIORITY[b[0]] || 100;
    return prioA - prioB;
  });

  for (const [key, t] of tasksList) {
    const card = document.createElement('div');
    const isFeaturedTask = key === 'search' || key === 'dailySet' || key === 'sign';
    card.className = `task-card task-card-clickable${isFeaturedTask ? ' task-card-featured' : ''}`;
    card.dataset.taskKey = key;
    card.setAttribute('role', 'button');
    card.setAttribute('tabindex', '0');
    card.setAttribute('title', '点击立即执行一次该任务');
    const isDone = t.done || (t.max > 0 && t.progress >= t.max);
    
    let subtext = isDone ? '状态: ✅ 已完成' : (running ? '状态: ⏳ 进行中' : '状态: 待执行');
    let pointsBadge = `+${t.points || 0} 积分`;
    let progressLabel = `进度: ${t.progress || 0} / ${t.max || 1} ${t.unit || ''}`;
    let progPercent = t.max > 0 ? Math.min(100, Math.round((t.progress / t.max) * 100)) : (isDone ? 100 : 0);

    const isPunchCard = t.isPunchCard || key === 'desktopApp' || key === 'monthlyQuest' || key.startsWith('quest_');
    if (isPunchCard) {
      const p = Number(t.progress || 0);
      const m = Number(t.max || (key === 'desktopApp' ? 8 : (key === 'quest_halloween' ? 6 : 5))) || 1;
      progPercent = Math.min(100, Math.round((p / m) * 100));
      const typeLabel = t.name?.includes('每周') ? '每周打孔卡' : (t.name?.includes('月') ? '每月打孔卡' : '活动打孔卡');
      if (isDone) {
        subtext = `已全部达成 · ${typeLabel} (悬停查看记录)`;
      } else if (t.available === false && p === 0) {
        subtext = `未检测到该任务 · ${typeLabel}`;
        pointsBadge = '+0 积分';
      } else {
        subtext = t.expiresText ? `${t.expiresText} · ${typeLabel} (悬停查看记录)` : `${typeLabel} (悬停查看记录)`;
      }
      progressLabel = `进度: ${p} / ${m} 个任务`;
      pointsBadge = `+${t.points || (key === 'desktopApp' ? 20 : 50)} 积分`;
      card.setAttribute('data-tip', formatPunchCardTooltip(t));
      card.style.cursor = 'help';
    }

    let extraStreakHtml = '';
    let displayName = t.name || key;

    // 1. 必应 PC 搜索任务：对应官网「必应搜索连续打卡」7 日进度条
    if (key === 'search') {
      const searchStreak = stats.streaks?.bing;
      extraStreakHtml = render7DayStreakTrack(searchStreak, stats.streakDays, isDone, '必应搜索连续打卡');
      if (Number(t.max || 0) > 0) {
        const tierLabel = t.searchTier?.label ? ` · ${t.searchTier.label}` : '';
        progressLabel = `进度: ${t.progress || 0} / ${t.max} ${t.unit || '分'}${tierLabel}`;
      } else {
        progressLabel = '进度: 等待官网同步会员等级配额';
        pointsBadge = '配额待同步';
      }
      if (t.statusMessage) {
        subtext = `${subtext} · ${t.statusMessage}`;
      }
    }

    // 2. 每日活动集：对应官网「每日连续打卡活动」7 日进度条
    if (key === 'dailySet') {
      const dsStreak = stats.streaks?.dailyset;
      extraStreakHtml = render7DayStreakTrack(dsStreak, stats.streakDays, isDone, '每日连续打卡活动');
    }

    // 3. 移动端签到：与另外两张重点卡保持一致，只展示移动端完成状态
    if (key === 'sign') {
      displayName = '移动端签到';
      const appStreak = stats.streaks?.bingapp;
      extraStreakHtml = render7DayStreakTrack(appStreak, stats.streakDays, isDone, '移动端连续打卡');
    }

    if (isPunchCard && !isDone) {
      const cooling = Object.values(t.subtaskState || {}).some(state => Number(state?.cooldownUntil || 0) > Date.now());
      if (cooling) subtext = `${subtext} · 今日已尝试，等待冷却`;
    }

    // 图标处理：所有 rewards app 的任务，图表换成 rewards app 的官方矢量图标
    const isRewardsApp = key === 'desktopApp'
      || /rewards\s*app/i.test(displayName || '')
      || (displayName || '').includes('桌面应用')
      || t.icon === 'rewards-app';
    const iconHtml = isRewardsApp ? getRewardsAppOfficialIconHtml() : escapeHtml(t.icon || '📌');

    card.innerHTML = `
      <div class="task-top">
        <div class="task-info">
          <div class="task-icon">${iconHtml}</div>
          <div>
            <div class="task-name">${escapeHtml(displayName)}</div>
            <div class="task-subtext">${escapeHtml(subtext)}</div>
          </div>
        </div>
        <div class="pts-badge">${escapeHtml(pointsBadge)}</div>
      </div>
      <div class="progress-wrap">
        <div class="progress-labels">
          <span>${escapeHtml(progressLabel)}</span>
          <span>${progPercent}%</span>
        </div>
        <div class="progress-bar-track">
          <div class="progress-bar-fill" style="width: ${progPercent}%;"></div>
        </div>
      </div>
      ${extraStreakHtml}
    `;
    const triggerTaskCard = () => runTaskCardAction(selectedAccountId, key, displayName);
    card.addEventListener('click', triggerTaskCard);
    card.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        triggerTaskCard();
      }
    });
    taskGrid.appendChild(card);
  }

  // 6. 渲染时间轴（每行带账号名，服务端已按选中账号过滤）
  const timelineList = document.getElementById('timeline-list');
  if (timelineList) {
    if (timeline && timeline.length > 0) {
      timelineList.innerHTML = timeline.map(item => {
        const acc = item.accountName || item.tag || '系统';
        return `
      <div class="timeline-item">
        <span class="timeline-time">${item.time}</span>
        <span class="timeline-tag">[${escapeHtml(acc)}]</span>
        <span>${escapeHtml(item.text)}</span>
      </div>`;
      }).join('');
    } else {
      timelineList.innerHTML = selectedAccountId === 'all'
        ? '<div class="timeline-empty">暂无打卡明细</div>'
        : '<div class="timeline-empty">当前账号暂无打卡明细</div>';
    }
  }
}

// 渲染多账号概览矩阵卡片 (在“全部账号汇总”视图中展示)
function formatDiagnosisTime(ts) {
  if (!ts) return '未知时间';
  try {
    return new Date(ts).toLocaleString('zh-CN', { hour12: false });
  } catch {
    return '未知时间';
  }
}

// 账号凭据体检状态：有效 / 失效 / 未检测（悬停展示上次检测时间与结果）
function getAccountAuthStatus(acc) {
  const d = acc?.authDiagnosis;
  if (!d || !d.checkedAt) {
    return {
      text: '未检测',
      cls: 'badge-auth-unknown',
      tip: '尚未体检该账号\n点击右上角「账号体检」可检测 Cookie 与 Token 是否过期'
    };
  }
  const cookieLine = d.cookieValid ? '✅ Cookie 有效' : '❌ Cookie 失效';
  const tokenLine = d.tokenValid ? '✅ Token 有效' : '❌ Token 失效';
  const tip = [
    `上次检测：${formatDiagnosisTime(d.checkedAt)}`,
    `检测结果：${d.overallValid ? (d.warning ? '已登录但存在异常' : '整体有效') : '存在失效项'}`,
    cookieLine,
    tokenLine,
    ...(d.cookieMessage ? [`Cookie：${d.cookieMessage}`] : []),
    ...(d.tokenMessage ? [`Token：${d.tokenMessage}`] : []),
    ...(d.warning ? [`⚠️ ${d.warningMessage || '凭据存在异常，请重新检查'}`] : [])
  ].join('\n');
  if (d.overallValid && d.warning) {
    return { text: '需修复', cls: 'badge-auth-warn', tip };
  }
  return d.overallValid
    ? { text: '有效', cls: 'badge-auth-valid', tip }
    : { text: '失效', cls: 'badge-auth-invalid', tip };
}

/**
 * 账号运行状态统一口径：
 * 蓝=正在执行 > 黄=已暂停 > 红=凭据失效/异常 > 绿=正常 > 灰=未体检。
 */
function getAccountRuntimeStatus(acc, runtime = {}) {
  const auth = getAccountAuthStatus(acc);
  const isRunning = runtime.running === true && runtime.runningAccountId === acc?.id;
  if (isRunning) {
    return {
      key: 'running',
      icon: '🔵',
      label: '运行中',
      cls: 'status-running',
      tip: '正在执行该账号的自动化任务'
    };
  }
  if (acc?.enabled === false) {
    const pausedTip = [
      '账号已暂停',
      '不会自动执行任务，也不会自动刷新 Token / Cookie',
      '手动体检和手动刷新进度仍可使用',
      '账号数据、凭据、历史与浏览器会话全部保留',
      ...(auth.cls === 'badge-auth-invalid' || auth.cls === 'badge-auth-warn'
        ? [`上次体检：${auth.text}`, auth.tip]
        : [])
    ].join('\n');
    return {
      key: 'paused',
      icon: '🟡',
      label: '已暂停',
      cls: 'status-paused',
      tip: pausedTip
    };
  }
  if (auth.cls === 'badge-auth-invalid' || auth.cls === 'badge-auth-warn') {
    return {
      key: 'invalid',
      icon: '🔴',
      label: auth.text,
      cls: 'status-invalid',
      tip: auth.tip
    };
  }
  if (auth.cls === 'badge-auth-unknown') {
    return {
      key: 'unknown',
      icon: '⚪',
      label: '未检测',
      cls: 'status-unknown',
      tip: auth.tip
    };
  }
  return {
    key: 'valid',
    icon: '🟢',
    label: '正常',
    cls: 'status-valid',
    tip: auth.tip
  };
}

// 下次自动启动时间：今日计划 / 即将启动 / 明日窗口 / 停用等
// 倒计时格式化：把「距下次执行的分钟数」显示为 HH:MM
function formatCountdown(minutes) {
  const total = Math.max(0, Math.round(Number(minutes) || 0));
  const h = Math.floor(total / 60);
  const m = total % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

// 下次自动启动：统一只显示倒计时（如 ⏰21:50 = 21 小时 50 分后执行）
function formatNextRun(sched) {
  if (!sched) return { text: '⏰ --', tip: '调度信息尚未就绪' };
  const windowText = `${sched.windowStart} - ${sched.windowEnd}`;
  switch (sched.status) {
    case 'scheduled': {
      const mins = Math.max(0, Math.round(sched.minutesUntil || 0));
      return {
        text: `⏰ ${formatCountdown(mins)}`,
        tip: `距下次自动启动约 ${Math.floor(mins / 60)} 小时 ${mins % 60} 分\n作息窗口：${windowText}`
      };
    }
    case 'imminent':
      return { text: '⏰ 00:00', tip: `已进入 ${windowText} 窗口，调度器下一分钟启动` };
    case 'disabled':
      return { text: '⏰ 已暂停', tip: '该账号已暂停，不会自动启动；手动刷新和手动体检仍可使用' };
    case 'no-credential':
      return { text: '⏰ 未配凭据', tip: '未配置 Cookie / Token，不会自动启动' };
    case 'schedule-off':
      return { text: '⏰ 定时关闭', tip: '后台定时巡检已关闭（可在「配置中心 → 定时巡检」开启）' };
    default:
      return { text: '⏰ --', tip: '调度信息尚未就绪' };
  }
}

function renderAccountsOverviewGrid(accounts, runtime = {}) {
  const grid = document.getElementById('accounts-grid');
  if (!grid) return;

  const { running = false, runningAccountId = null, schedule = {} } = runtime;
  const prepared = accounts.map(acc => {
    const isRunning = running && runningAccountId === acc.id;
    const runtimeStatus = getAccountRuntimeStatus(acc, { running, runningAccountId });
    const paused = acc.enabled === false;
    const nextRun = formatNextRun(schedule[acc.id]);
    return { acc, isRunning, runtimeStatus, paused, nextRun };
  });

  const signature = JSON.stringify(prepared.map(({ acc, isRunning, runtimeStatus, paused, nextRun }) => ({
    id: acc.id,
    name: acc.name,
    enabled: acc.enabled,
    earned: acc.earned,
    balance: acc.balance,
    claimablePoints: acc.claimablePoints,
    streakDays: acc.streakDays,
    doneTasks: acc.doneTasks,
    totalTasks: acc.totalTasks,
    percent: acc.percent,
    auth: acc.authDiagnosis,
    isRunning,
    runtimeStatus: runtimeStatus.key,
    paused,
    nextRun: nextRun.text,
    nextRunTip: nextRun.tip
  })));
  if (signature === accountsOverviewRenderSignature && grid.childElementCount === prepared.length) {
    return;
  }
  accountsOverviewRenderSignature = signature;
  grid.innerHTML = '';

  prepared.forEach(({ acc, isRunning, runtimeStatus, paused, nextRun }) => {
    const card = document.createElement('div');
    card.className = `account-overview-card ${runtimeStatus.cls}`;
    card.innerHTML = `
      <div class="acc-card-top">
        <div class="acc-card-title">
          <span>👤</span>
          <span class="acc-card-name" title="${escapeHtml(acc.name)}">${escapeHtml(acc.name)}</span>
        </div>
        <div class="acc-card-badges">
          ${isRunning
            ? '<span class="badge-mini badge-running">● 运行中</span>'
            : `<span class="badge-mini ${runtimeStatus.cls}" data-tip="${escapeHtml(runtimeStatus.tip)}">${runtimeStatus.icon} ${escapeHtml(runtimeStatus.label)}</span>`}
          <span class="badge-mini badge-schedule" data-tip="${escapeHtml(nextRun.tip)}">${nextRun.text}</span>
        </div>
      </div>

      <div class="acc-card-stats">
        <div class="acc-stat-box">
          <span class="acc-stat-lbl">今日已增</span>
          <span class="acc-stat-num" style="color:#34D399;">+${acc.earned || 0}</span>
        </div>
        <div class="acc-stat-box">
          <span class="acc-stat-lbl">当前总分</span>
          <span class="acc-stat-num">${(acc.balance || 0).toLocaleString()}</span>
        </div>
        <div class="acc-stat-box">
          <span class="acc-stat-lbl">连续签到</span>
          <span class="acc-stat-num" style="color:#F59E0B;">${acc.streakDays || 0}天</span>
        </div>
      </div>

      <div class="progress-wrap">
        <div class="progress-labels">
          <span>任务达成率: ${acc.doneTasks || 0}/${acc.totalTasks || 6} 项</span>
          <span>${acc.percent || 0}%</span>
        </div>
        <div class="progress-bar-track">
          <div class="progress-bar-fill" style="width: ${acc.percent || 0}%;"></div>
        </div>
      </div>

      <div class="acc-card-actions">
        <button class="btn btn-primary btn-sm btn-run-single" title="${paused ? '账号已暂停，请先启用' : '立即运行此账号打卡'}" ${paused ? 'disabled' : ''}>▶️ 运行</button>
        <button class="btn ${paused ? 'btn-success' : 'btn-warning'} btn-sm btn-pause-single" title="${paused ? '启用此账号' : '暂停此账号'}">${paused ? '▶️ 启用' : '⏸️ 暂停'}</button>
        <button class="btn btn-secondary btn-sm btn-sync-single" title="从微软官网同步该账号今日真实进度">🔄 刷新</button>
        <button class="btn btn-secondary btn-sm btn-view-acc" title="进入该账号明细大屏">明细 ➜</button>
        <div class="acc-more-wrap">
          <button class="btn btn-secondary btn-sm btn-more-actions" title="更多账号操作">•••</button>
          <div class="acc-more-dropdown">
            <button class="dropdown-item btn-edit-account" title="编辑账号信息与 Cookie 凭据">✏️ 编辑账号 / 更新凭据</button>
            <button class="dropdown-item btn-test-single-search" title="${paused ? '账号已暂停，请先启用' : '单独搜索一次 (拟人键盘输入，安全验证)'}" ${paused ? 'disabled' : ''}>🔍 单次安全测搜</button>
            <button class="dropdown-item btn-test-single" title="测试该账号登录状态">📋 账号状态体检</button>
            <div class="dropdown-sep"></div>
            <button class="dropdown-item btn-toggle-single">${paused ? '▶️ 启用账号' : '⏸️ 暂停账号'}</button>
          </div>
        </div>
      </div>
    `;

    const moreBtn = card.querySelector('.btn-more-actions');
    const moreMenu = card.querySelector('.acc-more-dropdown');
    moreBtn?.addEventListener('click', (e) => {
      e.stopPropagation();
      document.querySelectorAll('.acc-more-dropdown.show').forEach(m => {
        if (m !== moreMenu) m.classList.remove('show');
      });
      moreMenu?.classList.toggle('show');
    });

    card.querySelector('.btn-edit-account')?.addEventListener('click', (e) => {
      e.stopPropagation();
      document.querySelectorAll('.acc-more-dropdown.show').forEach(m => m.classList.remove('show'));
      openQuickAddAccountModal(acc.id);
    });

    // 绑定卡片上的各快捷按钮
    card.querySelector('.btn-sync-single')?.addEventListener('click', async (e) => {
      e.stopPropagation();
      const btn = e.target;
      const origText = btn.innerText;
      btn.innerText = '⏳ 同步中';
      openActionModal(
        `刷新账号进度 · ${acc.name}`,
        '正在从微软官网拉取该账号真实进度...',
        ['锁定账号上下文', '请求微软官网数据', '解析任务与积分', '刷新账号卡片'],
        0
      );
      startActionProgressTicker(12, 88, 8, '正在从微软官网拉取该账号真实进度...');
      try {
        const res = await fetch('/api/status/sync', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ accountId: acc.id, force: true })
        }).then(r => r.json());
        stopActionProgressTicker();
        if (res.success) {
          fetchStatus();
          if (res.skipped) {
            updateActionModal({
              progress: 100,
              badge: { text: '已跳过', cls: 'warn' },
              message: res.message || '任务正在执行中，已跳过同步',
              result: '为避免多账号上下文串台，本次同步已安全跳过。'
            });
          } else {
            updateActionModal({
              activeIndex: 4,
              progress: 100,
              badge: { text: '同步完成', cls: 'ok' },
              message: `账号 [${acc.name}] 进度已刷新`,
              result: buildMicrosoftStatusDetails(res.data)
            });
          }
        } else {
          updateActionModal({
            progress: 100,
            badge: { text: '同步失败', cls: 'err' },
            message: res.message || '同步失败',
            result: `失败原因：${res.message || '未知错误'}`
          });
        }
      } catch (err) {
        stopActionProgressTicker();
        updateActionModal({
          progress: 100,
          badge: { text: '同步异常', cls: 'err' },
          message: err.message,
          result: `同步异常：${err.message}`
        });
      } finally {
        btn.innerText = origText;
      }
    });

    card.querySelector('.btn-test-single-search')?.addEventListener('click', async (e) => {
      e.stopPropagation();
      const btn = e.target;
      const origText = btn.innerText;
      btn.innerText = '⏳ 测搜中...';
      openActionModal(
        `单次安全测搜 · ${acc.name}`,
        '正在执行一次拟人搜索并校验积分...',
        ['准备浏览器环境', '校验账号登录态', '执行拟人键盘搜索', '同步积分与配额', '输出测试明细'],
        0
      );
      startMicrosoftActionPolling();
      try {
        const res = await fetch('/api/tasks/single-search', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ accountId: acc.id })
        }).then(r => r.json());
        stopMicrosoftActionPolling();
        if (res.success) {
          const d = res.data || {};
          const credited = d.credited;
          const before = d.before ? `${d.before.progress}/${d.before.max}` : '未知';
          const after = d.after ? `${d.after.progress}/${d.after.max}` : '未知';
          const search = d.searchResult || {};
          const loginText = search.login?.userName
            ? `已登录：${search.login.userName}`
            : (search.login?.isGuest ? '游客态（不会计分）' : '登录态未识别');
          updateActionModal({
            activeIndex: 5,
            progress: 100,
            badge: credited === true
              ? { text: '已计分', cls: 'ok' }
              : { text: credited === false ? '未计分' : '已提交', cls: credited === false ? 'warn' : 'ok' },
            message: credited === true
              ? `账号 [${acc.name}] 搜索已计分`
              : `账号 [${acc.name}] 搜索已提交，官网暂未确认`,
            result: [
              res.data.message || '搜索动作已执行',
              `官网进度：${before} → ${after}`,
              `登录态：${loginText}`,
              search.finalUrl ? `结果页：${search.finalUrl}` : '',
              credited === false ? '如果连续多次仍未计分，可能是新号搜索观察期、搜索限流或账号市场不匹配。' : ''
            ].filter(Boolean).join('\n')
          });
          fetchStatus();
        } else {
          updateActionModal({
            progress: 100,
            badge: { text: '测搜失败', cls: 'err' },
            message: res.message || '测搜失败',
            result: `失败原因：${res.message || '未知错误'}`
          });
        }
      } catch (err) {
        stopMicrosoftActionPolling();
        updateActionModal({
          progress: 100,
          badge: { text: '请求异常', cls: 'err' },
          message: err.message,
          result: `请求异常：${err.message}`
        });
      } finally {
        btn.innerText = origText;
      }
    });

    card.querySelector('.btn-run-single')?.addEventListener('click', async (e) => {
      e.stopPropagation();
      const res = await fetch('/api/tasks/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accountId: acc.id })
      }).then(r => r.json());
      if (res.success) fetchStatus();
      else {
        openActionModal('无法启动账号任务', res.message || '启动失败', ['检查运行状态'], 0);
        updateActionModal({ progress: 100, badge: { text: '启动失败', cls: 'err' } });
      }
    });

    card.querySelector('.btn-pause-single')?.addEventListener('click', async (e) => {
      e.stopPropagation();
      await toggleAccountById(acc.id);
    });

    card.querySelector('.btn-toggle-single')?.addEventListener('click', async (e) => {
      e.stopPropagation();
      await toggleAccountById(acc.id);
    });

    card.querySelector('.btn-test-single')?.addEventListener('click', (e) => {
      e.stopPropagation();
      selectedAccountId = acc.id;
      diagMode = 'single';
      diagAccountId = acc.id;
      openModal('diag-modal');
      runAccountDiagnosis();
    });

    card.querySelector('.btn-view-acc')?.addEventListener('click', (e) => {
      e.stopPropagation();
      selectedAccountId = acc.id;
      fetchStatus();
      fetchHistory(currentHistoryDays);
    });

    card.addEventListener('click', () => {
      selectedAccountId = acc.id;
      fetchStatus();
      fetchHistory(currentHistoryDays);
    });

    grid.appendChild(card);
  });
}

// 建立 SSE 实时日志流
// 实时日志：保留全量日志，按当前选中账号过滤后渲染
let allLogs = [];
let accountNameById = {};

function logAccountName(log) {
  return log?.accountName || log?.tag || '系统';
}

function logMatchesSelectedAccount(log) {
  if (selectedAccountId === 'all') return true;
  const target = accountNameById[selectedAccountId];
  if (!target) return true;
  return logAccountName(log) === target;
}

function buildLogLine(log) {
  const div = document.createElement('div');
  div.className = 'log-line';
  const acc = logAccountName(log);
  const cls = acc === '系统' ? 'log-acc log-acc-system' : 'log-acc';
  div.innerHTML = `<span class="log-time">[${escapeHtml(log.time)}]</span> <span>${escapeHtml(log.icon)}</span> <strong class="${cls}">[${escapeHtml(acc)}]</strong> ${escapeHtml(log.message)}`;
  return div;
}

function renderLogs() {
  const terminal = document.getElementById('terminal-logs');
  if (!terminal) return;
  const chkAutoScroll = document.getElementById('chk-auto-scroll');
  const visible = allLogs.filter(log => (log.timestamp || 0) >= logViewSince && logMatchesSelectedAccount(log));
  terminal.innerHTML = '';
  if (visible.length === 0) {
    terminal.innerHTML = `<div class="log-empty">${logViewSince ? '暂无新日志（已清空当前页面显示，后端日志仍保留）' : '当前账号暂无日志记录'}</div>`;
    return;
  }
  const frag = document.createDocumentFragment();
  visible.forEach(log => frag.appendChild(buildLogLine(log)));
  terminal.appendChild(frag);
  if (chkAutoScroll?.checked) terminal.scrollTop = terminal.scrollHeight;
}

function initLogStream() {
  if (eventSource) eventSource.close();
  eventSource = new EventSource('/api/logs/stream');

  eventSource.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      if (data.type === 'history') {
        allLogs = Array.isArray(data.logs) ? data.logs : [];
        renderLogs();
      } else if (data.type === 'log') {
        allLogs.push(data.entry);
        if (allLogs.length > 800) allLogs.shift();
        appendLogToModal(data.entry);
        if ((data.entry.timestamp || 0) >= logViewSince && logMatchesSelectedAccount(data.entry)) {
          const terminal = document.getElementById('terminal-logs');
          const chkAutoScroll = document.getElementById('chk-auto-scroll');
          if (terminal) {
            terminal.appendChild(buildLogLine(data.entry));
            if (chkAutoScroll?.checked) terminal.scrollTop = terminal.scrollHeight;
          }
        }
      }
    } catch (e) {
      console.error('解析日志流失败:', e);
    }
  };
}

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function getSelectedAccount() {
  if (!selectedAccountId || selectedAccountId === 'all') return null;
  return (currentStatus?.summary?.accountsList || []).find(a => a.id === selectedAccountId) || null;
}

async function toggleSelectedAccount() {
  const acc = getSelectedAccount();
  if (!acc) return;
  await toggleAccountById(acc.id);
}

async function toggleAccountById(accountId) {
  try {
    const res = await fetch(`/api/accounts/${encodeURIComponent(accountId)}/toggle`, {
      method: 'POST'
    }).then(r => r.json());
    if (!res.success) throw new Error(res.message || '操作失败');
    await Promise.all([fetchStatus(), fetchConfig()]);
  } catch (e) {
    openActionModal('账号状态切换失败', e.message, ['更新账号状态', '刷新看板'], 0);
    updateActionModal({ progress: 100, badge: { text: '操作失败', cls: 'err' }, result: `操作失败：${e.message}` });
  }
}

async function runTasks() {
  try {
    const reqBody = selectedAccountId !== 'all' ? { accountId: selectedAccountId } : {};
    const res = await fetch('/api/tasks/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(reqBody)
    }).then(r => r.json());
    if (res.success) {
      fetchStatus();
    } else {
      openActionModal('无法启动任务', res.message || '启动失败', ['检查运行状态'], 0);
      updateActionModal({ progress: 100, badge: { text: '启动失败', cls: 'err' }, result: res.message || '' });
    }
  } catch (e) {
    openActionModal('启动任务异常', e.message, ['检查网络与运行状态'], 0);
    updateActionModal({ progress: 100, badge: { text: '请求异常', cls: 'err' }, result: `请求异常：${e.message}` });
  }
}

async function stopTasks() {
  try {
    const res = await fetch('/api/tasks/stop', { method: 'POST' }).then(r => r.json());
    if (!res.success) throw new Error(res.message || '停止失败');
    fetchStatus();
  } catch (e) {
    openActionModal('停止任务失败', e.message, ['发送停止指令'], 0);
    updateActionModal({ progress: 100, badge: { text: '停止失败', cls: 'err' }, result: `停止失败：${e.message}` });
  }
}

async function fetchConfig() {
  try {
    const res = await fetch('/api/config').then(r => r.json());
    if (res.success) {
      currentConfig = res.data;
      if (res.data.ui?.theme && !localStorage.getItem('ms_rewards_theme')) {
        setTheme(res.data.ui.theme, false);
      }
      const cronHint = document.getElementById('cron-hint');
      if (cronHint) {
        cronHint.innerText = `定时巡检: ${res.data.schedule?.enabled ? res.data.schedule?.cron : '已停用'}`;
      }
    }
  } catch (e) {
    console.error('获取配置失败:', e);
  }
}

// ===== 全局搜索节奏（任务与防风控） =====
const SEARCH_MAX_ROUNDS = 20;            // 单账号最多 20 次搜索（60 分 ÷ 3 分/次）
const SEARCH_WINDOW_MAX_SEC = 40 * 60;   // 1 小时档位中为启动随机与其他任务预留 20 分钟
const SEARCH_INTERVAL_MIN = 60;          // 安全下限：基础间隔（秒）
const SEARCH_INTERVAL_MAX = 120;
const SEARCH_JITTER_MIN = 30;            // 安全下限：随机浮动（秒）
const SEARCH_JITTER_MAX = 60;
const SEARCH_STAGNANT_MIN = 1;           // 停滞保护下限
const SEARCH_STAGNANT_MAX = 5;

// 停滞保护：连续多少次搜索官网进度不涨就停手
function readSearchStagnantLimit() {
  let value = parseInt(document.getElementById('cfg-search-stagnant')?.value, 10);
  if (isNaN(value)) value = 5;
  return Math.max(SEARCH_STAGNANT_MIN, Math.min(SEARCH_STAGNANT_MAX, value));
}

function readSearchRhythmInputs() {
  const intervalEl = document.getElementById('cfg-search-interval');
  const jitterEl = document.getElementById('cfg-search-jitter');
  let interval = parseInt(intervalEl?.value, 10);
  let jitter = parseInt(jitterEl?.value, 10);
  if (isNaN(interval)) interval = 60;
  if (isNaN(jitter)) jitter = 60;
  interval = Math.max(1, Math.min(SEARCH_INTERVAL_MAX, interval));
  jitter = Math.max(0, Math.min(SEARCH_JITTER_MAX, jitter));
  return { interval, jitter };
}

function formatDurationCN(sec) {
  const total = Math.max(0, Math.round(sec));
  const h = Math.floor(total / 3600);
  const m = Math.round((total % 3600) / 60);
  if (h > 0) return `${h} 小时 ${m} 分`;
  return `${m} 分钟`;
}

// 校验搜索节奏，返回错误文案；空字符串表示通过
function validateSearchRhythm() {
  const { interval, jitter } = readSearchRhythmInputs();
  if (interval < SEARCH_INTERVAL_MIN) {
    return `基础间隔不能低于 ${SEARCH_INTERVAL_MIN} 秒（防风控安全下限）`;
  }
  if (jitter < SEARCH_JITTER_MIN) {
    return `随机浮动不能低于 ${SEARCH_JITTER_MIN} 秒（防风控安全下限）`;
  }
  const slowestSec = (interval + jitter) * SEARCH_MAX_ROUNDS;
  if (slowestSec > SEARCH_WINDOW_MAX_SEC) {
    return `按最多 ${SEARCH_MAX_ROUNDS} 次搜索估算最慢需要 ${formatDurationCN(slowestSec)}，`
      + `超过 40 分钟搜索上限；请让「基础间隔 + 随机浮动」≤ 120 秒`;
  }
  return '';
}

// 更新预估执行时间提示；返回是否通过全部校验
function updateSearchRhythmHint() {
  const hint = document.getElementById('cfg-search-rhythm-hint');
  if (!hint) return true;
  const { interval, jitter } = readSearchRhythmInputs();
  // 随机浮动是「只延后」的叠加模型：单次实际等待 = 间隔 + 0~浮动 秒
  const fastestSec = interval * SEARCH_MAX_ROUNDS;
  const slowestSec = (interval + jitter) * SEARCH_MAX_ROUNDS;
  const err = validateSearchRhythm();

  if (!err) {
    hint.innerHTML = `按最多 ${SEARCH_MAX_ROUNDS} 次搜索估算：单次 ${interval}~${interval + jitter} 秒，`
      + `总耗时约 <strong>${formatDurationCN(fastestSec)} ~ ${formatDurationCN(slowestSec)}</strong>，`
      + `在 40 分钟搜索预算内 ✅（1 小时档位另留 20 分钟给随机启动与其他任务）`;
    hint.style.color = '';
  } else {
    hint.innerHTML = `⚠️ ${err}`;
    hint.style.color = '#F87171';
  }
  return !err;
}

const RUN_HOURS = Array.from({ length: 14 }, (_, index) => index + 9);

function normalizeRunHoursInput(value, fallback = [9]) {
  const values = Array.isArray(value) ? value : [];
  const valid = [...new Set(values
    .map(item => Number(item))
    .filter(item => Number.isInteger(item) && RUN_HOURS.includes(item)))]
    .sort((a, b) => a - b);
  return valid.length > 0 ? valid : fallback;
}

function buildRunHourOccupancy(excludeAccountId = null) {
  const occupancy = new Map();
  for (const account of currentConfig?.accounts || []) {
    if (excludeAccountId && account.id === excludeAccountId) continue;
    for (const hour of normalizeRunHoursInput(account.runHours || [account.timeSlot?.startHour])) {
      if (!occupancy.has(hour)) occupancy.set(hour, []);
      occupancy.get(hour).push(account.name || account.id);
    }
  }
  return occupancy;
}

function renderRunHourGrid(containerId, selectedHours = [9], options = {}) {
  const container = document.getElementById(containerId);
  if (!container) return;
  const selected = new Set(normalizeRunHoursInput(selectedHours));
  const occupancy = options.occupancy || buildRunHourOccupancy(options.excludeAccountId || null);
  container.innerHTML = RUN_HOURS.map(hour => {
    const accountNames = occupancy.get(hour) || [];
    const occupied = accountNames.length > 0;
    const tip = occupied ? `已被以下账号占用：${accountNames.join('、')}` : '';
    return `
      <label class="run-hour-option${occupied ? ' is-occupied' : ''}"
        ${occupied ? `data-tip="${escapeHtml(tip)}" title="${escapeHtml(tip)}"` : ''}>
        <input type="checkbox" value="${hour}" ${selected.has(hour) ? 'checked' : ''}>
        <span>${String(hour).padStart(2, '0')}:00</span>
        ${occupied ? '<i class="run-hour-occupied-dot" aria-hidden="true"></i>' : ''}
      </label>
    `;
  }).join('');
}

function readRunHours(containerId) {
  const container = document.getElementById(containerId);
  if (!container) return [];
  return [...container.querySelectorAll('input[type="checkbox"]:checked')]
    .map(input => Number(input.value))
    .filter(hour => RUN_HOURS.includes(hour))
    .sort((a, b) => a - b);
}

function buildLegacyTimeSlot(runHours) {
  const [startHour] = normalizeRunHoursInput(runHours);
  return {
    startHour,
    endHour: (startHour + 1) % 24,
    randomDelayMin: 10,
    durationHours: 1
  };
}

function cloneProxyDrafts(network = {}) {
  const source = Array.isArray(network?.proxies) ? network.proxies : [];
  return source.map((item, index) => ({
    id: item.id || `draft_proxy_${Date.now()}_${index}`,
    name: item.name || `代理 ${index + 1}`,
    url: item.url || item.proxyUrl || ''
  }));
}

function collectProxyDraftsFromDom() {
  const cards = Array.from(document.querySelectorAll('#proxy-list .proxy-card'));
  if (cards.length === 0 && proxyDrafts.length === 0) return [];
  proxyDrafts = cards.map((card, index) => ({
    id: card.getAttribute('data-proxy-id') || `draft_proxy_${Date.now()}_${index}`,
    name: card.querySelector('[data-proxy-field="name"]')?.value.trim() || `代理 ${index + 1}`,
    url: card.querySelector('[data-proxy-field="url"]')?.value.trim() || ''
  }));
  return proxyDrafts.map(item => ({ ...item }));
}

function getDefaultProxyId() {
  const select = document.getElementById('cfg-default-proxy');
  if (select) return select.value;
  return currentConfig?.network?.defaultProxyId || '';
}

function isGlobalProxyEnabled() {
  return document.getElementById('cfg-use-proxy')?.checked === true;
}

function setGlobalProxyEnabled(enabled) {
  const direct = document.getElementById('cfg-global-direct');
  const proxy = document.getElementById('cfg-use-proxy');
  if (direct) direct.checked = !enabled;
  if (proxy) proxy.checked = enabled;
}

function getProxyAssignedAccounts(proxyId) {
  if (!proxyId) return [];
  const network = currentConfig?.network || {};
  return (currentConfig?.accounts || []).flatMap(account => {
    if (account.proxyMode === 'proxy' && account.proxyId === proxyId) {
      return [{ name: account.name || account.id, mode: '指定' }];
    }
    if (
      account.proxyMode === 'inherit'
      && network.useProxy === true
      && network.defaultProxyId === proxyId
    ) {
      return [{ name: account.name || account.id, mode: '跟随全局' }];
    }
    return [];
  });
}

function renderProxyAssignedAccounts(proxyId) {
  const assigned = getProxyAssignedAccounts(proxyId);
  const chips = assigned.length > 0
    ? assigned.map(account => `
      <span class="proxy-assignment-chip" title="${escapeHtml(account.name)} · ${escapeHtml(account.mode)}">
        <span>${escapeHtml(account.name)}</span>
        <small>${escapeHtml(account.mode)}</small>
      </span>
    `).join('')
    : '<span class="proxy-assignment-empty">暂无账号使用</span>';
  return `
    <div class="proxy-card-assignments">
      <span class="proxy-assignments-label">当前分配账号</span>
      <div class="proxy-assignment-list">${chips}</div>
    </div>
  `;
}

function renderProxyCards(defaultProxyId = '') {
  const list = document.getElementById('proxy-list');
  if (!list) return;
  if (proxyDrafts.length === 0) {
    list.innerHTML = '<div class="proxy-empty">还没有代理节点。点击右上角「＋ 添加代理」创建第一套配置。</div>';
    return;
  }
  list.innerHTML = proxyDrafts.map((proxy, index) => `
    <div class="proxy-card${proxy.id === defaultProxyId ? ' is-default' : ''}" data-proxy-id="${escapeHtml(proxy.id)}">
      <div class="proxy-card-head">
        <span class="proxy-card-index">PROXY ${String(index + 1).padStart(2, '0')}</span>
        ${proxy.id === defaultProxyId ? '<span class="proxy-default-badge">全局默认</span>' : ''}
      </div>
      <div class="proxy-card-fields">
        <div class="proxy-field">
          <label>节点名称</label>
          <input type="text" class="form-input" data-proxy-field="name" maxlength="60"
            value="${escapeHtml(proxy.name)}" placeholder="例如：上海电信">
        </div>
        <div class="proxy-field">
          <label>代理地址</label>
          <input type="text" class="form-input" data-proxy-field="url" spellcheck="false"
            value="${escapeHtml(proxy.url)}" placeholder="http://127.0.0.1:7890 或 socks5://127.0.0.1:1080">
        </div>
      </div>
      ${renderProxyAssignedAccounts(proxy.id)}
      <div class="proxy-card-actions">
        <button type="button" class="btn btn-secondary btn-sm" data-proxy-action="test">测试</button>
        <button type="button" class="btn btn-primary btn-sm" data-proxy-action="save">保存</button>
        <button type="button" class="btn btn-danger-soft btn-sm" data-proxy-action="delete">删除</button>
      </div>
      <div class="proxy-card-status" data-proxy-status></div>
    </div>
  `).join('');
}

function renderDefaultProxyOptions(defaultProxyId = '') {
  const select = document.getElementById('cfg-default-proxy');
  if (!select) return;
  const options = [
    '<option value="">未选择默认代理</option>',
    ...proxyDrafts.map(proxy => `
      <option value="${escapeHtml(proxy.id)}" ${proxy.id === defaultProxyId ? 'selected' : ''}>
        ${escapeHtml(proxy.name || '未命名代理')}
      </option>
    `)
  ];
  select.innerHTML = options.join('');
}

function renderProxySettings() {
  const network = currentConfig?.network || {};
  const defaultProxyId = network.defaultProxyId || proxyDrafts[0]?.id || '';
  renderProxyCards(defaultProxyId);
  renderDefaultProxyOptions(defaultProxyId);
}

function setProxyStatus(proxyId, kind, html) {
  const card = Array.from(document.querySelectorAll('#proxy-list .proxy-card'))
    .find(item => item.getAttribute('data-proxy-id') === proxyId);
  const box = card?.querySelector('[data-proxy-status]');
  if (!box) return;
  box.className = `proxy-card-status${kind ? ` ${kind}` : ''}`;
  box.innerHTML = html;
}

function updateAccountProxyControls(preferredProxyId = null) {
  const modeEl = document.getElementById('cfg-account-proxy-mode');
  const nodeGroup = document.getElementById('cfg-account-proxy-node-group');
  const nodeEl = document.getElementById('cfg-account-proxy-id');
  const hintEl = document.getElementById('cfg-account-proxy-hint');
  if (!modeEl || !nodeGroup || !nodeEl || !hintEl) return;

  const mode = ['inherit', 'direct', 'proxy'].includes(modeEl.value) ? modeEl.value : 'direct';
  nodeEl.innerHTML = proxyDrafts.map(proxy => `
    <option value="${escapeHtml(proxy.id)}">${escapeHtml(proxy.name || '未命名代理')}</option>
  `).join('');

  if (mode === 'proxy') {
    nodeGroup.style.display = '';
    if (preferredProxyId && proxyDrafts.some(proxy => proxy.id === preferredProxyId)) {
      nodeEl.value = preferredProxyId;
    }
    if (proxyDrafts.length === 0) {
      nodeEl.innerHTML = '<option value="">暂无可用代理，请先在「网络与代理」中添加</option>';
      hintEl.textContent = '当前账号需要指定代理，但尚未保存任何代理节点。';
      hintEl.style.color = '#F59E0B';
    } else {
      const selected = proxyDrafts.find(proxy => proxy.id === nodeEl.value);
      hintEl.textContent = `该账号的 HTTP API、浏览器搜索和账号测试将使用「${selected?.name || '指定代理'}」。`;
      hintEl.style.color = '';
    }
    return;
  }

  nodeGroup.style.display = 'none';
  if (mode === 'direct') {
    hintEl.textContent = '该账号始终直连，不使用任何代理。';
    hintEl.style.color = '';
    return;
  }

  const useGlobal = isGlobalProxyEnabled();
  const defaultProxy = proxyDrafts.find(proxy => proxy.id === getDefaultProxyId());
  if (useGlobal && defaultProxy) {
    hintEl.textContent = `跟随全局：使用「${defaultProxy.name}」作为该账号出口。`;
    hintEl.style.color = '';
  } else {
    hintEl.textContent = '跟随全局：全局默认代理当前未启用，该账号将直连。';
    hintEl.style.color = '';
  }
}

function updateAuxiliaryProxyControls({
  modeId,
  groupId,
  nodeId,
  hintId,
  preferredProxyId = '',
  globalToggleId,
  useGlobalOverride,
  inheritHint = '跟随全局默认设置'
}) {
  const modeEl = document.getElementById(modeId);
  const nodeGroup = document.getElementById(groupId);
  const nodeEl = document.getElementById(nodeId);
  const hintEl = document.getElementById(hintId);
  if (!modeEl || !nodeGroup || !nodeEl || !hintEl) return;

  const mode = ['inherit', 'direct', 'proxy'].includes(modeEl.value) ? modeEl.value : 'direct';
  nodeEl.innerHTML = proxyDrafts.map(proxy => `
    <option value="${escapeHtml(proxy.id)}">${escapeHtml(proxy.name || '未命名代理')}</option>
  `).join('');

  if (mode === 'proxy') {
    nodeGroup.style.display = '';
    if (preferredProxyId && proxyDrafts.some(proxy => proxy.id === preferredProxyId)) {
      nodeEl.value = preferredProxyId;
    }
    if (proxyDrafts.length === 0) {
      nodeEl.innerHTML = '<option value="">暂无可用代理节点</option>';
      hintEl.textContent = '需要先在「网络与代理」中保存至少一个代理节点。';
      hintEl.style.color = '#F59E0B';
    } else {
      const selected = proxyDrafts.find(proxy => proxy.id === nodeEl.value);
      hintEl.textContent = `该账号的凭据测试、Token 换取和后续任务将使用「${selected?.name || '指定代理'}」。`;
      hintEl.style.color = '';
    }
    return;
  }

  nodeGroup.style.display = 'none';
  if (mode === 'direct') {
    hintEl.textContent = '该账号将直连，不使用任何代理。';
    hintEl.style.color = '#F59E0B';
    return;
  }

  const useGlobal = useGlobalOverride !== undefined
    ? useGlobalOverride
    : document.getElementById(globalToggleId)?.checked;
  const defaultProxyId = document.getElementById('cfg-default-proxy')?.value
    || currentConfig?.network?.defaultProxyId
    || '';
  const defaultProxy = proxyDrafts.find(proxy => proxy.id === defaultProxyId);
  hintEl.textContent = useGlobal && defaultProxy
    ? `${inheritHint}：使用「${defaultProxy.name}」。`
    : `${inheritHint}：全局默认代理未启用，该账号将直连。`;
  hintEl.style.color = useGlobal && defaultProxy ? '' : '#F59E0B';
}

function updateQuickAddProxyControls(preferredProxyId = '') {
  updateAuxiliaryProxyControls({
    modeId: 'quick-add-proxy-mode',
    groupId: 'quick-add-proxy-node-group',
    nodeId: 'quick-add-proxy-id',
    hintId: 'quick-add-proxy-hint',
    preferredProxyId,
    globalToggleId: 'cfg-use-proxy',
    useGlobalOverride: currentConfig?.network?.useProxy === true,
    inheritHint: '跟随全局默认设置'
  });
}

function updateGuideProxyControls(preferredProxyId = '') {
  updateAuxiliaryProxyControls({
    modeId: 'guide-account-proxy-mode',
    groupId: 'guide-account-proxy-node-group',
    nodeId: 'guide-account-proxy-id',
    hintId: 'guide-account-proxy-hint',
    preferredProxyId,
    globalToggleId: 'guide-use-proxy',
    inheritHint: '跟随全局默认设置'
  });
}

function readProxySelection(modeId, nodeId) {
  const mode = document.getElementById(modeId)?.value || 'direct';
  const proxyId = mode === 'proxy' ? (document.getElementById(nodeId)?.value || '') : '';
  return {
    mode: ['inherit', 'direct', 'proxy'].includes(mode) ? mode : 'direct',
    proxyId
  };
}

function resolveGuideProxyTestTarget() {
  const selection = readProxySelection('guide-account-proxy-mode', 'guide-account-proxy-id');
  if (selection.mode === 'proxy') {
    const proxy = proxyDrafts.find(item => item.id === selection.proxyId);
    if (!proxy?.url) return { error: '请选择有效的代理节点' };
    return { useProxy: true, proxyUrl: proxy.url, label: `指定代理：${proxy.name}` };
  }
  if (selection.mode === 'inherit' && document.getElementById('guide-use-proxy')?.checked) {
    const proxyUrl = document.getElementById('guide-proxy-url')?.value.trim() || '';
    if (!proxyUrl) return { error: '已选择跟随全局代理，请填写全局默认代理地址' };
    return { useProxy: true, proxyUrl, label: '跟随全局默认代理' };
  }
  return { useProxy: false, proxyUrl: '', label: '直连（容器默认网络）' };
}

function describeProxySelection(selection) {
  if (selection.mode === 'direct') return '直连（不使用代理）';
  if (selection.mode === 'proxy') {
    const proxy = proxyDrafts.find(item => item.id === selection.proxyId);
    return proxy ? `指定代理：${proxy.name}` : '指定代理未选择';
  }
  const defaultProxyId = currentConfig?.network?.defaultProxyId || '';
  const defaultProxy = proxyDrafts.find(item => item.id === defaultProxyId);
  const enabled = currentConfig?.network?.useProxy && defaultProxy;
  return enabled ? `跟随全局：${defaultProxy.name}` : '跟随全局：当前为直连';
}

async function persistProxyDrafts(drafts, defaultProxyId, statusProxyId = '') {
  const response = await fetch('/api/network/proxies', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      proxies: drafts,
      defaultProxyId,
      useProxy: isGlobalProxyEnabled(),
      lockRegion: document.getElementById('cfg-lock-region')?.checked !== false
    })
  }).then(r => r.json());
  if (!response.success) throw new Error(response.message || '代理配置保存失败');

  currentConfig.network = response.data.network;
  const accountProxyUpdates = new Map(
    (response.data.accounts || []).map(item => [item.id, item])
  );
  currentConfig.accounts = (currentConfig.accounts || []).map(account => {
    const update = accountProxyUpdates.get(account.id);
    return update
      ? { ...account, proxyMode: update.proxyMode, proxyId: update.proxyId }
      : account;
  });
  proxyDrafts = cloneProxyDrafts(response.data.network);
  setGlobalProxyEnabled(!!response.data.network.useProxy);
  renderProxyCards(response.data.network.defaultProxyId || '');
  renderDefaultProxyOptions(response.data.network.defaultProxyId || '');
  const currentAccount = currentConfig.accounts.find(account => account.id === editingAccountIdInModal);
  document.getElementById('cfg-account-proxy-mode').value = currentAccount?.proxyMode || 'direct';
  updateAccountProxyControls(currentAccount?.proxyId || '');

  for (const proxy of proxyDrafts) {
    setProxyStatus(proxy.id, 'ok', '✅ 已保存并生效');
  }
  if (statusProxyId) {
    setProxyStatus(statusProxyId, 'ok', '✅ 已保存并生效');
  }
  return response.data;
}

async function saveProxySettingsFromCards() {
  const drafts = collectProxyDraftsFromDom();
  const invalid = drafts.find(item => !item.url);
  if (invalid) {
    setProxyStatus(invalid.id, 'err', '❌ 请先填写代理地址');
    return;
  }
  const defaultProxyId = getDefaultProxyId() || drafts[0]?.id || '';
  const activeCard = document.activeElement?.closest?.('.proxy-card');
  const statusProxyId = activeCard?.getAttribute('data-proxy-id') || '';
  try {
    for (const proxy of drafts) setProxyStatus(proxy.id, '', '⏳ 正在保存代理配置...');
    await persistProxyDrafts(drafts, defaultProxyId, statusProxyId);
  } catch (e) {
    const targetId = statusProxyId || drafts[0]?.id;
    if (targetId) setProxyStatus(targetId, 'err', `❌ ${escapeHtml(e.message)}`);
  }
}

async function testProxyCard(proxyId) {
  const drafts = collectProxyDraftsFromDom();
  const proxy = drafts.find(item => item.id === proxyId);
  if (!proxy) return;
  if (!proxy.url) {
    setProxyStatus(proxyId, 'err', '❌ 请先填写代理地址');
    return;
  }
  setProxyStatus(proxyId, '', '⏳ 正在通过该代理访问网络并查询出口 IP...');
  try {
    const res = await fetch('/api/proxy/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ proxyUrl: proxy.url, useProxy: true })
    }).then(r => r.json());
    if (!res.success) {
      setProxyStatus(proxyId, 'err', `❌ ${escapeHtml(res.message || '代理不可用')}`);
      return;
    }
    const regionText = res.regionPass
      ? `中国大陆 ${escapeHtml(res.region || 'CN')} · 国区检测通过`
      : `出口地区 ${escapeHtml(res.region || '未知')} · 非国区`;
    setProxyStatus(
      proxyId,
      res.regionPass ? 'ok' : 'warn',
      `✅ ${escapeHtml(res.ipInfo || '代理已连通')}<br>${regionText} · ${Number(res.latencyMs || 0)} ms`
    );
  } catch (e) {
    setProxyStatus(proxyId, 'err', `❌ 测试请求失败：${escapeHtml(e.message)}`);
  }
}

async function deleteProxyCard(proxyId) {
  const drafts = collectProxyDraftsFromDom();
  const proxy = drafts.find(item => item.id === proxyId);
  if (!proxy) return;
  const confirmed = await showWebConfirm(
    `确定删除代理「${proxy.name || '未命名代理'}」吗？\n使用该节点的账号会自动改为跟随全局设置。`,
    '删除代理配置'
  );
  if (!confirmed) return;

  const remaining = drafts.filter(item => item.id !== proxyId);
  const persisted = (currentConfig?.network?.proxies || []).some(item => item.id === proxyId);
  if (!persisted) {
    const oldDefault = getDefaultProxyId();
    const nextDefault = oldDefault === proxyId ? (remaining[0]?.id || '') : oldDefault;
    proxyDrafts = remaining;
    renderProxyCards(nextDefault);
    renderDefaultProxyOptions(nextDefault);
    updateAccountProxyControls(document.getElementById('cfg-account-proxy-id')?.value || '');
    return;
  }

  const oldDefault = getDefaultProxyId();
  const nextDefault = oldDefault === proxyId ? (remaining[0]?.id || '') : oldDefault;
  try {
    await persistProxyDrafts(remaining, nextDefault);
  } catch (e) {
    setProxyStatus(proxyId, 'err', `❌ 删除失败：${escapeHtml(e.message)}`);
  }
}

function populateSettingsForm() {
  if (!currentConfig) return;
  const c = currentConfig;
  const accounts = c.accounts || [];

  // 1. 填充多账号下拉框
  const accSelect = document.getElementById('cfg-account-select');
  if (accSelect) {
    accSelect.innerHTML = accounts.map(a => `
      <option value="${a.id}" ${editingAccountIdInModal === a.id ? 'selected' : ''}>
        ${escapeHtml(a.name || a.id)}
      </option>
    `).join('');
    if (!editingAccountIdInModal && accounts.length > 0) {
      editingAccountIdInModal = accounts[0].id;
    }
  }

  // 网络与代理。先准备代理列表，账号区域才能渲染代理节点下拉框。
  proxyDrafts = cloneProxyDrafts(c.network);
  renderProxySettings();
  setGlobalProxyEnabled(!!c.network?.useProxy);
  document.getElementById('cfg-lock-region').checked = c.network?.lockRegion !== false;
  loadAccountIntoForm(editingAccountIdInModal);

  // 任务
  document.getElementById('cfg-task-sign').checked = c.tasks?.sign !== false;
  document.getElementById('cfg-task-read').checked = c.tasks?.read !== false;
  document.getElementById('cfg-task-search').checked = c.tasks?.search !== false;
  document.getElementById('cfg-task-promos').checked = c.tasks?.promos !== false;
  document.getElementById('cfg-task-dailyset').checked = c.tasks?.dailySet !== false;
  document.getElementById('cfg-task-desktop').checked = c.tasks?.desktopApp !== false;
  document.getElementById('cfg-task-keep').checked = c.tasks?.keepRunning !== false;
  const intervalEl = document.getElementById('cfg-search-interval');
  const jitterEl = document.getElementById('cfg-search-jitter');
  if (intervalEl) intervalEl.value = c.tasks?.searchIntervalSec ?? 60;
  if (jitterEl) jitterEl.value = c.tasks?.searchJitterSec ?? 60;
  const stagnantEl = document.getElementById('cfg-search-stagnant');
  if (stagnantEl) stagnantEl.value = Math.min(5, c.tasks?.searchStagnantLimit ?? 5);
  const gapEl = document.getElementById('cfg-account-gap');
  if (gapEl) gapEl.value = c.tasks?.accountGapSec ?? 180;
  updateSearchRhythmHint();
  document.getElementById('cfg-search-engine').value = c.tasks?.searchEngineMode || 'browser';
  document.getElementById('cfg-search-api').value = c.tasks?.searchApi || 'baidu.official';
  // 主题
  const themeVal = 'dark';
  const themeSelect = document.getElementById('cfg-ui-theme');
  if (themeSelect) themeSelect.value = themeVal;
  // 调度
  document.getElementById('cfg-sched-enabled').checked = c.schedule?.enabled !== false;
  document.getElementById('cfg-sched-cron').value = c.schedule?.cron || '*/25 * * * *';
  // Web 访问密码
  const authPassElem = document.getElementById('cfg-auth-password');
  if (authPassElem) authPassElem.value = c.server?.authPassword || '';
  // 通知
  document.getElementById('cfg-notify-wework').value = c.notify?.wework || '';
  document.getElementById('cfg-notify-dingding').value = c.notify?.dingding || '';
  document.getElementById('cfg-notify-feishu').value = c.notify?.feishu || '';
  document.getElementById('cfg-notify-bark').value = c.notify?.bark || '';
  document.getElementById('cfg-notify-pushme').value = c.notify?.pushme || '';
  document.getElementById('cfg-notify-tg-token').value = c.notify?.telegram?.botToken || '';
  document.getElementById('cfg-notify-tg-chat').value = c.notify?.telegram?.chatId || '';
  const qqBot = c.notify?.qqBot || {};
  const qqAppIdEl = document.getElementById('cfg-notify-qq-appid');
  const qqSecretEl = document.getElementById('cfg-notify-qq-secret');
  const qqTypeEl = document.getElementById('cfg-notify-qq-type');
  const qqOpenidEl = document.getElementById('cfg-notify-qq-openid');
  if (qqAppIdEl) qqAppIdEl.value = qqBot.appId || '';
  if (qqSecretEl) qqSecretEl.value = qqBot.clientSecret || '';
  if (qqTypeEl) qqTypeEl.value = ['group', 'user', 'channel'].includes(qqBot.openidType) ? qqBot.openidType : 'group';
  if (qqOpenidEl) qqOpenidEl.value = qqBot.openid || '';

  // 液态视觉与背景
  const visualVal = c.visual || JSON.parse(localStorage.getItem('msr_visual_config') || 'null') || DEFAULT_VISUAL_CONFIG;
  applyVisualConfig(visualVal);
}

function loadAccountIntoForm(accId) {
  if (!currentConfig || !Array.isArray(currentConfig.accounts)) return;
  const acc = currentConfig.accounts.find(a => a.id === accId) || currentConfig.accounts[0];
  if (!acc) return;

  editingAccountIdInModal = acc.id;
  document.getElementById('cfg-account-name').value = acc.name || '';
  const orderElem = document.getElementById('cfg-account-order');
  if (orderElem) orderElem.value = acc.order !== undefined ? acc.order : 1;
  document.getElementById('cfg-account-enabled').checked = acc.enabled !== false;
  const proxyMode = ['inherit', 'direct', 'proxy'].includes(acc.proxyMode)
    ? acc.proxyMode
    : (acc.proxyId ? 'proxy' : 'direct');
  document.getElementById('cfg-account-proxy-mode').value = proxyMode;
  updateAccountProxyControls(acc.proxyId || '');

  // 凭据字段：接口已脱敏，这里只回填占位符，避免把明文重新渲染到 DOM
  const cookieElem = document.getElementById('cfg-cookie');
  const authCodeElem = document.getElementById('cfg-authcode');
  const hasCookie = acc.cookie === SECRET_PLACEHOLDER || !!acc.hasCookie;
  const hasAuthCode = acc.authCodeUrl === SECRET_PLACEHOLDER || !!acc.hasAuthCodeUrl;
  cookieElem.value = '';
  authCodeElem.value = '';
  cookieElem.placeholder = hasCookie ? '已配置 Cookie（内容已隐藏，可重新粘贴覆盖）' : COOKIE_INPUT_PLACEHOLDER;
  authCodeElem.placeholder = hasAuthCode ? '已配置授权码（内容已隐藏，可重新粘贴覆盖）' : '粘贴包含 code= 的完整跳转链接';
  cookieElem.type = 'password';
  authCodeElem.type = 'password';
  document.querySelectorAll('.secret-toggle').forEach(btn => { btn.textContent = '👁'; });
  updateCookieHint(hasCookie);

  const refreshTokenElem = document.getElementById('cfg-refresh-token');
  if (refreshTokenElem) {
    refreshTokenElem.value = acc.refreshToken ? '********' : '';
    delete refreshTokenElem.dataset.clear;
  }
  const cookieRes = document.getElementById('cfg-cookie-test-result');
  if (cookieRes) cookieRes.innerHTML = '';
  const authRes = document.getElementById('cfg-auth-test-result');
  if (authRes) authRes.innerHTML = '';

  renderRunHourGrid('cfg-run-hours', acc.runHours || [acc.timeSlot?.startHour || 9], {
    excludeAccountId: acc.id
  });
}

async function saveSettingsFromModal() {
  const saveStatus = document.getElementById('settings-save-status');
  const setSaveStatus = (kind, text) => {
    if (!saveStatus) return;
    saveStatus.className = `settings-save-status${kind ? ` ${kind}` : ''}`;
    saveStatus.textContent = text;
  };
  setSaveStatus('', '');
  // 保护：配置还没加载完成时保存，会用空数据覆盖掉所有账号（连同 Cookie/Token）
  if (!currentConfig || !Array.isArray(currentConfig.accounts) || currentConfig.accounts.length === 0) {
    setSaveStatus('err', '配置尚未加载完成');
    openActionModal('配置尚未加载完成', '为避免覆盖账号数据，请稍后重试。', ['等待配置加载', '重新保存'], 0);
    updateActionModal({ progress: 100, badge: { text: '暂不可保存', cls: 'warn' } });
    return;
  }
  // 搜索节奏必须满足安全下限并落在 40 分钟搜索预算内，否则拒绝保存
  const rhythmError = validateSearchRhythm();
  if (rhythmError) {
    setSaveStatus('err', rhythmError);
    updateSearchRhythmHint();
    openActionModal('搜索节奏设置无效', rhythmError, ['调整搜索间隔', '重新保存'], 0);
    updateActionModal({ progress: 100, badge: { text: '参数无效', cls: 'err' } });
    return;
  }
  const searchRhythm = readSearchRhythmInputs();
  const proxyDraftsForSave = collectProxyDraftsFromDom();
  const invalidProxy = proxyDraftsForSave.find(item => !item.url);
  if (invalidProxy) {
    setSaveStatus('err', '代理配置不完整');
    openActionModal('代理配置不完整', '请为每一套代理填写地址，或删除不需要的空白节点。', ['检查代理地址', '重新保存'], 0);
    updateActionModal({ progress: 100, badge: { text: '参数无效', cls: 'err' } });
    return;
  }
  const useProxy = isGlobalProxyEnabled();
  const defaultProxyId = getDefaultProxyId() || proxyDraftsForSave[0]?.id || '';
  if (useProxy && !defaultProxyId) {
    setSaveStatus('err', '缺少默认代理');
    openActionModal('缺少默认代理', '启用全局默认代理后，请至少添加并选择一个代理节点。', ['添加代理', '重新保存'], 0);
    updateActionModal({ progress: 100, badge: { text: '参数无效', cls: 'warn' } });
    return;
  }
  const accountProxyMode = document.getElementById('cfg-account-proxy-mode')?.value || 'direct';
  const accountProxyId = accountProxyMode === 'proxy'
    ? (document.getElementById('cfg-account-proxy-id')?.value || '')
    : '';
  if (accountProxyMode === 'proxy' && !accountProxyId) {
    setSaveStatus('err', '当前账号缺少指定代理');
    openActionModal('缺少账号代理', '当前账号选择了「使用指定代理」，请先选择一套代理节点。', ['选择代理节点', '重新保存'], 0);
    updateActionModal({ progress: 100, badge: { text: '参数无效', cls: 'warn' } });
    return;
  }
  const runHours = readRunHours('cfg-run-hours');
  if (runHours.length === 0) {
    setSaveStatus('err', '请至少勾选一个运行时间档位');
    openActionModal('缺少运行时间', '请至少勾选一个每日运行时间档位。', ['勾选时间档位', '重新保存'], 0);
    updateActionModal({ progress: 100, badge: { text: '参数无效', cls: 'warn' } });
    return;
  }
  const currentAccId = editingAccountIdInModal || 'acc_1';
  const currentAccounts = currentConfig?.accounts || [];
  const idx = currentAccounts.findIndex(a => a.id === currentAccId);

  const updatedAccountData = {
    id: currentAccId,
    name: document.getElementById('cfg-account-name').value.trim() || '账号',
    order: parseInt(document.getElementById('cfg-account-order')?.value, 10) || 1,
    enabled: document.getElementById('cfg-account-enabled').checked,
    cookie: document.getElementById('cfg-cookie').value.trim(),
    authCodeUrl: document.getElementById('cfg-authcode').value.trim(),
    proxyMode: accountProxyMode,
    proxyId: accountProxyId,
    runHours,
    timeSlot: buildLegacyTimeSlot(runHours)
  };
  if (document.getElementById('cfg-refresh-token')?.dataset.clear === '1') {
    updatedAccountData.refreshToken = SECRET_CLEAR;
    updatedAccountData.accessToken = SECRET_CLEAR;
  }

  if (idx !== -1) {
    currentAccounts[idx] = { ...currentAccounts[idx], ...updatedAccountData };
  } else {
    currentAccounts.push(updatedAccountData);
  }

  const selectedTheme = 'dark';
  setTheme(selectedTheme);

  const visualConfig = readVisualInputs();
  localStorage.setItem('msr_visual_config', JSON.stringify(visualConfig));
  applyVisualConfig(visualConfig);

  const updateData = {
    accounts: currentAccounts,
    visual: visualConfig,
    network: {
      useProxy,
      proxyUrl: proxyDraftsForSave.find(item => item.id === defaultProxyId)?.url || '',
      proxies: proxyDraftsForSave,
      defaultProxyId,
      lockRegion: document.getElementById('cfg-lock-region').checked
    },
    tasks: {
      sign: document.getElementById('cfg-task-sign').checked,
      read: document.getElementById('cfg-task-read').checked,
      search: document.getElementById('cfg-task-search').checked,
      promos: document.getElementById('cfg-task-promos').checked,
      dailySet: document.getElementById('cfg-task-dailyset').checked,
      desktopApp: document.getElementById('cfg-task-desktop').checked,
      keepRunning: document.getElementById('cfg-task-keep').checked,
      searchIntervalSec: searchRhythm.interval,
      searchJitterSec: searchRhythm.jitter,
      searchStagnantLimit: readSearchStagnantLimit(),
      accountGapSec: Math.max(15, parseInt(document.getElementById('cfg-account-gap')?.value, 10) || 180),
      searchEngineMode: document.getElementById('cfg-search-engine')?.value || 'browser',
      searchApi: document.getElementById('cfg-search-api')?.value || 'baidu.official'
    },
    ui: {
      theme: selectedTheme
    },
    schedule: {
      enabled: document.getElementById('cfg-sched-enabled').checked,
      cron: document.getElementById('cfg-sched-cron').value.trim()
    },
    server: {
      authPassword: document.getElementById('cfg-auth-password')?.value.trim() || ''
    },
    notify: {
      wework: document.getElementById('cfg-notify-wework').value.trim(),
      dingding: document.getElementById('cfg-notify-dingding').value.trim(),
      feishu: document.getElementById('cfg-notify-feishu').value.trim(),
      bark: document.getElementById('cfg-notify-bark').value.trim(),
      pushme: document.getElementById('cfg-notify-pushme').value.trim(),
      telegram: {
        botToken: document.getElementById('cfg-notify-tg-token').value.trim(),
        chatId: document.getElementById('cfg-notify-tg-chat').value.trim()
      },
      qqBot: {
        appId: document.getElementById('cfg-notify-qq-appid')?.value.trim() || '',
        clientSecret: document.getElementById('cfg-notify-qq-secret')?.value.trim() || '',
        openidType: document.getElementById('cfg-notify-qq-type')?.value || 'group',
        openid: document.getElementById('cfg-notify-qq-openid')?.value.trim() || ''
      }
    }
  };

  setSaveStatus('', '正在保存...');
  const res = await fetch('/api/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(updateData)
  }).then(r => r.json());

  if (res.success) {
    currentConfig = res.data;
    renderRunHourGrid('cfg-run-hours', runHours, { excludeAccountId: currentAccId });
    setSaveStatus('ok', '✅ 配置已保存并即时生效');
    fetchStatus();
  } else {
    setSaveStatus('err', `保存失败：${res.message || '未知错误'}`);
  }
}

async function saveGuideNetworkSettings() {
  const useProxy = document.getElementById('guide-use-proxy').checked;
  const proxyUrl = document.getElementById('guide-proxy-url').value.trim();
  const lockRegion = document.getElementById('guide-lock-region').checked;
  const proxySelection = readProxySelection('guide-account-proxy-mode', 'guide-account-proxy-id');
  const result = document.getElementById('guide-proxy-result');
  if (useProxy && !proxyUrl) {
    if (result) result.innerHTML = '<span style="color:#EF4444;">已启用全局代理，请填写代理地址。</span>';
    return;
  }
  if (proxySelection.mode === 'proxy' && !proxySelection.proxyId) {
    if (result) result.innerHTML = '<span style="color:#EF4444;">当前账号选择了指定代理，请选择可用节点。</span>';
    return;
  }

  const button = document.getElementById('guide-btn-save-network');
  const originalText = button?.innerText || '';
  if (button) {
    button.disabled = true;
    button.innerText = '正在保存网络出口...';
  }
  try {
    const res = await fetch('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ network: { useProxy, proxyUrl, lockRegion } })
    }).then(r => r.json());
    if (!res.success) throw new Error(res.message || '网络配置保存失败');

    currentConfig = res.data;
    proxyDrafts = cloneProxyDrafts(currentConfig.network);
    guideDraftAccount.proxyMode = proxySelection.mode;
    guideDraftAccount.proxyId = proxySelection.proxyId;
    guideNetworkConfirmed = true;
    updateGuideProxyControls(proxySelection.proxyId);

    const routeText = describeProxySelection(proxySelection);
    const summary = `本次账号会话出口：${routeText}。后续 Cookie 测试与 Token 换取将使用该出口。`;
    document.getElementById('guide-token-network-summary').textContent = summary;
    document.getElementById('guide-cookie-network-summary').textContent = summary;
    if (result) result.innerHTML = `<span style="color:#34D399;">✅ 网络出口已保存：${escapeHtml(routeText)}</span>`;
    switchStep(2, { force: true });
  } catch (e) {
    guideNetworkConfirmed = false;
    if (result) result.innerHTML = `<span style="color:#EF4444;">保存失败：${escapeHtml(e.message)}</span>`;
  } finally {
    if (button) {
      button.disabled = false;
      button.innerText = originalText;
    }
  }
}

async function saveGuideSettings() {
  if (!guideNetworkConfirmed) {
    openActionModal('请先确认网络出口', '必须先保存代理策略，才能绑定 Cookie 或 Token。', ['返回网络出口', '重新保存'], 0);
    updateActionModal({ progress: 100, badge: { text: '参数缺失', cls: 'warn' } });
    return;
  }

  const runHours = readRunHours('guide-run-hours');
  if (runHours.length === 0) {
    openActionModal('缺少运行时间', '请至少勾选一个每日运行时间档位。', ['勾选时间档位', '重新保存'], 0);
    updateActionModal({ progress: 100, badge: { text: '参数缺失', cls: 'warn' } });
    return;
  }

  // 1) 保存账号本身：名称 / 序号 / Cookie / Token / 时段
  //    以前这里只提交 account.timeSlot，会被 update() 写到第一个账号上，
  //    向导里填的名称和序号则完全没有保存过。
  const name = document.getElementById('guide-account-name')?.value.trim() || guideDraftAccount.name;
  const order = parseInt(document.getElementById('guide-account-order')?.value, 10) || guideDraftAccount.order;
  const cookie = document.getElementById('guide-cookie-input')?.value.trim() || guideDraftAccount.cookie;

  try {
    const accRes = await fetch('/api/accounts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: guideDraftAccount.id,
        name,
        order,
        enabled: true,
        cookie,
        authCodeUrl: guideDraftAccount.authCodeUrl,
        refreshToken: guideDraftAccount.refreshToken,
        accessToken: guideDraftAccount.accessToken,
        tokenTime: guideDraftAccount.tokenTime,
    proxyMode: guideDraftAccount.proxyMode || 'direct',
        proxyId: guideDraftAccount.proxyId || '',
        runHours,
        tokenAlreadyExchanged: !!(guideDraftAccount.refreshToken && guideDraftAccount.accessToken),
        timeSlot: buildLegacyTimeSlot(runHours)
      })
    }).then(r => r.json());
    if (!accRes.success || !accRes.data?.id) {
      throw new Error(accRes.message || '账号保存失败');
    }
    selectedAccountId = accRes.data.id;
  } catch (e) {
    openActionModal('向导保存失败', e.message, ['保存账号资料', '校验网络出口'], 0);
    updateActionModal({ progress: 100, badge: { text: '保存失败', cls: 'err' }, result: `保存失败：${e.message}` });
    return;
  }

  fetchConfig();
  fetchStatus();
  switchStep(4);
}

window.testNotifyChannel = async function(channel) {
  let val = '';
  if (channel === 'telegram') {
    const botToken = document.getElementById('cfg-notify-tg-token')?.value.trim();
    const chatId = document.getElementById('cfg-notify-tg-chat')?.value.trim();
    if (!botToken || !chatId) {
      openActionModal('通知参数缺失', '请先输入 Telegram Bot Token 和 Chat ID。', ['填写参数', '重新测试'], 0);
      updateActionModal({ progress: 100, badge: { text: '参数缺失', cls: 'warn' } });
      return;
    }
    val = JSON.stringify({ botToken, chatId });
  } else if (channel === 'qqbot') {
    const appId = document.getElementById('cfg-notify-qq-appid')?.value.trim();
    const clientSecret = document.getElementById('cfg-notify-qq-secret')?.value.trim();
    const openidType = document.getElementById('cfg-notify-qq-type')?.value || 'group';
    const openid = document.getElementById('cfg-notify-qq-openid')?.value.trim();
    if (!appId || !clientSecret || !openid) {
      openActionModal('QQ 机器人参数缺失', '请先填写 AppID、AppSecret 与 OpenID（群聊填 group_openid，私聊填 user_openid）。', ['填写参数', '重新测试'], 0);
      updateActionModal({ progress: 100, badge: { text: '参数缺失', cls: 'warn' } });
      return;
    }
    val = { appId, clientSecret, openidType, openid };
  } else {
    const idMap = {
      wework: 'cfg-notify-wework',
      dingding: 'cfg-notify-dingding',
      feishu: 'cfg-notify-feishu',
      bark: 'cfg-notify-bark',
      pushme: 'cfg-notify-pushme'
    };
    val = document.getElementById(idMap[channel])?.value.trim();
    if (!val) {
      openActionModal('通知参数缺失', '请先输入配置的值。', ['填写参数', '重新测试'], 0);
      updateActionModal({ progress: 100, badge: { text: '参数缺失', cls: 'warn' } });
      return;
    }
  }

  openActionModal('通知测试', `正在测试「${channel}」通知渠道...`, ['校验参数', '发送测试消息', '返回结果'], 0);
  startActionProgressTicker(15, 85, 10, `正在测试「${channel}」通知渠道...`);
  try {
    const res = await fetch('/api/notify/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ channel, value: val })
    }).then(r => r.json());
    stopActionProgressTicker();
    if (res.success) {
      updateActionModal({ activeIndex: 3, progress: 100, badge: { text: '发送成功', cls: 'ok' }, message: '测试消息发送成功', result: `「${channel}」测试消息发送成功，请查收。` });
    } else {
      updateActionModal({ progress: 100, badge: { text: '发送失败', cls: 'err' }, message: res.message || '测试发送失败', result: `测试发送失败：${res.message || '未知错误'}` });
    }
  } catch (e) {
    stopActionProgressTicker();
    updateActionModal({ progress: 100, badge: { text: '测试异常', cls: 'err' }, message: e.message, result: `测试异常：${e.message}` });
  }
};

// 账号体检：根据范围选择分发到「单个账号」或「全部账号」
function syncDiagScopeUI() {
  document.querySelectorAll('#diag-scope-group .diag-scope-btn').forEach(btn => {
    btn.classList.toggle('active', btn.getAttribute('data-mode') === diagMode);
  });
  const selectWrap = document.getElementById('diag-account-select');
  if (selectWrap) selectWrap.style.display = diagMode === 'single' ? '' : 'none';
}

function populateDiagAccountSelect() {
  const select = document.getElementById('diag-account-select');
  if (!select) return;
  const accounts = currentConfig?.accounts || [];
  if (!diagAccountId || !accounts.some(a => a.id === diagAccountId)) {
    diagAccountId = accounts[0]?.id || 'acc_1';
  }
  select.innerHTML = accounts.map(a =>
    `<option value="${a.id}" ${a.id === diagAccountId ? 'selected' : ''}>${escapeHtml(a.name || a.id)}</option>`
  ).join('');
}

function setDiagMode(mode) {
  diagMode = mode === 'all' ? 'all' : 'single';
  syncDiagScopeUI();
  if (diagMode === 'single') populateDiagAccountSelect();
  runAccountDiagnosis();
}

async function runAccountDiagnosis() {
  syncDiagScopeUI();
  if (diagMode === 'single') {
    populateDiagAccountSelect();
    await runSingleAccountDiagnosis(diagAccountId);
  } else {
    await runAllAccountDiagnosis();
  }
}

function setDiagLoading(show, text) {
  const loading = document.getElementById('diag-loading');
  const content = document.getElementById('diag-content');
  const loadingText = document.getElementById('diag-loading-text');
  if (loadingText && text) loadingText.innerText = text;
  if (loading) loading.style.display = show ? 'block' : 'none';
  if (content) content.style.display = show ? 'none' : 'block';
}

// 单个账号：完整的三维检测详情
async function runSingleAccountDiagnosis(accountId) {
  setDiagLoading(true, '正在全面请求微软官方接口检测当前 Docker 中的登录态...');
  document.getElementById('diag-all-summary').style.display = 'none';
  document.getElementById('diag-all-list').style.display = 'none';
  document.getElementById('diag-banner').style.display = '';
  document.getElementById('diag-cards').style.display = '';
  document.querySelector('.diag-summary-box').style.display = '';
  document.getElementById('diag-tips').style.display = '';

  const targetId = accountId
    || (selectedAccountId !== 'all' ? selectedAccountId : (currentConfig?.accounts?.[0]?.id || 'acc_1'));

  try {
    const res = await fetch('/api/auth/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accountId: targetId })
    }).then(r => r.json());
    if (!res.success) throw new Error(res.message || '诊断接口异常');

    const data = res.data;
    const cookie = data.cookie || {};
    const token = data.token || {};
    const net = data.network || {};
    const accName = data.accountName || '当前账号';

    // 1. 综合 Banner
    const banner = document.getElementById('diag-banner');
    const bIcon = document.getElementById('diag-banner-icon');
    const bTitle = document.getElementById('diag-banner-title');
    const bSub = document.getElementById('diag-banner-sub');

    if (data.allValid && net.regionPass) {
      banner.className = 'diag-banner ok';
      bIcon.innerText = '🟢';
      bTitle.innerText = `账号 [${escapeHtml(accName)}] 登录完全正常 (双端在线)`;
      bSub.innerText = '当前 Docker 环境已完美就绪，所有任务通道与网络环境均处于最佳状态！';
    } else if (data.warning) {
      banner.className = 'diag-banner partial';
      bIcon.innerText = '🟡';
      bTitle.innerText = `账号 [${escapeHtml(accName)}] 已登录，但 Cookie 存在异常`;
      bSub.innerText = data.warningMessage || '网页端 Cookie 缺少 _U 标头，PC 搜索不会计分，请重新抓取完整 Cookie。';
    } else if (data.overallValid) {
      banner.className = 'diag-banner partial';
      bIcon.innerText = '🟡';
      bTitle.innerText = `账号 [${escapeHtml(accName)}] 部分登录有效`;
      bSub.innerText = '部分通道已连接，但仍有项未就绪（如网页端或移动端单边未登录），请根据下方提示补充。';
    } else {
      banner.className = 'diag-banner failed';
      bIcon.innerText = '🔴';
      bTitle.innerText = `账号 [${escapeHtml(accName)}] 尚未成功在 Docker 中登录`;
      bSub.innerText = '未检测到有效的微软登录凭据，请点击右上角「新手配置向导」进行绑定。';
    }

    // 2. 网页端 Cookie 卡片
    const pillCookie = document.getElementById('diag-pill-cookie');
    const detailCookie = document.getElementById('diag-detail-cookie');
    if (cookie.valid && cookie.warning) {
      pillCookie.className = 'diag-status-pill pill-warn';
      pillCookie.innerText = '已登录 · 需修复';
      detailCookie.innerHTML = `
        <div style="color:#F59E0B;">状态：⚠️ 身份认证有效，但 Cookie 不完整 —— ${escapeHtml(cookie.warningMessage || '缺少 _U 登录标头')}</div>
        <div style="margin-top:4px; font-size:11.5px; color:#94A3B8;">建议：在电脑登录 rewards.bing.com/dashboard 后重新抓取完整 Cookie（必须包含 _U），否则 PC 搜索不会计分。</div>
      `;
    } else if (cookie.valid) {
      pillCookie.className = 'diag-status-pill pill-ok';
      pillCookie.innerText = '已登录正常';
      detailCookie.innerHTML = `
        <div>状态：✅ 身份认证有效，可执行 PC 搜索、每日活动集与桌面专属任务</div>
        <div style="margin-top:4px; color:#E2E8F0;">${escapeHtml(cookie.message || '')}</div>
      `;
    } else {
      pillCookie.className = 'diag-status-pill pill-err';
      pillCookie.innerText = '未登录 / 失效';
      detailCookie.innerHTML = `
        <div style="color:#F87171;">状态：❌ ${escapeHtml(cookie.message || 'Cookie 缺失或已失效')}</div>
        <div style="margin-top:4px; font-size:11.5px; color:#94A3B8;">建议：在电脑登录 rewards.bing.com/dashboard，按 F12 复制完整 Cookie 粘贴到配置中心。</div>
      `;
    }

    // 3. 移动端 Token 卡片
    const pillToken = document.getElementById('diag-pill-token');
    const detailToken = document.getElementById('diag-detail-token');
    if (token.valid) {
      pillToken.className = 'diag-status-pill pill-ok';
      pillToken.innerText = '已授权正常';
      detailToken.innerHTML = `
        <div>状态：✅ OAuth Token 活跃，可执行 App 静默签到与新闻资讯阅读 (30分)</div>
        <div style="margin-top:4px; color:#E2E8F0;">${escapeHtml(token.message || '')}</div>
      `;
    } else {
      pillToken.className = 'diag-status-pill pill-err';
      pillToken.innerText = '未授权 / 失效';
      detailToken.innerHTML = `
        <div style="color:#F87171;">状态：❌ ${escapeHtml(token.message || '未获取到移动端 OAuth 授权')}</div>
        <div style="margin-top:4px; font-size:11.5px; color:#94A3B8;">建议：点击「新手配置向导」第一步，打开官方链接授权并粘贴跳转 URL。</div>
      `;
    }

    // 4. 网络卡片
    const pillNet = document.getElementById('diag-pill-network');
    const detailNet = document.getElementById('diag-detail-network');
    const networkRoute = net.proxyUsed
      ? `代理：${escapeHtml(net.proxy?.name || '指定代理')}`
      : '直连（未使用代理）';
    if (net.regionPass) {
      pillNet.className = 'diag-status-pill pill-ok';
      pillNet.innerText = '中国大陆 (安全)';
      detailNet.innerHTML = `
        <div>状态：✅ 出口 IP 符合微软国区要求 (${net.region})，防风控检测通过</div>
        <div style="margin-top:4px; color:#E2E8F0;">当前访问 IP：<strong style="font-family:ui-monospace,monospace;">${escapeHtml(net.ip || '未知')}</strong> · ${escapeHtml(net.location || '归属地未知')}</div>
        <div style="margin-top:4px; font-size:11.5px; color:#94A3B8;">${networkRoute}</div>
      `;
    } else {
      pillNet.className = 'diag-status-pill pill-err';
      pillNet.innerText = `非大陆地区 (${net.region || '未知'})`;
      detailNet.innerHTML = `
        <div style="color:#F87171;">状态：⚠️ 出口位于非大陆地区，若开启国区保护将被自动停止打卡防风控。</div>
        <div style="margin-top:4px; color:#E2E8F0;">当前访问 IP：<strong style="font-family:ui-monospace,monospace;">${escapeHtml(net.ip || '未知')}</strong> · ${escapeHtml(net.location || '归属地未知')}</div>
        <div style="margin-top:4px; font-size:11.5px; color:#94A3B8;">${networkRoute}。建议在配置中心为该账号选择国内 HTTP / SOCKS5 代理。</div>
      `;
    }

    // 5. 数据概览明细
    document.getElementById('diag-val-balance').innerText = data.balance ? `${data.balance.toLocaleString()} 积分` : '--';
    document.getElementById('diag-val-search').innerText = cookie.pcSearch || '--';
    document.getElementById('diag-val-read').innerText = token.readProgress || '--';

    // 6. 建议区
    const tipsBox = document.getElementById('diag-tips');
    if (data.allValid) {
      tipsBox.innerHTML = `💡 <strong>检测完毕：</strong>账号 [${escapeHtml(accName)}] 在 Docker 中运行环境完美，点击「▶️ 立即执行」即可开始打卡！`;
    } else {
      tipsBox.innerHTML = '💡 <strong>下一步建议：</strong>请点击右上角「💡 新手配置向导」，根据缺失的项（Cookie 或 Token）补充配置即可。';
    }

    setDiagLoading(false);

    // 同步刷新大屏
    fetchStatus();
  } catch (e) {
    setDiagLoading(false);
    document.getElementById('diag-banner-title').innerText = '诊断请求失败';
    document.getElementById('diag-banner-sub').innerText = e.message;
  }
}

// 全部账号：逐个串行体检，并在账号间严格执行安全防风控强制间隔
async function runAllAccountDiagnosis() {
  const accounts = (currentConfig?.accounts || []).filter(a => a.enabled !== false);
  document.getElementById('diag-banner').style.display = 'none';
  document.getElementById('diag-cards').style.display = 'none';
  document.querySelector('.diag-summary-box').style.display = 'none';
  document.getElementById('diag-tips').style.display = 'none';
  document.getElementById('diag-all-summary').style.display = 'none';
  document.getElementById('diag-all-list').style.display = 'none';

  if (accounts.length === 0) {
    setDiagLoading(false);
    document.getElementById('diag-all-summary').style.display = 'block';
    document.getElementById('diag-all-summary').innerText = '当前没有可体检的启用账号。';
    return;
  }

  const results = [];
  const gapSec = Math.max(15, parseInt(document.getElementById('cfg-account-gap')?.value, 10) || (currentConfig?.tasks?.accountGapSec ?? 30));

  try {
    for (let i = 0; i < accounts.length; i++) {
      const acc = accounts[i];
      setDiagLoading(true, `正在检测账号登录状态 (${i + 1}/${accounts.length}): ${acc.name || acc.id}...`);
      try {
        const res = await fetch('/api/auth/test', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ accountId: acc.id, force: true })
        }).then(r => r.json());

        if (res.success && res.data) {
          results.push(res.data);
        } else {
          results.push({
            accountId: acc.id,
            accountName: acc.name || acc.id,
            cookie: { valid: false, message: res.message || '体检未通过' },
            token: { valid: false, message: res.message || '体检未通过' },
            overallValid: false,
            allValid: false,
            balance: 0,
            error: res.message || '接口返回失败'
          });
        }
      } catch (e) {
        results.push({
          accountId: acc.id,
          accountName: acc.name || acc.id,
          cookie: { valid: false, message: e.message },
          token: { valid: false, message: e.message },
          overallValid: false,
          allValid: false,
          balance: 0,
          error: e.message
        });
      }

      // 多账号体检强制安全隔离倒计时：在界面清晰展示等待时间
      if (i < accounts.length - 1) {
        for (let s = gapSec; s > 0; s--) {
          setDiagLoading(true, `🛡️ 多账号防风控隔离：等待 ${s} 秒后检测下一个账号 (${i + 2}/${accounts.length}: ${accounts[i + 1].name || accounts[i + 1].id})...`);
          await new Promise(r => setTimeout(r, 1000));
        }
      }
    }
    renderAllAccountDiagnosisResults(results);
  } catch (e) {
    const summaryBox = document.getElementById('diag-all-summary');
    summaryBox.style.display = 'block';
    summaryBox.innerHTML = `<span style="color:#EF4444;">体检失败: ${escapeHtml(e.message)}</span>`;
  } finally {
    setDiagLoading(false);
    fetchStatus();
  }
}

function renderAllAccountDiagnosisResults(results) {
  const summaryBox = document.getElementById('diag-all-summary');
  const listBox = document.getElementById('diag-all-list');
  const validCount = results.filter(r => r.allValid).length;
  const partialCount = results.filter(r => r.overallValid && !r.allValid).length;
  const failedCount = results.length - validCount - partialCount;
  summaryBox.style.display = 'block';
  summaryBox.innerHTML = `共体检 <strong>${results.length}</strong> 个账号：`
    + `<span style="color:#34D399; font-weight:700;">完全有效 ${validCount}</span> / `
    + `<span style="color:#F59E0B; font-weight:700;">部分有效 ${partialCount}</span> / `
    + `<span style="color:#F87171; font-weight:700;">失效 ${failedCount}</span>`;
  listBox.style.display = 'flex';
  listBox.innerHTML = results.map(r => {
    const name = escapeHtml(r.accountName || r.accountId || '未知账号');
    const cookieOk = !!r.cookie?.valid;
    const tokenOk = !!r.token?.valid;
    const overallOk = !!r.overallValid;
    const err = r.error ? ` · ${escapeHtml(r.error)}` : '';
    const cls = overallOk ? 'pill-ok' : 'pill-err';
    const statusText = overallOk ? (r.allValid ? '整体有效' : '部分有效') : '失效';
    return `
      <div class="diag-all-row">
        <span class="diag-all-name">${name}</span>
        <span class="diag-status-pill ${cookieOk ? 'pill-ok' : 'pill-err'}">Cookie ${cookieOk ? '有效' : '失效'}</span>
        <span class="diag-status-pill ${tokenOk ? 'pill-ok' : 'pill-err'}">Token ${tokenOk ? '有效' : '失效'}</span>
        <span class="diag-status-pill ${cls}">${statusText}</span>
        <span class="diag-all-detail">${r.balance ? r.balance.toLocaleString() + ' 分' : '--'}${err}</span>
      </div>
    `;
  }).join('');
}

// 切换历史记录天数 (7 日 / 30 日)
function switchHistoryDays(days) {
  currentHistoryDays = days;
  document.getElementById('btn-history-7')?.classList.toggle('active', days === 7);
  document.getElementById('btn-history-30')?.classList.toggle('active', days === 30);
  fetchHistory(days, selectedAccountId);
}

// 拉取历史记录数据 (支持单账号与全局汇总)
async function fetchHistory(days = 7, accId = selectedAccountId) {
  try {
    const target = accId || 'all';
    const res = await fetch(`/api/history?days=${days}&accountId=${target}`).then(r => r.json());
    if (res.success && Array.isArray(res.data)) {
      renderHistoryChart(res.data, days);
    }
  } catch (e) {
    console.error('获取历史记录失败:', e);
  }
}

// 渲染历史柱形图与 Hover Tooltip
function renderHistoryChart(dataList, days) {
  const container = document.getElementById('history-chart-container');
  const tooltip = document.getElementById('history-tooltip');
  if (!container || !tooltip) return;

  container.innerHTML = '';
  if (dataList.length === 0) return;

  // 计算最大值，方便归一化高度
  const maxEarned = Math.max(...dataList.map(d => d.earned || 0), 160);

  dataList.forEach((item, index) => {
    const isToday = index === dataList.length - 1;
    const heightPercent = Math.max(12, Math.min(100, Math.round((item.earned / maxEarned) * 100)));

    const col = document.createElement('div');
    col.className = `chart-col ${isToday ? 'today' : ''}`;

    col.innerHTML = `
      <div class="chart-val-hint">+${item.earned}</div>
      <div class="chart-bar-wrap">
        <div class="chart-bar" style="height: ${heightPercent}%;"></div>
      </div>
      <div class="chart-date-label">${days === 30 ? (index % 4 === 0 || isToday ? item.dayLabel : '') : item.dayLabel}</div>
    `;

    // Hover 交互
    const showTooltip = (e) => {
      document.getElementById('tt-date').innerText = `${item.date} (${item.weekday})`;
      document.getElementById('tt-earned').innerText = `+${item.earned} 积分`;
      
      const bdList = document.getElementById('tt-breakdown');
      const accList = Array.isArray(item.accounts) ? item.accounts : null;

      if (accList && accList.length > 0) {
        // 全部账号汇总模式：显示每个账号的当日数值与占比
        const total = Number(item.earned || 0);
        const rows = [...accList].sort((a, b) => Number(b.earned || 0) - Number(a.earned || 0));
        bdList.innerHTML = `
          <div class="tooltip-section-title">各账号占比（${rows.length} 个账号）</div>
          ${rows.map(a => {
            const earned = Number(a.earned || 0);
            const pct = total > 0 ? (earned / total) * 100 : 0;
            return `
              <div class="tooltip-item">
                <span class="tt-acc-name">👤 ${escapeHtml(a.name)}</span>
                <span class="tt-acc-val">+${earned}<em>${pct.toFixed(1)}%</em></span>
              </div>`;
          }).join('')}
        `;
      } else if (item.breakdown && item.breakdown.length > 0) {
        bdList.innerHTML = item.breakdown.map(b => `
          <div class="tooltip-item">
            <span>${b.icon || '📌'} ${b.name}</span>
            <span style="font-weight: 600; color: #34D399;">+${b.points}</span>
          </div>
        `).join('');
      } else {
        bdList.innerHTML = '<div style="color:#64748B;">打卡任务已满额到账</div>';
      }

      document.getElementById('tt-balance').innerText = `当日结余: ${(item.balance || 0).toLocaleString()} 积分`;

      tooltip.style.display = 'block';

      // 先显示再测量，保证多账号长列表时提示框不会被视口裁掉
      const barEl = col.querySelector('.chart-bar') || col;
      const rect = barEl.getBoundingClientRect();
      const tipRect = tooltip.getBoundingClientRect();
      const tipW = tipRect.width;
      const tipH = tipRect.height;
      const centerX = Math.max(
        tipW / 2 + 8,
        Math.min(window.innerWidth - tipW / 2 - 8, rect.left + rect.width / 2)
      );
      let top = rect.top - tipH - 12;
      if (top < 8) top = rect.bottom + 12; // 上方放不下就改放到柱子下方
      if (top + tipH > window.innerHeight - 8) {
        top = Math.max(8, window.innerHeight - tipH - 8);
      }
      tooltip.style.left = `${centerX - tipW / 2}px`;
      tooltip.style.top = `${top}px`;
    };

    col.addEventListener('mouseenter', showTooltip);
    col.addEventListener('mousemove', showTooltip);
    col.addEventListener('mouseleave', () => {
      tooltip.style.display = 'none';
    });

    container.appendChild(col);
  });
}

// 测试词库来源并展示明细
async function handleTestSearchApi() {
  const selectElem = document.getElementById('cfg-search-api');
  const selectedMode = selectElem?.value || 'offline';
  const statusDiv = document.getElementById('words-modal-status');
  const tagsDiv = document.getElementById('words-modal-tags');
  
  openModal('search-words-modal');
  statusDiv.innerHTML = '<span style="color:#38BDF8;">⏳ 正在请求并测试所选词库接口...</span>';
  tagsDiv.innerHTML = '';

  try {
    const res = await fetch('/api/tasks/test-search-api', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ searchApi: selectedMode })
    }).then(r => r.json());

    if (res.success && Array.isArray(res.sample)) {
      statusDiv.innerHTML = `<span style="color:#34D399; font-weight:700;">✅ [${escapeHtml(res.name)}] 接口通畅！成功抓取 ${res.count} 条热词，前 ${res.sample.length} 条明细预览：</span>`;
      tagsDiv.innerHTML = res.sample.map((w, i) => `
        <span style="font-size:12px; padding:4px 9px; background:var(--card-bg); border:1px solid var(--border-color); border-radius:6px; color:var(--text-main);">
          ${i + 1}. ${escapeHtml(w)}
        </span>
      `).join('');
    } else {
      statusDiv.innerHTML = `<span style="color:#F87171; font-weight:700;">❌ [${escapeHtml(res.name || selectedMode)}] 获取失败: ${escapeHtml(res.message || '未知错误')}</span>`;
      tagsDiv.innerHTML = '<span style="color:var(--text-muted); font-size:12px;">未能获取到有效词条，建议切换回「本地离线智能词库（最稳定）」。</span>';
    }
  } catch (e) {
    statusDiv.innerHTML = `<span style="color:#F87171;">❌ 请求异常: ${escapeHtml(e.message)}</span>`;
  }
}

// ===== 全部历史日志弹窗 =====
let logsModalEntries = [];
let logsModalOpen = false;

function initLogsModal() {
  document.getElementById('btn-open-logs')?.addEventListener('click', openLogsModal);
  document.getElementById('btn-close-logs')?.addEventListener('click', closeLogsModal);
  document.getElementById('btn-close-logs-btn')?.addEventListener('click', closeLogsModal);
  document.getElementById('logs-filter')?.addEventListener('input', () => renderLogsModal());
  document.getElementById('btn-logs-clear')?.addEventListener('click', () => {
    logsModalEntries = [];
    renderLogsModal();
  });
}

async function openLogsModal() {
  logsModalOpen = true;
  openModal('logs-modal');
  const list = document.getElementById('logs-modal-list');
  if (list) list.innerHTML = '<div class="logs-empty">正在加载历史日志...</div>';
  try {
    const res = await fetch('/api/logs/history?limit=500').then(r => r.json());
    logsModalEntries = res.success ? (res.data || []) : [];
  } catch {
    logsModalEntries = [];
  }
  renderLogsModal(true);
}

function closeLogsModal() {
  logsModalOpen = false;
  closeModal('logs-modal');
}

function renderLogsModal(scrollToBottom = false) {
  const list = document.getElementById('logs-modal-list');
  if (!list) return;
  const filter = (document.getElementById('logs-filter')?.value || '').trim().toLowerCase();
  const rows = logsModalEntries.filter(e => {
    if (!filter) return true;
    return `${e.accountName || ''} ${e.message || ''} ${e.icon || ''}`.toLowerCase().includes(filter);
  });
  if (rows.length === 0) {
    list.innerHTML = `<div class="logs-empty">${logsModalEntries.length === 0 ? '暂无日志' : '没有匹配的日志'}</div>`;
    return;
  }
  list.innerHTML = rows.map(e => `
    <div class="logs-line">
      <span class="logs-time">[${escapeHtml(e.fullTime || e.time || '')}]</span>
      <span>${escapeHtml(e.icon || 'ℹ️')}</span>
      ${e.accountName ? `<span class="logs-acc">[${escapeHtml(e.accountName)}]</span>` : ''}
      <span>${escapeHtml(e.message || '')}</span>
    </div>`).join('');

  const auto = document.getElementById('logs-autoscroll');
  if (scrollToBottom || auto?.checked) list.scrollTop = list.scrollHeight;
}

function appendLogToModal(entry) {
  if (!logsModalOpen || !entry) return;
  logsModalEntries.push({
    fullTime: entry.fullTime || '',
    time: entry.time || '',
    icon: entry.icon || 'ℹ️',
    accountName: entry.accountName || '',
    message: entry.message || ''
  });
  if (logsModalEntries.length > 800) logsModalEntries.shift();
  renderLogsModal();
}
