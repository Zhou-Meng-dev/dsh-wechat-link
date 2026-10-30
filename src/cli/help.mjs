/**
 * `-h` / `--help` / `help` 共用的帮助文本。
 * 命令名右侧补齐到 17 字符，源码/SEA/npm bin 三种形态说明列都能对齐。
 */

import { CLI } from './context.mjs';

export function printHelp() {
  const P = CLI.padEnd(17);
  console.log(`
DSH × 微信桥接（多租户）

用法:
  ${P}                  启动所有租户，常驻运行
  ${P} login            扫码添加一个新的微信 bot（独立租户）
  ${P} login --cwd DIR  扫码添加，并指定工作目录
  ${P} list             列出所有租户
  ${P} rm <id>          删除租户

每租户能力管理（改完自动重启该租户）:
  ${P} skills  <id> list                列出技能
  ${P} skills  <id> add <目录>          添加技能
  ${P} skills  <id> rm <名称>           删除技能
  ${P} persona <id> --show              查看系统提示词
  ${P} persona <id> --set "文本"        设置系统提示词
  ${P} persona <id> --file <路径>       从文件设置
  ${P} persona <id> --clear             恢复默认
  ${P} plugin  <id> list                列出插件
  ${P} plugin  <id> add <包名>          安装插件
  ${P} plugin  <id> rm  <包名>          移除插件
  ${P} apikey  --default --set <key>    设置预设 key（新 bot 自动继承）
  ${P} apikey  --default --show         查看预设 key
  ${P} apikey  <id> --show              查看单个 bot 的 key（掩码）
  ${P} apikey  <id> --set <key>         设置本租户独立 key
  ${P} apikey  <id> --file <路径>       从文件读取 key
  ${P} apikey  <id> --clear             清除，回退宿主凭据

定时任务（到点由 agent 生成内容并主动推送）:
  ${P} task <id> list
  ${P} task <id> add --at "2026-10-28 12:30" --prompt "..."
  ${P} task <id> add --daily "09:00" --prompt "..."
  ${P} task <id> add --weekly "1,3,5 09:00" --prompt "..."   （周一三五）
  ${P} task <id> add --every 60 --prompt "..."
  ${P} task <id> add --window "08:00-23:00" --count 10 --prompt "..."   （窗口内分层随机）
  ${P} task <id> rm <taskId|标题>
  ${P} task <id> enable|disable <taskId|标题>
  ${P} task <id> update <taskId|标题> --daily "08:00" | --window "08:00-23:00" --count 10
  ${P} task <id> snooze <taskId|标题> [--minutes 10]

用量统计:
  ${P} usage <id>                    今日 + 本月用量
  ${P} usage <id> --day 2026-10-30    指定日期
  ${P} usage <id> --month 2026-10     指定月份
  ${P} usage <id> --json              JSON 输出

微信内置命令（不经过模型）:
  /new  /status  /tasks  /usage  /help

其它:
  ${P} doctor [--check]  检查运行依赖（dsh 版本 / 凭据 / Python / PDF+OCR / 图表工具 / bwrap；--check 只读）
  ${P} setup            首次配置（API key；可重跑）
  ${P} version          打印版本（也可用 -v / -V / --version）
  ${P} help             打印本帮助（也可用 -h / --help）

每个租户 = 一个独立的微信 bot + 独立的 DSH agent + 独立的工作目录，
互不影响。运行中的服务会自动检测新增/删除的租户。

环境变量:
  BRIDGE_HOME          桥接根目录（默认 ~/.dsh-wechat-link；配置/凭据/租户数据都在这里）
  BRIDGE_CONFIG        配置文件路径（默认 $BRIDGE_HOME/config.json）
  BRIDGE_SECRETS       凭据文件路径（默认 $BRIDGE_HOME/secrets.json）
  WECHAT_WORKSPACES    租户工作目录根（默认 $BRIDGE_HOME/workspace）
  WECHAT_SANDBOX_ROOT  租户数据根（默认 $BRIDGE_HOME/tenants；存 persona.md / tasks.json 等）
  BRIDGE_SKIP_SETUP    设为 1 时跳过首次启动配置向导
  DSH_SANDBOX          默认 1（bwrap 沙箱）；设为 0 显式关闭（不推荐）
  BRIDGE_DSH_MODE      设为 container 时：用租户独立 dsh-home，但不套 bwrap
  WECHAT_NODE_BIN      宿主 node 路径（默认自动解析；SEA 模式建议显式设置）
  WECHAT_DSH_JS        宿主 dsh bin.js 路径（默认自动解析）
  WECHAT_TOOL_ROOT     node/dsh 的共同根（只读挂到沙箱 /opt/volta）
  SANDBOX_HOME         沙箱内要遮蔽的宿主家目录（默认 $HOME）
  BRIDGE_HEALTH_PORT   暴露 /healthz 与 /readyz 的端口（默认不监听）
  BRIDGE_HEALTH_HOST   健康检查绑定地址（默认 127.0.0.1）
  BRIDGE_OCR_LANG      扫描 PDF OCR 语言（默认自动选 chi_sim+eng）
  DSH_HOME             覆盖 DSH 主目录
`);
}
