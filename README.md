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
| `onebot_send_sticker` | 发表情/图片（需开 allowSticker） |

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
