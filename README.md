# dsh-onebot-connector

把 [OneBot v11](https://github.com/botuniverse/onebot-11) 接进 DeepSeek Harness。

**这个插件只管 OneBot 对接。** QQ 账号怎么登、用什么签名、怎么防风控，全部由你的 OneBot 实现负责。插件里没有、也不会有任何 QQ 账号密码、协议版本、签名服务地址。

## 它做什么

- **被动监听**：勾选的群一有消息，立刻唤醒你指定的会话（"我家的鱼"）。
- **主动读取**：其它群只缓存不推送。模型调 `onebot_list_groups` 能看到每群最后一条消息，调 `onebot_read_group` 才真正读到内容 —— **不读就不知道发生了什么**。
- **发消息 / 发表情**：`onebot_send_message` / `onebot_send_sticker`（默认关闭）。

## 兼容的 OneBot 实现

任何支持 OneBot v11 **正向 WebSocket** 的实现：

- [NapCat](https://github.com/NapNeko/NapCatQQ)
- [LLOneBot](https://github.com/LLOneBot/LLOneBot)
- [Lagrange.Core](https://github.com/LagrangeDev/Lagrange.Core)
- [go-cqhttp](https://github.com/Mrs4s/go-cqhttp)

## 安装

```powershell
dsh plugin --profile web add github:<你>/dsh-onebot-connector
```

本地开发可以直接把目录放进 profile 的 `node_modules`。

## 配置

设置页：**设置 → 插件 → OneBot 连接**。

| 字段 | 说明 |
|---|---|
| 启用连接 | 与 DSH 生命周期绑定：启用即连，禁用或退出 DSH 即断 |
| WebSocket 地址 | 例 `ws://127.0.0.1:3001` |
| access_token | OneBot 的令牌，没设就留空。只存本机，不回显 |
| 推送目标 | 选一个会话当"我家的鱼" |
| 被动监听 | 勾选要实时唤醒的群 |
| 允许主动发消息 / 发表情包 | 默认关 |
| 允许主动读取群 | 默认开 |

## 工具

| 工具 | 作用 |
|---|---|
| `onebot_status` | 连接状态 |
| `onebot_list_groups` | 群列表 + 每群最后一条消息（概览，不是全文） |
| `onebot_read_group` | 读某群最近消息（主动读才看得见） |
| `onebot_send_message` | 发文本（需开 allowSend） |
| `onebot_faces` | 查 QQ 表情名字和 id |
| `onebot_send_sticker` | 发表情/图片（需开 allowSticker） |

## 表情

QQ 的 `face` 段只有一个数字 id（`{type:"face",data:{id:"341"}}`），模型看到 `341` 什么也读不出来。
所以插件内置了一张从 QQ 客户端里抽的官方表情表（`lib/faces.js`，282 条，覆盖 id 0~417）：

**看** —— 收到的表情在文本里直接翻成名字：

```
[QQ群 神经（698206047）] 某人: 你好[表情:微笑]
[QQ群 神经（698206047）] 某人: [表情:打招呼]在吗
```

**发** —— 按名字发，插件负责翻 id：

```js
onebot_send_sticker({ group_id: 123, source: "face:斜眼笑" })
onebot_send_sticker({ group_id: 123, source: "face:14" })        // 等价
onebot_send_sticker({ group_id: 123, source: "C:/pics/笑死.gif" })
```

**查** —— 不确定名字就先搜：

```
onebot_faces({ query: "笑" })
→ 微笑(14)、偷笑(20)、憨笑(28)、坏笑(101)、斜眼笑(178)、笑哭(182)…
```

图片和表情包一律落盘到 `~/.dsh/plugins-data/onebot-connector/images/`，模型可以用 `read_image` 真看到内容——不是只给三个字「[图片]」。

## 让模型爱用表情

能力给了，习不习惯用是提示词的事。把类似这段写进目标会话的 system prompt 会明显好使：

> 你在 QQ 群里聊天，不是写报告。多用短句，适当用 `onebot_send_sticker` 发 `face:名字` 的 QQ 表情表达情绪（`onebot_faces` 可以查名字）。别人发了表情，你可以接着用表情回。

## 安全

| 项 | 做法 |
|---|---|
| 存储 | 只有 endpoint + token，存 `~/.dsh/plugins-data/onebot-connector/state.json`（0600） |
| 不进包 | 插件目录内没有任何凭据；重装/升级不带走 |
| 不回显 | 面板只显示"有没有 token"，不显示内容 |
| 日志 | token 不落日志 |
| 崩溃隔离 | 所有异步回调都 catch —— 插件跑在宿主进程里，未捕获异常会带走整个 DSH |
| 发送限流 | 全局 3 秒间隔 |

## 依赖

- [`node-napcat-ts`](https://github.com/HkTeamX/node-napcat-ts) —— OneBot v11 客户端（底层是标准协议，不绑定 NapCat）

## 许可

MIT
