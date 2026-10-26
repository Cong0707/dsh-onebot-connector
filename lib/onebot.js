/**
 * OneBot v11 对接层 —— 基于成熟库 node-napcat-ts（NCWebsocket）。
 *
 * 为什么用库而不是手写：OneBot v11 的段结构、事件类型、重连、API 超时
 * 都有既定规矩，自己写容易漏。node-napcat-ts 底层就是标准 OneBot v11，
 * 兼容 NapCat / LLOneBot / Lagrange / go-cqhttp 等任何实现。
 *
 * 安全：这一层**不存任何 QQ 账号密码**。
 * QQ 登录由 OneBot 实现自己负责，我们只要 endpoint + accessToken。
 */
import { NCWebsocket } from 'node-napcat-ts';

/** 收到/发出的段数组 → 一行可读文本。 */
export function segmentsToText(segments) {
  if (!Array.isArray(segments)) return String(segments ?? '');
  return segments.map((seg) => {
    if (!seg || typeof seg !== 'object') return '';
    switch (seg.type) {
      case 'text': return String(seg.data?.text ?? '');
      case 'at': return seg.data?.qq === 'all' ? '@全体成员' : `@${seg.data?.qq ?? ''}`;
      case 'face': return '[表情]';
      case 'mface': return `[表情包${seg.data?.summary ? ':' + seg.data.summary : ''}]`;
      case 'image': return '[图片]';
      case 'record': return '[语音]';
      case 'video': return '[视频]';
      case 'file': return `[文件${seg.data?.file ? ':' + seg.data.file : ''}]`;
      case 'reply': return '';
      case 'json': return '[卡片]';
      case 'xml': return '[XML]';
      case 'poke': return '[戳一戳]';
      case 'forward': return '[合并转发]';
      default: return `[${seg.type}]`;
    }
  }).join('').trim();
}

/** 文本 → OneBot 段。 */
export function textToSegments(text) {
  return [{ type: 'text', data: { text: String(text ?? '') } }];
}

const SEND_GLOBAL_GAP = 3_000;

export class OneBotClient {
  constructor({ log }) {
    this.log = log;
    this.bot = null;
    this.state = 'idle';          // idle | connecting | online | offline | failed
    this.lastError = '';
    this.selfId = 0;
    this.nickname = '';
    this.connectAt = 0;
    this.listeners = new Set();
    this.manualStop = false;
    this.lastSendAt = 0;
    this.groupCache = new Map();   // groupId → 最近消息
    this.groups = new Map();
    this.msgCount = 0;
    this.endpoint = { baseUrl: '', accessToken: '' };
    this._offs = [];
  }

  configure({ baseUrl, accessToken }) {
    this.endpoint = {
      baseUrl: String(baseUrl ?? '').trim(),
      accessToken: String(accessToken ?? '').trim(),
    };
  }

  onEvent(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }

  emit(event) {
    for (const fn of this.listeners) {
      try { fn(event); } catch (e) { this.log.warn('事件处理出错：' + (e?.message ?? e)); }
    }
  }

  status() {
    return {
      state: this.state,
      online: this.state === 'online',
      selfId: this.selfId,
      nickname: this.nickname,
      connectAt: this.connectAt,
      lastError: this.lastError,
      messageCount: this.msgCount,
      baseUrl: this.endpoint.baseUrl,
      hasToken: Boolean(this.endpoint.accessToken),
    };
  }

  setState(s, detail) {
    if (this.state === s) return;
    this.state = s;
    if (detail) this.lastError = detail;
    this.log.info(`OneBot 状态：${s}${detail ? '（' + detail + '）' : ''}`);
    this.emit({ kind: 'state', state: s, detail: detail ?? '' });
  }

  async start() {
    if (this.state === 'connecting' || this.state === 'online') {
      return { ok: false, reason: `当前状态 ${this.state}` };
    }
    const { baseUrl, accessToken } = this.endpoint;
    if (!baseUrl) return { ok: false, reason: '未配置 WS 地址' };
    this.manualStop = false;
    this.setState('connecting');

    try {
      const options = { baseUrl };
      if (accessToken) options.accessToken = accessToken;
      // 库自带重连；但重连太激进会刷日志，这里给保守值
      options.reconnection = { enable: true, attempts: 10, delay: 3000 };
      options.apiTimeout = 20000;

      const bot = new NCWebsocket(options, false);
      this.bot = bot;
      this.bindEvents(bot);

      await bot.connect();
      this.connectAt = Date.now();
      this.setState('online');

      // 拿自己的身份
      try {
        const info = await bot.get_login_info();
        this.selfId = info?.user_id ?? 0;
        this.nickname = info?.nickname ?? '';
      } catch (e) {
        this.log.warn('获取登录信息失败：' + (e?.message ?? e));
      }
      this.refreshGroups().catch(() => {});
      return { ok: true };
    } catch (e) {
      const msg = e?.message ?? String(e);
      this.setState('failed', msg);
      this.log.warn('OneBot 连接失败：' + msg);
      return { ok: false, reason: msg };
    }
  }

  bindEvents(bot) {
    const safe = (fn) => (...args) => {
      try { fn(...args); } catch (e) { this.log.warn('回调异常：' + (e?.message ?? e)); }
    };

    this._offs.push(bot.subscribe('message.group', safe((ctx) => this.onGroupMessage(ctx))));
    this._offs.push(bot.subscribe('message.private', safe((ctx) => this.onPrivateMessage(ctx))));
    this._offs.push(bot.subscribe('meta_event.lifecycle', safe((ctx) => {
      const selfId = ctx?.self_id ?? ctx?.data?.self_id;
      if (selfId) this.selfId = selfId;
    })));
  }

  onGroupMessage(ctx) {
    const gid = ctx?.group_id;
    if (!gid) return;
    const text = segmentsToText(ctx.message);
    const sender = ctx.sender?.card || ctx.sender?.nickname || String(ctx.user_id ?? '');
    const time = (ctx.time ?? Math.floor(Date.now() / 1000)) * 1000;
    this.msgCount += 1;

    const cache = this.groupCache.get(gid) ?? [];
    cache.push({ userId: ctx.user_id, senderName: sender, text, time, messageId: ctx.message_id });
    if (cache.length > 200) cache.splice(0, cache.length - 200);
    this.groupCache.set(gid, cache);

    this.emit({
      kind: 'group-message',
      groupId: gid,
      groupName: this.groups.get(gid)?.groupName ?? '',
      userId: ctx.user_id,
      senderName: sender,
      text,
      messageId: ctx.message_id,
      time,
      isSelf: ctx.user_id === this.selfId,
    });
  }

  onPrivateMessage(ctx) {
    this.msgCount += 1;
    this.emit({
      kind: 'private-message',
      userId: ctx.user_id,
      senderName: ctx.sender?.nickname || String(ctx.user_id ?? ''),
      text: segmentsToText(ctx.message),
      time: (ctx.time ?? Math.floor(Date.now() / 1000)) * 1000,
      isSelf: ctx.user_id === this.selfId,
    });
  }

  async stop() {
    this.manualStop = true;
    for (const off of this._offs) { try { off(); } catch { /* ignore */ } }
    this._offs = [];
    const bot = this.bot;
    this.bot = null;
    if (bot) { try { await bot.disconnect(); } catch { /* ignore */ } }
    this.setState('idle');
    return { ok: true };
  }

  // ── 群操作 ──────────────────────────────────────────────────────
  async refreshGroups() {
    if (!this.bot) return [];
    const list = await this.bot.get_group_list();
    if (!Array.isArray(list)) return [];
    const out = [];
    for (const g of list) {
      const gid = g.group_id;
      const cached = this.groupCache.get(gid) ?? [];
      const last = cached[cached.length - 1];
      this.groups.set(gid, { groupName: g.group_name ?? '', memberCount: g.member_count ?? 0 });
      out.push({
        groupId: gid,
        groupName: g.group_name ?? '',
        memberCount: g.member_count ?? 0,
        lastMessage: last ? { text: last.text, senderName: last.senderName, time: last.time } : null,
        cachedCount: cached.length,
      });
    }
    return out.sort((a, b) => (b.lastMessage?.time ?? 0) - (a.lastMessage?.time ?? 0));
  }

  async listGroups() {
    if (!this.bot) throw new Error('OneBot 未连接');
    return this.refreshGroups();
  }

  async readGroup(groupId, limit = 20) {
    const gid = Number(groupId);
    const cached = this.groupCache.get(gid) ?? [];
    if (cached.length >= limit) return cached.slice(-limit);
    if (this.bot) {
      try {
        const res = await this.bot.get_group_msg_history({ group_id: gid, count: limit });
        const msgs = res?.messages ?? res ?? [];
        if (Array.isArray(msgs) && msgs.length) {
          const rows = msgs.map((m) => ({
            userId: m.sender?.user_id ?? m.user_id ?? 0,
            senderName: m.sender?.card || m.sender?.nickname || '',
            text: segmentsToText(m.message),
            time: (m.time ?? 0) * 1000,
            messageId: m.message_id,
          }));
          const merged = [...cached];
          for (const r of rows) if (!merged.some((x) => x.messageId === r.messageId)) merged.push(r);
          merged.sort((a, b) => a.time - b.time);
          this.groupCache.set(gid, merged.slice(-200));
          return merged.slice(-limit);
        }
      } catch (e) {
        this.log.warn('拉群历史失败：' + (e?.message ?? e));
      }
    }
    return cached.slice(-limit);
  }

  // ── 发送 ────────────────────────────────────────────────────────
  checkRate() {
    const now = Date.now();
    if (now - this.lastSendAt < SEND_GLOBAL_GAP) {
      return `发送太快，请等 ${Math.ceil((SEND_GLOBAL_GAP - (now - this.lastSendAt)) / 1000)} 秒`;
    }
    return null;
  }

  async sendGroup(groupId, message) {
    if (!this.bot) throw new Error('OneBot 未连接');
    const gid = Number(groupId);
    if (!gid) throw new Error('群号无效');
    const limited = this.checkRate();
    if (limited) throw new Error(limited);
    const msg = Array.isArray(message) ? message : textToSegments(message);
    const res = await this.bot.send_group_msg({ group_id: gid, message: msg });
    this.lastSendAt = Date.now();
    return { ok: true, messageId: res?.message_id ?? 0 };
  }

  async sendPrivate(userId, message) {
    if (!this.bot) throw new Error('OneBot 未连接');
    const uid = Number(userId);
    if (!uid) throw new Error('QQ 号无效');
    const msg = Array.isArray(message) ? message : textToSegments(message);
    const res = await this.bot.send_private_msg({ user_id: uid, message: msg });
    this.lastSendAt = Date.now();
    return { ok: true, messageId: res?.message_id ?? 0 };
  }

  async sendSticker(groupId, source) {
    if (!this.bot) throw new Error('OneBot 未连接');
    const gid = Number(groupId);
    if (!gid) throw new Error('群号无效');
    const limited = this.checkRate();
    if (limited) throw new Error(limited);
    const s = String(source ?? '').trim();
    const seg = s.startsWith('face:')
      ? { type: 'face', data: { id: String(s.slice(5) || '1') } }
      : { type: 'image', data: { file: s } };
    const res = await this.bot.send_group_msg({ group_id: gid, message: [seg] });
    this.lastSendAt = Date.now();
    return { ok: true, messageId: res?.message_id ?? 0 };
  }
}
