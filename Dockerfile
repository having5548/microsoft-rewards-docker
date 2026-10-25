FROM node:20-bookworm-slim

# 构建时使用的 Debian 源。国内 NAS（飞牛 / 群晖 / 威联通）直连 deb.debian.org 常常只有
# 几十 KB/s，换成清华 / 中科大镜像能把 apt-get 这一步从十几分钟压到一两分钟。
# 海外环境或 GitHub Actions 保持默认官方源即可（默认值就是官方源）。
ARG APT_MIRROR=deb.debian.org

# 安装 Chromium、虚拟显示、字体与软件渲染的 OpenGL 支持
# libgl*/libgl1-mesa-dri：Xvfb 里没有 GPU，靠 Mesa llvmpipe 提供 WebGL。
#   微软登录页会采集 WebGL，缺了它可能被判成异常浏览器。
# fontconfig + 各字体包：--no-install-recommends 不会自动装推荐项，
#   字体缺失会让页面回退到占位字形，出现满屏乱码。
RUN if [ "${APT_MIRROR}" != "deb.debian.org" ]; then \
      if [ -f /etc/apt/sources.list.d/debian.sources ]; then \
        sed -i "s|deb.debian.org|${APT_MIRROR}|g" /etc/apt/sources.list.d/debian.sources; \
      fi; \
      if [ -f /etc/apt/sources.list ]; then \
        sed -i "s|deb.debian.org|${APT_MIRROR}|g" /etc/apt/sources.list; \
      fi; \
      echo "APT 源已切换为 ${APT_MIRROR}"; \
    fi; \
    apt-get update && apt-get install -y --no-install-recommends \
    chromium \
    xvfb \
    x11vnc \
    novnc \
    websockify \
    fontconfig \
    fonts-dejavu-core \
    fonts-liberation \
    fonts-noto-color-emoji \
    fonts-wqy-zenhei \
    libgl1 \
    libegl1 \
    libgles2 \
    libglx-mesa0 \
    libgl1-mesa-dri \
    tzdata \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

ENV TZ=Asia/Shanghai
ENV NODE_ENV=production
ENV CHROMIUM_PATH=/usr/bin/chromium
# 可见浏览器：供「微软账号登录窗口」通过 noVNC 内嵌小窗使用
ENV MSR_VISIBLE=1
ENV DISPLAY=:1
# 容器内没有 GPU，固定走 Mesa 软件渲染，保证 Chromium 下 WebGL 可用。
ENV LIBGL_ALWAYS_SOFTWARE=1

WORKDIR /app

# 先复制 package 文件以利用 Docker 层缓存
COPY package*.json ./

# 有 package-lock.json 时用 npm ci，构建结果可复现（不会因为依赖漂移导致线上行为变化）
# 国内 NAS 建议把 NPM_REGISTRY 换成镜像源（compose 里默认已指向 npmmirror）：
#   npm 9+ 的 replace-registry-host 会把 lock 文件里 registry.npmjs.org 的地址自动替换成本次配置的源，
#   所以不需要重新生成 package-lock.json。
ARG NPM_REGISTRY=https://registry.npmjs.org
RUN npm ci --omit=dev --no-audit --no-fund --registry=${NPM_REGISTRY}

# 复制源码与资源
COPY src/ ./src/
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# 创建持久化数据目录
RUN mkdir -p /app/data

EXPOSE 5308 6080

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:5308/api/health').then(r=>r.ok?process.exit(0):process.exit(1)).catch(()=>process.exit(1))"

VOLUME ["/app/data"]

ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["npm", "start"]
