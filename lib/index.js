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

  async function wakeTarget(event) {
    const sessionId = targetSession();
    if (!sessionId) return;
    const agents = ctx.get('agents');
    if (!agents) return;
    const line = `[QQ群 ${event.groupName ? event.groupName + '（' + event.groupId + '）' : event.groupId}] ${event.senderName}: ${event.text}`;
    try {
      const agent = await agents.resume?.({ resumeSessionId: sessionId, agentOptions: {}, setup: () => {} });
      if (agent?.inject) await agent.inject({ text: line, source: 'onebot-connector' });
      else if (agent?.followup) await agent.followup(line);
    } catch (e) {
      log.warn('唤醒会话失败：' + (e?.message ?? e));
    }
  }

  function onEvent(event) {
    if (disposed) return;
    if (event.kind !== 'group-message') return;
    if (event.isSelf) return;
    if (!passiveGroups().has(String(event.groupId))) return;
    wakeTarget(event).catch((e) => log.warn('推送失败：' + (e?.message ?? e)));
  }

  async function start() {
    if (disposed || ob) return;
    const ep = await resolveEndpoint();
    const client = new OneBotClient({ log });
    client.configure(ep);
    ob = client;
    unsubscribe = client.onEvent(onEvent);
    if (!ep.baseUrl) {
      log.warn('未配置 OneBot 地址，未连接。请在设置页填写 WS 地址。');
      return;
    }
    log.info(`连接 ${ep.baseUrl}${ep.accessToken ? '（带 token）' : '（无 token）'}`);
    const res = await client.start();
    if (!res.ok) log.warn('连接未成功：' + (res.reason ?? '未知'));
  }

  async function stop() {
    if (unsubscribe) { try { unsubscribe(); } catch { /* ignore */ } unsubscribe = null; }
    const client = ob;
    ob = null;
    if (client) { try { await client.stop(); } catch { /* ignore */ } }
  }

  ctx.effect(() => () => {
    disposed = true;
    stop().catch((e) => log.warn('停止失败：' + (e?.message ?? e)));
  }, 'onebot-connector: shutdown');

  if (enabled()) start().catch((e) => log.warn('启动失败：' + (e?.message ?? e)));

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

  const route = (path, handler) => {
    try {
      ctx.webServer.register({
        kind: 'exact',
        path: PREFIX + path,
        handler: (req, res) => {
          Promise.resolve().then(() => handler(req, res)).catch((e) => send(res, 500, { ok: false, message: e?.message ?? String(e) }));
        },
      });
    } catch (e) {
      log.warn('注册接口失败 ' + path + '：' + (e?.message ?? e));
    }
  };

  route('/state', async (_req, res) => send(res, 200, await stateView()));

  route('/connect', async (_req, res) => {
    if (ob && ob.status().online) return send(res, 200, { ok: true, status: ob.status() });
    await stop();
    await start();
    return send(res, 200, { ok: ob ? ob.status().online : false, status: ob ? ob.status() : {} });
  });

  route('/disconnect', async (_req, res) => {
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
