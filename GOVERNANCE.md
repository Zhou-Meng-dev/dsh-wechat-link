# 项目治理

这份文档说明项目**由谁决策、什么算事实来源、改动如何进入主干、版本如何发布**。
贡献流程的实操细节见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 范围

- 项目：`dsh-wechat-link`（微信 iLink ↔ DeepSeek Harness 多租户桥接）。
- 目标：在单机上安全地运行多个互不影响的 bot；消息不丢；配置与数据可备份、可迁移。
- 非目标：群聊、个人微信逆向协议、绕过微信平台限制。明确不做项记录在本地开发看板 `docs/feature-backlog.md`（不入库）。

## 角色与决策

| 角色 | 职责 |
|---|---|
| Maintainer（ZhouMeng） | 最终技术决策、合并、发布、安全响应 |
| Contributor | 提交 issue / PR、补充测试与文档 |

当前是单人维护阶段，不设投票委员会。规则：

1. 影响用户行为的改动先开 issue，说明动机、替代方案与迁移成本。
2. 涉及隔离边界、密钥处理、数据格式的改动，必须在 PR 描述里单列风险。
3. 争议以“可验证的证据”为准：测试、复现步骤、协议实测记录优先于个人偏好。
4. 决策结论写回 issue 或本地开发看板，避免只存在于聊天记录里。

## 事实来源（Single Source of Truth）

| 内容 | 唯一来源 | 约束 |
|---|---|---|
| 版本号 | `package.json` + `src/version.mjs` | 两处必须一致，`test/cli.test.mjs` 会断言 |
| 用户文档 | `README.md` | 命令、路径、配置字段必须与代码一致 |
| 功能状态 | 本地 `docs/feature-backlog.md`（开发文档，不入库） | 状态变化当次更新，不积压 |
| 变更记录 | `CHANGELOG.md` | 每个发布版本一节 |
| 安全策略 | `SECURITY.md` | 报告渠道、支持版本、密钥处置 |
| 部署方式 | `deploy/` + `docker-compose.yml` | systemd 模板用 `@REPO@` / `@BRIDGE_HOME@` 占位 |
| 依赖检查 | `src/ops/preflight.mjs`（`doctor`） | 启动自检与 `install.sh` 只调用，不复制检查清单 |

文档中的数字、路径、命令必须可复现。**不要写会漂移的硬编码统计**（例如“N 个测试文件”），
改为给出可执行的检查命令；确需数字时，在同一 PR 里用命令核对。

## 变更流程

```
issue / 明确需求
  → 分支（feat/…、fix/…）
  → 实现 + 测试 + 文档
  → npm run check
  → PR（描述动机、影响、验证方式）
  → review（至少一名非作者；单人阶段由 maintainer 自查清单）
  → squash merge 到 main
```

- `main` 始终保持可运行：合并前 CI 必须绿。
- 破坏性变更（配置版本、目录布局、CLI 参数、默认模型）必须在 PR 与 CHANGELOG 中标注，
  并提供迁移步骤；未发布过的旧格式可以直接拒绝读取，但不能静默改写用户数据。
- 紧急修复允许先合并后补测试，但必须在 24 小时内补上并在 CHANGELOG 记录。

## 版本与发布

采用 Semantic Versioning；`0.x` 阶段不承诺跨 minor 兼容，但每次破坏性变更都要写迁移说明。

发布清单：

1. `CHANGELOG.md` 增加版本小节（日期、Added / Changed / Fixed / Security）。
2. 同步 `package.json` 与 `src/version.mjs` 的版本号。
3. `npm run check` 全绿；`npm pack --dry-run` 检查包内容。
4. 合并到 `main` 后打 tag 并推送：`git tag -a vX.Y.Z -m "vX.Y.Z" && git push origin vX.Y.Z`。
   推 tag 会触发 `.github/workflows/publish.yml`：重跑检查、校验 tag 与版本一致、
   以 `--provenance` 发布；版本已存在时自动跳过。
5. 自动发布的认证二选一：
   - **Trusted Publishing（推荐）**：首次手动发布后，在 npm 包设置 → Trusted Publishing
     绑定 `Zhou-Meng-dev/dsh-wechat-link` 与 `publish.yml`，之后不再需要长期 token；
   - **`NPM_TOKEN` 仓库 secret**：Granular access token，只给本包 publish 权限并设过期时间。
   两者都未配置时 workflow 会失败，不会静默跳过发布。
6. **首次发布仍需手动**：包尚不存在，无法配置 Trusted Publishing。执行 `npm publish`，
   再把 `vX.Y.Z` tag 移到发布提交；之后推 tag 触发的 workflow 会检测到版本已存在并跳过。
7. 更新本地开发看板 `docs/feature-backlog.md` 的基线表与更新记录（不入库）。

## 文档治理

- 文档与代码同 PR 修改；不允许“代码已改、README 仍是旧命令”。
- 每季度做一次文档审计：随机抽取 README / backlog 中的命令与数字，逐条执行核对。
- 历史决策保留在 backlog 的“更新记录”里，不删除旧行；被推翻的结论要写明原因。
- 架构图 `assets/architecture.svg` 为手工维护；模块或数据流变化时同步更新。

## 安全与数据

- 漏洞报告、支持版本、密钥轮换见 [SECURITY.md](SECURITY.md)。
- 仓库内**不得出现**真实 bot token、API key、`secrets.json`、`config.json`、备份文件。
- 测试使用假 key（`sk-test…`）与临时目录；日志中的密钥必须掩码。
- 用户数据默认在 `~/.dsh-wechat-link/`（`BRIDGE_HOME` 可覆盖），权限 0700/0600，不随仓库迁移。

## 已知治理缺口

按优先级记录，完成后移入上表或 backlog：

| 缺口 | 影响 | 计划 |
|---|---|---|
| 无分支保护 / CODEOWNERS | 依赖 maintainer 自律 | 在 GitHub 仓库设置中启用 |
| 无 issue / PR 模板 | 信息完整度靠人工 | 有外部贡献者后补 |
| 架构图为手工维护 | 易与代码漂移 | 结构变化时同步 `assets/architecture.svg` |
