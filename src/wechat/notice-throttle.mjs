/**
 * 提示节流：同一个 peer + 同一个 key 在一个窗口内只发一次。
 *
 * 用途：DLQ 告警、队列满/限流提示、预算拦截提示。
 * 这些提示本身要走正常发送通道（token 失效自然进 outbox），
 * 但绝不能因为用户刷屏就每条消息回一条提示 —— 那会把问题放大。
 *
 * Map 上限 2000，按插入顺序淘汰最旧 key，避免长时间运行后无限增长。
 */

export const DEFAULT_NOTICE_WINDOW_MS = 5 * 60 * 1000;
export const DEFAULT_MAX_NOTICE_KEYS = 2000;

export class NoticeThrottle {
  /**
   * @param {object} [opts]
   * @param {number} [opts.windowMs] - 窗口长度
   * @param {number} [opts.maxEntries]
   * @param {() => number} [opts.now]
   */
  constructor({
    windowMs = DEFAULT_NOTICE_WINDOW_MS,
    maxEntries = DEFAULT_MAX_NOTICE_KEYS,
    now = () => Date.now(),
  } = {}) {
    this.windowMs = Number.isFinite(windowMs) && windowMs >= 0 ? windowMs : DEFAULT_NOTICE_WINDOW_MS;
    this.maxEntries = Number.isFinite(maxEntries) && maxEntries > 0 ? maxEntries : DEFAULT_MAX_NOTICE_KEYS;
    this.now = now;
    /** @type {Map<string, number>} key → 上次发送时间 */
    this.lastSentAt = new Map();
  }

  /**
   * 现在可以发吗？可以则记录本次发送时间。
   * @param {string} peerId
   * @param {string} key - 提示类别，如 'dlq' / 'rate' / 'budget'
   * @param {{windowMs?: number}} [opts] - 覆盖本次窗口（如任务预算提示要「每天一次」）
   * @returns {boolean}
   */
  canSend(peerId, key, { windowMs = this.windowMs } = {}) {
    const id = `${peerId ?? ''}|${key ?? ''}`;
    const now = this.now();
    const window = Number.isFinite(windowMs) && windowMs >= 0 ? windowMs : this.windowMs;
    const last = this.lastSentAt.get(id);
    if (last !== undefined && now - last < window) return false;

    this.lastSentAt.delete(id);
    this.lastSentAt.set(id, now);
    while (this.lastSentAt.size > this.maxEntries) {
      const oldest = this.lastSentAt.keys().next().value;
      this.lastSentAt.delete(oldest);
    }
    return true;
  }

  /** 仅供测试/诊断：清掉某个 key 或全部。 */
  reset(peerId, key) {
    if (peerId === undefined) {
      this.lastSentAt.clear();
      return;
    }
    this.lastSentAt.delete(`${peerId}|${key ?? ''}`);
  }

  stats() {
    return { keys: this.lastSentAt.size, windowMs: this.windowMs };
  }
}
