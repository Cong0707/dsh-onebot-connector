/**
 * onebot_* 工具注册。
 *
 * 语义：
 *   - onebot_status       连接状态
 *   - onebot_list_groups  群列表 + 每群最后一条（概览，不是全文）
 *   - onebot_read_group   真正读某群消息（不调就不知道）
 *   - onebot_send_message 发文本
 *   - onebot_send_sticker 发表情/图片
 */

function text(s) { return [{ type: 'text', text: String(s ?? '') }]; }
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
    name: 'onebot_send_sticker',
    description: '往 QQ 群发表情或图片。source 可以是图片 URL、本地路径，或 "face:<id>" 表示 QQ 自带表情。默认关闭，需开启 allowSticker。',
    parameters: {
      group_id: { type: 'number', required: true, description: '群号' },
      source: { type: 'string', required: true, description: '图片 URL / 本地路径 / "face:14"' },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_a, v) => text(v.summary) },
    async execute(args) {
      try {
        if (!allowSticker()) return { ok: false, error: '表情发送已被禁用', summary: '表情功能在设置里关着（allowSticker=false）。' };
        const c = need();
        const gid = Number(args?.group_id);
        const src = String(args?.source ?? '').trim();
        if (!gid) return { ok: false, error: '群号无效', summary: '群号无效' };
        if (!src) return { ok: false, error: '表情来源为空', summary: '需要图片 URL、路径或 face:id' };
        const res = await c.sendSticker(gid, src);
        return { ok: true, groupId: gid, messageId: res.messageId, summary: `表情已发送到群 ${gid}。` };
      } catch (e) {
        return { ok: false, error: String(e?.message ?? e), summary: '发表情失败：' + String(e?.message ?? e) };
      }
    },
  }));

  log.info('已注册 5 个 OneBot 工具');
}
