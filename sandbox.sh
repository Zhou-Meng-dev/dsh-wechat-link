#!/usr/bin/env bash
# 以「桥接在宿主、agent 在沙箱」的方式启动微信桥接。
#
# 说明：main.mjs 现在默认自动解析沙箱工具链；本脚本保留给需要显式指定
# node/dsh/工具根的旧部署（deploy/install.sh 的 systemd unit 也走这里）。
#
# 结构：
#   main.mjs（宿主，能读配置/连 iLink）
#     └─ bwrap ─ dsh（沙箱，agent 与它派生的 bash 都在里面）
#
# 沙箱内 agent 看不到：
#   宿主 ~/.ssh、~/code、其它仓库、桥接的配置/凭据、宿主 ~/.dsh
#
# 沙箱内 agent 能看到：
#   系统运行库（只读）、node + dsh（只读）、
#   本租户 DSH_HOME（读写，只含凭据）、本租户工作目录（读写）

set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOST_HOME="${HOME}"
# 所有配置与租户数据都在这个根目录下（可用 BRIDGE_HOME 覆盖）
BRIDGE_ROOT="${BRIDGE_HOME:-$HOST_HOME/.dsh-wechat-link}"
SANDBOX_ROOT="${WECHAT_SANDBOX_ROOT:-$BRIDGE_ROOT/tenants}"
WORKSPACE="${WECHAT_WORKSPACES:-$BRIDGE_ROOT/workspace}"
CRED_SRC="$HOST_HOME/.dsh/.credentials.yaml"

die() { echo "❌ $*" >&2; exit 1; }

# 部署脚本会写这个文件，解析出 node/dsh 的真实路径与工具根。
# 没有它时退回 Volta 默认布局（兼容旧部署）。
DEPLOY_ENV="$BRIDGE_ROOT/deploy.env"
if [[ -f "$DEPLOY_ENV" ]]; then
  # shellcheck disable=SC1090
  source "$DEPLOY_ENV"
fi

TOOL_ROOT="${WECHAT_TOOL_ROOT:-${VOLTA_ROOT:-$HOST_HOME/.volta}}"
NODE_BIN="${WECHAT_NODE_BIN:-$(command -v node || true)}"
DSH_JS="${WECHAT_DSH_JS:-}"
if [[ -z "$DSH_JS" ]]; then
  DSH_JS="$TOOL_ROOT/tools/image/packages/@deepseek-ai/dsh/lib/node_modules/@deepseek-ai/dsh/lib/bin.js"
fi

command -v bwrap >/dev/null || die "缺少 bubblewrap (apt install bubblewrap)"
[[ -n "$NODE_BIN" && -x "$NODE_BIN" ]] || die "找不到 node（运行 deploy/install.sh，或设置 WECHAT_NODE_BIN）"
[[ -f "$DSH_JS" ]] || die "找不到 dsh（运行 deploy/install.sh，或设置 WECHAT_DSH_JS）"
[[ "$NODE_BIN" == "$TOOL_ROOT"/* ]] || die "node ($NODE_BIN) 不在 WECHAT_TOOL_ROOT ($TOOL_ROOT) 下"
[[ "$DSH_JS" == "$TOOL_ROOT"/* ]] || die "dsh ($DSH_JS) 不在 WECHAT_TOOL_ROOT ($TOOL_ROOT) 下"

NODE_MAJOR="$("$NODE_BIN" -p 'process.versions.node.split(".")[0]')"
[[ "$NODE_MAJOR" -ge 22 ]] || die "node 版本过低（$("$NODE_BIN" -v)），需要 >=22"

# 工具根在沙箱里统一挂到 /opt/volta；下面把宿主绝对路径映射成沙箱内路径。
SANDBOX_NODE="/opt/volta/${NODE_BIN#"$TOOL_ROOT"/}"
SANDBOX_DSH_JS="/opt/volta/${DSH_JS#"$TOOL_ROOT"/}"

mkdir -p "$SANDBOX_ROOT" "$WORKSPACE"

# 凭据由 tenant.mjs 按租户策略决定：
#   配了 apiKey 的租户 → 用环境变量，不复制宿主凭据
#   没配的租户         → 回退复制宿主凭据
# 这里只负责提供来源路径。
if [[ ! -f "$CRED_SRC" ]]; then
  echo "⚠️  未找到宿主凭据 $CRED_SRC —— 未配置独立 apiKey 的租户将无法调用模型" >&2
fi

export DSH_SANDBOX=1
export BRIDGE_HOME="$BRIDGE_ROOT"
export CRED_SOURCE="$CRED_SRC"
export WECHAT_SANDBOX_ROOT="$SANDBOX_ROOT"
export SANDBOX_HOME="$HOST_HOME"
export VOLTA_ROOT="$TOOL_ROOT"
export SANDBOX_NODE="$SANDBOX_NODE"
export SANDBOX_DSH_JS="$SANDBOX_DSH_JS"
export WECHAT_WORKSPACES="$WORKSPACE"

echo "=== $(date -Is) 启动桥接（agent 沙箱化） ==="
echo "    node    : $NODE_BIN"
echo "    桥接根  : $BRIDGE_ROOT"
echo "    沙箱根  : $SANDBOX_ROOT"
echo "    工作区  : $WORKSPACE"
echo "    配置    : ${BRIDGE_CONFIG:-$BRIDGE_ROOT/config.json} （仅桥接可读，agent 不可见）"
echo "    工具根  : $TOOL_ROOT → /opt/volta"

exec "$NODE_BIN" "$REPO/src/main.mjs"
