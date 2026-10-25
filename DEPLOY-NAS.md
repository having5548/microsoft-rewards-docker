# NAS（群晖 / 威联通 / 极空间 / 绿联）Docker 部署说明

本文件的步骤针对 **v1.9.0 之后的本仓库版本**，镜像需要**用本目录的源码现场构建**（官方 Docker Hub 上的旧镜像不含 QQ 机器人、登录窗口等改动）。

---

## 0. 开始前必须知道的两件事

1. **5308 端口 = 微软账号 + 一个已登录浏览器的完全控制权。**
   登录窗口（noVNC）是同一条鉴权链，密码为空时任何人都能在你的容器里操作浏览器。
   部署完成后**第一件事**是打开配置中心 → 安全 → 设置「访问密码」，见第 4 节。
2. **数据全在 `./data`**：`data/config.json` 里是明文的 Cookie / OAuth Token。
   别把这个目录放进 SMB 共享、网盘同步或人人可读的备份里。

---

## 1. 目录准备

把本目录（去掉 `node_modules/` 与 `data/`）整个拷到 NAS 上，例如群晖的
`/volume1/docker/ms-rewards/`，最终结构应为：

```
ms-rewards/
├── Dockerfile
├── docker-entrypoint.sh
├── docker-compose.yml
├── package.json
├── package-lock.json
├── .dockerignore
└── src/
```

> 群晖 File Station 直接拖文件夹也可以；不要带 Windows 上跑出来的 `node_modules`（架构不对，必须由镜像内重新安装）。

---

## 2. 构建并启动

### 方式 A：SSH + docker compose（推荐）

```bash
cd /volume1/docker/ms-rewards
sudo docker compose up -d --build      # 首次会构建镜像（10~25 分钟，取决于网速与 CPU）
sudo docker compose logs -f            # 看到「Web 控制台已启动」即成功
```

之后升级：覆盖源码目录 → `sudo docker compose up -d --build`。

### 方式 B：群晖 Container Manager「项目」

1. Container Manager → 项目 → 新增；
2. 路径选 `/volume1/docker/ms-rewards`，来源选「使用现有的 docker-compose.yml」；
3. 勾选「构建镜像」后启动。

### 方式 C：NAS 上无法构建（部分 ARM 机型 / 没有 compose 构建能力）

在任意一台有 Docker 的电脑上：

```bash
docker build -t ghcr.io/having5548/microsoft-rewards-docker:v1.9.0 .
docker save ghcr.io/having5548/microsoft-rewards-docker:v1.9.0 -o ms-rewards-1.9.0.tar
```

把 tar 传到 NAS 后导入，并在 `docker-compose.yml` 里注释掉 `build:` 段：

```bash
docker load -i ms-rewards-1.9.0.tar
docker compose up -d
```

> 这一步是跨架构的：x86 NAS 上导入 ARM 镜像会报 `exec format error`，反之亦然。

---

## 3. 首次配置流程

1. 浏览器打开 `http://<NAS 内网 IP>:5308`；
2. **先在配置中心设访问密码**（见下一节），刷新页面生效；
3. 账号 → **🌐 打开登录窗口自动获取 Cookie** → 在弹出的 noVNC 小窗里登录微软账号 → 点「✅ 保存并填入 Cookie」；
   - 小窗是容器里那台 Chromium 的真实画面，登录态直接由后端抓取，不需要手工复制 Cookie；
4. 移动端任务（App 签到 / 新闻阅读）需要再贴一次 OAuth 授权码链接 → 「换取 Token」；
5. 定时巡检：勾选每天的小时档位（09:00–22:00，每档 1 小时，档内随机 0–10 分钟启动）；
6. 通知：消息推送里填 QQ 机器人（AppID / AppSecret / 发送目标 + OpenID），点「测试」验证。

---

## 4. 安全设置（强烈建议）

**设置访问密码**：配置中心 → 安全 → 「访问密码」→ 保存（写进 `data/config.json` 的 `server.authPassword`，HTTP Basic 鉴权，noVNC 的 WebSocket 升级也走同一套校验）。

**给 VNC 加密码**：如果容器会被多人访问，在 `docker-compose.yml` 的 `environment` 里加

```yaml
NOVNC_PASSWORD: 你的密码
```

不设时容器内 `x11vnc` 以 `-nopw` 启动（只监听容器内的 5900，靠 5308 的 Basic 鉴权挡着）。

**限定访问来源**（任选其一）：

- 端口只绑内网 IP：`"192.168.1.10:5308:5308"`；
- 反向代理（Nginx Proxy Manager / 群晖反代）加 HTTPS，注意**必须转发 WebSocket 升级头**，否则登录窗口的小窗连不上画面。

---

## 5. 常见问题

| 现象 | 原因与处理 |
| --- | --- |
| 构建卡在 `npm ci` / 报 `ETIMEDOUT` | 依赖源太慢。compose 默认用 `https://registry.npmmirror.com`；若你改过，确认 `NPM_REGISTRY` 生效 |
| 拉 `node:20-bookworm-slim` 很慢 | 在 NAS 的 Docker/注册表设置里配置镜像加速器，或先 `docker pull` 再构建 |
| 构建到 `apt-get` 失败 | Debian 源超时，重试一次即可；反复失败就在内网换 DNS（如 223.5.5.5） |
| 启动后立刻退出 | `docker compose logs` 看报错；最常见是 5308 被占用 |
| 打开登录窗口提示「未检测到 Chromium」 | 用了自建镜像但没装 chromium；本仓库 Dockerfile 已内置并设置 `CHROMIUM_PATH=/usr/bin/chromium` |
| 登录窗口黑屏 / 连不上 | `MSR_VISIBLE` 必须为 1；反代场景检查 WebSocket 升级；`docker exec ms-rewards ps aux \| grep -E "Xvfb\|x11vnc\|websockify"` 看三个进程是否都在 |
| 内存占用高 | 搜索与登录窗口都会临时拉起 Chromium（约 200–400MB）。低内存机型建议 `MSR_VISIBLE=0` 并改用「粘贴完整 Cookie」 |
| 时间不对 | 已内置 `TZ=Asia/Shanghai`；调度档位按容器时区计算 |

---

## 6. 运维

```bash
# 健康检查
curl -s http://127.0.0.1:5308/api/health

# 备份（含凭据，注意存放位置）
tar -czf ms-rewards-data-$(date +%F).tar.gz data/

# 看实时日志
docker compose logs -f --tail=200
```

容器内 `/app/data` 是唯一需要持久化的目录（配置、日志、历史、每个账号的浏览器会话、登录窗口的 chromium profile）。
