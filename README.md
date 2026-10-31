# 🎁 Microsoft Rewards 微软积分自动化（Docker / WebUI）

> 给 NAS 和长期开机的机器用的微软积分托管面板：每天按你选的时间档自动跑搜索、签到、阅读、活动集与打孔卡，多账号互不干扰，结果推到微信 / 钉钉 / 飞书 / Telegram / QQ 机器人。
>
> 不用一直开着电脑，也不用装浏览器插件——整套跑在容器里，浏览器是容器内那台 Chromium，你只需要在 Web 控制台点几下。

> ### ⚠️ 这是二改版
>
> | 项 | 说明 |
> | --- | --- |
> | 二改自 | 一个 MIT 协议的第三方项目，原作者与许可证见 [MODIFIED.md](MODIFIED.md) / [LICENSE](LICENSE) |
> | 当前版本 | **v1.9.0** |
> | 维护者 | [having5548](https://github.com/having5548) |
> | 与上游的差异 | 移除了 Epic 免费游戏模块；新增「登录窗口自动抓 Cookie」与 QQ 机器人通知；Cookie 粘贴容错；更新检测指向本仓库 —— 详见 [MODIFIED.md](MODIFIED.md) |
>
> 二改引入的问题请提到本仓库；自动化操作 Rewards 违反微软服务条款，**账号存在被限制/封停的风险，请自行评估，不要用主号试**。

---

## ✨ 它能做什么

- **每天自动打卡**：PC 搜索、移动端签入、新闻阅读、每日活动集、桌面端专属任务、任务区打孔卡，按官网真实进度判断，不刷假数字。
- **登录窗口抓 Cookie**：不用 F12 手工复制。点一下按钮，容器里起一台可见 Chromium，你像平时一样登录，后端把**完整** Cookie 抓下来校验后写进账号。
- **多账号矩阵**：每个账号独立的 Cookie / Token / 代理出口 / 运行时段，日志带账号前缀；任务、体检、同步之间用锁互斥，不会串号。
- **自定义时间档**：09:00–22:00 共 14 个一小时档位，每档随机延后 0–10 分钟启动；错过档位会自动顺延到下一个勾选档。
- **多渠道通知**：企业微信、钉钉、飞书、Bark、PushMe、Telegram，以及**官方 QQ 机器人**（群聊 / 私聊 / 频道）。
- **防风控**：默认锁定中国大陆出口 IP；指纹常量单一来源（UA / Sec-CH-UA / platform 对齐）；用 patchright 驱动并持久化浏览器会话。
- **容器内可见浏览器**：登录窗口通过 noVNC 内嵌在 WebUI 里，和面板共用同一个端口与鉴权。

---

## 🚀 快速开始（5 分钟）

### 1. 建目录、写 `docker-compose.yml`

```bash
mkdir -p /path/to/ms-rewards && cd /path/to/ms-rewards
```

```yaml
name: ms-rewards

services:
  microsoft-rewards:
    image: ghcr.io/having5548/microsoft-rewards-docker:latest
    container_name: ms-rewards
    restart: unless-stopped
    ports:
      - "5308:5308"
    environment:
      - TZ=Asia/Shanghai
      - MSR_VISIBLE=1
      - LOGIN_WINDOW_TIMEOUT_MIN=30
    volumes:
      - ./data:/app/data
```

> 镜像已由 CI 构建好（amd64 + arm64），**不需要自己 build**。只有想改代码时才看下面的「本地源码运行」。

### 2. 启动

```bash
docker compose up -d
docker compose logs -f        # 看到「Web 控制台已启动」即可
```

### 3. 打开控制台

浏览器访问 `http://<你的机器 IP>:5308`。

**第一件事先去配置中心设「访问密码」** —— 这个端口等于你的微软账号 + 一台可操作的浏览器，默认没有密码（详见「安全须知」）。

### 4. 配一个微软账号

配置中心 → 「🌐 打开登录窗口自动获取 Cookie」：

1. 弹出的小窗是容器里那台 Chromium 的真实画面；
2. 在小窗里登录微软账号，等右上角出现头像 / 积分；
3. 点小窗底部「✅ 保存并填入 Cookie」，后端抓 Cookie → 校验 → 写入账号；
4. 校验没过时窗口不会关，可以继续在窗口里处理。

不想用登录窗口（比如纯无头部署）也可以手工粘贴，见下面「Cookie 与登录窗口」。

### 5. 开定时、配通知

- 账号卡片里勾选每天的执行时间档；
- 配置中心 → 消息推送，填你用的渠道（QQ 机器人需要 AppID / AppSecret / 目标 OpenID），点「测试」验证；
- 想立刻跑一次就点「▶️ 立即执行」，日志会实时刷在面板上。

---

## 🐳 部署

### Docker Compose（推荐）

就是上面那段。要点：

- **`name: ms-rewards`** 固定项目名。不加的话 compose 会用目录名当项目名，换个文件夹就会因为「容器名已存在」报 Conflict。
- **端口**：只映射 `5308`。容器内的 `6080`（websockify）和 `5900`（x11vnc）**不需要**映射，noVNC 走 5308 反向代理且共用同一套鉴权。
- **数据卷**：`./data:/app/data` 是唯一需要持久化的目录。

### docker run

```bash
docker run -d \
  --name ms-rewards \
  --restart unless-stopped \
  -p 5308:5308 \
  -v "$(pwd)/data:/app/data" \
  -e TZ=Asia/Shanghai \
  -e MSR_VISIBLE=1 \
  ghcr.io/having5548/microsoft-rewards-docker:latest
```

### 群晖 / 威联通 / 极空间 / 绿联 / 飞牛

完整步骤（镜像加速、构建慢、ARM 机型、反代 WebSocket、升级与回滚、排错表）见 **[DEPLOY-NAS.md](DEPLOY-NAS.md)**。

### 环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `TZ` | `Asia/Shanghai` | 容器时区，调度档位与日志时间都按它算 |
| `PORT` | `5308` | WebUI 端口（容器内） |
| `MSR_VISIBLE` | `1` | 是否启动可见浏览器（Xvfb + x11vnc + websockify）。`0` 时「登录窗口」不可用，只能手工粘贴 Cookie |
| `NOVNC_PASSWORD` | 空 | 可见浏览器的 VNC 密码。不设时容器内 x11vnc 无密码，但仍需通过 5308 的访问密码 |
| `NOVNC_PORT` / `VNC_PORT` | `6080` / `5900` | 容器内 websockify / x11vnc 端口，无需映射 |
| `LOGIN_WINDOW_TIMEOUT_MIN` | `30` | 登录窗口多久没保存自动关闭；`0` 关闭保护 |
| `CHROMIUM_PATH` | `/usr/bin/chromium` | 浏览器内核路径 |
| `MSR_DATA_DIR` | `./data` | 数据目录（本地开发时可指到临时目录） |
| `MSR_UPDATE_REPO` | `having5548/microsoft-rewards-docker` | 「检查更新」读哪个仓库的 tags |

### 构建参数（仅自己 build 时用）

| 参数 | 默认 | 说明 |
| --- | --- | --- |
| `NPM_REGISTRY` | `https://registry.npmmirror.com` | `npm ci` 的源 |
| `APT_MIRROR` | `mirrors.tuna.tsinghua.edu.cn` | apt 装 chromium/xvfb 的 Debian 源；海外可设 `deb.debian.org` |

---

## 🧩 功能细节

### 任务类型

| 任务 | 说明 |
| --- | --- |
| PC 搜索 | 真机拟人输入（键盘事件流 + 随机延时 + 滚动结果页），可用离线词库或热搜 API 取词 |
| 移动端签入 | 用 OAuth Token 走 BingSapphire 接口，官网连签状态优先 |
| 新闻阅读 | 通过 DAPI 阅读每日资讯拿阅读分 |
| 每日活动集 | 自动完成 Dashboard 的三张活动卡 |
| 桌面端专属 | 伪装官方桌面客户端特征，拿每周桌面打孔卡 |
| 任务区打孔卡 | 自动识别当月/当周打孔卡并推进当天可做的子任务 |

具体分数以官网实际配额为准（Microsoft 会调整）。所有进度**只认官网返回值**，`max(本地, 官网)` 这类假进度已移除。

### 定时调度

- 每天 14 个一小时档位可选（09:00–22:00 开始，最晚 23:00 结束）；
- 每档启动时间 = 档位起点 + 0–10 分钟随机；
- 每天只在**最早可用的已勾选档**跑一次；错过 10 分钟宽限自动顺延到下一个勾选档；
- 被别的账号占用的档位在界面上标黄，悬停能看到占用者；
- 计划落盘在 `data/schedule_plan.json`，重启不丢，也不会一重启就立刻开跑。

### 多账号与隔离

| 隔离项 | 做法 |
| --- | --- |
| 凭据 | 每账号独立 Cookie / Refresh Token / Access Token |
| 网络 | 每账号可选「跟随全局 / 直连 / 指定代理节点」 |
| 上下文 | `accountContextLock` 串行化「任务执行 / 体检 / 同步 / 换 Token」，避免全局上下文被抢 |
| 浏览器 | `browserSlotLock` 保证同一时间只有一个 Chromium（搜索与登录窗口共用） |
| 日志 | 每行带 `[账号名]` 前缀，时间线也按账号分开 |

### 通知渠道

企业微信、钉钉、飞书、Bark、PushMe、Telegram、**QQ 机器人**。

QQ 机器人需要：

- `AppID`、`AppSecret`（QQ 开放平台机器人管理页获取）；
- 发送目标：群聊填 `group_openid`、私聊填 `user_openid`、频道填 `channel_id`；
- access_token 由程序换取并按 AppID 缓存到过期前 60 秒；
- 不带 `msg_id` 属于**主动消息**，受平台每月额度限制，额度用尽会返回错误码（如 `40034005`），日志原样记录。

### 代理与防风控

- 默认启用**国区锁**：出口不是中国大陆 IP 时直接停止，避免被微软判成异区行为；
- 支持 HTTP / HTTPS / SOCKS5，带认证的 SOCKS5 由容器内本地桥接层转成无认证 HTTP 代理给 Chromium；
- 指纹常量集中在 `src/core/fingerprint.js`（`CHROME_MAJOR = 156`），UA、`Sec-CH-UA`、`navigator.platform` 由同一份常量派生；
- 浏览器驱动用 **patchright**（Playwright 的补丁分支），并持久化每账号的会话，避免「全新浏览器里凭空出现登录态」这种不自然状态。

---

## 🍪 Cookie 与登录窗口

### 为什么推荐登录窗口

手工从 F12 复制 Cookie 是最容易出错的环节：复制漏项、只复制了某个值、Safari 表格格式带制表符、缺 `_U`……失败之后往往只表现为一句「Cookie 已过期」，很难排查。

登录窗口把这件事变成：在真实浏览器里登录 → 后端直接读完整 Cookie → 校验通过才落库。

### 手工粘贴的容错规则

- 支持完整 Cookie 串、Cookie-Editor 导出的 JSON、Safari/Excel 表格复制（制表符）、带 `Cookie:` 前缀或整体带引号的写法；
- 缺 `_U` 时，从 `SRCHUID` / `_EDGE_S` / `SRCHHPGUSR` 里的 `GUID=` **交叉校验后**补齐；几处不一致就拒绝猜；
- 只贴了某一个 Cookie 的值时，明确提示「这只是一个值，需要完整串」，不会静默存进去；
- 只贴了单个 `名=值` 而账号已有完整 Cookie 时按**合并**处理，不会把 `MUID` / `RPSSecAuth` 冲掉。

### 校验怎么做的

保存前会拿这套 Cookie 真去请求 Rewards 接口（读积分、连签、搜索配额）：

- 页面被重定向到登录页 / 判定游客态 → 明确报「登录态已失效」；
- 请求成功但没有登录态标记 → 报告缺了哪些 Cookie，而不是笼统的「已过期」；
- 只有读到真实积分的才算通过，才写入账号。

---

## 🔐 安全须知（重要，请务必看）

1. **`5308` 端口等于「你的微软账号 + 一台已登录浏览器」的完全控制权。** 登录窗口就是 noVNC，谁连上谁就能操作那台浏览器。
2. **部署完第一件事：配置中心 → 安全 → 设置访问密码。** 它写进 `data/config.json` 的 `server.authPassword`，走 HTTP Basic，noVNC 的 WebSocket 升级握手也复用同一套校验。
3. **容器可能被多人访问时，再加 `NOVNC_PASSWORD`。** 不设时容器内 x11vnc 以无密码启动（只监听容器内 5900，靠 5308 的鉴权挡着）。
4. **尽量只绑内网**：`"192.168.1.10:5308:5308"`；要用公网就上反向代理 + HTTPS，并且**必须转发 WebSocket 升级头**，否则登录窗口小窗连不上画面。
5. **`data/config.json` 里是明文的 Cookie 与 Token**（文件权限 0600）。别把这个目录放进 SMB 共享、网盘同步或人人可读的备份。

---

## 📁 数据与备份

`./data` 是唯一需要持久化的目录：

| 文件 / 目录 | 内容 |
| --- | --- |
| `config.json` | 账号凭据、代理、任务开关、通知配置（**含明文 Cookie/Token**，0600） |
| `stats.json` | 当日积分、任务配额、连签与印章进度 |
| `history.json` | 历史积分与任务明细（图表数据） |
| `app.log` | 运行日志（5MB 轮转） |
| `sessions/` | 每账号的浏览器会话（Cookie + localStorage，不含身份 Cookie `_U`） |
| `login-profile/` | 登录窗口的 Chromium 用户数据（登录态在这，删掉就要重新登录） |
| `schedule_plan.json` | 当天/明天的调度计划 |

```bash
# 备份（注意存放位置，里面是凭据）
tar -czf ms-rewards-data-$(date +%F).tar.gz data/

# 强制所有账号重新登录一次（不影响积分历史）
rm -rf data/sessions data/login-profile
```

---

## 🔄 更新与回滚

```bash
docker compose pull          # 拉新镜像
docker compose up -d         # 只重建有变化的容器（data 卷不动，不用重新登录）
```

- 确认版本：`curl -s http://127.0.0.1:5308/api/status | grep -o '"version":"[^"]*"'`，控制台头部胶囊也显示同一个版本号（由服务端下发，不会和镜像脱节）；
- **回滚**：把 `image:` 换成固定 tag（如 `:1.9.0`）再 `docker compose up -d`；
- **镜像 tag**：`latest`（跟随 main）、`1.9`、`1.9.0`；每次打 tag 会同时创建 GitHub Release。

---

## ❓ 常见问题

**Q1：明明刚复制的 Cookie，为什么还是提示「已过期」？**
绝大多数不是真过期，而是复制下来的东西构不成登录态：只复制了某一个值、缺 `_U`/`MUID`、复制到了别的域名下的 Cookie，或者会话确实失效了。现在这四种情况会被分开报出来（缺什么、补了什么、是不是被重定向到登录页）。优先用「🌐 打开登录窗口自动获取 Cookie」。

**Q2：登录窗口打不开 / 黑屏？**
- `MSR_VISIBLE` 必须是 `1`；
- 镜像里要装了 chromium（本仓库 Dockerfile 已内置，`CHROMIUM_PATH=/usr/bin/chromium`）；
- 反代场景检查 WebSocket 升级头；
- 容器里应有 `Xvfb`、`x11vnc`、`websockify` 三个进程：`docker exec ms-rewards ps aux | grep -E "Xvfb|x11vnc|websockify"`。

**Q3：为什么提示「非中国大陆 IP，已自动停止」？**
Rewards 会检测出口地区，中国区账号在境外 IP 上打卡容易被风控。默认开启国区锁；境外 VPS 用户请在配置中心配代理并走国内节点。

**Q4：更新后界面还是旧版本号？**
99% 是容器没换镜像。`docker compose config | grep image` 看写的是哪个 tag，然后 `docker compose up -d --force-recreate`。只在镜像页点「更新」不会让运行中的容器换镜像。

**Q5：构建（或拉镜像）特别慢？**
不用自己构建，直接拉现成镜像。拉 `ghcr.io` 慢的话在能上网的机器上 `docker pull` + `docker save` 再 `docker load`。真要构建就先换源：`APT_MIRROR` / `NPM_REGISTRY` 都已默认国内镜像，细节见 [DEPLOY-NAS.md](DEPLOY-NAS.md) 第 6 节。

**Q6：Cookie 会经常过期吗？**
网页 Cookie 通常能用数周到数月；移动端 Token 由程序用 Refresh Token 在后台续期。真的失效时面板和推送都会提示。

---

## 🛠️ 开发

```bash
npm install          # 需要 Node 20+
npm start            # 启动服务（默认 5308）
npm run dev          # 带 --watch
npm test             # node:test，无需网络，用临时数据目录
npm run demo         # 本地演示模式（假数据，不碰真实配置）
```

当前测试 **164 项**（163 通过 / 1 跳过：POSIX 文件权限断言在 Windows 上没有意义）。

### 目录结构

```
src/
├── index.js              入口：起 HTTP + noVNC WebSocket 代理 + 调度器
├── config.js             配置读写、账号增删、代理迁移、Cookie 规范化
├── scheduler.js          小时档位调度、计划落盘
├── network.js            axios 客户端（按域名白名单附带微软 Cookie）
├── core/
│   ├── api.js            微软网页/DAPI 接口与页面解析
│   ├── auth.js           Cookie/Token 体检、OAuth 换票
│   ├── browser.js        patchright 驱动、拟人搜索、打孔卡、会话复用
│   ├── cookieAssistant.js Cookie 解析/规范化/`_U` 推导/浏览器注入前净化
│   ├── loginWindow.js    可见浏览器登录窗口（抓 Cookie）
│   ├── taskManager.js    任务编排、账号隔离、统计
│   ├── notifier.js       多渠道推送（含 QQ 机器人）
│   ├── fingerprint.js    指纹单一来源（CHROME_MAJOR 等）
│   ├── browserSession.js 每账号浏览器会话持久化
│   ├── localProxyBridge.js 带认证 SOCKS5 的本地桥接
│   ├── contextLock.js    账号上下文锁 / 浏览器资源锁
│   └── ...
└── web/
    ├── server.js         Express 路由与鉴权、noVNC 反代
    └── public/           原生前端（无框架、无构建步骤）
```

> 升级基础镜像后如果 Chromium 主版本变了，启动日志会提醒你同步 `src/core/fingerprint.js` 里的 `CHROME_MAJOR`（当前 156）。

---

## 📜 许可与致谢

- 本项目基于 **MIT License** 分发，许可证全文见 [LICENSE](LICENSE)（保留原作者版权声明）。
- 二改内容与上游差异见 [MODIFIED.md](MODIFIED.md)。
- 核心打卡逻辑重构自社区开源的微软积分脚本，感谢原作者们的逆向研究。
- **免责声明**：本项目仅供学习与个人自动化研究使用。自动化操作 Microsoft Rewards 违反微软服务条款，可能导致账号被限制或封停，风险由使用者自行承担。
