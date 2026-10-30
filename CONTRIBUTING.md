# 贡献指南

本项目把微信（腾讯 iLink 官方 Bot 通道）接入 DeepSeek Harness，一台机器跑多个互相隔离的 bot。
改动优先保证三件事：**租户隔离、消息不丢、可回滚**。

## 开发环境

| 依赖 | 用途 | 是否必需 |
|---|---|---|
| Node.js ≥ 22 | 运行桥接与测试 | ✅ |
| `dsh` | 真实 agent 子进程 | 跑单测不需要 |
| `python3` + Pillow | 定时任务脚本、图片转码 | 可选 |
| `pdftotext` / `pdftoppm` + `tesseract` | PDF 文本提取 / 扫描件 OCR | 可选 |
| matplotlib / graphviz / qrencode | agent 生成图表、流程图、二维码 | 可选 |
| `bwrap` | dsh 默认沙箱（`DSH_SANDBOX=0` 可关闭） | 默认需要 |

不需要微信账号即可开发：单测不联网，`cli-sim` 用命令行模拟微信消息。

```bash
npm ci                  # 只装 esbuild / postject 两个构建期依赖
npm run check           # 语法检查 + 全部单测
npm test                # 只跑单测
npm run sim             # 交互式模拟微信消息（不启动 dsh）
node src/main.mjs doctor --check   # 只检查依赖，不写目录（需要 dsh 在 PATH）
```

## 目录速览

| 路径 | 内容 |
|---|---|
| `src/main.mjs`、`src/cli/` | 入口、命令分发、帮助与各子命令 |
| `src/tenant.mjs`、`src/tenant-registry.mjs` | 租户生命周期/装配、`TenantRegistry` |
| `src/agent/session.mjs` | dsh 会话、沙箱、persona、会话映射 |
| `src/wechat/reply.mjs`、`inbound.mjs`、`ingest.mjs`、`links.mjs` | 出站发送、入站管线、媒体落盘、链接抓取 |
| `src/wechat/commands.mjs` | 内置命令解析/渲染（绕过模型） |
| `src/tasks/runtime.mjs` | 任务调度、收件箱、执行与历史 |
| `src/config.mjs`、`src/assets.mjs` | 配置分层、资源定位 |
| `src/agent/` | dsh 子进程、会话、persona / skills / plugins、文档探测 |
| `src/wechat/` | iLink 协议、消息整形、媒体收发、待发队列 |
| `src/tasks/` | 定时任务、任务收件箱、执行历史、`taskctl.py` |
| `src/sandbox/` | 默认沙箱解析、bwrap 参数 |
| `src/ops/` | preflight / doctor、首次配置、用量统计 |
| `test/*.test.mjs` | 单元 / 集成测试（node:test） |
| `docs/feature-backlog.md` | 功能候选、状态与决策记录 |

## 代码约定

- **ESM + Node 内置模块**，文件后缀 `.mjs`；不要引入新的运行时依赖（`dependencies` 目前为空）。
- 2 空格缩进、LF、UTF-8；编辑器配置见 `.editorconfig`。
- 对外日志用中文；**token / API key 一律不进日志**，需要展示时用 `maskKey()`。
- 路径必须从 `BRIDGE_HOME` / 租户 id 派生，禁止写死 `/home/<user>` 之类个人绝对路径。
- 协议 I/O 与纯逻辑分层：解析、计划计算、Markdown 清理等写成可注入的纯函数，便于单测。
- 失败要显式：缺 token、配置版本不符、依赖缺失都直接报错，不静默降级。

## 测试要求

- 新行为必须带测试，放在 `test/<module>.test.mjs`，用 `node:test` + `node:assert/strict`。
- 测试不得访问真实微信 / 网络；用临时目录作为 `BRIDGE_HOME`，结束后清理。
- 涉及消息链路的改动，至少覆盖：正常路径、失败回退、并发/顺序不变量。
- 合并前必须 `npm run check` 通过。

## 提交规范

使用 Conventional Commits 的子集，描述用中文或英文均可，但同一 PR 保持一致：

```
feat(media): 支持 HEIC 入站转码
fix(outbox): token 失效时不重复丢弃消息
docs(readme): 修正 systemd 安装步骤
chore(ci): 增加 Node 22 测试矩阵
```

常用类型：`feat` / `fix` / `docs` / `test` / `refactor` / `perf` / `chore`。
一个提交只做一件事；格式化、重命名等噪声改动单独提交。

## PR 检查清单

- [ ] `npm run check` 通过（语法 + 测试）
- [ ] 新增/修改的行为有测试
- [ ] README、`docs/feature-backlog.md` 与代码同步
- [ ] 没有提交密钥、真实 token、个人绝对路径、构建产物
- [ ] 破坏性变更（配置格式、目录布局、CLI 参数）写明迁移方式
- [ ] 新增环境变量 / 配置字段已写进 README 与 `help`

## 发布

发布流程、版本策略与文档治理见 [GOVERNANCE.md](GOVERNANCE.md)；安全问题的报告方式见 [SECURITY.md](SECURITY.md)。
