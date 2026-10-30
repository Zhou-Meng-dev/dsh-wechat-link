/**
 * 对话管理器：把"一个微信用户的一条消息"翻译成"一次 DSH 回合"，并把回复取回来。
 *
 * 核心难点（实测得出）：
 *   1. session/prompt 只返回"已入队"回执，不是答案 —— 必须等 turn 结束。
 *   2. 判定回合结束的信号是 session.status === 'idle'，但要区分
 *      "本回合还没开始"和"本回合已经结束"。
 *   3. 一个会话同一时间只能跑一个回合，并发消息必须排队。
 *   4. 同一个 dsh 进程会推送所有会话的事件（协议明确"不过滤"），必须按 sessionId 分流。
 */

import { extractAssistantText } from './sdk-client.mjs';

/** 单个回合等待上限。 */
const TURN_TIMEOUT_MS = 10 * 60 * 1000;

export class ConversationManager {
  /**
   * @param {import('./sdk-client.mjs').DshClient} client
   * @param {object} [opts]
   * @param {number} [opts.turnTimeoutMs]
   * @param {(msg: string) => void} [opts.log]
   * @param {import('./session-store.mjs').SessionStore} [opts.store]
   *        会话映射持久化。提供后，重启会尝试 session/resume 恢复上下文。
   * @param {(info: {peerId:string, sessionId:string, usage:object, ok:boolean,
   *                error:string|null, durationMs:number}) => void} [opts.onTurn]
   *        回合结束回调（成功/失败/超时都会调用一次），用于用量统计。
   */
  constructor(client, opts = {}) {
    this.client = client;
    this.turnTimeoutMs = opts.turnTimeoutMs ?? TURN_TIMEOUT_MS;
    this.log = opts.log ?? ((m) => console.error(`[conv] ${m}`));
    this.store = opts.store ?? null;
    this.onTurn = opts.onTurn ?? null;

    /** @type {Map<string, SessionState>} sessionId → 状态 */
    this.sessions = new Map();
    /** @type {Map<string, string>} peerId → sessionId */
    this.peerToSession = new Map();
    /** 已经尝试过 resume 的 sessionId，避免每次提问都重试 */
    this.resumed = new Set();

    // 从磁盘恢复映射
    if (this.store) {
      for (const peerId of this.store.peers()) {
        const sid = this.store.get(peerId);
        if (sid) this.peerToSession.set(peerId, sid);
      }
      if (this.peerToSession.size > 0) {
        this.log(`恢复 ${this.peerToSession.size} 个用户会话映射（将在首次提问时 resume）`);
      }
    }

    client.on('event', (params) => this.#onEvent(params));
    client.on('status', (params) => this.#onStatus(params));
  }

  /**
   * 把一条用户消息送入某个 peer 的会话，并返回助手回复。
   * @param {string} peerId - 微信用户的稳定 id
   * @param {string} text
   * @returns {Promise<string>}
   */
  async ask(peerId, text, images = []) {
    const sessionId = this.#sessionOf(peerId);
    const state = this.#stateOf(sessionId);

    // 串行化：同一会话的回合必须排队，否则 dsh 会把新消息插进正在跑的回合
    const run = async () => {
      await this.#ensureResumed(sessionId);
      return this.#runTurn(state, text, images, peerId);
    };
    const p = state.queue.then(run, run);
    state.queue = p.catch(() => {});
    return p;
  }

  /**
   * 首次使用某个持久化会话时尝试恢复上下文。
   * 失败不算错误：prompt 会用同一 id 惰性新建，只是没有历史。
   */
  async #ensureResumed(sessionId) {
    if (this.resumed.has(sessionId)) return;
    this.resumed.add(sessionId);
    const ok = await this.client.resume(sessionId);
    if (ok) this.log(`已恢复会话上下文: ${sessionId.slice(-24)}`);
  }

  /** 为一个 peer 开新会话（丢弃上下文）。 */
  reset(peerId) {
    const old = this.peerToSession.get(peerId);
    this.peerToSession.delete(peerId);
    // 新会话 id 用随机后缀，避免复用旧 id 撞上已有上下文
    const next = `wx-${peerId}-${Date.now().toString(36)}`;
    this.peerToSession.set(peerId, next);
    // 记入持久化并标记为"已处理"，新会话无需 resume
    this.store?.set(peerId, next);
    this.resumed.add(next);
    this.log(`reset ${peerId}: ${old ?? '(无)'} → ${next}`);
    return next;
  }

  /** 列出当前活跃会话数（诊断用）。 */
  stats() {
    return {
      peers: this.peerToSession.size,
      sessions: this.sessions.size,
      busy: [...this.sessions.values()].filter((s) => s.turn).length,
    };
  }

  // ---------------------------------------------------------------- internals

  #sessionOf(peerId) {
    let sid = this.peerToSession.get(peerId);
    if (!sid) sid = this.reset(peerId);
    return sid;
  }

  #stateOf(sessionId) {
    let s = this.sessions.get(sessionId);
    if (!s) {
      s = {
        sessionId,
        queue: Promise.resolve(),
        /** 当前进行中的回合；null 表示空闲 */
        turn: null,
        /** 是否已经见过 "running" —— 用于避免把启动前的 idle 误判为回合结束 */
        sawRunning: false,
        idleWaiters: [],
      };
      this.sessions.set(sessionId, s);
    }
    return s;
  }

  async #runTurn(state, text, images = [], peerId = '') {
    const { sessionId } = state;
    const startedAt = Date.now();

    const turn = {
      texts: [],
      sawRunning: false,
      done: false,
      resolve: null,
      reject: null,
      error: null,
      /** 本回合所有模型调用的 TokenUsage 累加 */
      usage: {},
    };

    const finished = new Promise((resolve, reject) => {
      turn.resolve = resolve;
      turn.reject = reject;
    });

    state.turn = turn;
    state.sawRunning = false;

    const timer = setTimeout(() => {
      if (!turn.done) {
        turn.done = true;
        state.turn = null;
        turn.reject(new Error(`回合超时（${this.turnTimeoutMs}ms）`));
      }
    }, this.turnTimeoutMs);

    try {
      await this.client.prompt(sessionId, text, images);
    } catch (err) {
      clearTimeout(timer);
      turn.done = true;
      state.turn = null;
      this.#recordTurn({
        peerId,
        sessionId,
        usage: turn.usage,
        ok: false,
        error: err.message,
        durationMs: Date.now() - startedAt,
      });
      throw err;
    }

    let waitError = null;
    try {
      await finished;
    } catch (err) {
      waitError = err;
    } finally {
      clearTimeout(timer);
    }

    // 有错误且完全没有产出文本时，抛给调用方，让用户看到失败原因
    const textOut = turn.texts.join('').trim();
    const error = waitError?.message ?? (turn.error && !textOut ? turn.error : null);

    this.#recordTurn({
      peerId,
      sessionId,
      usage: turn.usage,
      ok: !error,
      error,
      durationMs: Date.now() - startedAt,
    });

    if (waitError) throw waitError;
    if (error) throw new Error(error);

    // 多个 assistant/message（工具调用循环）时，取全部文本拼接
    return textOut;
  }

  /** 回调给上层做用量统计；回调本身出错不能影响对话主流程。 */
  #recordTurn(info) {
    if (!this.onTurn) return;
    try {
      this.onTurn(info);
    } catch (err) {
      this.log(`记录回合用量失败: ${err.message}`);
    }
  }

  #onEvent({ sessionId, event }) {
    const state = this.sessions.get(sessionId);
    if (!state?.turn) return;

    const text = extractAssistantText(event);
    if (text) state.turn.texts.push(text);

    // TokenUsage 可能出现在 assistant/message（每次模型调用）与
    // compaction/summary（上下文压缩）上，都是真实计费，全部累加。
    if (event?.type === 'assistant/message' || event?.type === 'compaction/summary') {
      this.#addUsage(state.turn.usage, event.data?.usage);
    }

    // 回合失败必须记录下来。否则用户只会看到"没有回复"，
    // 没有任何可诊断的信息 —— 这是一个真实的坑，别删。
    if (event?.type === 'turn/end') {
      const reason = event.data?.reason;
      if (reason && reason.kind !== 'completed') {
        const msg =
          reason.error?.message ??
          reason.failure?.message ??
          JSON.stringify(reason).slice(0, 300);
        state.turn.error = msg;
      }
    }

    // 模型流里的失败信号（如输出被截断、适配器报错）
    if (event?.type === 'assistant/attempt') {
      for (const c of event.data?.stream ?? []) {
        const r = c?.chunk?.reason;
        if (r && r.kind === 'error') {
          const msg = r.failure?.message ?? r.error?.message ?? JSON.stringify(r).slice(0, 300);
          if (!state.turn.error) state.turn.error = msg;
        }
      }
    }
  }

  /** 把一次模型调用的 TokenUsage 累加进回合统计（字段缺失按 0）。 */
  #addUsage(target, usage) {
    if (!usage || typeof usage !== 'object') return;
    for (const key of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens', 'totalTokens']) {
      const n = Number(usage[key]);
      if (Number.isFinite(n) && n > 0) target[key] = (target[key] ?? 0) + n;
    }
  }

  #onStatus({ sessionId, status }) {
    const state = this.sessions.get(sessionId);
    if (!state) return;

    if (status === 'running') {
      if (state.turn) state.turn.sawRunning = true;
      return;
    }

    // status === 'idle'
    const turn = state.turn;
    if (!turn || turn.done) return;

    // 必须见过 running 才能认定"这一回合结束了"。
    // 否则可能是 prompt 入队前就收到的 idle（例如冷启动时）。
    if (!turn.sawRunning) return;

    turn.done = true;
    state.turn = null;
    turn.resolve();
  }
}

/** @typedef {{sessionId: string, queue: Promise<any>, turn: any, sawRunning: boolean, idleWaiters: any[]}} SessionState */
