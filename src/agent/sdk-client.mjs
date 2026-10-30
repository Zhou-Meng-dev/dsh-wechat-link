/**
 * DSH SDK 客户端：管理一个常驻的 `dsh --profile sdk` 子进程，
 * 通过换行分隔的 JSON-RPC 2.0 over stdio 与之通信。
 *
 * 协议要点（实测自 0.2.1-rc.4）：
 *   - initialize  参数扁平：{ cwd, provider, model, reasoningEffort?, maxTokens? }
 *   - session/prompt  返回 { messageId }，这只是"已入队"回执，不是答案
 *   - session.event  通知，event.type 标识事件种类
 *   - session.status 通知，status: 'running' | 'idle'
 *
 * 关键时序：prompt 回执 → turn/start → assistant/message → turn/end → status:idle
 * 真正的回复文本要从 assistant/message 的 data.message.content 里过滤 type==='text'。
 */

import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';

/** 子进程退出后，延迟多久判定为异常（避免启动瞬间误判）。 */
const STARTUP_GRACE_MS = 500;

export class DshClient extends EventEmitter {
  /**
   * @param {object} opts
   * @param {string} opts.dshBin        - dsh 可执行文件，默认 'dsh'
   * @param {string} opts.profile       - profile 名，默认 'sdk'
   * @param {string} opts.cwd           - 会话工作目录
   * @param {string} [opts.dshHome]     - DSH_HOME 覆盖（测试用）
   * @param {string} opts.provider      - 模型 provider
   * @param {string} opts.model         - 模型名
   * @param {string} [opts.reasoningEffort]
   * @param {number} [opts.maxTokens]
   * @param {string[]} [opts.dshCmd]    - 覆盖启动命令，如 [node, bin.js]。
   *                                      沙箱里没有 volta shim 时用它直接跑 dsh。
   */
  constructor(opts) {
    super();
    this.opts = {
      dshBin: 'dsh',
      profile: 'sdk',
      ...opts,
    };
    this.proc = null;
    this.buffer = '';
    this.pending = new Map();
    this.nextId = 1;
    this.ready = false;
    this.closed = false;
    this.serverInfo = null;
  }

  /** 启动子进程并完成 initialize 握手。 */
  async start() {
    if (this.proc) throw new Error('客户端已启动');

    const env = { ...process.env, ...(this.opts.extraEnv ?? {}) };
    if (this.opts.dshHome) env.DSH_HOME = this.opts.dshHome;

    // 启动命令优先级：
    //   1. sandboxOpts   → bwrap 包一层，agent 被限制在租户目录
    //   2. dshCmd        → 显式指定 argv（沙箱内手动测试用）
    //   3. dshBin        → 直接调用 dsh
    let cmd;
    let argv;
    let spawnCwd = this.opts.cwd;
    if (this.opts.sandboxOpts) {
      const { buildSandboxArgv } = await import('../sandbox/sandbox.mjs');
      const dshArgs = ['--profile', this.opts.profile, ...(this.opts.extraDshArgs ?? [])];
      argv = buildSandboxArgv({
        ...this.opts.sandboxOpts,
        dshArgs,
        envVars: this.opts.extraEnv ?? {},
      });
      cmd = process.env.BWRAP_BIN ?? '/usr/bin/bwrap';
    } else if (this.opts.dshCmd) {
      const [c, ...pre] = this.opts.dshCmd;
      cmd = c;
      argv = [...pre, '--profile', this.opts.profile, ...(this.opts.extraDshArgs ?? [])];
    } else {
      cmd = this.opts.dshBin;
      argv = ['--profile', this.opts.profile, ...(this.opts.extraDshArgs ?? [])];
    }

    this.proc = spawn(cmd, argv, {
      cwd: spawnCwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.proc.stdout.setEncoding('utf8');
    this.proc.stdout.on('data', (chunk) => this.#onStdout(chunk));

    this.proc.stderr.setEncoding('utf8');
    this.proc.stderr.on('data', (chunk) => {
      const line = chunk.trim();
      if (line) this.emit('stderr', line);
    });

    this.proc.on('exit', (code, signal) => {
      this.closed = true;
      this.ready = false;
      const err = new Error(`dsh 子进程退出 (code=${code}, signal=${signal})`);
      for (const { reject } of this.pending.values()) reject(err);
      this.pending.clear();
      this.emit('exit', { code, signal });
    });

    this.proc.on('error', (err) => this.emit('error', err));

    // 握手
    const initParams = {
      cwd: this.opts.cwd,
      provider: this.opts.provider,
      model: this.opts.model,
    };
    if (this.opts.reasoningEffort) initParams.reasoningEffort = this.opts.reasoningEffort;
    if (this.opts.maxTokens) initParams.maxTokens = this.opts.maxTokens;

    const result = await this.rpc('initialize', initParams);
    this.serverInfo = result?.serverInfo ?? null;
    this.ready = true;
    this.emit('ready', this.serverInfo);
    return this.serverInfo;
  }

  /**
   * 恢复一个已持久化的会话（跨进程重启保留上下文）。
   *
   * 注意：会话不存在、或已被本运行时之外持有，服务端会拒绝。
   * 因此调用方应把它当作「尽力而为」——失败后照常用 prompt，
   * prompt 会用同一 id 惰性新建会话。
   *
   * @param {string} sessionId
   * @returns {Promise<boolean>} 是否恢复成功
   */
  async resume(sessionId) {
    if (!this.ready) return false;
    try {
      await this.rpc('session/resume', { sessionId }, 15000);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 发送一条用户消息。
   * @param {string} sessionId - SDK 侧会话 id（不存在的 id 会惰性创建 agent+session）
   * @param {string} text
   * @returns {Promise<{messageId: string}>} 入队回执
   */
  async prompt(sessionId, text, images = []) {
    if (!this.ready) throw new Error('客户端未就绪');
    const contentBlocks = [];
    if (text) contentBlocks.push({ type: 'text', text });
    // 图片块：{ type:'image', data: base64, mimeType }
    for (const img of images) {
      if (img?.data && img?.mimeType) {
        contentBlocks.push({ type: 'image', data: img.data, mimeType: img.mimeType });
      }
    }
    // 空消息不允许；有图时至少给一句占位文本
    if (contentBlocks.length === 0) contentBlocks.push({ type: 'text', text: '(空)' });
    return this.rpc('session/prompt', { sessionId, contentBlocks });
  }

  /** 关闭子进程。 */
  async shutdown() {
    if (!this.proc || this.closed) return;
    try {
      await this.rpc('shutdown', {}, 5000);
    } catch {
      /* 忽略：可能已经退出 */
    }
    this.proc.stdin.end();
    setTimeout(() => {
      if (!this.closed) this.proc.kill('SIGTERM');
    }, 1000);
  }

  /** 立刻强杀（测试与故障恢复用）。 */
  kill() {
    if (this.proc && !this.closed) this.proc.kill('SIGKILL');
  }

  // ---------------------------------------------------------------- internals

  rpc(method, params, timeoutMs = 120000) {
    if (this.closed) return Promise.reject(new Error('连接已关闭'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`RPC 超时: ${method}`));
      }, timeoutMs);

      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });

      this.#write({ jsonrpc: '2.0', id, method, params });
    });
  }

  #write(obj) {
    if (!this.proc || this.closed) throw new Error('无法写入：连接已关闭');
    this.proc.stdin.write(JSON.stringify(obj) + '\n');
  }

  #onStdout(chunk) {
    this.buffer += chunk;
    let idx;
    while ((idx = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;

      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        // 协议规定格式错误的行被忽略
        this.emit('malformed', line);
        continue;
      }
      this.#dispatch(msg);
    }
  }

  #dispatch(msg) {
    // 响应帧：带 id
    if (msg.id !== undefined) {
      const entry = this.pending.get(msg.id);
      if (!entry) return;
      this.pending.delete(msg.id);
      if (msg.error) {
        const err = new Error(msg.error.message ?? JSON.stringify(msg.error));
        err.code = msg.error.code;
        err.data = msg.error.data;
        entry.reject(err);
      } else {
        entry.resolve(msg.result);
      }
      return;
    }

    // 通知帧：只有 method
    switch (msg.method) {
      case 'session.event':
        this.emit('event', msg.params);
        break;
      case 'session.status':
        this.emit('status', msg.params);
        break;
      case 'subagent.started':
        this.emit('subagent-started', msg.params);
        break;
      case 'subagent.finished':
        this.emit('subagent-finished', msg.params);
        break;
      default:
        this.emit('notification', msg);
    }
  }
}

/**
 * 从一个 session.event 信封中提取 assistant 的可见文本。
 * 只取 type === 'text' 的块，忽略 reasoning。
 * @param {object} event
 * @returns {string} 文本，非 assistant/message 时返回空串
 */
export function extractAssistantText(event) {
  if (event?.type !== 'assistant/message') return '';
  const blocks = event.data?.message?.content ?? [];
  return blocks
    .filter((b) => b?.type === 'text' && typeof b.text === 'string' && b.text)
    .map((b) => b.text)
    .join('');
}
