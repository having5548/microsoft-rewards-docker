# 二改说明

**本项目是二改版（derivative work），不是原作者的官方版本。**

| 项目 | 信息 |
| --- | --- |
| 上游原项目 | [wangheqiang530/microsoft-rewards-docker](https://github.com/wangheqiang530/microsoft-rewards-docker) |
| 上游基线版本 | **v1.8.6**（快照于上游 `main`，2026-10-24） |
| 本二改版本 | **v1.9.0** |
| 二改维护者 | [having5548](https://github.com/having5548) |
| 上游许可证声明 | 上游 README 声明 MIT，但仓库内**未提供 LICENSE 文件**；本仓库按其声明附上 MIT 许可证正文（见 [LICENSE](LICENSE)），并保留原作者版权声明 |

> 原项目作者与此二改无关：二改引入的问题不要去找原作者，上游更新也不保证能直接合并进本仓库。

---

## 这一版改了什么

### 1. 删除 Epic 免费游戏领取（整块移除）

- 删除 `src/core/epic.js`（约 2200 行）、相关接口（`/api/epic/*`）、前端页签与面板、庆祝动画、指纹自检、会话导入等全部 UI；
- 删除 `config.epic` 配置段、调度器里的 Epic 定时任务、删除账号时的 profile 清理逻辑；
- 删除 6 个 Epic 专用测试文件与其余测试里的 Epic 用例；
- 文档（README / TODO）与 Docker 说明里的 Epic 章节一并删除。

### 2. 新增 QQ 机器人推送（官方 OpenAPI v2）

- 配置项：`notify.qqBot = { appId, clientSecret, openidType, openid }`，支持**群聊**（`group_openid`）/ **私聊**（`user_openid`）/ **频道**（`channel_id`）三种目标；
- `POST https://bots.qq.com/app/getAppAccessToken` 换取 `access_token`，按 AppID 缓存到过期前 60 秒（避免同 AppID 频繁换取被限频），401 时自动刷新重试一次；
- 发消息：`POST /v2/groups/{openid}/messages`（或 `/v2/users/…`、`/channels/…`），`Authorization: QQBot {token}`，`msg_type: 0`；频道接口按官方定义不带 `msg_type`；
- 入口域名按 `api.sgroup.qq.com` → `api.bot.qq.com` 顺序回退；
- 不带 `msg_id` 属于**主动消息**，受平台每月主动推送额度限制；额度用尽时平台返回 `err_code`（如 `40034005`），日志原样记录；
- 与其它渠道一样支持「测试」按钮（`POST /api/notify/test`，`channel: 'qqbot'`）。

### 3. 新增「登录窗口自动获取 Cookie」

手工从 F12 复制 Cookie 是最容易出错的环节（复制漏项、只复制了某个值、Safari 表格格式、缺少 `_U`），失败后又只表现为一句「Cookie 已过期」。现在改为：

- 在配置中心 / 新建账号 / 配置向导点「🌐 打开登录窗口自动获取 Cookie」；
- 后端在容器内启动**可见 Chromium**（复用镜像里已有的 Xvfb + x11vnc + websockify，经 noVNC 反向代理在 WebUI 内嵌小窗显示）；
- 用户在小窗里正常登录微软账号，后端每 1.5 秒从浏览器读取 Cookie，检测到 `_U` 即可保存；
- 保存时先抓 Cookie → 规范化 → **真实校验**（请求 `rewards.bing.com` 确认登录态）→ 通过才写入账号并关闭窗口；不通过则**保留窗口**让用户继续处理；
- 登录窗口与积分任务共用 `browserSlotLock`（同一时间只有一个 Chromium），默认 30 分钟超时自动关闭并释放资源（`LOGIN_WINDOW_TIMEOUT_MIN`，0 = 不超时）；
- 每个账号一份独立 profile（`data/login-profile/`），重启后可免重复输入密码，同时避免串号。

### 4. Cookie 粘贴容错（新增 `src/core/cookieAssistant.js`）

- 支持完整 Cookie 串、Cookie-Editor 导出的 JSON、Safari / Excel 表格复制（制表符）、带 `Cookie:` 前缀与包裹引号；
- **缺少 `_U` 时自动补齐**：从 `SRCHUID` / `_EDGE_S` / `SRCHHPGUSR` 里的 `GUID=` 交叉校验，几处一致才补，不一致则拒绝猜；
- 只贴了 `_U` 的 GUID 值、或只贴了 `_U=...` 一对时，与账号已有 Cookie **合并**而不是整体替换；
- **只贴了一个 Cookie 的值**（最常见错误）会明确提示「这只是一个 Cookie 的值，不是完整的 Cookie 串」，并给出获取完整串的步骤，不再含糊报「已过期」；
- 账号体检区分四种失败原因：单值输入 / 缺关键项（列清单）/ 页面无登录态标记 / 真的被重定向到登录页。

### 5. 其它顺带修复

- **更新检测指向本仓库**：`/api/system/check-update` 原来读的是原作者仓库的 tags/releases，跟本二改的版本号比较得出的结论是错的；现在默认读 `having5548/microsoft-rewards-docker`，可用环境变量 `MSR_UPDATE_REPO=owner/repo` 覆盖（再次二改时用得上）；
- **CI 只发布到本仓库的 GHCR**：原工作流会向 Docker Hub 的 `wangheqiang/*` 命名空间推送，二改仓库里已移除，只推 `ghcr.io/<owner>/<repo>`，避免误推到原作者名下；
- 修复 Windows 上检测不到 Edge 的问题：新版 Edge 装在 `Program Files (x86)\Microsoft\Edge\Application`，原候选路径写成了 `Microsoft Edge`，并补充 `%LOCALAPPDATA%` 下的用户级安装；
- 容器退出时主动关闭登录窗口占用的 Chromium，避免 SIGTERM 后迟迟不退出；
- 版本号 1.8.6 → 1.9.0，新增 `DEPLOY-NAS.md`（群晖/威联通/极空间部署与排错）、`MSR_VISIBLE` / `LOGIN_WINDOW_TIMEOUT_MIN` 环境变量、`NPM_REGISTRY` 构建参数（国内 NAS 默认走 npmmirror）、`.gitattributes`（强制脚本 LF）。

---

## 一些说明

- **测试**：`npm test` 共 152 项，151 通过、1 跳过（POSIX 文件权限断言在 Windows 上无意义）。
- **兼容性**：旧环境变量 `EPIC_VISIBLE` / `EPIC_LOGIN_TIMEOUT_MIN` 仍被识别，老 compose 升级后不会突然失去可见浏览器或超时保护。
- **已知限制**：登录窗口需要容器内有图形环境（`MSR_VISIBLE=1`，镜像默认开启）；纯无头部署时请改用「手工粘贴完整 Cookie」。
- **风险提示**：自动化操作 Microsoft Rewards 违反微软服务条款，存在账号被限制/封停的风险；二改不对此作任何担保。

## 上游更新怎么合并

本仓库是从上游 **压缩包快照**（无 git 历史）开始二改的，因此**没有上游的提交历史**，无法直接 `git merge` 上游。

同步上游改动时的建议做法：

1. 把上游新版本下载到临时目录；
2. 用 `git diff --no-index` 或对比工具逐文件比对；
3. 优先合并 `src/core/api.js`、`src/core/taskManager.js`、`src/core/browser.js` 等**未二改**的模块；
4. 二改过的模块（`config.js`、`scheduler.js`、`web/server.js`、`web/public/*`、`notifier.js`）需要手工合并，重点保住本文档第 1~4 节的改动。
