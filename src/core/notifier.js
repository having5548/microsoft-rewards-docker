import configManager from '../config.js';
import networkClient from '../network.js';
import logger from '../logger.js';

/**
 * QQ 机器人 access_token 缓存。
 *
 * QQ 官方的 getAppAccessToken 有效期通常是 7200 秒，且**同一个 AppID 频繁换取会被限频**。
 * 这里按 AppID 缓存到「过期前 60 秒」为止；取 token 失败不缓存，下次重试。
 */
const qqTokenCache = new Map();

/** QQ 消息正文有长度上限，超长会被平台直接拒绝，这里先截断并保留可读的结尾 */
const QQ_CONTENT_LIMIT = 1200;

/**
 * QQ OpenAPI 有两套可用的入口域名：文档里的统一地址 api.bot.qq.com，
 * 以及历史上大量机器人仍在用的 api.sgroup.qq.com。两者是同一服务，
 * 依次尝试可以在其中一边被网络策略挡住时继续工作。
 */
const QQ_API_HOSTS = ['https://api.sgroup.qq.com', 'https://api.bot.qq.com'];

function truncateForQQ(text) {
  const value = String(text || '');
  return value.length > QQ_CONTENT_LIMIT ? `${value.slice(0, QQ_CONTENT_LIMIT)}…（内容过长已截断）` : value;
}

export class Notifier {
  async send(title, content) {
    const cfg = configManager.get();
    const notify = cfg.notify || {};
    const timeStr = new Date().toLocaleString('zh-CN', { hour12: false });
    const fullContent = `【${title}】\n时间: ${timeStr}\n\n${content}`;

    const tasks = [];

    // 1. 企业微信
    if (notify.wework) {
      tasks.push(this.sendWeWork(notify.wework.trim(), fullContent));
    }

    // 2. 钉钉
    if (notify.dingding) {
      tasks.push(this.sendDingTalk(notify.dingding.trim(), title, fullContent));
    }

    // 3. 飞书
    if (notify.feishu) {
      tasks.push(this.sendFeishu(notify.feishu.trim(), title, fullContent));
    }

    // 4. Bark
    if (notify.bark) {
      tasks.push(this.sendBark(notify.bark.trim(), title, content));
    }

    // 5. PushMe
    if (notify.pushme) {
      tasks.push(this.sendPushMe(notify.pushme.trim(), title, content));
    }

    // 6. Telegram
    if (notify.telegram?.botToken && notify.telegram?.chatId) {
      tasks.push(this.sendTelegram(
        notify.telegram.botToken.trim(),
        notify.telegram.chatId.trim(),
        title,
        fullContent
      ));
    }

    // 7. QQ 机器人（AppID + AppSecret + OpenID）
    if (notify.qqBot?.appId && notify.qqBot?.clientSecret && notify.qqBot?.openid) {
      tasks.push(this.sendQQBot(notify.qqBot, title, fullContent));
    }

    if (tasks.length > 0) {
      const results = await Promise.allSettled(tasks);
      return results;
    }
  }

  async sendWeWork(key, text) {
    const url = key.startsWith('http') ? key : `https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=${key}`;
    try {
      await networkClient.request({
        url,
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        data: {
          msgtype: 'text',
          text: { content: text }
        }
      });
      logger.log('🔵', '「企业微信」消息推送成功');
      return true;
    } catch (e) {
      logger.log('🔴', `「企业微信」推送失败: ${e.message}`);
      throw e;
    }
  }

  async sendDingTalk(token, title, text) {
    const url = token.startsWith('http') ? token : `https://oapi.dingtalk.com/robot/send?access_token=${token}`;
    try {
      await networkClient.request({
        url,
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        data: {
          msgtype: 'markdown',
          markdown: {
            title: `# ${title}`,
            text: text
          }
        }
      });
      logger.log('🔵', '「钉钉」消息推送成功');
      return true;
    } catch (e) {
      logger.log('🔴', `「钉钉」推送失败: ${e.message}`);
      throw e;
    }
  }

  async sendFeishu(urlOrKey, title, text) {
    const url = urlOrKey.startsWith('http') ? urlOrKey : `https://open.feishu.cn/open-apis/bot/v2/hook/${urlOrKey}`;
    try {
      await networkClient.request({
        url,
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        data: {
          msg_type: 'interactive',
          card: {
            schema: '2.0',
            header: {
              title: { tag: 'plain_text', content: title },
              template: 'blue'
            },
            body: {
              elements: [{ tag: 'markdown', content: text }]
            }
          }
        }
      });
      logger.log('🔵', '「飞书」消息推送成功');
      return true;
    } catch (e) {
      logger.log('🔴', `「飞书」推送失败: ${e.message}`);
      throw e;
    }
  }

  async sendBark(keyOrUrl, title, text) {
    const base = keyOrUrl.startsWith('http') ? keyOrUrl.replace(/\/$/, '') : `https://api.day.app/${keyOrUrl}`;
    const url = `${base}/${encodeURIComponent(title)}/${encodeURIComponent(text)}?group=rewards&icon=https://rewards.bing.com/rewards.png`;
    try {
      await networkClient.request({ url, method: 'GET' });
      logger.log('🔵', '「Bark」消息推送成功');
      return true;
    } catch (e) {
      logger.log('🔴', `「Bark」推送失败: ${e.message}`);
      throw e;
    }
  }

  async sendPushMe(key, title, text) {
    const url = `https://push.i-i.me/?push_key=${encodeURIComponent(key)}`;
    try {
      await networkClient.request({
        url,
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        data: {
          title: `Microsoft Rewards - ${title}`,
          content: text,
          type: 'markdown'
        }
      });
      logger.log('🔵', '「PushMe」消息推送成功');
      return true;
    } catch (e) {
      logger.log('🔴', `「PushMe」推送失败: ${e.message}`);
      throw e;
    }
  }

  async sendTelegram(botToken, chatId, title, text) {
    const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
    // Telegram 基础 Markdown 模式下，未配对的下划线 _ 会导致 400 实体解析异常
    const safeTitle = String(title || '').replace(/(?<!\\)_/g, '\\_');
    const safeText = String(text || '').replace(/(?<!\\)_/g, '\\_');
    const message = `*${safeTitle}*\n\n${safeText}`;
    try {
      await networkClient.request({
        url,
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        data: {
          chat_id: chatId,
          text: message,
          parse_mode: 'Markdown'
        }
      });
      logger.log('🔵', '「Telegram」消息推送成功');
      return true;
    } catch (e) {
      logger.log('🔴', `「Telegram」推送失败: ${e.message}`);
      throw e;
    }
  }

  /**
   * 换取 QQ 机器人 access_token。
   * 官方接口：POST https://bots.qq.com/app/getAppAccessToken { appId, clientSecret }
   * 返回 { access_token, expires_in }，有效期通常 7200 秒。
   */
  async getQQBotToken(appId, clientSecret, forceRefresh = false) {
    const key = `${appId}`;
    const cached = qqTokenCache.get(key);
    if (!forceRefresh && cached && cached.expiresAt > Date.now()) {
      return cached.token;
    }

    const res = await networkClient.request({
      url: 'https://bots.qq.com/app/getAppAccessToken',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      data: JSON.stringify({ appId: String(appId), clientSecret: String(clientSecret) })
    });
    const data = typeof res === 'string' ? (() => { try { return JSON.parse(res); } catch { return {}; } })() : (res || {});

    if (!data.access_token) {
      const reason = data.message || data.msg || data.code || '未返回 access_token';
      throw new Error(`获取 QQ 机器人 access_token 失败：${reason}（请检查 AppID / AppSecret 是否正确）`);
    }

    const expiresIn = Number(data.expires_in) || 7200;
    qqTokenCache.set(key, {
      token: data.access_token,
      // 提前 60 秒过期，避免踩在边界上被平台判 401
      expiresAt: Date.now() + Math.max(60, expiresIn - 60) * 1000
    });
    return data.access_token;
  }

  /** 清掉缓存的 token（改了 AppSecret 或测试失败后需要） */
  clearQQBotToken(appId) {
    if (appId) qqTokenCache.delete(String(appId));
    else qqTokenCache.clear();
  }

  /**
   * 发送 QQ 机器人消息。
   *
   * msg_type 0 = 纯文本。不带 msg_id 属于**主动消息**，受平台「主动推送额度」限制
   * （每个自然月按机器人等级发放），额度用尽时平台返回错误码 40034005/304049 之类，
   * 这里原样把 err_code 抛出去，便于在日志里定位。
   */
  async sendQQBot(settings, title, text) {
    const appId = String(settings?.appId || '').trim();
    const clientSecret = String(settings?.clientSecret || '').trim();
    const openidType = ['group', 'user', 'channel'].includes(settings?.openidType) ? settings.openidType : 'group';
    const openid = String(settings?.openid || '').trim();

    if (!appId || !clientSecret || !openid) {
      throw new Error('QQ 机器人配置不完整：需要 AppID、AppSecret 与 OpenID');
    }

    const pathPrefix = openidType === 'group' ? 'groups' : (openidType === 'user' ? 'users' : 'channels');
    const pathSuffix = openidType === 'channel' ? '' : '/messages';
    // 群聊 / 私聊接口要求 msg_type（0 = 纯文本）；频道接口没有这个字段，
    // 多传一个未知字段在部分机器人版本上会直接 400，所以按类型区分。
    const body = openidType === 'channel'
      ? { content: truncateForQQ(`【${title}】\n${text}`) }
      : { content: truncateForQQ(`【${title}】\n${text}`), msg_type: 0 };

    let lastError = null;
    for (const attempt of [0, 1]) {
      let token = await this.getQQBotToken(appId, clientSecret, attempt > 0);
      try {
        let data = null;
        let lastHostError = null;
        for (const host of QQ_API_HOSTS) {
          try {
            const res = await networkClient.request({
              url: `${host}/v2/${pathPrefix}/${encodeURIComponent(openid)}${pathSuffix}`,
              method: 'POST',
              headers: {
                'Content-Type': 'application/json; charset=utf-8',
                'Authorization': `QQBot ${token}`
              },
              data: JSON.stringify(body)
            });
            data = typeof res === 'string' ? (() => { try { return JSON.parse(res); } catch { return {}; } })() : (res || {});
            break;
          } catch (e) {
            lastHostError = e;
          }
        }
        if (data === null) throw lastHostError || new Error('QQ 接口不可达');

        if (data.err_code && data.err_code !== 0) {
          throw new Error(`QQ 机器人返回错误 ${data.err_code}: ${data.message || ''}`);
        }
        logger.log('🔵', '「QQ 机器人」消息推送成功');
        return true;
      } catch (e) {
        lastError = e;
        // token 失效时换一次新 token 再试；其它错误（额度、权限）重试没有意义
        const retriable = /401|token|access_token/i.test(e.message || '');
        if (attempt === 0 && retriable) {
          qqTokenCache.delete(appId);
          continue;
        }
        break;
      }
    }

    logger.log('🔴', `「QQ 机器人」推送失败: ${lastError?.message || '未知错误'}`);
    throw lastError || new Error('QQ 机器人推送失败');
  }

  async testChannel(channel, value) {
    const title = '测试通知';
    const content = '如果你看到这条消息，说明该推送渠道已成功配置并联通！';
    switch (channel) {
      case 'wework':
        return this.sendWeWork(value, `【${title}】\n${content}`);
      case 'dingding':
        return this.sendDingTalk(value, title, `### ${title}\n${content}`);
      case 'feishu':
        return this.sendFeishu(value, title, content);
      case 'bark':
        return this.sendBark(value, title, content);
      case 'pushme':
        return this.sendPushMe(value, title, content);
      case 'qqbot': {
        const config = typeof value === 'object' ? value : JSON.parse(value);
        return this.sendQQBot(config, title, content);
      }
      case 'telegram': {
        const { botToken, chatId } = typeof value === 'object' ? value : JSON.parse(value);
        return this.sendTelegram(botToken, chatId, title, content);
      }
      default:
        throw new Error('不支持的通知渠道');
    }
  }
}

export const notifier = new Notifier();
export default notifier;
