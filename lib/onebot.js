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
import { faceName, faceIdOf } from './faces.js';
import { mkdir, writeFile, stat, readFile, readdir, unlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join, resolve, relative, isAbsolute } from 'node:path';

/** 收到/发出的段数组 → 一行可读文本。 */
export function segmentsToText(segments) {
  if (!Array.isArray(segments)) return String(segments ?? '');
  return segments.map((seg) => {
    if (!seg || typeof seg !== 'object') return '';
    switch (seg.type) {
      case 'text': return String(seg.data?.text ?? '');
      case 'at': return seg.data?.qq === 'all' ? '@全体成员' : `@${seg.data?.qq ?? ''}`;
      case 'face': {
        // OneBot 只给 id，翻成名字模型才看得懂 —— "341" 对模型毫无意义
        const id = String(seg.data?.id ?? seg.data?.face_id ?? '');
        const name = faceName(id);
        return name ? `[表情:${name}]` : `[表情:${id}]`;
      }
      case 'mface': {
        // 表情包：summary 一般是 "[动画表情]" 这种没信息量的词，
        // 真正能看懂的途径是把图下载下来让模型 read_image，text 里只留个标记
        const sm = String(seg.data?.summary ?? '').replace(/^\[|\]$/g, '').trim();
        return sm && !/^(动画表情|表情)$/.test(sm) ? `[表情包:${sm}]` : '[表情包]';
      }
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

/** 图片缓存目录。模型只能 read_image 读本地文件，所以图片必须落盘。 */
export function imageDir() {
  return join(homedir(), '.dsh', 'plugins-data', 'onebot-connector', 'images');
}

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_IMAGES_PER_MSG = 4;

// —— 图片缓存清理 ——
// 不清理的话群里天天发图，磁盘会一直涨（实测 1.5 小时 52MB，按这速度一个月 25GB）。
// 策略：超过 maxMB 或超过 maxAge 就删最旧的；10 分钟内刚下载的不动，免得模型正要读却被删。
const CACHE_MAX_MB = 256;
const CACHE_MAX_AGE_MS = 7 * 24 * 3600 * 1000;
const CACHE_KEEP_RECENT_MS = 10 * 60 * 1000;
const CACHE_PRUNE_GAP_MS = 60 * 1000;
let lastPruneAt = 0;

/**
 * 清理图片缓存。失败一律静默 —— 清不掉也不能影响收消息。
 * @returns {Promise<{removed:number, freedBytes:number, keptBytes:number}>}
 */
export async function pruneImageCache({ log, maxMB = CACHE_MAX_MB, maxAgeMs = CACHE_MAX_AGE_MS } = {}) {
  const now = Date.now();
  if (now - lastPruneAt < CACHE_PRUNE_GAP_MS) return { removed: 0, freedBytes: 0, keptBytes: -1 };
  lastPruneAt = now;

  const dir = imageDir();
  let names;
  try { names = await readdir(dir); } catch { return { removed: 0, freedBytes: 0, keptBytes: 0 }; }

  const files = [];
  for (const n of names) {
    const p = join(dir, n);
    try {
      const st = await stat(p);
      if (!st.isFile()) continue;
      files.push({ path: p, size: st.size, mtime: st.mtimeMs });
    } catch { /* 文件刚被删掉，忽略 */ }
  }
  if (!files.length) return { removed: 0, freedBytes: 0, keptBytes: 0 };

  files.sort((a, b) => a.mtime - b.mtime);      // 最旧的排前面
  let total = files.reduce((s, x) => s + x.size, 0);
  const cap = Math.max(1, Number(maxMB) || CACHE_MAX_MB) * 1024 * 1024;

  let removed = 0;
  let freed = 0;
  for (const x of files) {
    if (now - x.mtime < CACHE_KEEP_RECENT_MS) continue;   // 刚下的别碰
    const tooOld = now - x.mtime > maxAgeMs;
    const tooBig = total > cap;
    if (!tooOld && !tooBig) continue;
    try {
      await unlink(x.path);
      total -= x.size;
      freed += x.size;
      removed++;
    } catch { /* 删不掉就算了 */ }
  }

  if (removed > 0) {
    log?.info?.('图片缓存清理：删 ' + removed + ' 个，释放 ' + (freed / 1024 / 1024).toFixed(1) + 'MB，剩余 ' + (total / 1024 / 1024).toFixed(1) + 'MB');
  }
  return { removed, freedBytes: freed, keptBytes: total };
}
const MAX_SEND_IMAGE_BYTES = 6 * 1024 * 1024;   // base64 会膨胀 33%，留点余量

/** 用魔数判断真实格式，扩展名不对 read_image 会拒绝。 */
function sniffExt(buf, fallback) {
  if (buf[0] === 0x89 && buf[1] === 0x50) return 'png';
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'jpg';
  if (buf[0] === 0x47 && buf[1] === 0x49) return 'gif';
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf[8] === 0x57) return 'webp';
  return fallback;
}

function guessExt(summary) {
  const s = String(summary || '');
  if (/\.png/i.test(s)) return 'png';
  if (/\.gif/i.test(s)) return 'gif';
  if (/\.webp/i.test(s)) return 'webp';
  return 'jpg';
}

/**
 * 把消息里的图片段落盘，返回本地路径。
 *
 * 为什么必须这么做：模型看到 "[图片]" 三个字什么也得不到。
 * 只有当图片是个本地文件，模型才能用 read_image 真正看到内容。
 *
 * @returns {Promise<{path: string, url: string, summary: string}[]>}
 */
export async function downloadSegmentImages(segments, { log, maxCacheMB } = {}) {
  if (!Array.isArray(segments)) return [];
  const picks = [];
  for (const seg of segments) {
    if (!seg || (seg.type !== 'image' && seg.type !== 'mface')) continue;
    const url = seg.data?.url;
    if (!url) continue;
    picks.push({ url, summary: seg.data?.summary ?? '' });
    if (picks.length >= MAX_IMAGES_PER_MSG) break;
  }
  if (!picks.length) return [];

  try { await mkdir(imageDir(), { recursive: true }); } catch { return []; }

  const done = await Promise.all(picks.map(async ({ url, summary }) => {
    try {
      const hash = createHash('sha1').update(url).digest('hex').slice(0, 20);
      let ext = guessExt(summary);
      const cached = join(imageDir(), hash + '.' + ext);
      try {
        const st = await stat(cached);
        if (st.size > 0) return { path: cached, url, summary };
      } catch { /* 未缓存 */ }

      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), 8000);
      let buf;
      try {
        const res = await fetch(url, { signal: ac.signal });
        if (!res.ok) return null;
        const len = Number(res.headers.get('content-length') || 0);
        if (len > MAX_IMAGE_BYTES) return null;
        buf = Buffer.from(await res.arrayBuffer());
      } finally { clearTimeout(timer); }

      if (!buf || buf.length === 0 || buf.length > MAX_IMAGE_BYTES) return null;
      ext = sniffExt(buf, ext);
      const file = join(imageDir(), hash + '.' + ext);
      await writeFile(file, buf);
      return { path: file, url, summary };
    } catch (e) {
      log?.warn?.('图片下载失败：' + (e?.message ?? e));
      return null;
    }
  }));

  const ok = done.filter(Boolean);
  // 每次落盘之后顺手清一次（内部有 60 秒节流，不会变成性能问题）
  pruneImageCache({ log, maxMB: maxCacheMB }).catch(() => {});
  return ok;
}

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

  configure({ baseUrl, accessToken, imageCacheMB, stickerDir }) {
    this.endpoint = {
      baseUrl: String(baseUrl ?? '').trim(),
      accessToken: String(accessToken ?? '').trim(),
    };
    // 传函数时可以每次现读 —— 面板改了立刻生效；传数字就是固定值。
    this.cacheMaxMB = typeof imageCacheMB === 'function'
      ? imageCacheMB
      : (() => { const mb = Number(imageCacheMB); return Number.isFinite(mb) && mb > 0 ? mb : CACHE_MAX_MB; })();
    this.imageCacheMB = this.cacheMaxMB();
    this.stickerDir = String(stickerDir ?? '').trim();
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

    // 注意：组消息要下载图片，是异步的，所以单独 catch，不能让异常冒到宿主进程
    this._offs.push(bot.subscribe('message.group', safe((ctx) => {
      this.onGroupMessage(ctx).catch((e) => this.log.warn('处理群消息失败：' + (e?.message ?? e)));
    })));
    this._offs.push(bot.subscribe('message.private', safe((ctx) => this.onPrivateMessage(ctx))));
    this._offs.push(bot.subscribe('meta_event.lifecycle', safe((ctx) => {
      const selfId = ctx?.self_id ?? ctx?.data?.self_id;
      if (selfId) this.selfId = selfId;
    })));
  }

  async onGroupMessage(ctx) {
    const gid = ctx?.group_id;
    if (!gid) return;
    const text = segmentsToText(ctx.message);
    const sender = ctx.sender?.card || ctx.sender?.nickname || String(ctx.user_id ?? '');
    const time = (ctx.time ?? Math.floor(Date.now() / 1000)) * 1000;
    this.msgCount += 1;

    // 图片先落盘，模型才能 read_image 看到内容
    let images = [];
    try { images = await downloadSegmentImages(ctx.message, { log: this.log, maxCacheMB: this.cacheMaxMB() }); } catch { images = []; }

    // time 来自服务器，只有秒；recvAt 是本地收到的时刻，毫秒 —— 想知道「多久才送到」用这个。
    const recvAt = Date.now();
    const record = { userId: ctx.user_id, senderName: sender, text, time, recvAt, messageId: ctx.message_id, images };
    const cache = this.groupCache.get(gid) ?? [];
    cache.push(record);
    if (cache.length > 200) cache.splice(0, cache.length - 200);
    this.groupCache.set(gid, cache);

    this.emit({
      kind: 'group-message',
      groupId: gid,
      groupName: this.groups.get(gid)?.groupName ?? '',
      userId: ctx.user_id,
      senderName: sender,
      text,
      images,
      messageId: ctx.message_id,
      time,
      recvAt,
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

  /**
   * 读群消息。
   * @param {number} groupId
   * @param {number} limit
   * @param {{withImages?: boolean}} opts withImages=true 时把图片落盘并返回路径
   */
  async readGroup(groupId, limit = 20, opts = {}) {
    const gid = Number(groupId);
    const withImages = opts?.withImages === true;
    const cached = this.groupCache.get(gid) ?? [];
    if (cached.length >= limit && !withImages) return cached.slice(-limit);
    if (this.bot) {
      try {
        const res = await this.bot.get_group_msg_history({ group_id: gid, count: limit });
        const msgs = res?.messages ?? res ?? [];
        if (Array.isArray(msgs) && msgs.length) {
          const rows = [];
          for (const m of msgs) {
            let images = [];
            if (withImages) {
              try { images = await downloadSegmentImages(m.message, { log: this.log, maxCacheMB: this.cacheMaxMB() }); } catch { images = []; }
            }
            rows.push({
              userId: m.sender?.user_id ?? m.user_id ?? 0,
              senderName: m.sender?.card || m.sender?.nickname || '',
              text: segmentsToText(m.message),
              time: (m.time ?? 0) * 1000,
              messageId: m.message_id,
              images,
            });
          }
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

  /**
   * 读账号的收藏表情。
   *
   * 注意区分：fetch_custom_face 只返回 URL 而且是残缺的（实测只给 10 个），
   * fetch_custom_face_detail 才是全量（48 个）且带 emoji_id / md5 / 备注。
   * 两个都是 SnowLuma 的扩展 action，不在 OneBot v11 标准里。
   */
  async fetchCustomFaces() {
    if (!this.bot) throw new Error('OneBot 未连接');
    const r = await this.bot.send('fetch_custom_face_detail', {});
    if (!Array.isArray(r)) return [];
    return r.filter((x) => x && x.emoji_id);
  }

  /**
   * 列本地表情图目录。返回 [{ name, path, size, mtime }]，按文件名排序。
   *
   * 这些就是普通图片文件 —— 发出去走 image 段，不是 mface 那种市场表情。
   */
  async listStickers(dirArg) {
    const dir = String(dirArg ?? this.stickerDir ?? '').trim();
    if (!dir) throw new Error('还没配置图片目录（stickerDir）');
    let names;
    try { names = await readdir(dir); } catch (e) {
      throw new Error('读不到图片目录 ' + dir + '：' + (e?.message ?? e));
    }
    const out = [];
    for (const n of names) {
      if (!/\.(jpe?g|png|gif|webp|bmp)$/i.test(n)) continue;
      const p = join(dir, n);
      try {
        const st = await stat(p);
        if (st.isFile()) out.push({ name: n, path: p, size: st.size, mtime: st.mtimeMs });
      } catch { /* 跳过读不到的 */ }
    }
    out.sort((a, b) => a.name.localeCompare(b.name, 'zh'));
    return out;
  }

  /** 把 pic:名字 解析成绝对路径，挡住目录穿越。 */
  resolveSticker(dirArg, name) {
    const dir = String(dirArg ?? this.stickerDir ?? '').trim();
    if (!dir) throw new Error('还没配置图片目录（stickerDir），用不了 pic:');
    const base = resolve(dir);
    const full = resolve(base, name);
    const rel = relative(base, full);
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) {
      throw new Error('文件名不合法（不能跳出图片目录）：' + name);
    }
    return full;
  }

  /**
   * 把图片来源变成 image 段。
   *
   * URL 直接给；本地文件必须转 base64 —— 坑：OneBot 实现通常跑在容器或另一台机器上，
   * 它看不到我们这边的 C:\... 路径，直接传路径会失败（甚至悄悄发个坏图）。
   */
  async buildImageSeg(source) {
    const s = String(source ?? '').trim();
    if (!s) throw new Error('图片来源为空');
    if (/^(https?:)?\/\//i.test(s) || /^base64:\/\//i.test(s)) {
      return { type: 'image', data: { file: s } };
    }
    let buf;
    try { buf = await readFile(s); } catch (e) {
      throw new Error('读不到文件 ' + s + '：' + (e?.message ?? e));
    }
    if (buf.length > MAX_SEND_IMAGE_BYTES) {
      throw new Error('图片太大（' + Math.round(buf.length / 1024 / 1024) + 'MB），超过 ' + MAX_SEND_IMAGE_BYTES / 1024 / 1024 + 'MB 上限');
    }
    return { type: 'image', data: { file: 'base64://' + buf.toString('base64'), sub_type: 1 } };
  }

  /**
   * 发图片（照片、截图、随手拍的图）。
   * 和 sendSticker 是两条路：这条就是普通图片，不带任何表情语义。
   */
  async sendImage(groupId, source) {
    if (!this.bot) throw new Error('OneBot 未连接');
    const gid = Number(groupId);
    if (!gid) throw new Error('群号无效');
    const limited = this.checkRate();
    if (limited) throw new Error(limited);
    const seg = await this.buildImageSeg(source);
    const res = await this.bot.send_group_msg({ group_id: gid, message: [seg] });
    this.lastSendAt = Date.now();
    return { ok: true, messageId: res?.message_id ?? 0 };
  }

  /**
   * 发表情（三选一）。
   *   face:名字/数字  → QQ 自带小黄脸（seg.type = face）
   *   fav:序号       → 账号里收藏的表情包
   *   pic:文件名     → 本地表情图目录里的图（配置 stickerDir）
   *
   * 这里不接受裸路径 —— 想发普通图片请用 sendImage。
   */
  async sendSticker(groupId, source, stickerDir) {
    if (!this.bot) throw new Error('OneBot 未连接');
    const gid = Number(groupId);
    if (!gid) throw new Error('群号无效');
    const limited = this.checkRate();
    if (limited) throw new Error(limited);
    const s = String(source ?? '').trim();
    if (!s) throw new Error('表情来源为空');
    let seg;
    if (s.startsWith('face:')) {
      const raw = s.slice(5).trim();
      const id = faceIdOf(raw);
      if (!id) throw new Error('没有叫「' + raw + '」的 QQ 表情。用 onebot_faces 搜一下确切名字。');
      seg = { type: 'face', data: { id: String(id) } };
    } else if (s.startsWith('fav:')) {
      const key = s.slice(4).trim();
      const faces = await this.fetchCustomFaces();
      if (!faces.length) throw new Error('收藏表情列表是空的');
      let hit = null;
      if (/^\d+$/.test(key)) hit = faces[Number(key) - 1] ?? null;
      else hit = faces.find((x) => x.md5 === key.toUpperCase() || x.emoji_id === key || (x.desc && x.desc === key)) ?? null;
      if (!hit) throw new Error('收藏里没有「' + key + '」。用 onebot_custom_faces 看列表（序号从 1 开始）。');
      seg = { type: 'image', data: { file: hit.url } };
    } else if (s.startsWith('pic:')) {
      const file = this.resolveSticker(stickerDir, s.slice(4).trim());
      seg = await this.buildImageSeg(file);
    } else {
      throw new Error('表情只认 face:名字 / fav:序号 / pic:文件名。要发普通图片用 onebot_send_image。');
    }
    const res = await this.bot.send_group_msg({ group_id: gid, message: [seg] });
    this.lastSendAt = Date.now();
    return { ok: true, messageId: res?.message_id ?? 0 };
  }
}
