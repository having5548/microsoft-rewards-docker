#!/usr/bin/env bash
set -euo pipefail

# 可见浏览器（Xvfb + x11vnc + websockify）用于「微软账号登录窗口」：
# 用户在 WebUI 内嵌的 noVNC 小窗里登录微软账号，后端直接把完整 Cookie 抓下来。
# MSR_VISIBLE=1 启用；EPIC_VISIBLE 是旧变量名，保留兼容。
VISIBLE="${MSR_VISIBLE:-${EPIC_VISIBLE:-1}}"

if [ "$VISIBLE" = "1" ]; then
  export DISPLAY="${DISPLAY:-:1}"
  rm -f /tmp/.X1-lock /tmp/.X11-unix/X1 2>/dev/null || true
  Xvfb "$DISPLAY" -ac -screen 0 "${VNC_WIDTH:-1366}x${VNC_HEIGHT:-768}x24" &
  sleep 1

  if [ -n "${NOVNC_PASSWORD:-}" ]; then
    x11vnc -display "$DISPLAY" -forever -shared -rfbport "${VNC_PORT:-5900}" -bg -passwd "$NOVNC_PASSWORD"
  else
    x11vnc -display "$DISPLAY" -forever -shared -rfbport "${VNC_PORT:-5900}" -bg -nopw
  fi

  websockify -D --web=/usr/share/novnc/ "${NOVNC_PORT:-6080}" "localhost:${VNC_PORT:-5900}"
  echo "登录窗口（WebUI 内嵌小窗）: http://<host>:${PORT:-5308}/novnc/vnc.html"
fi

exec "$@"
