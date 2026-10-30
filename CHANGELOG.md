# Changelog

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### Added

- 内置命令 `/status`、`/tasks`、`/usage`、`/help`（中英文别名）：由桥接直接处理，
  不经过模型，命令单独成批，token 失效时进待发队列。
- 用量统计与预算告警（OPS-001）：每回合累加 DSH `TokenUsage` 到租户 `usage.json`，
  支持日/月汇总、模型计数、失败回合；CLI `usage <id> [--day|--month|--json]`，
  微信 `/usage` 同源；按 `budgetTokensPerDay` / `budgetTokensPerMonth` 每周期告警一次。
- 网页链接抓取（INGEST-001）：用户发链接时抓取正文，落盘 `_inbox/links/` 后注入摘要；
  SSRF 防护覆盖内网/回环/link-local/IPv6，重定向逐跳校验，DNS 结果钉死，
  8s 超时、2MB 响应上限、只接受文本内容。
- 扫描版 PDF OCR（INGEST-002）：`doc_probe.py` 在无文本层时自动用
  `pdftoppm` + `tesseract` 识别，默认 5 页，`--ocr-pages` / `--no-ocr` 可调，
  缺工具时明确降级；`doctor` 增加 OCR 工具检查。
- 媒体工具链（MEDIA-002）：Docker 镜像加入 matplotlib、Graphviz、qrencode、
  Noto CJK 字体；`doctor` 增加可选检查；能力提示里补充图表/二维码/流程图生成命令。
- 测试：`usage`、`links`、`commands`、`conversation-usage` 与 OCR/预检回归测试。
- GitHub Actions CI：Node 22 / 24 矩阵、`.mjs` 语法检查、Shell 语法检查、打包内容与 CLI 冒烟。
- Dependabot：npm devDependencies、GitHub Actions 与 Docker 基础镜像的定期升级。
- `CONTRIBUTING.md`、`GOVERNANCE.md`、`SECURITY.md`、`CHANGELOG.md`。
- `npm run lint`（`node --check` 全量语法门禁）、`npm run check`、`npm run test:coverage`。
- `.editorconfig`、`.gitattributes`，统一换行与缩进。
- 治理回归测试：systemd 占位符、文档相对链接、npm 包 `docs/` 资源。
- `doctor --check` 只读模式：只检查不创建目录；`doctor` 新增 dsh 版本与宿主凭据检查。
- 默认沙箱自动解析（`src/sandbox/sandbox-env.mjs`）：源码与 SEA 产物都自动定位宿主 node / dsh bin.js /
  工具根，不再要求先跑 `sandbox.sh` 或手工导出 `SANDBOX_*`。

### Changed

- 链接抓取注入的正文摘录从 4000 字降到 1500 字；同一用户在一个会话内重复发送
  同一 URL 时只注入标题 + 落盘路径，不再重复抓取/注入，`/new` 清空该用户的缓存。
- 文件说明只保留“先探测”的警告、兜底命令和缺工具降级提示；`--sheet` / `--page` /
  `--out` / OCR 等选项细节统一交给 `doc_probe.py --help`，避免 prompt 与脚本漂移。
- `ConversationManager` 在回合结束（成功/失败/超时）回调一次用量；`Tenant`
  负责 `usage.json` 生命周期与预算提醒。
- 入站流水线并行执行图片下载、文件落盘与链接抓取；链接内容标注为不可信外部资料。
- `mergeQueueItems` 透传命令名，内置命令仍严格单独成批。
- **dsh 沙箱改为默认开启**：`node src/main.mjs` 与 SEA 单文件一致；只有 `DSH_SANDBOX=0`
  才显式关闭（启动告警），容器模式用 `BRIDGE_DSH_MODE=container` 代替 bwrap。
- 工具根禁止是家目录或其祖先，避免把 `~/.ssh` 等宿主文件只读挂进沙箱。
- `sandbox.sh` 保留为“显式指定工具链”的兼容入口；正常启动不再依赖它。
- 根 `install.sh` 收敛为 `doctor` 的薄封装；依赖检查清单只在 `src/ops/preflight.mjs` 维护一份。
- systemd unit 模板改用 `@REPO@` / `@BRIDGE_HOME@` 占位符，由 `deploy/install.sh`
  或 README 中的 `sed` 命令替换，仓库内不再硬编码个人绝对路径。
- npm 包纳入 `docs/`，README 引用的架构图与功能清单在安装包内可用。
- `prepublishOnly` 从只跑测试改为 `npm run check`（语法 + 测试）。
- `src/` 按能力分组为 `agent/`、`wechat/`、`tasks/`、`sandbox/`、`ops/`；仅移动文件与改 import，模块接口不变。

### Fixed

- `src/tenant.mjs` 的家目录回退改为 `os.homedir()`，不再硬编码 `/home/zhoumeng`。
- 修复 `BRIDGE_HOME` 位于 `/tmp` 下时，`--tmpfs /tmp` 覆盖已 bind 的工作目录，
  bwrap 报 `Can't chdir ...: No such file or directory` 的问题（`src/sandbox/sandbox.mjs`）。
- 根目录 `install.sh` 删除失效的 macOS launchd 指引，改为指向 systemd 部署脚本。
- `docs/feature-backlog.md` 移除会漂移的测试文件计数，改为可执行命令。

## [0.1.0] - 2026-10-30

首个可用版本：微信 iLink 官方 Bot 通道 ↔ DeepSeek Harness 多租户桥接。

### Added

- 多租户：每租户独立 bot token、`dsh` 子进程、`DSH_HOME`、工作目录与会话；运行时热添加/删除。
- iLink 长轮询、文本/语音转写/图片/文件/引用消息入站；图片与文件出站（CDN 加密上传）。
- 同用户消息 FIFO + 500ms 合并；回合串行化，避免并发跑同一用户。
- Markdown → 微信纯文本；超长回复转文件；长内容分段发送。
- 定时任务：一次性 / 每日 / 每周 / 固定间隔；按标题管理、暂停恢复、稍后提醒；
  `taskctl.py` 同步等待 agent 结果；执行历史与失败提示。
- `context_token` 失效时进入待发队列，下次入站自动补发。
- 图片归一化：大图压缩、HEIC/BMP/TIFF 转码（Pillow 优先，ImageMagick 兜底）。
- 每租户 persona / skills / plugins；API key 预设 + 单 bot 覆盖（环境变量注入）。
- bubblewrap 沙箱、Docker / Kubernetes 部署、`/healthz`、systemd 用户服务。
- 首次启动依赖自检（doctor）与 API key 配置向导；配置/数据统一到 `~/.dsh-wechat-link/`。
- Node SEA 单文件 Linux 可执行程序（实验）。
- `cli-sim` 命令行模拟微信消息；覆盖消息队列、Markdown、定时任务、媒体与沙箱参数的测试。

### Security

- 租户之间文件、进程、会话隔离；`allowUsers` 白名单；凭据目录 0700、文件 0600。
- 沙箱遮蔽宿主家目录；密钥优先通过环境变量注入，日志中的 key 一律掩码。
