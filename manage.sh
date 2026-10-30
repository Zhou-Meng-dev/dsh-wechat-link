#!/usr/bin/env bash
# dsh-wechat-link Docker 管理脚本
#
# 用法：./manage.sh <命令> [参数]
#   status              查看所有租户/容器/端口/健康状态
#   health              请求每个租户的 /healthz
#   doctor [目标]       在容器内运行依赖自检（dsh/Python/Pillow 等）
#   logs [目标] [-f]    看日志（目标可以是租户 id、容器名、项目名；省略则全部）
#   restart <目标>      重启容器
#   start|stop <目标>   启动/停止容器
#   persona <租户> [--show|--set "..."|--file 路径]  查看/修改人设
#   apikey <租户> ...   管理 API key（参数同 main.mjs apikey）
#   backup [目标|all]   备份数据卷到 ./backups/（会短暂停止容器）
#   data <目标>         查看租户数据卷和宿主机路径
#   shell <目标>        进入容器 shell
#   update              重建镜像并重建所有容器
#   add-tenant <标签> <端口>  新增一个独立 Compose project（扫码登录）
#
# 目标匹配优先级：租户 id / 容器名 / 项目名 / 服务名，支持唯一子串。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

IMAGE="${IMAGE:-dsh-wechat-link:local}"
BASE_COMPOSE="$ROOT/docker-compose.yml"
LOCAL_COMPOSE="$ROOT/docker-compose.tenants.yml"
BACKUP_DIR="${BACKUP_DIR:-$ROOT/backups}"

# 当前容器发现结果（并行数组）
TENANT_IDS=()
TENANT_CONTAINERS=()
TENANT_PROJECTS=()
TENANT_SERVICES=()
TENANT_VOLUMES=()
TENANT_PORTS=()
TENANT_HEALTH=()

die() { echo "❌ $*" >&2; exit 1; }
info() { echo "==> $*"; }

need_docker() {
  command -v docker >/dev/null 2>&1 || die "找不到 docker 命令"
  docker info >/dev/null 2>&1 || die "Docker 未运行或无权限"
}

need_compose() {
  docker compose version >/dev/null 2>&1 || die "找不到 docker compose（需要 Compose v2）"
}

# 读取容器内 config.json 的租户 id；失败时返回空
container_tenant_ids() {
  local c="$1"
  docker exec "$c" node -e '
    const fs = require("fs");
    try {
      const c = JSON.parse(fs.readFileSync("/data/.dsh-wechat-link/config.json", "utf8"));
      process.stdout.write((c.tenants || []).map((t) => t.id).join(","));
    } catch {}
  ' 2>/dev/null || true
}

discover() {
  need_docker
  TENANT_IDS=(); TENANT_CONTAINERS=(); TENANT_PROJECTS=(); TENANT_SERVICES=()
  TENANT_VOLUMES=(); TENANT_PORTS=(); TENANT_HEALTH=()

  local c image oneoff project service volume port health state ids id
  while IFS= read -r c; do
    [ -n "$c" ] || continue
    image=$(docker inspect -f '{{.Config.Image}}' "$c" 2>/dev/null || true)
    [ "$image" = "$IMAGE" ] || continue

    oneoff=$(docker inspect -f '{{index .Config.Labels "com.docker.compose.oneoff"}}' "$c" 2>/dev/null || true)
    [ "$oneoff" = "True" ] && continue

    project=$(docker inspect -f '{{index .Config.Labels "com.docker.compose.project"}}' "$c" 2>/dev/null || true)
    service=$(docker inspect -f '{{index .Config.Labels "com.docker.compose.service"}}' "$c" 2>/dev/null || true)
    volume=$(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/data"}}{{.Name}}{{end}}{{end}}' "$c" 2>/dev/null || true)
    port=$(docker inspect -f '{{range $p, $conf := .HostConfig.PortBindings}}{{if eq $p "8080/tcp"}}{{range $conf}}{{.HostPort}}{{end}}{{end}}{{end}}' "$c" 2>/dev/null || true)
    state=$(docker inspect -f '{{.State.Status}}' "$c" 2>/dev/null || true)
    if [ "$state" = "running" ]; then
      health=$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$c" 2>/dev/null || true)
    else
      health="$state"
    fi

    if [ "$state" = "running" ]; then
      ids=$(container_tenant_ids "$c")
    else
      ids=""
      if [[ "$c" =~ ^dsh-wechat-link-t-(.+)$ ]]; then ids="t-${BASH_REMATCH[1]}"; fi
    fi
    ids="${ids//$'\n'/}"
    [ -n "$ids" ] || ids="(unknown)"

    IFS=',' read -r -a _ids <<< "$ids"
    for id in "${_ids[@]}"; do
      [ -n "$id" ] || continue
      TENANT_IDS+=("$id")
      TENANT_CONTAINERS+=("$c")
      TENANT_PROJECTS+=("${project:--}")
      TENANT_SERVICES+=("${service:--}")
      TENANT_VOLUMES+=("${volume:--}")
      TENANT_PORTS+=("${port:--}")
      TENANT_HEALTH+=("${health:--}")
    done
  done < <(docker ps -a --format '{{.Names}}')
}

# 输出匹配的数组下标；匹配不到/多个时退出
resolve_index() {
  local q="${1:-}" i
  [ -n "$q" ] || die "缺少目标（租户 id / 容器名 / 项目名）"

  for i in "${!TENANT_IDS[@]}"; do
    if [ "$q" = "${TENANT_IDS[$i]}" ] || [ "$q" = "${TENANT_CONTAINERS[$i]}" ] \
      || [ "$q" = "${TENANT_PROJECTS[$i]}" ] || [ "$q" = "${TENANT_SERVICES[$i]}" ]; then
      echo "$i"
      return 0
    fi
  done

  local matches=()
  for i in "${!TENANT_IDS[@]}"; do
    if [[ "${TENANT_IDS[$i]}" == *"$q"* ]] || [[ "${TENANT_CONTAINERS[$i]}" == *"$q"* ]]; then
      matches+=("$i")
    fi
  done
  if [ "${#matches[@]}" -eq 1 ]; then
    echo "${matches[0]}"
    return 0
  fi
  if [ "${#matches[@]}" -eq 0 ]; then
    die "没有找到目标: $q"
  fi
  local names=()
  for i in "${matches[@]}"; do names+=("${TENANT_IDS[$i]}(${TENANT_CONTAINERS[$i]})"); done
  die "「$q」匹配到多个目标: ${names[*]}，请用完整租户 id"
}

cmd_status() {
  discover
  if [ "${#TENANT_IDS[@]}" -eq 0 ]; then
    echo "没有找到镜像 $IMAGE 的运行中容器。"
    return 0
  fi
  printf '%-20s %-30s %-16s %-6s %-10s\n' "租户" "容器" "项目" "端口" "健康"
  local i
  for i in "${!TENANT_IDS[@]}"; do
    printf '%-20s %-30s %-16s %-6s %-10s\n' \
      "${TENANT_IDS[$i]}" "${TENANT_CONTAINERS[$i]}" "${TENANT_PROJECTS[$i]}" \
      "${TENANT_PORTS[$i]}" "${TENANT_HEALTH[$i]}"
  done
}

cmd_health() {
  discover
  local i resp
  for i in "${!TENANT_IDS[@]}"; do
    if [ "${TENANT_HEALTH[$i]}" = "exited" ] || [ "${TENANT_HEALTH[$i]}" = "created" ] || [ "${TENANT_HEALTH[$i]}" = "dead" ]; then
      printf '%-20s 容器未运行（%s）\n' "${TENANT_IDS[$i]}" "${TENANT_HEALTH[$i]}"
      continue
    fi
    if [ "${TENANT_PORTS[$i]}" = "-" ]; then
      printf '%-20s 未映射端口\n' "${TENANT_IDS[$i]}"
      continue
    fi
    resp=$(curl -fsS --max-time 3 "http://127.0.0.1:${TENANT_PORTS[$i]}/healthz" 2>/dev/null || true)
    if [ -n "$resp" ]; then
      printf '%-20s %s\n' "${TENANT_IDS[$i]}" "$resp"
    else
      printf '%-20s ⚠️ 健康检查失败（127.0.0.1:%s）\n' "${TENANT_IDS[$i]}" "${TENANT_PORTS[$i]}"
    fi
  done
}

cmd_logs() {
  local target="" follow=() arg
  if [ "$#" -gt 0 ] && [[ "$1" != -* ]]; then target="$1"; shift; fi
  follow=("$@")
  discover

  if [ -n "$target" ]; then
    local idx; idx=$(resolve_index "$target")
    exec docker logs "${follow[@]}" "${TENANT_CONTAINERS[$idx]}"
  fi

  local i
  for i in "${!TENANT_IDS[@]}"; do
    echo "===== ${TENANT_IDS[$i]} (${TENANT_CONTAINERS[$i]}) ====="
    docker logs --tail 50 "${follow[@]}" "${TENANT_CONTAINERS[$i]}" 2>&1 || true
  done
}

cmd_lifecycle() {
  local action="$1" target="${2:-}"
  discover
  local idx; idx=$(resolve_index "$target")
  docker "$action" "${TENANT_CONTAINERS[$idx]}"
}

cmd_persona() {
  local target="${1:-}"; shift || true
  [ -n "$target" ] || die "用法: ./manage.sh persona <租户> [--show|--set 文本|--file 路径]"
  discover
  local idx; idx=$(resolve_index "$target")
  local container="${TENANT_CONTAINERS[$idx]}" id="${TENANT_IDS[$idx]}"

  if [ "$#" -eq 0 ]; then set -- --show; fi

  if [ "$1" = "--file" ]; then
    local file="${2:-}"
    [ -n "$file" ] && [ -f "$file" ] || die "--file 需要存在的主机文件路径"
    local remote="/tmp/persona-upload-$$.md"
    docker cp "$file" "$container:$remote"
    docker exec -e HOME=/home/node "$container" node src/main.mjs persona "$id" --file "$remote"
    docker exec "$container" rm -f "$remote" 2>/dev/null || true
  else
    docker exec -e HOME=/home/node "$container" node src/main.mjs persona "$id" "$@"
  fi

  if [ "$1" != "--show" ]; then
    info "重启容器以应用新人设…"
    docker restart "$container" >/dev/null
    info "已重启 ${container}"
  fi
}

cmd_apikey() {
  local target="${1:-}"; shift || true
  [ -n "$target" ] || die "用法: ./manage.sh apikey <租户> [--show|--set key|--clear]"
  discover
  local idx; idx=$(resolve_index "$target")
  local container="${TENANT_CONTAINERS[$idx]}" id="${TENANT_IDS[$idx]}"

  if [ "$#" -eq 0 ]; then set -- --show; fi
  docker exec -e HOME=/home/node "$container" node src/main.mjs apikey "$id" "$@"

  if [ "$1" != "--show" ]; then
    info "重启容器以应用 API key…"
    docker restart "$container" >/dev/null
    info "已重启 ${container}"
  fi
}

cmd_doctor() {
  local target="${1:-}"
  discover
  local indices=() i
  if [ -n "$target" ]; then
    indices=("$(resolve_index "$target")")
  else
    indices=("${!TENANT_IDS[@]}")
  fi
  local failed=0
  for i in "${indices[@]}"; do
    echo "===== ${TENANT_IDS[$i]} (${TENANT_CONTAINERS[$i]}) ====="
    if ! docker exec -e HOME=/home/node "${TENANT_CONTAINERS[$i]}" node src/main.mjs doctor; then
      failed=1
    fi
  done
  return "$failed"
}

cmd_data() {
  local target="${1:-}"
  discover
  local idx; idx=$(resolve_index "$target")
  local vol="${TENANT_VOLUMES[$idx]}"
  echo "租户:     ${TENANT_IDS[$idx]}"
  echo "容器:     ${TENANT_CONTAINERS[$idx]}"
  echo "数据卷:   $vol"
  if [ "$vol" != "-" ]; then
    echo "宿主机路径: $(docker volume inspect -f '{{.Mountpoint}}' "$vol" 2>/dev/null || echo '(未知)')"
  fi
}

cmd_shell() {
  local target="${1:-}"
  discover
  local idx; idx=$(resolve_index "$target")
  exec docker exec -it "${TENANT_CONTAINERS[$idx]}" sh
}

cmd_backup() {
  local target="${1:-all}"
  discover
  if [ "${#TENANT_IDS[@]}" -eq 0 ]; then die "没有找到运行中的租户"; fi

  local indices=()
  if [ "$target" = "all" ]; then
    indices=("${!TENANT_IDS[@]}")
  else
    indices=("$(resolve_index "$target")")
  fi

  mkdir -p "$BACKUP_DIR"
  chmod 700 "$BACKUP_DIR" 2>/dev/null || true

  local seen="|" i vol c ts file
  for i in "${indices[@]}"; do
    vol="${TENANT_VOLUMES[$i]}"
    c="${TENANT_CONTAINERS[$i]}"
    if [ "$vol" = "-" ]; then
      echo "⚠️ ${TENANT_IDS[$i]} 没有 /data 卷，跳过"
      continue
    fi
    case "$seen" in *"|$vol|"*) continue ;; esac
    seen="$seen$vol|"

    ts=$(date +%Y%m%d-%H%M%S)
    file="$BACKUP_DIR/backup-${TENANT_IDS[$i]}-${ts}.tgz"
    local was_running=1
    case "${TENANT_HEALTH[$i]}" in exited|created|dead) was_running=0 ;; esac
    info "备份 ${TENANT_IDS[$i]} ($vol) → $file"
    if [ "$was_running" -eq 1 ]; then docker stop "$c" >/dev/null; fi
    if ! docker run --rm \
      --user "$(id -u):$(id -g)" \
      -v "$vol":/data:ro \
      -v "$BACKUP_DIR":/backup \
      --entrypoint sh "$IMAGE" \
      -c "tar czf '/backup/$(basename "$file")' -C /data ."; then
      if [ "$was_running" -eq 1 ]; then docker start "$c" >/dev/null || true; fi
      die "备份失败，已尝试重新启动 $c"
    fi
    if [ "$was_running" -eq 1 ]; then docker start "$c" >/dev/null; fi
    chmod 600 "$file" 2>/dev/null || true
    info "备份完成：$file"
    if [ "$was_running" -eq 1 ] && [ "${TENANT_PORTS[$i]}" != "-" ]; then
      wait_health "${TENANT_PORTS[$i]}" || echo "⚠️ ${TENANT_IDS[$i]} 已启动，但健康检查暂未通过"
    fi
  done
}

cmd_update() {
  need_compose
  info "重建镜像 $IMAGE …"
  docker compose -f "$BASE_COMPOSE" build

  discover
  if [ "${#TENANT_IDS[@]}" -eq 0 ]; then die "没有找到运行中的租户"; fi

  local done_projects="|" i project
  for i in "${!TENANT_IDS[@]}"; do
    project="${TENANT_PROJECTS[$i]}"
    [ "$project" = "-" ] && continue
    case "$done_projects" in *"|$project|"*) continue ;; esac
    done_projects="$done_projects$project|"

    if [[ "${TENANT_SERVICES[$i]}" == bridge-t-* ]] && [ -f "$LOCAL_COMPOSE" ]; then
      info "重建项目 $project（$LOCAL_COMPOSE）"
      docker compose -f "$LOCAL_COMPOSE" up -d --force-recreate
    else
      [ "${TENANT_PORTS[$i]}" != "-" ] || die "项目 $project 没有宿主机端口，无法保留端口重建"
      info "重建项目 $project（端口 ${TENANT_PORTS[$i]}）"
      BRIDGE_PORT="${TENANT_PORTS[$i]}" docker compose -p "$project" -f "$BASE_COMPOSE" up -d --force-recreate
    fi
  done
  cmd_status
}

wait_health() {
  local port="$1" i
  [ "$port" = "-" ] && return 1
  for i in $(seq 1 20); do
    if curl -fsS --max-time 2 "http://127.0.0.1:$port/healthz" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  return 1
}

cmd_add_tenant() {
  local label="${1:-}" port="${2:-}"
  [ -n "$label" ] && [ -n "$port" ] || die "用法: ./manage.sh add-tenant <标签> <端口>"
  [[ "$label" =~ ^[a-z0-9][a-z0-9_-]*$ ]] || die "标签只能包含小写字母、数字、下划线、短横线，且以字母/数字开头"
  [[ "$port" =~ ^[0-9]+$ ]] && [ "$port" -ge 1 ] && [ "$port" -le 65535 ] || die "端口必须是 1–65535"
  need_compose
  docker image inspect "$IMAGE" >/dev/null 2>&1 || die "镜像 $IMAGE 不存在，先执行 ./manage.sh update 或 docker compose build"

  if command -v ss >/dev/null 2>&1 && ss -ltn 2>/dev/null | awk '{print $4}' | grep -qE "[:.]$port$"; then
    die "端口 $port 已被占用"
  fi

  info "新增租户 project=$label port=$port"
  info "即将显示二维码；用新微信号扫码"
  BRIDGE_PORT="$port" docker compose -p "$label" -f "$BASE_COMPOSE" run --rm bridge login
  BRIDGE_PORT="$port" docker compose -p "$label" -f "$BASE_COMPOSE" run --rm bridge list

  info "启动项目 $label …"
  BRIDGE_PORT="$port" docker compose -p "$label" -f "$BASE_COMPOSE" up -d

  if wait_health "$port"; then
    info "已启动：http://127.0.0.1:$port/healthz"
    return 0
  fi
  echo "⚠️ 容器已启动，但健康检查暂未通过；查看日志："
  echo "   docker compose -p $label logs -f bridge"
}

cmd_help() {
  cat <<'EOF'
dsh-wechat-link Docker 管理脚本

用法：./manage.sh <命令> [参数]
  status              查看所有租户/容器/端口/健康状态
  health              请求每个租户的 /healthz
  doctor [目标]       在容器内运行依赖自检（dsh/Python/Pillow 等）
  logs [目标] [-f]    看日志（目标可以是租户 id、容器名、项目名；省略则全部）
  restart <目标>      重启容器
  start|stop <目标>   启动/停止容器
  persona <租户> [--show|--set "..."|--file 路径]  查看/修改人设
  apikey <租户> ...   管理 API key（参数同 main.mjs apikey）
  backup [目标|all]   备份数据卷到 ./backups/（会短暂停止容器）
  data <目标>         查看租户数据卷和宿主机路径
  shell <目标>        进入容器 shell
  update              重建镜像并重建所有容器
  add-tenant <标签> <端口>  新增一个独立 Compose project（扫码登录）

目标匹配优先级：租户 id / 容器名 / 项目名 / 服务名，支持唯一子串。
EOF
}
need_docker
case "${1:-help}" in
  status|list) shift || true; cmd_status ;;
  health) shift || true; cmd_health ;;
  doctor) shift || true; cmd_doctor "${1:-}" ;;
  logs) shift || true; cmd_logs "$@" ;;
  restart|start|stop) action="$1"; shift; cmd_lifecycle "$action" "${1:-}" ;;
  persona) shift || true; cmd_persona "$@" ;;
  apikey) shift || true; cmd_apikey "$@" ;;
  backup) shift || true; cmd_backup "${1:-all}" ;;
  data|volume) shift || true; cmd_data "${1:-}" ;;
  shell) shift || true; cmd_shell "${1:-}" ;;
  update) shift || true; cmd_update ;;
  add-tenant|add) shift || true; cmd_add_tenant "$@" ;;
  help|-h|--help) cmd_help ;;
  *) echo "未知命令: $1" >&2; echo; cmd_help; exit 1 ;;
esac
