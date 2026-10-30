#!/usr/bin/env bash
# DSH × 微信桥接 —— 环境检查入口
#
# 用法：
#   ./install.sh          检查环境（会创建缺失的配置/工作区目录）
#   ./install.sh --check  只检查，不创建任何目录
#   ./install.sh -h       打印本帮助
#
# 依赖检查的唯一实现在 src/ops/preflight.mjs（`node src/main.mjs doctor`）。
# 这里只做参数转发和下一步提示，避免维护两份会漂移的检查清单。

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

CHECK_ONLY=0
case "${1:-}" in
  --check|-n) CHECK_ONLY=1 ;;
  -h|--help)
    # 打印文件头注释，读到第一行非注释为止
    awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); print; next } NR > 1 { exit }' "$0"
    exit 0
    ;;
  "") ;;
  *)
    echo "未知参数: $1（支持 --check / -h）" >&2
    exit 2
    ;;
esac

# doctor 需要 Node；这里只做“有没有”的兜底，版本检查交给 doctor
command -v node >/dev/null 2>&1 || {
  echo "❌ 未找到 node，请先安装 Node.js >= 22" >&2
  exit 1
}

args=(doctor)
[[ "$CHECK_ONLY" == "1" ]] && args+=(--check)
node src/main.mjs "${args[@]}"

[[ "$CHECK_ONLY" == "1" ]] && exit 0

cat <<EOF

下一步：
  1. 登录微信机器人:   node src/main.mjs login
  2. 启动桥接:         node src/main.mjs
  3. 不接微信先测:     node src/cli-sim.mjs
  4. 后台常驻:         ./deploy/install.sh

已登录的租户可用 node src/main.mjs list 查看。
EOF
