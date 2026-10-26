/**
 * dsh-onebot-connector —— 把 OneBot v11 接进 DSH。
 *
 * 设计边界（重要）：
 *   本插件**只管 OneBot 对接**。QQ 账号怎么登、用什么签名、怎么防风控，
 *   全部由 OneBot 实现（NapCat / LLOneBot / Lagrange / go-cqhttp）自己负责。
 *   插件里没有、也不会出现任何 QQ 账号密码、协议版本、签名地址。
 *
 * 语义：
 *   - 被动监听：勾选的群收到消息，立刻唤醒目标会话
 *   - 主动读取：其它群只缓存；模型调 onebot_list_groups 看最后一条，
 *              调 onebot_read_group 才真正读到内容 —— 不读就不知道发生了什么
 *   - 目标会话：选一个会话当「我家的鱼」，推送和记忆都落在它身上
 *
 * 生命周期：插件启用 = 连 OneBot；禁用 / DSH 退出 = 断开。
 *
 * 安全：
 *   - 只存 endpoint + accessToken，存 ~/.dsh/plugins-data/onebot-connector/（0600）
 *   - 不存任何 QQ 账号密码
 *   - 日志不打印 token
 *   - 所有异步回调 catch（宿主进程内未捕获异常会带走整个 DSH）
 *
 * @module dsh-onebot-connector
 */
import z from '@deepseek-ai/schemastery';
import { OneBotClient } from './onebot.js';
import { readState, writeState } from './store.js';

export const name = 'onebot-connector';
export const inject = ['tools', 'agents', 'webServer'];

const PREFIX = '/onebot-connector/api';

/**
 * 构造一条 user 消息。
 * 用官方 createUserMessage 而不是手搓对象 —— 它会补 id / 时间戳等必需字段。
 * 用惰性 import：万一某个部署解析不到 dsh-llm，插件整体不至于加载失败。
 */
let _createUserMessage = null;
async function buildUserMessage(text) {
  if (!_createUserMessage) {
    const m = await import('@deepseek-ai/dsh-llm');
    _createUserMessage = m.createUserMessage;
  }
  return _createUserMessage({
    content: [{ type: 'text', text: String(text ?? '') }],
    source: { kind: 'onebot-connector' },
  });
}

/** 每个插件实例一个 id，用来判断路由/client 归属。 */
const INSTANCE_ID = Math.random().toString(36).slice(2, 10);

/**
 * 路由登记表挂在 globalThis 上，这样插件重载后新实例能看到旧实例留下的路由。
 * 模块级变量在重载后会重置，挡不住旧 handler 残留。
 */
function routeRegistry() {
  const KEY = '__dshOnebotConnectorRoutes';
  if (!globalThis[KEY]) globalThis[KEY] = new Map();
  return globalThis[KEY];
}

/**
 * 连接单例：重载时新实例复用/接管旧实例的连接，
 * 避免同一个 bot 上挂两条 WS（QQ 那边会看到两个客户端，容易被风控）。
 */
function clientHub() {
  const KEY = '__dshOnebotConnectorHub';
  if (!globalThis[KEY]) globalThis[KEY] = { client: null, owner: '' };
  return globalThis[KEY];
}

const log = {
  info: (m) => console.log('[onebot-connector] ' + m),
  warn: (m) => console.warn('[onebot-connector] ' + m),
  error: (m) => console.error('[onebot-connector] ' + m),
};

/** 面向 dsh-settings 的配置。 */
export const Config = z.object({
  enabled: z.string().default('true').volatile()
    .description('启用 OneBot 连接（与 DSH 生命周期一致）。true/false'),
  baseUrl: z.string().default('').volatile()
    .description('OneBot 正向 WebSocket 地址，例如 ws://127.0.0.1:3001'),
  accessToken: z.string().default('').volatile()
    .description('OneBot 的 access_token（没设就留空）。只写本地，不回显。'),
  passiveGroups: z.string().default('').volatile()
    .description('被动监听：收到消息就唤醒会话的群号（每行一个）。其它群只缓存不推送。'),
  targetSession: z.string().default('').volatile()
    .description('把消息推送到哪个会话（选一个会话当「我家的鱼」）。'),
  allowSend: z.string().default('false').volatile()
    .description('允许模型主动发消息到群里。true/false'),
  allowSticker: z.string().default('false').volatile()
    .description('允许模型发表情包。true/false'),
  allowActiveRead: z.string().default('true').volatile()
    .description('允许模型主动读取未监听群的消息。true/false'),
}).description('把 OneBot v11 接进 DSH：被动监听 + 主动读取 + 推送目标会话。');

/**
 * 解包 cordis 的 volatile 引用。
 *
 * 带 .volatile() 的 Config 字段在宿主里是 **Ref 对象**，取值必须 .get()；
 * 拿 .value 只会得到 undefined（我一开始就栽在这，导致 baseUrl 变成 [object Object]）。
 * 手写 patch 直接传字符串时原样返回。
 */
function unwrap(value) {
  if (value && typeof value === 'object' && typeof value.get === 'function') {
    try { return value.get(); } catch { return undefined; }
  }
  if (value && typeof value === 'object' && 'value' in value) return value.value;
  return value;
}

function val(config, key, fallback) {
  const raw = unwrap(config?.[key]);
  if (raw === undefined || raw === null) return fallback;
  const s = typeof raw === 'string' ? raw : String(raw);
  return s === '' ? fallback : s;
}
const asBool = (v, d) => String(v === undefined ? d : v).toLowerCase() === 'true';
const asList = (v) => String(v ?? '').split(/[\r\n,，;；\s]+/).map((s) => s.trim()).filter(Boolean);

export async function apply(ctx, config) {
  const enabled = () => asBool(val(config, 'enabled', 'true'), true);
  const passiveGroups = () => new Set(asList(val(config, 'passiveGroups', '')));
  const targetSession = () => String(val(config, 'targetSession', '')).trim();
  // 连接信息优先取 DSH 配置（面板保存的），没有就用本地 state.json。
  // 这样面板改了能立刻连上，重启后也能记住 token。
  const baseUrl = () => String(val(config, 'baseUrl', '')).trim();
  const accessToken = () => String(val(config, 'accessToken', '')).trim();

  /** 启动时解析最终连接信息：config 优先，state.json 兜底。 */
  async function resolveEndpoint() {
    let saved = {};
    try { saved = await readState(); } catch { /* ignore */ }
    return {
      baseUrl: baseUrl() || String(saved.baseUrl ?? '').trim(),
      accessToken: accessToken() || String(saved.accessToken ?? '').trim(),
    };
  }

  /** @type {OneBotClient | null} */
  let ob = null;
  let disposed = false;
  let unsubscribe = null;

  // ── 收消息 → 攒 → 每 3 秒打包投递一次 ────────────────────────
  // 不逐条吵醒模型：群里连刷十条也只算一次唤醒，省 token 也不炸上下文。
  const BATCH_MS = 3000;
  const BATCH_MAX = 80;              // 单包上限，防止刷屏时包过大
  let pending = [];
  let flushTimer = null;
  let flushing = false;

  function scheduleFlush() {
    if (flushTimer) return;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      flush().catch((e) => log.warn('打包投递失败：' + (e?.message ?? e)));
    }, BATCH_MS);
    if (typeof flushTimer.unref === 'function') flushTimer.unref();
  }

  async function flush() {
    // 上一包还在投递就别抢，留给下一轮，避免乱序
    if (flushing || !pending.length) return;
    flushing = true;
    const batch = pending;
    pending = [];
    try {
      await deliverBatch(batch);
    } finally {
      flushing = false;
    }
    if (pending.length) scheduleFlush();   // 投递期间又来了，接着排
  }

  /** 把一批消息拼成一段文本。单条就按原来的格式，多条才用清单。 */
  function formatBatch(batch) {
    const first = batch[0];
    const head = first.groupName ? `${first.groupName}（${first.groupId}）` : String(first.groupId);
    const imgs = [];
    for (const e of batch) if (Array.isArray(e.images) && e.images.length) imgs.push(...e.images);

    const stamp = (e) => {
      const t = Number(e.time);
      if (!Number.isFinite(t) || t <= 0) return '';
      return new Date(t).toTimeString().slice(0, 8) + ' ';
    };

    let text;
    if (batch.length === 1) {
      const e = batch[0];
      text = `[QQ群 ${head}] ${e.senderName}: ${e.text}`;
    } else {
      const lines = batch.map((e) => `  ${stamp(e)}${e.senderName}: ${e.text}`);
      text = `[QQ群 ${head}，${batch.length} 条消息]\n${lines.join('\n')}`;
    }

    // 图片不给路径等于没给 —— 模型只能看到 "[图片]" 三个字。
    // 所以把落盘后的本地路径一并写进文本，模型可以自己 read_image。
    if (imgs.length) {
      text += '\n[图片，共 ' + imgs.length + ' 张，可直接读取：\n' + imgs.map((im) => '  ' + im.path).join('\n') + ']';
    }
    return text;
  }

  // 同一个错误别每 3 秒刷一次
  let lastErrKey = '';
  let lastErrAt = 0;
  function warnOnce(key, msg) {
    const now = Date.now();
    if (key === lastErrKey && now - lastErrAt < 60_000) return;
    lastErrKey = key;
    lastErrAt = now;
    log.warn(msg);
  }

  /**
   * 拿到目标会话的 agent。
   *
   * 顺序：registry.get → registry.list 里找 → resume。
   *
   * 为什么不直接 resume：会话被 GUI 开着时，写句柄已被持有，
   * resume 会抛 "already owned by an active write handle"。
   * 而且那个 agent 本来就在 registry 里，直接拿就行 —— 根本不该 resume。
   */
  async function obtainAgent(agents, sessionId) {
    try { const a = agents.get?.(sessionId); if (a) return a; } catch { /* ignore */ }

    // 兜底：key 万一不是纯 session id，遍历找一遍
    try {
      const all = agents.list?.() ?? [];
      const hit = all.find((a) => a?.id === sessionId || a?.session?.id === sessionId);
      if (hit) return hit;
    } catch { /* ignore */ }

    try {
      const handle = await agents.resume({ resumeSessionId: sessionId, agentOptions: {}, setup: () => {} });
      return handle?.agent ?? handle ?? null;
    } catch (e) {
      const msg = e?.message ?? String(e);
      if (/already owned by an active write handle/i.test(msg)) {
        // 有别人持有写句柄，但 registry 里又查不到 —— 不该发生；
        // 记一次就好，别刷屏，下一包会重新查 registry
        warnOnce('owned', '会话被其它写句柄占用，暂不唤醒：' + sessionId);
      } else {
        warnOnce('resume:' + msg, 'resume 会话失败：' + msg);
      }
      return null;
    }
  }

  async function deliverBatch(batch) {
    const sessionId = targetSession();
    if (!sessionId) return;
    const agents = ctx.get('agents');
    if (!agents) return;
    const line = formatBatch(batch);
    const groupId = batch[0]?.groupId;

    /**
     * 投递到目标会话 —— 用 steer。
     *
     * agent 上有三个发送方法，语义不一样（见 dsh-agent-loop 的 send）：
     *   followup → send(msg, "next-turn", wakeup=true)   排队，等当前整轮跑完才轮到
     *   steer    → send(msg, "next-step", wakeup=true)   插到下个 step，立刻能看到
     *   inject   → send(msg, "next-step", wakeup=false)  只塞不唤醒，agent 不动
     *
     * 这里必须用 steer，两个原因：
     *  1. 模型可能正在跑长任务，followup 要等它整轮结束才理 QQ 消息，太慢。
     *     steer 进入 next-step 队列，下一个 step 边界就会被 claim，能及时回复。
     *  2. 模型空闲时必须能主动拉起。steer 的 wakeup=true 会走到 wakeDriver()：
     *     phase 是 idle 就直接开新一轮（running 才只打 wakeRequested 标记），
     *     所以「跑着时插话」和「闲着时拉起」是同一个调用。
     *
     * 另外 agents.resume() 返回的是 handle，agent 在 handle.agent 上，别直接拿 handle 用。
     */
    try {
      const agent = await obtainAgent(agents, sessionId);
      if (!agent || typeof agent.steer !== 'function') {
        log.warn('拿不到可投递的 agent：' + sessionId);
        return;
      }

      agent.steer(await buildUserMessage(line));
      log.info(`已插话到会话 ${String(sessionId).slice(-8)}（群 ${groupId}，${batch.length} 条，${agent.status ?? '?'}）`);
    } catch (e) {
      log.warn('推送到会话失败：' + (e?.message ?? e));
    }
  }

  function onEvent(event) {
    if (disposed) return;
    if (event.kind !== 'group-message') return;
    if (event.isSelf) return;
    const passive = passiveGroups();
    if (!passive.has(String(event.groupId))) return;
    if (!targetSession()) {
      log.warn('群 ' + event.groupId + ' 有消息，但没设推送目标会话 —— 已忽略');
      return;
    }
    log.info(`收到 ${event.groupId} ${event.senderName}: ${String(event.text).slice(0, 40)}`);
    pending.push(event);
    if (pending.length > BATCH_MAX) pending.splice(0, pending.length - BATCH_MAX);  // 只留最近 80 条
    scheduleFlush();
  }

  async function start() {
    if (disposed || ob) return;
    const ep = await resolveEndpoint();

    // 重载场景：旧实例可能还挂着一条 WS，先收掉，不然同一 bot 会有两个客户端
    const hub = clientHub();
    if (hub.client && hub.owner !== INSTANCE_ID) {
      try { await hub.client.stop(); } catch { /* ignore */ }
      hub.client = null;
      hub.owner = '';
    }

    const client = new OneBotClient({ log });
    client.configure(ep);
    ob = client;
    hub.client = client;
    hub.owner = INSTANCE_ID;
    unsubscribe = client.onEvent(onEvent);
    if (!ep.baseUrl) {
      log.warn('未配置 OneBot 地址，未连接。请在设置页填写 WS 地址。');
      return;
    }
    log.info(`连接 ${ep.baseUrl}${ep.accessToken ? '（带 token）' : '（无 token）'}`);
    const res = await client.start();
    if (!res.ok) log.warn('连接未成功：' + (res.reason ?? '未知'));
  }

  // ── 巡检：让「改配置 / 拨开关」不必重启 DSH ──────────────────
  let lastAttempt = 0;
  let lastKey = '';
  let manualPause = false;   // 用户点「断开」时置位，巡检不再自动连回去
  const RETRY_GAP = 20_000;

  async function supervise() {
    if (disposed) return;
    try {
      if (!enabled()) {
        if (ob) { log.info('已禁用，断开连接'); await stop(); }
        return;
      }
      if (manualPause) return;
      const ep = await resolveEndpoint();
      const key = ep.baseUrl + '|' + ep.accessToken;

      if (ob) {
        const st = ob.status();
        if (st.state === 'connecting') return;
        if (st.online && key === lastKey) return;
        if (!st.online && Date.now() - lastAttempt < RETRY_GAP) return;
        await stop();
      }
      if (!ep.baseUrl) return;

      lastAttempt = Date.now();
      lastKey = key;
      await start();
    } catch (e) {
      log.warn('巡检失败：' + (e?.message ?? e));
    }
  }

  async function stop() {
    if (unsubscribe) { try { unsubscribe(); } catch { /* ignore */ } unsubscribe = null; }
    const client = ob;
    ob = null;
    const hub = clientHub();
    if (hub.client === client) { hub.client = null; hub.owner = ''; }
    if (client) { try { await client.stop(); } catch { /* ignore */ } }
  }

  ctx.effect(() => () => {
    disposed = true;
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
    pending = [];
    stop().catch((e) => log.warn('停止失败：' + (e?.message ?? e)));
    // 只清自己注册的路由；别把新实例刚装上的那批删掉
    const reg = routeRegistry();
    for (const [path, rec] of Array.from(reg.entries())) {
      if (rec.instance !== INSTANCE_ID) continue;
      try { rec.dispose(); } catch { /* ignore */ }
      reg.delete(path);
    }
  }, 'onebot-connector: shutdown');

  // 启动即巡检一次，之后每 5 秒对账一次：
  // 开关拨了、地址改了、连接掉了，都会被它纠正，不需要重启 DSH。
  supervise().catch((e) => log.warn('启动失败：' + (e?.message ?? e)));
  ctx.effect(() => {
    const timer = setInterval(() => { supervise().catch(() => {}); }, 5000);
    if (typeof timer.unref === 'function') timer.unref();
    return () => clearInterval(timer);
  }, 'onebot-connector: supervisor');

  // ── HTTP 接口（面板用）───────────────────────────────────────────
  const send = (res, code, body) => {
    try {
      res.statusCode = code;
      res.setHeader('content-type', 'application/json; charset=utf-8');
      res.setHeader('cache-control', 'no-store');
      res.end(JSON.stringify(body));
    } catch { /* ignore */ }
  };
  const readBody = (req) => new Promise((resolve) => {
    let raw = ''; let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 500_000) { req.destroy(); resolve({}); return; }
      raw += c;
    });
    req.on('end', () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch { resolve({}); } });
    req.on('error', () => resolve({}));
  });

  async function stateView() {
    const st = ob ? ob.status() : { state: 'disabled', online: false, selfId: 0, nickname: '', baseUrl: '', hasToken: false };
    let groups = [];
    if (ob && st.online) {
      try { groups = await ob.listGroups(); } catch { groups = []; }
    }
    return {
      ok: true,
      enabled: enabled(),
      status: st,
      groups,
      config: {
        passiveGroups: Array.from(passiveGroups()),
        targetSession: targetSession(),
        allowSend: asBool(val(config, 'allowSend', 'false'), false),
        allowSticker: asBool(val(config, 'allowSticker', 'false'), false),
        allowActiveRead: asBool(val(config, 'allowActiveRead', 'true'), true),
      },
    };
  }

  /**
   * 注册接口路由。
   *
   * 坑（我踩过）：ctx.webServer.register 遇到重复 (kind, path) 会 **抛异常**，
   * 而且它返回的 disposer 必须自己保存 —— 否则插件重载后旧 handler 永远活着。
   * 结果就是：新实例把 WS 连上了，/state 却一直是旧实例在答（ob=null → "disabled"）。
   *
   * 所以这里用 globalThis 存一份登记表，跨实例生效：
   * 注册前先顶掉同路径的旧路由，卸载时只清自己的。
   */
  const route = (path, handler) => {
    const full = PREFIX + path;
    const reg = routeRegistry();

    const stale = reg.get(full);
    if (stale) {
      try { stale.dispose(); } catch { /* ignore */ }
      reg.delete(full);
    }

    const spec = {
      kind: 'exact',
      path: full,
      handler: (req, res) => {
        Promise.resolve().then(() => handler(req, res)).catch((e) => send(res, 500, { ok: false, message: e?.message ?? String(e) }));
      },
    };
    try {
      const dispose = ctx.webServer.register(spec);
      reg.set(full, { dispose, instance: INSTANCE_ID });
    } catch (e) {
      log.warn('注册接口失败 ' + path + '：' + (e?.message ?? e));
    }
  };

  route('/state', async (_req, res) => send(res, 200, await stateView()));

  route('/connect', async (_req, res) => {
    manualPause = false;
    lastAttempt = 0;
    if (ob && ob.status().online) return send(res, 200, { ok: true, status: ob.status() });
    await stop();
    await start();
    const st = ob ? ob.status() : {};
    if (st.online) lastKey = (await resolveEndpoint()).baseUrl + '|' + (await resolveEndpoint()).accessToken;
    return send(res, 200, { ok: st.online === true, message: st.lastError || '', status: st });
  });

  route('/disconnect', async (_req, res) => {
    manualPause = true;
    await stop();
    return send(res, 200, { ok: true });
  });

  // 面板保存连接信息（baseUrl / accessToken）。token 只进本地文件，不回显。
  route('/save-conn', async (req, res) => {
    const body = await readBody(req);
    const patch = {};
    if (body.baseUrl !== undefined) patch.baseUrl = String(body.baseUrl ?? '').trim();
    if (body.accessToken) patch.accessToken = String(body.accessToken);
    try {
      await writeState(patch);
      return send(res, 200, { ok: true });
    } catch (e) {
      return send(res, 500, { ok: false, message: e?.message ?? String(e) });
    }
  });

  // 诊断：看看 registry 里到底有哪些 agent，目标会话在不在里面
  route('/agents', async (_req, res) => {
    const agents = ctx.get('agents');
    if (!agents) return send(res, 200, { ok: false, message: 'agents 服务不可用' });
    let ids = [];
    try {
      ids = (agents.list?.() ?? []).map((a) => ({ id: a?.id, sessionId: a?.session?.id, status: a?.status ?? '' }));
    } catch (e) {
      return send(res, 200, { ok: false, message: e?.message ?? String(e) });
    }
    const sid = targetSession();
    return send(res, 200, {
      ok: true,
      targetSession: sid,
      targetLive: !!sid && ids.some((a) => a.id === sid || a.sessionId === sid),
      count: ids.length,
      agents: ids,
    });
  });

  // 自测：不用等群里来人，直接验证「推送目标会话」这条路通不通
  route('/test-push', async (req, res) => {
    const body = await readBody(req);
    const sid = String(body.sessionId || targetSession() || '').trim();
    if (!sid) return send(res, 200, { ok: false, message: '没有推送目标会话' });
    const text = String(body.text || '这是一条来自 OneBot 连接器的测试消息。收到请忽略。');
    try {
      const agents = ctx.get('agents');
      if (!agents) return send(res, 200, { ok: false, message: 'agents 服务不可用' });
      const live = agents.get?.(sid) ?? null;
      const agent = live ?? await obtainAgent(agents, sid);
      const resumed = !live && !!agent;
      if (!agent || typeof agent.steer !== 'function') {
        return send(res, 200, { ok: false, message: '拿不到可投递的 agent' });
      }
      agent.steer(await buildUserMessage(text));
      return send(res, 200, { ok: true, sessionId: sid, resumed, mode: 'steer', status: agent.status ?? '', message: '已插话' });
    } catch (e) {
      return send(res, 200, { ok: false, message: e?.message ?? String(e) });
    }
  });

  route('/groups', async (_req, res) => {
    if (!ob) return send(res, 200, { ok: true, groups: [] });
    let groups = [];
    try { groups = await ob.listGroups(); } catch (e) { return send(res, 200, { ok: false, message: e?.message ?? String(e), groups: [] }); }
    return send(res, 200, { ok: true, groups });
  });

  // ── 工具注册 ─────────────────────────────────────────────────────
  const tools = ctx.get('tools');
  if (tools?.register) {
    let defineTool = null;
    try { defineTool = (await import('@deepseek-ai/dsh-tools')).defineTool; } catch { /* ignore */ }
    if (typeof defineTool !== 'function') {
      try { defineTool = (await import('@deepseek-ai/dsh-tools/schema')).defineTool; } catch { /* ignore */ }
    }
    if (typeof defineTool === 'function') {
      const api = await import('./tools.js');
      api.registerTools({ ctx, tools, defineTool, config, log, asBool, val, ob: () => ob, passiveGroups, targetSession });
    } else {
      log.warn('defineTool 不可用，OneBot 工具未注册（连接本身仍工作）');
    }
  }
}
