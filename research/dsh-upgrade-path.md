# DSH 0.1.2-rc.1 → 0.2.x 升级路径

调研时间：2026-10-27
数据来源：npm registry（`registry.npmjs.org/@deepseek-ai/dsh`）、本机 Volta 安装状态、`@deepseek-ai/dsh-webhook` 类型定义

## 一、现状

| 项 | 值 |
|---|---|
| 当前版本 | `0.1.2-rc.1`（2026-09-03 发布） |
| 安装方式 | **Volta**：`volta install @deepseek-ai/dsh@<version>` |
| 可执行文件 | `~/.volta/bin/dsh`（shim） |
| Node | `24.18.0`（Volta 管理，满足所有版本要求） |
| npm `latest` | `0.2.1-rc.2` |
| npm `next` | `0.2.1-rc.4`（最新） |

**升级不会动 `~/.dsh/`。** 你的 `settings.yaml`、`.credentials.yaml`、`sessions/`、`skills/`、`profiles/` 都在 DSH_HOME，与 CLI 版本无关。两个 profile（`web`、`headless`）的 dependencies 都是空的，没有装过第三方插件，**升级风险很低**。

## 二、版本时间线（0.1.2 之后）

```
0.1.2-rc.1   2026-09-03  ← 你在这里
0.1.3-alpha.2 09-07
0.1.5-alpha.1/2 → 0.1.5-rc.1/2/3
0.1.7-rc.1/2
0.2.0-rc.1   2026-09-28  ← 插件最低要求
0.2.0-rc.2   09-29
0.2.1-alpha.1~5 → 0.2.1-rc.1/2/3/4
0.2.1-rc.4   2026-10-26  ← 最新（next 标签）
```

**中间跨越了 0.1.3 / 0.1.5 / 0.1.6 / 0.1.7 / 0.2.0 / 0.2.1 共 6 个次版本**，跨了两个 minor（0.1 → 0.2）。

## 三、0.1.2 → 0.2.0 的实际变更

依赖层面移除的包：

- `@deepseek-ai/cordis-plugin-hmr` → 被 `@deepseek-ai/dsh-hmr` 取代
- `@deepseek-ai/dsh-workflow-worker-thread` → 被 `@deepseek-ai/dsh-workflow-ptc` 取代

新增的包（节选，说明改动较大）：

`dsh-hmr`、`dsh-http-proxy`、`dsh-agent-preset`、`dsh-atomic-write`、`dsh-skill-office`、`dsh-tool-present`、`dsh-workflow-ptc`、`dsh-mcp-resources`、`dsh-plugin-manager`、`dsh-experimental-*` 若干

cordis 版本：`^4.0.2` → `~4.0.4`（0.2.1 起 `~4.0.5`），**peer dependency 收紧**，这是第三方插件普遍要求 0.2.x 的根因。

## 四、⚠️ 一个影响选版的关键发现

`dsh-webhook` 在 0.2.x 中的捆绑状态变了：

| 版本 | dsh-webhook 是否在主依赖 |
|---|---|
| 0.1.2-rc.1 | ✅ 是（`^0.1.2-rc.1`） |
| 0.2.0-rc.1 / rc.2 | ✅ 是（`0.2.0-rc.x`） |
| **0.2.1-rc.1 ~ rc.4** | ❌ **已移除** |

但 `dsh-webhook` **仍然独立发布**（`dist-tags.next` = `0.2.1-rc.4`），可以手动安装。

**影响：如果你的目标是「自己开发走 webhook 路线」，升到 `0.2.0-rc.2` 比升到 `0.2.1-rc.2` 更省事**——webhook 是默认捆绑的，不用额外装。

反之，如果只是要用现成插件 `dsh-channel-wechat`（要求 `>=0.2.0-rc.1`），**升到 `0.2.0-rc.2` 即可满足，不必追最新**。

## 五、推荐升级路径

### 路线 A：稳妥（推荐）

升到 **`0.2.0-rc.2`**。满足插件要求，webhook 仍捆绑，且是 0.2.0 的 rc 收尾版本（比 rc.1 多修了一轮）。

```bash
# 1. 备份（保险起见）
cp -r ~/.dsh ~/.dsh.bak-$(date +%Y%m%d)

# 2. 升级 CLI（Volta）
volta install @deepseek-ai/dsh@0.2.0-rc.2

# 3. 验证
dsh --version          # 应输出 0.2.0-rc.2
dsh web --help | head  # 确认能启动

# 4. 确认 webhook 在
dsh --dump-config 2>/dev/null | grep -i webhook
```

### 路线 B：追最新

升到 **`0.2.1-rc.4`**（npm `next`）。功能最新，但要自己补 `dsh-webhook`，且 rc 版本迭代快、可能有回归。

```bash
volta install @deepseek-ai/dsh@0.2.1-rc.4
```

### 回滚（一条命令）

Volta 保留旧版本，随时可切回：

```bash
volta install @deepseek-ai/dsh@0.1.2-rc.1
```

这是 Volta 相对 npm global 的最大优势——**升级是无损可逆的**。

## 六、升级后需验证的清单

1. `dsh --version` 版本正确
2. `dsh web` 能正常启动，`http://127.0.0.1:3080` 可访问
3. `~/.dsh/settings.yaml` 里的模型配置（`deepseek-v4-flash`）仍生效
4. 凭据仍可用（能正常对话）
5. 历史会话可读取（`~/.dsh/sessions/` 未被破坏）
6. skills 可用（`~/.dsh/skills/` 有 36 个目录，检查技能仍能加载）
7. 终端 UI 正常（`dsh --profile tui` 若常用）

## 七、升级与微信方案的决策矩阵

| 你的目标 | 推荐版本 | 理由 |
|---|---|---|
| 用现成 `dsh-channel-wechat` | `0.2.0-rc.2` | 满足 `>=0.2.0-rc.1`，且 webhook 捆绑 |
| 自己开发 webhook 桥接 | `0.2.0-rc.2` | webhook 默认可用，无需补装 |
| 自己开发、且要最新特性 | `0.2.1-rc.4` | 需手动装 `dsh-webhook` |
| 暂不折腾微信 | 保持 `0.1.2-rc.1` | 现状稳定，无必要升级 |

## 八、参考

- https://registry.npmjs.org/@deepseek-ai/dsh
- https://registry.npmjs.org/@deepseek-ai/dsh-webhook
- 本地源码：`~/.volta/tools/image/packages/@deepseek-ai/dsh/lib/node_modules/@deepseek-ai/dsh/`
