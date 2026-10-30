#
# 容器化部署：容器本身就是隔离边界，不再在容器里套 bwrap。
# 因此需要设置 BRIDGE_DSH_MODE=container（每个租户用独立 dsh-home，但不 bwrap）。
#
# 推荐拓扑：一个容器 = 一个租户（一个微信 bot）。
# 多租户塞进同一容器会让 agent 能读到同容器内其它租户的 /data 目录。

ARG BASE_IMAGE=node:24.22.1-bookworm-slim
FROM ${BASE_IMAGE}

ARG DSH_VERSION=0.2.1-rc.4
ARG NPM_REGISTRY=
# 可选：Debian apt 镜像（国内可用 mirrors.tuna.tsinghua.edu.cn）
ARG APT_MIRROR=
# 构建期代理（可选）：--build-arg HTTPS_PROXY=http://host:port
ARG HTTP_PROXY
ARG HTTPS_PROXY
ARG NO_PROXY
ENV DEBIAN_FRONTEND=noninteractive

# tini：PID 1 信号转发；python3/poppler：文件探测（xlsx/docx/pdf）
# matplotlib/graphviz/qrencode：agent 生成图表、流程图、二维码（MEDIA-002）
# tesseract + chi_sim：扫描版 PDF OCR（INGEST-002）；Noto CJK 供图表中文标签
# apt 不走构建期 HTTP(S)_PROXY（部分代理对 deb.debian.org 返回 502），
# 需要换源时用 --build-arg APT_MIRROR=mirrors.tuna.tsinghua.edu.cn
RUN if [ -n "$APT_MIRROR" ]; then \
      sed -i "s|http://deb.debian.org|http://$APT_MIRROR|g" /etc/apt/sources.list.d/debian.sources; \
    fi \
 && env -u HTTP_PROXY -u HTTPS_PROXY -u http_proxy -u https_proxy \
      apt-get -o Acquire::Retries=5 update \
 && env -u HTTP_PROXY -u HTTPS_PROXY -u http_proxy -u https_proxy \
      apt-get -o Acquire::Retries=5 install -y --no-install-recommends \
        ca-certificates tini python3 python3-pil python3-matplotlib \
        poppler-utils graphviz qrencode \
        tesseract-ocr tesseract-ocr-chi-sim fonts-noto-cjk \
 && rm -rf /var/lib/apt/lists/*

# DSH 引擎（SDK profile 由桥接 spawn）
# 国内网络可加 --build-arg NPM_REGISTRY=https://registry.npmmirror.com
# npm 11 默认不跑依赖的 install scripts；DSH 的 node-pty/koffi 等原生模块必须允许，
# 否则启动时会报 "No usable native binding found for node-addon-require-builtin-..."
RUN if [ -n "$NPM_REGISTRY" ]; then npm config set registry "$NPM_REGISTRY"; fi \
 && npm install -g \
      --allow-scripts=@deepseek-ai/dsh-subprocess-local,koffi,node-pty,@google/genai,protobufjs \
      @deepseek-ai/dsh@${DSH_VERSION} \
 && npm cache clean --force

WORKDIR /app
COPY package.json ./
COPY src ./src
COPY examples ./examples

ENV NODE_ENV=production \
    HOME=/home/node \
    # 所有配置/凭据/租户数据都在这个目录下（持久卷挂到 /data）
    BRIDGE_HOME=/data/.dsh-wechat-link \
    # /tmp 是 noexec 的 tmpfs；DSH 的原生模块加载器默认会把 .node 复制到 /tmp 再 dlopen，
    # noexec 下会报 "No usable native binding found"。直接从包目录加载即可。
    NARB_DISABLE_NATIVE_CACHE=1 \
    BRIDGE_DSH_MODE=container \
    BRIDGE_HEALTH_PORT=8080 \
    BRIDGE_HEALTH_HOST=0.0.0.0 \
    TZ=Asia/Hong_Kong

RUN mkdir -p /data && chown -R node:node /data /app
USER node

VOLUME ["/data"]
EXPOSE 8080
STOPSIGNAL SIGTERM

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8080/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["tini", "--", "node", "src/main.mjs"]
