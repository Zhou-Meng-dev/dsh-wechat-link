# DSH 接入微信：调研结论

调研时间：2026-10-27
调研方式：npm registry API、GitHub API、本地 DSH 安装包源码逐一核实（不依赖二手文章转述）

> **历史调研快照（2026-10-27）。** 项目后来选择了自建桥接，DSH 版本也已升级；
> 以下部分推荐与版本结论已过时，仅作决策记录。

## 结论摘要

1. **有教程，而且不止一份。** 现成方案有几个，主流做法都是「DSH 通道插件（channel plugin）」，而不是自己去 hack 微信协议。
2. **没有官方方案。** DSH 官方（`@deepseek-ai/dsh`）的 README 里完全没有微信或任何 IM（飞书/钉钉/Telegram/Slack）字样；这些全部是社区第三方项目。
3. **技术路线已经收敛到腾讯 iLink / ClawBot 官方通道**，不是逆向个人微信协议——这点显著降低了封号风险。
4. **⚠️ 当时本机的 DSH 版本较低，装不了最成熟的那个插件。** 当时是 `0.1.2-rc.1`，而 `dsh-channel-wechat` 要求 `>=0.2.0-rc.1`。

## 官方支持情况

当时安装的 `@deepseek-ai/dsh@0.1.2-rc.1`：

- `README.md` / `README.zh.md` 中检索 `wechat|微信`：**零命中**。
- `package.json` 的全部 100+ 个官方子包里，**没有任何 IM/微信相关包**。最接近的通用能力是：
  - `@deepseek-ai/dsh-webhook` —— Host 侧 `ctx.webhookRuntime`，把受信任的外部事件转成新的 agent Session（`register(rule)` / `dispatch(delivery)`）。这是「自建桥接」最正规的接口。
  - `@deepseek-ai/dsh-headless` —— `dsh --profile headless "<task>"` 一次性任务，答案打到 stdout 后退出。最粗暴但最省事的自建路径。
  - `@deepseek-ai/dsh-mcp-client`、`@deepseek-ai/dsh-acp`、`@deepseek-ai/dsh-sdk-app`。

## 现成社区方案（均已在 registry / GitHub API 上核实存在）

| 方案 | 分发 | 路线 | 活跃度 | 评价 |
|---|---|---|---|---|
| `dsh-channel-wechat` | npm + GitHub | 腾讯 iLink/ClawBot | v0.2.7，2026-10-24 推送，5★ | 文档最完整，推荐 |
| `@zackdk/dsh-weixin` | npm + GitHub | 腾讯 iLink Bot 2.4.6 | v0.1.5，2026-09-20，0★ | 功能全，但较新、star 少 |
| `Pan17/dsh-wechat` | GitHub（另有 `dsh-weixin` 包名，作者 caoyilearnai） | 私聊桥接，支持音视频 | 37★，2026-10-26 | star 最多 |
| `Culeot/dsh-wechat-bot` | npm + GitHub | iLink + 独立 bridge 进程 | v0.1.0，1★ | 带设置面板，架构分散 |
| `doyokol/dsh-wechat-bridge` | GitHub only | **自建 reader + 自编译 hook** | 0★，2026-10-25 | 不依赖第三方客户端，风险最高 |

### 当时首选：`dsh-channel-wechat`

- 仓库：https://github.com/wangx-wx/dsh-channel-wechat
- 安装：`dsh plugin --profile <profile> add dsh-channel-wechat`
- 登录：GUI → Plugins → dsh-channel-wechat → 扫码
- 要求：Node `^22.19.0 || >=24.0.0`，DSH `>=0.2.0-rc.1`
- 已解决的实际痛点（README 明示）：一轮结束才发回答、超长正文按段落切分、`ret: -2` 限流按 2s→4s→8s→16s 退避
- 附带完整文档：安装、微信内命令、配置参考、兼容性、故障排查、协议、架构

### 关键的版本阻塞

`dsh-channel-wechat` 的 `engines` 与 peerDependencies 全部要求 `>=0.2.0-rc.1`，而当时 `dsh --version` = `0.1.2-rc.1`。
**必须先升级 DSH 才能装。** `@zackdk/dsh-weixin` 只声明 `node >=20.3.0`，对 DSH 版本限制宽松，可作为升级前的备选。

## 各路线与前置条件

1. **通道插件（推荐）**：在一台常开的机器上跑 `dsh web`，插件进程内收发消息。需要扫码登录的微信号保持可用。
2. **iLink 官方通道**：腾讯提供的机器人通道，走官方接口，不碰个人协议，封号风险最低。
3. **个人微信 hook**（如 `dsh-wechat-bridge`）：需要自行编译 hook、维护 reader 进程，**违反微信用户协议，有封号风险**，不建议。
4. **企业微信自建应用**：官方途径中最稳，但需要企业主体认证；本次未找到成熟的现成 DSH 插件。

## 风险与限制

- **版本门槛**：当时 0.1.2-rc.1 装不了主流插件（上文已述）。
- **只能单账号驱动**：`dsh-channel-wechat` 默认仅允许扫码登录的那个微信号驱动 bot，其他人发消息不建会话、不回复。
- **群聊不在范围内**：当前插件均不支持群聊、运行期多账号、主动推送。
- **凭据安全**：`bot_token` 存在 `~/.dsh/.credentials.yaml` / DSH credentials 中，不要外泄或提交。
- **第三方信任**：全部为非官方社区代码，运行在使用者机器上并拥有 agent 执行权限（可能触及 `workspace-write` 甚至完全权限），审慎评估来源。
- **包名混淆**：`@zackdk/dsh-weixin` 与 `dsh-weixin`（作者 caoyilearnai）是两个不同项目，别装错。

## 自制桥接的可行路径

若不放心第三方插件，基于当时安装的 DSH 源码有两处正规接入点：

- **`dsh-webhook`**：写一个规则插件，`register()` 一条规则，在 `run(delivery, signal)` 里把微信消息体转成 `WebhookSessionRequest`（需 `workspacePath`、`title`、`prompt`、`agentPreset`、`permissionPreset`），即可创建会话并驱动 agent。注意：runtime **不等待回复、不检查输出**，要把回答送回微信需自行监听 `session/event`。
- **`dsh-headless`**：`dsh --profile headless "<消息>"`，读 stdout 即为答案。适合做最简单的「微信 → 一次性任务」桥，代价是**没有多轮上下文**（每次调用只跑一个任务）。

## 参考链接

- https://www.npmjs.com/package/dsh-channel-wechat
- https://github.com/wangx-wx/dsh-channel-wechat
- https://www.npmjs.com/package/@zackdk/dsh-weixin
- https://github.com/Pan17/dsh-wechat
- https://www.npmjs.com/package/dsh-wechat-bot
- https://github.com/doyokol/dsh-wechat-bridge
- https://github.com/Tencent/openclaw-weixin （协议实现所参考的腾讯仓库）
