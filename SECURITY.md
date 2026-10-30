# 安全策略

## 支持版本

| 版本 | 安全修复 |
|---|---|
| 0.1.x | ✅ |
| < 0.1 | ❌（未发布过） |

## 报告漏洞

**不要**在公开 issue 中披露可利用细节、真实 token 或用户数据。

1. 优先使用仓库的 **GitHub Security → Report a vulnerability**（私有安全公告）。
2. 若仓库尚未配置远端或该功能不可用，请通过维护者已知的私密渠道联系，并在消息里注明
   “SECURITY”，等待确认后再补充细节。
3. 报告请包含：受影响版本、复现步骤、影响范围（读/写/越权/密钥泄露）、建议修复方向。

响应目标（尽力而为，非 SLA）：48 小时内确认收到，7 天内给出修复或缓解计划；
修复发布后会在 `CHANGELOG.md` 记录，并在公告中致谢（除非你要求匿名）。

## 威胁模型

| 信任边界 | 说明 |
|---|---|
| 微信入站消息 | **不可信**。文本、引用、文件、图片都可能携带提示注入或恶意内容 |
| agent 工具调用 | 半可信。受 bwrap / 容器约束，但网络与资源仍是残余风险 |
| DSH 自带沙箱 | 只约束 bash 与文件写入（`workspace-write`），**读不受限**，也不约束 dsh 进程本身 |
| 宿主文件系统 | 可信但**不能**暴露给 agent；`~/.ssh`、`~/.dsh`、其它租户目录必须不可见 |
| iLink / 微信平台 | 外部服务，不在本项目控制范围内 |

已实现的防线：

- 每租户独立 `dsh` 子进程、独立 `DSH_HOME`、独立工作目录与会话。
- **默认**用 bubblewrap 遮蔽宿主家目录，只暴露租户目录与只读工具链；`DSH_SANDBOX=0` 才会关闭（启动会告警）。
- 容器模式下容器本身即隔离边界，不再套 bwrap。
- `allowUsers` 白名单；留空时只有扫码 owner 能驱动 bot。
- 配置 / 凭据目录 0700、文件 0600；密钥可通过环境变量注入，不强制落盘。
- 日志中的 key 使用掩码；测试只使用假 key。
- 审批回传尚未实现——需要审批的工具调用会超时失败，这是当前的一道（粗暴）防线。

残余风险、沙箱能挡住/挡不住什么，见 README 的「安全模型」与「沙箱能挡住什么」两节。

## 密钥与凭据处理

| 项 | 位置 | 处理 |
|---|---|---|
| bot token | `~/.dsh-wechat-link/secrets.json` → `tenants.<id>.token` | 仅 `login` 写入；不打印全文 |
| 租户 API key | 同文件 → `tenants.<id>.apiKey` | `apikey <id> --set/--clear` 轮换 |
| 预设 API key | 同文件 → `defaultApiKey` | `apikey --default --set/--clear` |
| 宿主 DSH 凭据 | `~/.dsh/.credentials.yaml` | 未配置租户 key 时回退使用 |

- 目录权限：`~/.dsh-wechat-link` 0700；`config.json` / `secrets.json` / `setup.json` 0600。
- **轮换**：重新扫码 `login` 会更新 token；API key 用 `apikey` 命令覆盖；删除租户用 `rm <id>`。
- **泄露处置**：立即停止服务 → 在 iLink / DeepSeek 侧吊销对应凭据 → 删除 `secrets.json` 中对应条目
  → 重新 `login` / `apikey --set` → 检查 `journalctl` 与 shell 历史是否残留明文。
- 不要把 `~/.dsh-wechat-link/` 提交到仓库；备份文件同样含凭据，需加密保存。

## 不在范围内

- 腾讯 iLink / 微信服务端自身的漏洞与策略限制。
- DeepSeek 模型输出的内容正确性；提示注入的“内容层”防护不等于沙箱隔离。
- 用户主动关闭沙箱（`DSH_SANDBOX=0`）或给 agent 扩大挂载后的后果。
- 第三方依赖（当前运行时依赖为空；构建期 devDependencies 由 Dependabot 跟踪）。
