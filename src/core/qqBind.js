import crypto from 'crypto';
import WebSocket from 'ws';
import axios from 'axios';
import logger from '../logger.js';

const TOKEN_URL = 'https://bots.qq.com/app/getAppAccessToken';
const GATEWAY_URL = 'https://api.sgroup.qq.com/gateway';
// 1 << 25：群聊与单聊（C2C）事件。QQ 把这两类事件放在同一个 intent 里。
const INTENTS = 1 << 25;
const BIND_TIMEOUT_MS = 60 * 1000;

/**
 * QQ 机器人的 OpenID 没法用 REST 接口查出来，只能被动接收事件：
 *   - 私聊：用户给机器人发消息 → C2C_MESSAGE_CREATE 里的 author.user_openid
 *   - 群聊：群里 @机器人 → GROUP_AT_MESSAGE_CREATE（部分环境是 GROUP_MESSAGE_CREATE）里的 group_openid
 * 所以这里走「生成验证码 → 连网关 → 用户把验证码发过来 → 从事件里取 OpenID」的流程，
 * 与 BetterGenshinImpact 的 QqWebSocketHelper 同一套思路。
 */
class QQBindManager {
  constructor() {
    this.sessions = new Map();
  }

  /** 生成 4 位数字验证码，避免要求用户输入复杂内容 */
  static generateCode() {
    return String(crypto.randomInt(0, 10000)).padStart(4, '0');
  }

  getSession(bindId) {
    const s = this.sessions.get(bindId);
    if (!s) return null;
    return {
      bindId: s.bindId,
      kind: s.kind,
      status: s.status,
      verifyCode: s.status === 'waiting' ? s.verifyCode : '',
      openid: s.openid || '',
      message: s.message || '',
      elapsedSec: Math.round((Date.now() - s.startedAt) / 1000)
    };
  }

  /**
   * 开一个绑定会话，立即返回验证码，后台连网关等消息。
   * kind: 'user'（私聊 user_openid）| 'group'（群聊 group_openid）
   */
  async start({ appId, clientSecret, kind = 'group' }) {
    const id = String(appId || '').trim();
    const secret = String(clientSecret || '').trim();
    if (!id) throw new Error('请先填写 QQ 机器人的 AppID');
    if (!secret) throw new Error('请先填写 QQ 机器人的 AppSecret');
    if (!['user', 'group'].includes(kind)) throw new Error('只有群聊和私聊需要自动获取 OpenID，频道请直接填 channel_id');

    // 同一时间只保留一个绑定会话，避免多个网关连接互相抢事件
    for (const [key, s] of this.sessions) {
      if (s.status === 'waiting') {
        s.status = 'cancelled';
        s.message = '被新的绑定请求取代';
        this.closeSession(key);
      }
    }

    const bindId = crypto.randomUUID();
    const session = {
      bindId,
      kind,
      status: 'waiting',
      verifyCode: QQBindManager.generateCode(),
      openid: '',
      message: '正在连接 QQ 网关…',
      startedAt: Date.now(),
      socket: null,
      heartbeat: null,
      timeout: null
    };
    this.sessions.set(bindId, session);

    // 后台跑，不阻塞 HTTP 响应，前端拿验证码后就开始轮询
    this._run(session, id, secret, kind).catch((e) => {
      this._fail(session, e.message || '绑定失败');
    });

    return { bindId, verifyCode: session.verifyCode, kind, timeoutSec: BIND_TIMEOUT_MS / 1000 };
  }

  cancel(bindId) {
    const s = this.sessions.get(bindId);
    if (!s) return false;
    if (s.status === 'waiting') {
      s.status = 'cancelled';
      s.message = '已取消';
    }
    this.closeSession(bindId);
    return true;
  }

  closeSession(bindId) {
    const s = this.sessions.get(bindId);
    if (!s) return;
    if (s.heartbeat) { clearInterval(s.heartbeat); s.heartbeat = null; }
    if (s.timeout) { clearTimeout(s.timeout); s.timeout = null; }
    if (s.socket) {
      try { s.socket.removeAllListeners(); s.socket.close(); } catch {}
      s.socket = null;
    }
  }

  _fail(session, message) {
    if (session.status !== 'waiting') return;
    session.status = 'failed';
    session.message = message;
    this.closeSession(session.bindId);
  }

  async _run(session, appId, clientSecret, kind) {
    session.timeout = setTimeout(() => {
      this._fail(session, `绑定超时（${BIND_TIMEOUT_MS / 1000} 秒内没收到验证码），请重试`);
    }, BIND_TIMEOUT_MS);
    session.timeout.unref?.();

    const token = await this._getAccessToken(appId, clientSecret);
    const gateway = await this._getGatewayUrl(token);

    const socket = new WebSocket(gateway);
    session.socket = socket;

    let seq = 0;
    socket.on('message', (raw) => {
      let payload;
      try { payload = JSON.parse(raw.toString()); } catch { return; }
      const op = payload.op;
      const t = payload.t;

      if (typeof payload.s === 'number') seq = payload.s;

      if (op === 10) {
        // Hello：拿到心跳间隔后先发 Identify，再开始心跳
        const interval = Number(payload?.d?.heartbeat_interval) || 45000;
        socket.send(JSON.stringify({ op: 2, d: { token: `QQBot ${token}`, intents: INTENTS, shard: [0, 1] } }));
        session.heartbeat = setInterval(() => {
          try { socket.send(JSON.stringify({ op: 1, d: seq || null })); } catch {}
        }, interval);
        session.heartbeat.unref?.();
        return;
      }

      if (op === 9) {
        this._fail(session, 'QQ 机器人鉴权失败：请检查 AppID / AppSecret，以及在开放平台是否开通了「群聊」或「单聊」事件权限');
        return;
      }

      if (op !== 0) return;

      if (t === 'READY') {
        session.message = kind === 'user'
          ? `请用 QQ 私聊机器人，发送验证码 ${session.verifyCode}`
          : `请在群里 @机器人，发送验证码 ${session.verifyCode}（也可以把机器人拉进群）`;
        return;
      }

      if (kind === 'user') {
        if (t === 'C2C_MESSAGE_CREATE') {
          const openid = payload?.d?.author?.user_openid;
          const content = String(payload?.d?.content || '');
          if (openid && content.includes(session.verifyCode)) this._succeed(session, openid);
        } else if (t === 'FRIEND_ADD') {
          const openid = payload?.d?.openid;
          if (openid) this._succeed(session, openid);
        }
        return;
      }

      if (t === 'GROUP_AT_MESSAGE_CREATE' || t === 'GROUP_MESSAGE_CREATE') {
        const groupOpenid = payload?.d?.group_openid;
        const content = String(payload?.d?.content || '');
        if (groupOpenid && content.includes(session.verifyCode)) {
          this._succeed(session, groupOpenid);
        } else if (groupOpenid) {
          session.message = '收到群消息但验证码不匹配，请发送当前显示的验证码';
        }
      } else if (t === 'GROUP_ADD_ROBOT') {
        const groupOpenid = payload?.d?.group_openid;
        if (groupOpenid) this._succeed(session, groupOpenid);
      }
    });

    socket.on('error', (e) => {
      this._fail(session, `QQ 网关连接失败：${e.message}`);
    });

    socket.on('close', () => {
      if (session.status === 'waiting') this._fail(session, 'QQ 网关连接已断开，请重试');
    });
  }

  _succeed(session, openid) {
    if (session.status !== 'waiting') return;
    session.status = 'success';
    session.openid = openid;
    session.message = '已获取 OpenID';
    this.closeSession(session.bindId);
    logger.log('🔵', `QQ 机器人 OpenID 自动获取成功（${session.kind === 'user' ? '私聊' : '群聊'}）`);
  }

  async _getAccessToken(appId, clientSecret) {
    const res = await axios.post(TOKEN_URL, { appId, clientSecret }, {
      timeout: 15000,
      headers: { 'Content-Type': 'application/json' },
      validateStatus: () => true
    });
    const token = res.data?.access_token;
    if (!token) {
      const detail = res.data?.message || res.data?.code || res.status;
      throw new Error(`获取 QQ access_token 失败（${detail}），请检查 AppID / AppSecret`);
    }
    return token;
  }

  async _getGatewayUrl(token) {
    const res = await axios.get(GATEWAY_URL, {
      timeout: 15000,
      headers: { Authorization: `QQBot ${token}` },
      validateStatus: () => true
    });
    const url = res.data?.url;
    if (!url) throw new Error(`获取 QQ 网关地址失败（${res.status}）`);
    return url;
  }
}

export const qqBindManager = new QQBindManager();
export default qqBindManager;
