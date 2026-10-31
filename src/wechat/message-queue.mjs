/**
 * 同用户消息队列：串行执行 + 短窗口合并。
 *
 * 设计约束：
 *   - 每个用户一条 FIFO 队列，消息不丢；
 *   - 同一用户同时最多跑一个回合（dsh 会把新消息插进正在跑的回合，
 *     上下文会串，回复也可能错位）；
 *   - 用户连续发多条时，在一个短窗口（默认 500ms）内合并成一次提问，
 *     窗口内所有文本 / 图片 / 文件按到达顺序拼接；
 *   - 带 `mergeable: false` 的条目（内置命令）单独成批，避免和普通消息混在一起。
 *
 * 窗口策略：以「最后一条消息到达后静默 windowMs」为准（防抖），
 * 同时用 maxWaitMs 兜底，避免用户长时间连续输入把消息无限期压住。
 */

/** 合并窗口：最后一条消息之后静默多久再开始处理 */
export const DEFAULT_MERGE_WINDOW_MS = 500;
/** 合并等待上限：从第一条消息算起最多压多久 */
export const DEFAULT_MAX_WAIT_MS = 3_000;

/**
 * 把同一批条目合并成一次提问。
 *
 * @param {object[]} items - 按到达顺序排列，每项至少含 text / images / files / contextToken
 * @returns {{text: string, images: object[], files: object[], contextToken: string|undefined,
 *            kind: string, command: string|null, messageCount: number}}
 */
export function mergeQueueItems(items) {
  const texts = [];
  const images = [];
  const files = [];
  let contextToken;
  let kind = 'text';
  /** 命令条目总是单独成批，直接带过去 */
  let command = null;

  for (const item of items) {
    if (item.text) texts.push(item.text);
    if (Array.isArray(item.images) && item.images.length) images.push(...item.images);
    if (Array.isArray(item.files) && item.files.length) files.push(...item.files);
    if (item.contextToken) contextToken = item.contextToken;
    if (kind === 'text' && item.kind) kind = item.kind;
    if (item.command) command = item.command;
  }

  return {
    text: texts.join('\n\n'),
    images,
    files,
    contextToken,
    kind,
    command,
    messageCount: items.length,
  };
}

export class UserMessageQueue {
  /**
   * @param {object} opts
   * @param {number} [opts.windowMs] - 合并窗口
   * @param {number} [opts.maxWaitMs] - 最长等待（防止连续输入饿死）
   * @param {(peerId: string, batch: object, items: object[]) => Promise<void> | void} opts.handle
   * @param {number} [opts.maxPerPeer] - 每用户待处理条数上限（不传 = 不限）
   * @param {(msg: string) => void} [opts.log]
   */
  constructor(opts = {}) {
    this.windowMs = Number.isFinite(opts.windowMs) ? Math.max(0, opts.windowMs) : DEFAULT_MERGE_WINDOW_MS;
    this.maxWaitMs = Number.isFinite(opts.maxWaitMs)
      ? Math.max(this.windowMs, opts.maxWaitMs)
      : Math.max(this.windowMs, DEFAULT_MAX_WAIT_MS);
    this.handle = opts.handle;
    this.maxPerPeer = Number.isFinite(opts.maxPerPeer) && opts.maxPerPeer > 0
      ? Math.floor(opts.maxPerPeer)
      : Infinity;
    this.log = opts.log ?? (() => {});
    this.stopped = false;
    /** false 表示已停止接收（drain 期间 / 关闭中），但已有消息继续处理 */
    this.accepting = true;
    /** 在途的 #flush promise，drain/waitIdle 用它判断是否真的空闲 */
    this.inflight = new Set();
    /** 最近一次 drain 超时放弃的条数（诊断） */
    this.abandonedCount = 0;
    /** 因每用户上限被拒绝的累计条数（诊断） */
    this.rejectedCount = 0;
    /** @type {Map<string, {pending: object[], timer: NodeJS.Timeout|null, running: boolean, currentItems: object[]|null}>} */
    this.states = new Map();
  }

  /**
   * 追加一条消息。同步入队，保证同一用户的消息顺序与到达顺序一致。
   *
   * @param {string} peerId
   * @param {object} item - { text, images?, files?, contextToken?, kind?, mergeable? }
   * @returns {{accepted: boolean, reason?: 'stopped'|'draining'|'invalid'}}
   *          关闭/排空期间拒绝入队（不抛错），调用方据此提示或保留 pending
   */
  push(peerId, item) {
    if (this.stopped) return { accepted: false, reason: 'stopped' };
    if (!this.accepting) return { accepted: false, reason: 'draining' };
    if (!peerId || !item) return { accepted: false, reason: 'invalid' };
    const st = this.#state(peerId);
    // 每用户上限：拒绝最新一条（不是丢最旧），用户能立刻感知并重发
    if (st.pending.length >= this.maxPerPeer) {
      this.rejectedCount += 1;
      return { accepted: false, reason: 'full' };
    }
    // 记录到达时间：窗口按最后一条算，maxWait 按第一条算。
    st.pending.push({ ...item, receivedAt: Date.now() });
    this.#arm(peerId, st);
    return { accepted: true };
  }

  /** 停止接收新消息，但保留 pending 与在途回合（供 drain 使用）。 */
  stopAccepting() {
    this.accepting = false;
  }

  /** 诊断用：有多少用户的队列在忙 / 还有多少条待处理。 */
  stats() {
    let pending = 0;
    let running = 0;
    for (const st of this.states.values()) {
      pending += st.pending.length;
      if (st.running) running++;
    }
    return {
      peers: this.states.size,
      pending,
      running,
      accepting: this.accepting,
      abandoned: this.abandonedCount,
      rejected: this.rejectedCount,
      maxPerPeer: Number.isFinite(this.maxPerPeer) ? this.maxPerPeer : null,
    };
  }

  /**
   * 排空：不再接受新消息 → 立刻结算合并窗口 → 等所有在途回合结束。
   *
   * @param {object} [opts]
   * @param {number} [opts.timeoutMs]
   * @returns {Promise<{idle: boolean, abandoned: string[]}>} 超时时返回未 commit 的 journalId
   */
  async drain({ timeoutMs = 20_000 } = {}) {
    this.accepting = false;
    const deadline = Date.now() + Math.max(0, Number(timeoutMs) || 0);

    for (const [peerId, st] of this.states) {
      // 合并窗口不再等待：关闭时立刻处理已到达的消息
      if (st.timer) { clearTimeout(st.timer); st.timer = null; }
      if (!st.running && st.pending.length > 0) this.#scheduleFlush(peerId);
    }

    return this.waitIdle({ timeoutMs: Math.max(0, deadline - Date.now()) });
  }

  /**
   * 等到没有 pending、也没有在途回合。
   * @param {{timeoutMs?: number}} [opts]
   * @returns {Promise<{idle: boolean, abandoned: string[]}>}
   */
  async waitIdle({ timeoutMs = 20_000 } = {}) {
    const deadline = Date.now() + Math.max(0, Number(timeoutMs) || 0);

    for (;;) {
      // 兜底：有 pending 却没在跑、也没定时器（例如 drain 过程中新结算出来的批）
      for (const [peerId, st] of this.states) {
        if (!st.running && st.pending.length > 0 && !st.timer) this.#scheduleFlush(peerId);
      }

      const busy = this.inflight.size > 0
        || [...this.states.values()].some((st) => st.running || st.pending.length > 0);
      if (!busy) {
        this.abandonedCount = 0;
        return { idle: true, abandoned: [] };
      }

      if (Date.now() >= deadline) {
        const abandoned = this.#abandonedIds();
        this.abandonedCount = abandoned.length;
        return { idle: false, abandoned };
      }

      await new Promise((r) => setTimeout(r, 10));
    }
  }

  /** 停止接收并清掉所有待处理定时器（已经在跑的回合并不会被打断）。 */
  stop() {
    this.stopped = true;
    this.accepting = false;
    for (const st of this.states.values()) {
      if (st.timer) clearTimeout(st.timer);
      st.timer = null;
    }
    this.states.clear();
  }

  // ---------------------------------------------------------------- internals

  #state(peerId) {
    let st = this.states.get(peerId);
    if (!st) {
      st = { pending: [], timer: null, running: false, currentItems: null };
      this.states.set(peerId, st);
    }
    return st;
  }

  /** 把一次 #flush 记进 inflight，drain/waitIdle 才能等它。 */
  #scheduleFlush(peerId) {
    const p = this.#flush(peerId)
      .catch((err) => this.log(`处理 ${peerId} 的消息失败: ${err?.message ?? err}`))
      .finally(() => this.inflight.delete(p));
    this.inflight.add(p);
    return p;
  }

  /** 重新计算等待时间（每次新消息都重置防抖；已在跑则等它结束再排）。 */
  #arm(peerId, st) {
    if (this.stopped || st.running || st.pending.length === 0) return;
    if (st.timer) {
      clearTimeout(st.timer);
      st.timer = null;
    }

    // 已停止接收（drain 中）：不再等合并窗口，立刻处理
    if (!this.accepting) {
      this.#scheduleFlush(peerId);
      return;
    }

    const now = Date.now();
    const firstAt = st.pending[0].receivedAt;
    const lastAt = st.pending[st.pending.length - 1].receivedAt;
    const quietAt = lastAt + this.windowMs;
    const capAt = firstAt + this.maxWaitMs;
    const delay = Math.max(0, Math.min(quietAt, capAt) - now);

    st.timer = setTimeout(() => {
      st.timer = null;
      this.#scheduleFlush(peerId);
    }, delay);
  }

  async #flush(peerId) {
    const st = this.states.get(peerId);
    if (!st || st.running || st.pending.length === 0) return;

    // 批边界：命令类条目必须单独成批，不能和普通消息拼在一起。
    const head = st.pending[0];
    let count = 1;
    if (head.mergeable !== false) {
      while (count < st.pending.length && st.pending[count].mergeable !== false) count++;
    }
    const items = st.pending.splice(0, count);

    st.running = true;
    st.currentItems = items;
    try {
      await this.handle(peerId, mergeQueueItems(items), items);
    } catch (err) {
      // 处理失败不能拖垮队列，否则这个用户后续消息全卡住
      this.log(`处理 ${peerId} 的消息失败: ${err?.message ?? err}`);
    } finally {
      st.running = false;
      st.currentItems = null;
      if (st.pending.length > 0) this.#arm(peerId, st);
      // 空闲用户不留状态，避免长时间运行后 Map 里堆满历史 peer。
      // 注意：此刻当前 flush 仍在 this.inflight 里（外层 #scheduleFlush 才移除），
      // 不能拿 inflight.size 当条件，否则 states 永远不会被清理。
      else if (!st.timer) this.states.delete(peerId);
    }
  }

  /**
   * 尚未 commit 的 journalId（pending + 正在处理的批）。
   * 供关闭流程在强制退出前记录「放弃了哪些消息」。
   * @returns {string[]}
   */
  abandonedIds() {
    return this.#abandonedIds();
  }

  /** 尚未 commit 的 journalId：pending + 正在处理的批。 */
  #abandonedIds() {
    const ids = [];
    for (const st of this.states.values()) {
      for (const item of st.pending) {
        if (item.journalId) ids.push(item.journalId);
      }
      for (const item of st.currentItems ?? []) {
        if (item.journalId) ids.push(item.journalId);
      }
    }
    return ids;
  }
}
