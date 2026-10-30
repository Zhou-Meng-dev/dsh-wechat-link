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
   * @param {(msg: string) => void} [opts.log]
   */
  constructor(opts = {}) {
    this.windowMs = Number.isFinite(opts.windowMs) ? Math.max(0, opts.windowMs) : DEFAULT_MERGE_WINDOW_MS;
    this.maxWaitMs = Number.isFinite(opts.maxWaitMs)
      ? Math.max(this.windowMs, opts.maxWaitMs)
      : Math.max(this.windowMs, DEFAULT_MAX_WAIT_MS);
    this.handle = opts.handle;
    this.log = opts.log ?? (() => {});
    this.stopped = false;
    /** @type {Map<string, {pending: object[], timer: NodeJS.Timeout|null, running: boolean}>} */
    this.states = new Map();
  }

  /**
   * 追加一条消息。同步入队，保证同一用户的消息顺序与到达顺序一致。
   *
   * @param {string} peerId
   * @param {object} item - { text, images?, files?, contextToken?, kind?, mergeable? }
   */
  push(peerId, item) {
    if (this.stopped) return;
    if (!peerId) return;
    const st = this.#state(peerId);
    // 记录到达时间：窗口按最后一条算，maxWait 按第一条算。
    st.pending.push({ ...item, receivedAt: Date.now() });
    this.#arm(peerId, st);
  }

  /** 诊断用：有多少用户的队列在忙 / 还有多少条待处理。 */
  stats() {
    let pending = 0;
    let running = 0;
    for (const st of this.states.values()) {
      pending += st.pending.length;
      if (st.running) running++;
    }
    return { peers: this.states.size, pending, running };
  }

  /** 停止接收并清掉所有待处理定时器（已经在跑的回合并不会被打断）。 */
  stop() {
    this.stopped = true;
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
      st = { pending: [], timer: null, running: false };
      this.states.set(peerId, st);
    }
    return st;
  }

  /** 重新计算等待时间（每次新消息都重置防抖；已在跑则等它结束再排）。 */
  #arm(peerId, st) {
    if (this.stopped || st.running || st.pending.length === 0) return;
    if (st.timer) {
      clearTimeout(st.timer);
      st.timer = null;
    }

    const now = Date.now();
    const firstAt = st.pending[0].receivedAt;
    const lastAt = st.pending[st.pending.length - 1].receivedAt;
    const quietAt = lastAt + this.windowMs;
    const capAt = firstAt + this.maxWaitMs;
    const delay = Math.max(0, Math.min(quietAt, capAt) - now);

    st.timer = setTimeout(() => {
      st.timer = null;
      this.#flush(peerId).catch((err) => this.log(`处理 ${peerId} 的消息失败: ${err?.message ?? err}`));
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
    try {
      await this.handle(peerId, mergeQueueItems(items), items);
    } catch (err) {
      // 处理失败不能拖垮队列，否则这个用户后续消息全卡住
      this.log(`处理 ${peerId} 的消息失败: ${err?.message ?? err}`);
    } finally {
      st.running = false;
      if (st.pending.length > 0) this.#arm(peerId, st);
      // 空闲用户不留状态，避免长时间运行后 Map 里堆满历史 peer
      else if (!st.timer) this.states.delete(peerId);
    }
  }
}
