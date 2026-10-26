/**
 * onebot_* 工具注册。
 *
 * 语义：
 *   - onebot_status       连接状态
 *   - onebot_list_groups  群列表 + 每群最后一条（概览，不是全文）
 *   - onebot_read_group   真正读某群消息（不调就不知道）
 *   - onebot_send_message 发文本
 *   - onebot_faces        查表情名字和 id
 *   - onebot_custom_faces 列收藏的表情包
 *   - onebot_send_sticker 发表情/图片
 */

import { COMMON_FACES, searchFaces, faceIdOf, faceName } from './faces.js';

function text(s) { return [{ type: 'text', text: String(s ?? '') }]; }

/** 常用表情的一句话清单，塞进工具描述里省得模型每次都要先查。 */
const COMMON_HINT = COMMON_FACES.map((f) => `${f.name}(${f.id})`).join('、');
function fmtTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}

export function registerTools({ ctx, tools, defineTool, config, log, asBool, val, ob, passiveGroups, targetSession }) {
  const need = () => {
    const c = ob();
    if (!c) throw new Error('OneBot 未连接：插件可能被禁用，或地址没配');
    return c;
  };
  const allowRead = () => asBool(val(config, 'allowActiveRead', 'true'), true);
  const allowSend = () => asBool(val(config, 'allowSend', 'false'), false);
  const allowSticker = () => asBool(val(config, 'allowSticker', 'false'), false);

  tools.register(defineTool({
    name: 'onebot_status',
    description: '查看 OneBot 连接状态（是否在线、机器人账号、被动监听的群）。',
    parameters: {},
    output: { schema: { type: 'object', additionalProperties: true }, render: (_a, v) => text(v.summary) },
    async execute() {
      try {
        const c = ob();
        const st = c ? c.status() : { state: 'disabled', online: false };
        const passive = Array.from(passiveGroups ? passiveGroups() : []);
        const target = targetSession ? targetSession() : '';
        const summary = st.online
          ? `OneBot 在线（${st.selfId || '?'}${st.nickname ? ' ' + st.nickname : ''}）。被动监听 ${passive.length} 个群；推送目标 ${target || '未设置'}。`
          : `OneBot 离线（${st.state}）${st.lastError ? '：' + st.lastError : ''}`;
        return { ok: true, ...st, passiveGroups: passive, targetSession: target, summary };
      } catch (e) {
        return { ok: false, error: String(e?.message ?? e), summary: '查询失败：' + String(e?.message ?? e) };
      }
    },
  }));

  tools.register(defineTool({
    name: 'onebot_list_groups',
    description: '列出 QQ 群和每群「最后一条消息」摘要。这是概览：能看到有没有新消息，但看不到完整对话。要看全文调 onebot_read_group。',
    parameters: { limit: { type: 'number', description: '最多返回多少个群（默认 50）' } },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_a, v) => text(v.summary) },
    async execute(args) {
      try {
        const c = need();
        const groups = await c.listGroups();
        const limit = Math.min(Number(args?.limit) || 50, 200);
        const rows = groups.slice(0, limit);
        const lines = rows.map((g) => {
          const last = g.lastMessage
            ? `${fmtTime(g.lastMessage.time)} ${g.lastMessage.senderName}: ${String(g.lastMessage.text).slice(0, 60)}`
            : '（暂无缓存消息）';
          return `· ${g.groupName || g.groupId}（${g.groupId}）${g.memberCount ? ' ' + g.memberCount + '人' : ''}\n    ${last}`;
        });
        return {
          ok: true, total: groups.length, groups: rows,
          summary: rows.length ? `共 ${groups.length} 个群（显示 ${rows.length} 个）：\n${lines.join('\n')}` : '没有加入任何群',
        };
      } catch (e) {
        return { ok: false, error: String(e?.message ?? e), summary: '列举群失败：' + String(e?.message ?? e) };
      }
    },
  }));

  tools.register(defineTool({
    name: 'onebot_read_group',
    description: '读取某个 QQ 群最近的消息内容。不调用这个工具，就不知道那个群里发生了什么。设 with_images 可把图片下载到本地并返回路径（之后用 read_image 看）。',
    parameters: {
      group_id: { type: 'number', required: true, description: '群号' },
      limit: { type: 'number', description: '读最近多少条（默认 20，最多 100）' },
      with_images: { type: 'boolean', description: '是否下载图片并给出本地路径（默认 false）' },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_a, v) => text(v.summary) },
    async execute(args) {
      try {
        if (!allowRead()) return { ok: false, error: '主动读取已被禁用', summary: '主动读取在设置里关着。' };
        const c = need();
        const gid = Number(args?.group_id);
        if (!gid) return { ok: false, error: '群号无效', summary: '群号无效' };
        const limit = Math.min(Number(args?.limit) || 20, 100);
        const withImages = args?.with_images === true;
        const rows = await c.readGroup(gid, limit, { withImages });
        const lines = rows.map((m) => {
          const base = `${fmtTime(m.time)} ${m.senderName}: ${m.text}`;
          const imgs = Array.isArray(m.images) ? m.images : [];
          return imgs.length ? base + '\n' + imgs.map((im) => '    [图片] ' + im.path).join('\n') : base;
        });
        return {
          ok: true, groupId: gid, count: rows.length, messages: rows,
          summary: rows.length ? `群 ${gid} 最近 ${rows.length} 条：\n${lines.join('\n')}` : `群 ${gid} 暂无消息`,
        };
      } catch (e) {
        return { ok: false, error: String(e?.message ?? e), summary: '读取群失败：' + String(e?.message ?? e) };
      }
    },
  }));

  tools.register(defineTool({
    name: 'onebot_send_message',
    description: '往 QQ 群发一条文本消息。默认关闭，需在设置里开启 allowSend。',
    parameters: {
      group_id: { type: 'number', required: true, description: '群号' },
      message: { type: 'string', required: true, description: '要发送的文本' },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_a, v) => text(v.summary) },
    async execute(args) {
      try {
        if (!allowSend()) return { ok: false, error: '发送已被禁用', summary: '发送在设置里关着（allowSend=false）。' };
        const c = need();
        const gid = Number(args?.group_id);
        const msg = String(args?.message ?? '').trim();
        if (!gid) return { ok: false, error: '群号无效', summary: '群号无效' };
        if (!msg) return { ok: false, error: '消息为空', summary: '消息不能为空' };
        const res = await c.sendGroup(gid, msg);
        return { ok: true, groupId: gid, messageId: res.messageId, summary: `已发送到群 ${gid}。` };
      } catch (e) {
        return { ok: false, error: String(e?.message ?? e), summary: '发送失败：' + String(e?.message ?? e) };
      }
    },
  }));

  tools.register(defineTool({
    name: 'onebot_faces',
    description: [
      '查 QQ 自带表情的名字和 id。发表情之前用来确认真名，别猜。',
      '不传 query 返回经典表情（id 0~105）；传 query 按名字搜索，比如 "笑" 会返回 微笑/偷笑/憨笑/坏笑/斜眼笑/笑哭。',
      '收到别人的表情时会显示成 [表情:名字]，想知道那个名字的 id 就搜一下。',
    ].join(' '),
    parameters: {
      query: { type: 'string', description: '名字关键词，比如 "笑"、"赞"、"哭"。留空列出经典表情。' },
      limit: { type: 'number', description: '最多返回几个（默认 30）' },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_a, v) => text(v.summary) },
    async execute(args) {
      try {
        const q = String(args?.query ?? '').trim();
        const limit = Math.min(Number(args?.limit) || 30, 200);
        const list = searchFaces(q, limit);
        if (!list.length) {
          return { ok: false, query: q, faces: [], summary: `没有名字里带「${q}」的表情。` };
        }
        const lines = list.map((x) => `${x.name}（face:${x.id}）`);
        return {
          ok: true, query: q, count: list.length, faces: list,
          summary: `${q ? '匹配「' + q + '」' : '经典表情'} 共 ${list.length} 个：
${lines.join('、')}`,
        };
      } catch (e) {
        return { ok: false, error: String(e?.message ?? e), summary: '查表情失败：' + String(e?.message ?? e) };
      }
    },
  }));

  tools.register(defineTool({
    name: 'onebot_custom_faces',
    description: '列出账号里收藏的表情包（不是小黄脸）。每条带序号，发送时用 source="fav:序号"。有的带备注，query 可按备注筛选。',
    parameters: {
      query: { type: 'string', description: '按备注关键词筛选，留空列全部' },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_a, v) => text(v.summary) },
    async execute(args) {
      try {
        const c = need();
        const all = await c.fetchCustomFaces();
        const q = String(args?.query ?? '').trim();
        const rows = [];
        all.forEach((face, i) => {
          const desc = face.desc || '';
          if (q && !desc.includes(q)) return;
          rows.push({ index: i + 1, desc, md5: face.md5 || '', url: face.url, face });
        });
        const lines = rows.map((r) => '  ' + r.index + '. ' + (r.desc || '(无备注)') + '  → fav:' + r.index);
        const head = q
          ? '收藏表情 ' + all.length + ' 个，匹配「' + q + '」的 ' + rows.length + ' 个：'
          : '收藏表情 ' + all.length + ' 个，用 fav:序号 发送：';
        return {
          ok: true,
          total: all.length,
          count: rows.length,
          faces: rows.map((r) => ({ index: r.index, desc: r.desc, md5: r.md5, url: r.url })),
          summary: rows.length ? head + String.fromCharCode(10) + lines.join(String.fromCharCode(10)) : (q ? '没有备注里带「' + q + '」的收藏表情。' : '这个账号没有收藏表情。'),
        };
      } catch (e) {
        return { ok: false, error: String(e?.message ?? e), summary: '读收藏表情失败：' + String(e?.message ?? e) };
      }
    },
  }));
  tools.register(defineTool({
    name: 'onebot_send_image',
    description: '往 QQ 群发一张普通图片（照片、截图、随手拍的图）。不是表情，不要跟 onebot_send_sticker 混。默认关闭，需开启 allowSend。',
    parameters: {
      group_id: { type: 'number', required: true, description: '群号' },
      source: { type: 'string', required: true, description: '图片 URL 或本地绝对路径' },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_a, v) => text(v.summary) },
    async execute(args) {
      try {
        if (!allowSend()) return { ok: false, error: '发送已被禁用', summary: '发送在设置里关着（allowSend=false）。' };
        const c = need();
        const gid = Number(args?.group_id);
        const src = String(args?.source ?? '').trim();
        if (!gid) return { ok: false, error: '群号无效', summary: '群号无效' };
        if (!src) return { ok: false, error: '图片来源为空', summary: '需要图片 URL 或本地路径' };
        const res = await c.sendImage(gid, src);
        return { ok: true, groupId: gid, messageId: res.messageId, summary: '图片已发送到群 ' + gid + '。' };
      } catch (e) {
        return { ok: false, error: String(e?.message ?? e), summary: '发图片失败：' + String(e?.message ?? e) };
      }
    },
  }));

  tools.register(defineTool({
    name: 'onebot_stickers',
    description: '列出本地表情图目录里的图（配置项 stickerDir）。用返回的文件名配合 onebot_send_sticker 的 pic: 发送。想知道某张长什么样就用 read_image 看它返回的 path。',
    parameters: {
      query: { type: 'string', description: '按文件名筛选，留空列全部' },
      limit: { type: 'number', description: '最多列几个（默认 120）' },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_a, v) => text(v.summary) },
    async execute(args) {
      try {
        const c = need();
        const all = await c.listStickers();
        const q = String(args?.query ?? '').trim();
        const limit = Math.min(Number(args?.limit) || 120, 500);
        const rows = all.filter((x) => !q || x.name.includes(q)).slice(0, limit);
        const lines = rows.map((r) => '  ' + r.name + '  ' + Math.round(r.size / 1024) + 'KB  ' + r.path);
        return {
          ok: true,
          dir: c.stickerDir,
          total: all.length,
          count: rows.length,
          stickers: rows.map((r) => ({ name: r.name, path: r.path, size: r.size })),
          summary: rows.length
            ? '表情图 ' + all.length + ' 张（用 pic:文件名 发送，read_image 可以看 path）：' + String.fromCharCode(10) + lines.join(String.fromCharCode(10))
            : '表情图目录里没有图（或没配置 stickerDir）。',
        };
      } catch (e) {
        return { ok: false, error: String(e?.message ?? e), summary: '列表情图失败：' + String(e?.message ?? e) };
      }
    },
  }));
  tools.register(defineTool({
    name: 'onebot_send_sticker',
    description: [
      '往 QQ 群发表情。只管表情，发普通图片用 onebot_send_image。默认关闭，需开启 allowSticker。',
      'source 四种写法：',
      '(1) "face:名字" —— QQ 自带小黄脸，比如 "face:微笑"、"face:斜眼笑"、"face:笑哭"。名字不确定先调 onebot_faces 查。',
      '(2) "face:id" —— 直接给数字，比如 "face:14"。',
      '(3) "fav:序号" —— 账号里收藏的表情包，序号用 onebot_custom_faces 查，比如 "fav:3"。',
      '(4) "pic:文件名" —— 本地表情图目录里的图，文件名用 onebot_stickers 查，比如 "pic:无语.gif"。想看看那张长什么样，就用返回的 path 调 read_image。',
      '裸路径和 URL 不接受 —— 那种走 onebot_send_image。',
      '常用小黄脸：' + COMMON_HINT + '。',
    ].join(' '),
    parameters: {
      group_id: { type: 'number', required: true, description: '群号' },
      source: { type: 'string', required: true, description: 'face:名字 / face:id / fav:序号 / pic:文件名' },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_a, v) => text(v.summary) },
    async execute(args) {
      try {
        if (!allowSticker()) return { ok: false, error: '表情发送已被禁用', summary: '表情功能在设置里关着（allowSticker=false）。' };
        const c = need();
        const gid = Number(args?.group_id);
        const src = String(args?.source ?? '').trim();
        if (!gid) return { ok: false, error: '群号无效', summary: '群号无效' };
        if (!src) return { ok: false, error: '表情来源为空', summary: '需要 face:名字 / fav:序号 / pic:文件名' };
        const res = await c.sendSticker(gid, src);
        const what = src.startsWith('face:')
          ? '表情「' + (faceName(faceIdOf(src.slice(5))) || src.slice(5)) + '」'
          : (src.startsWith('fav:') ? '收藏表情' : '表情图「' + src.slice(4) + '」');
        return { ok: true, groupId: gid, messageId: res.messageId, summary: `${what}已发送到群 ${gid}。` };
      } catch (e) {
        return { ok: false, error: String(e?.message ?? e), summary: '发表情失败：' + String(e?.message ?? e) };
      }
    },
  }));

  log.info('已注册 9 个 OneBot 工具');
}
