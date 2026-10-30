#!/usr/bin/env bash
# 一键部署：解析 node/dsh 路径 → 写 deploy.env → 安装 systemd 用户服务。
#
# 用法：
#   ./deploy/install.sh            # 检查 + 写入配置/服务，但不启动
#   ./deploy/install.sh --start    # 同上，并立即启动服务
#   ./deploy/install.sh --check    # 只检查，不写任何文件
#   ./deploy/install.sh -h|--help  # 打印本帮助
#
# 之后还需要：
#   node src/main.mjs login        # 首次扫码（只做一次）
#   sudo loginctl enable-linger "$USER"   # 注销后服务继续运行

set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BRIDGE_ROOT="${BRIDGE_HOME:-$HOME/.dsh-wechat-link}"
DEPLOY_ENV="$BRIDGE_ROOT/deploy.env"
UNIT_NAME="dsh-wechat-link.service"
UNIT_DIR="$HOME/.config/systemd/user"
UNIT_PATH="$UNIT_DIR/$UNIT_NAME"

CHECK=0
START=0
for arg in "$@"; do
  case "$arg" in
    --check|-n) CHECK=1 ;;
    --start) START=1 ;;
    -h|--help)
      # 打印文件头注释，读到第一行非注释为止；不写死行号，避免头部增删后漏出代码
      awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); print; next } NR > 1 { exit }' "$0"
      exit 0
      ;;
    *)
      echo "未知参数: $arg（支持 --check / --start）" >&2
      exit 2
      ;;
  esac
done

ok()   { printf '  \033[32m✓\033[0m %s\n' "$1"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$1"; }
bad()  { printf '  \033[31m✗\033[0m %s\n' "$1"; }
die()  { bad "$1"; exit 1; }

MISSING=()

echo "部署 dsh-wechat-link"
echo "  仓库: $REPO"
echo

# ---------------------------------------------------------------- 依赖
echo "1. 检查依赖"

command -v bwrap >/dev/null 2>&1 || MISSING+=("bubblewrap（sudo apt install bubblewrap）")
if command -v bwrap >/dev/null 2>&1; then
  ok "bubblewrap $(bwrap --version 2>/dev/null | awk '{print $2}')"
fi

NODE_BIN="${WECHAT_NODE_BIN:-$(command -v node || true)}"
[[ -n "$NODE_BIN" ]] || die "找不到 node（需要 >=22）"
NODE_BIN="$(readlink -f "$NODE_BIN")"
NODE_VERSION="$("$NODE_BIN" -p 'process.versions.node')"
NODE_MAJOR="${NODE_VERSION%%.*}"
[[ "$NODE_MAJOR" -ge 22 ]] || die "node 版本 $NODE_VERSION 过低，需要 >=22"
ok "node $NODE_VERSION ($NODE_BIN)"

DSH_CMD="$(command -v dsh || true)"
[[ -n "$DSH_CMD" ]] || die "找不到 dsh 命令（先安装 @deepseek-ai/dsh）"

resolve_dsh_js() {
  local cmd="$1" real voltadir npm_root prefix
  real="$(readlink -f "$cmd" 2>/dev/null || true)"
  if [[ -n "$real" && "$real" == *.js && -f "$real" ]]; then
    printf '%s\n' "$real"; return 0
  fi
  voltadir="${VOLTA_HOME:-$HOME/.volta}"
  local v="$voltadir/tools/image/packages/@deepseek-ai/dsh/lib/node_modules/@deepseek-ai/dsh/lib/bin.js"
  if [[ -f "$v" ]]; then printf '%s\n' "$v"; return 0; fi
  npm_root="$(npm root -g 2>/dev/null || true)"
  if [[ -n "$npm_root" && -f "$npm_root/@deepseek-ai/dsh/lib/bin.js" ]]; then
    printf '%s\n' "$npm_root/@deepseek-ai/dsh/lib/bin.js"; return 0
  fi
  prefix="$(dirname "$(dirname "$real")")"
  if [[ -f "$prefix/lib/node_modules/@deepseek-ai/dsh/lib/bin.js" ]]; then
    printf '%s\n' "$prefix/lib/node_modules/@deepseek-ai/dsh/lib/bin.js"; return 0
  fi
  return 1
}

DSH_JS="${WECHAT_DSH_JS:-}"
if [[ -z "$DSH_JS" ]]; then
  DSH_JS="$(resolve_dsh_js "$DSH_CMD" || true)"
fi
[[ -n "$DSH_JS" && -f "$DSH_JS" ]] || die "找不到 dsh 的 bin.js（可用 WECHAT_DSH_JS=/path/to/bin.js 指定）"
DSH_JS="$(readlink -f "$DSH_JS")"
ok "dsh $DSH_JS"

if command -v loginctl >/dev/null 2>&1; then
  LINGER="$(loginctl show-user "$USER" -p Linger --value 2>/dev/null || true)"
  if [[ "$LINGER" == "yes" ]]; then
    ok "linger 已开启（注销后服务继续运行）"
  else
    warn "linger 未开启：sudo loginctl enable-linger $USER"
  fi
fi

if command -v pdftotext >/dev/null 2>&1; then
  ok "poppler-utils $(pdftotext -v 2>&1 | head -1 | awk '{print $3}')（PDF 提取可用）"
else
  warn "未安装 poppler-utils（PDF 只能报页数；sudo apt install poppler-utils）"
fi

if python3 -c 'import PIL' >/dev/null 2>&1; then
  ok "Pillow $(python3 -c 'import PIL; print(PIL.__version__)' 2>/dev/null)（大图压缩/格式转换可用）"
else
  warn "未安装 Pillow（大图/HEIC 无法自动转码；sudo apt install python3-pil）"
fi

if python3 -c 'import matplotlib' >/dev/null 2>&1; then
  ok "matplotlib（agent 可生成图表）"
else
  warn "未安装 matplotlib（agent 无法生成图表；sudo apt install python3-matplotlib）"
fi

if command -v dot >/dev/null 2>&1; then
  ok "graphviz（agent 可生成流程图）"
else
  warn "未安装 graphviz（agent 无法生成流程图；sudo apt install graphviz）"
fi

if command -v qrencode >/dev/null 2>&1; then
  ok "qrencode（agent 可生成二维码）"
else
  warn "未安装 qrencode（agent 无法生成二维码；sudo apt install qrencode）"
fi

if command -v pdftoppm >/dev/null 2>&1 && command -v tesseract >/dev/null 2>&1; then
  ok "pdftoppm + tesseract（扫描版 PDF OCR 可用）"
else
  warn "未安装 OCR 工具（扫描版 PDF 无法识别；sudo apt install poppler-utils tesseract-ocr tesseract-ocr-chi-sim）"
fi

if [[ ${#MISSING[@]} -gt 0 ]]; then
  echo
  bad "缺少必需依赖："
  for m in "${MISSING[@]}"; do echo "  - $m"; done
  exit 1
fi

# ---------------------------------------------------------------- 工具根
echo
echo "2. 解析工具根（node/dsh 会只读挂到沙箱的 /opt/volta）"

VOLTA_DIR="${VOLTA_HOME:-$HOME/.volta}"
if [[ -n "${WECHAT_TOOL_ROOT:-}" ]]; then
  TOOL_ROOT="$WECHAT_TOOL_ROOT"
elif [[ "$NODE_BIN" == "$VOLTA_DIR/"* && "$DSH_JS" == "$VOLTA_DIR/"* ]]; then
  TOOL_ROOT="$VOLTA_DIR"
else
  TOOL_ROOT="$("$NODE_BIN" -e '
    const path = require("node:path");
    const [a, b] = process.argv.slice(1).map((p) => path.resolve(p).split(path.sep));
    let i = 0;
    while (i < a.length && i < b.length && a[i] === b[i]) i++;
    process.stdout.write(a.slice(0, i).join(path.sep) || path.sep);
  ' "$NODE_BIN" "$DSH_JS")"
fi
TOOL_ROOT="$(readlink -f "$TOOL_ROOT")"
[[ "$TOOL_ROOT" != "/" ]] || die "node 与 dsh 的公共前缀是 /，请用 WECHAT_TOOL_ROOT 指定一个更小的目录"
[[ "$NODE_BIN" == "$TOOL_ROOT/"* ]] || die "node ($NODE_BIN) 不在工具根 $TOOL_ROOT 下"
[[ "$DSH_JS" == "$TOOL_ROOT/"* ]] || die "dsh ($DSH_JS) 不在工具根 $TOOL_ROOT 下"
ok "工具根 $TOOL_ROOT"

SANDBOX_NODE="/opt/volta/${NODE_BIN#"$TOOL_ROOT"/}"
SANDBOX_DSH_JS="/opt/volta/${DSH_JS#"$TOOL_ROOT"/}"
ok "沙箱内 node: $SANDBOX_NODE"
ok "沙箱内 dsh : $SANDBOX_DSH_JS"

# ---------------------------------------------------------------- 配置
echo
echo "3. 写入配置"

if [[ -f "$BRIDGE_ROOT/config.json" ]]; then
  ok "已有配置 $BRIDGE_ROOT/config.json"
else
  warn "尚未登录；稍后运行: node src/main.mjs login"
fi
if [[ -f "$HOME/.dsh/.credentials.yaml" ]]; then
  ok "宿主 DSH 凭据存在"
else
  warn "未找到 ~/.dsh/.credentials.yaml；请配置宿主 key，或 login 后用 apikey --default 设置"
fi

if [[ "$CHECK" == "1" ]]; then
  echo
  ok "检查完成（--check，未写任何文件）"
  echo "  将写入: $DEPLOY_ENV"
  echo "  将安装: $UNIT_PATH"
  exit 0
fi

mkdir -p "$BRIDGE_ROOT"
chmod 700 "$BRIDGE_ROOT"
{
  echo "# generated by deploy/install.sh at $(date -Is)"
  echo "WECHAT_TOOL_ROOT=$(printf '%q' "$TOOL_ROOT")"
  echo "WECHAT_NODE_BIN=$(printf '%q' "$NODE_BIN")"
  echo "WECHAT_DSH_JS=$(printf '%q' "$DSH_JS")"
} > "$DEPLOY_ENV"
chmod 600 "$DEPLOY_ENV"
ok "写入 $DEPLOY_ENV"

# ---------------------------------------------------------------- systemd
echo
echo "4. 安装 systemd 用户服务"

mkdir -p "$UNIT_DIR"
tmp="$(mktemp)"
# unit 模板用 @REPO@ / @BRIDGE_HOME@ 占位，仓库里不出现个人绝对路径。
# 路径中的 & | \ 是 sed 替换语法字符，必须先转义。
escape_sed() { printf '%s' "$1" | sed 's/[&|\\]/\\&/g'; }
sed -e "s|@REPO@|$(escape_sed "$REPO")|g" \
    -e "s|@BRIDGE_HOME@|$(escape_sed "$BRIDGE_ROOT")|g" \
    "$REPO/deploy/dsh-wechat-link.service" > "$tmp"
install -m 644 "$tmp" "$UNIT_PATH"
rm -f "$tmp"
chmod +x "$REPO/sandbox.sh" 2>/dev/null || true
ok "安装 $UNIT_PATH"

if command -v systemctl >/dev/null 2>&1 && systemctl --user show-environment >/dev/null 2>&1; then
  systemctl --user daemon-reload
  systemctl --user enable "$UNIT_NAME" >/dev/null 2>&1 || warn "enable 失败（可手动 systemctl --user enable $UNIT_NAME）"
  ok "已 enable（登录自启）"
  if [[ "$START" == "1" ]]; then
    systemctl --user restart "$UNIT_NAME"
    sleep 2
    if systemctl --user is-active --quiet "$UNIT_NAME"; then
      ok "服务已启动"
    else
      warn "服务未处于 active，查看: journalctl --user -u $UNIT_NAME -n 50"
    fi
  else
    warn "服务尚未启动：systemctl --user start $UNIT_NAME"
  fi
else
  warn "systemd 用户服务不可用；可直接前台运行 $REPO/sandbox.sh"
fi

echo
echo "下一步："
echo "  1) 首次登录:  node src/main.mjs login"
echo "  2) 启动服务:  systemctl --user start $UNIT_NAME"
echo "  3) 看日志:    journalctl --user -u $UNIT_NAME -f"
echo "  4) 注销常驻:  sudo loginctl enable-linger \"$USER\""
echo
echo "完成。"
