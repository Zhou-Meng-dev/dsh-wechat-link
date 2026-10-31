/**
 * 输入上限：消息长度截断、每用户速率（令牌桶）、每用户每日回合数。
 *
 * 设计约束：
 *   - 全部可注入时钟/写盘，测试不 sleep 真实分钟、不依赖当天日期
 *   - 纯逻辑与持久化分开：truncateForModel 是纯函数
 *   - 上限为 0 表示不限（每日回合数默认 0，避免老用户突然被拦）
 *   - limits.json 只保留当天；跨天整体重置
 *
 * limits.json 形状（0600）：
 * { "version": 1, "day": "2026-10-31", "peers": { "<id>": { "turns": 3, "lastAt": 1761000000000 } } }
 */

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';

import { atomicWriteJson } from '../ops/atomic-file.mjs';
import { dayKey } from '../ops/usage.mjs';
import { TENANT_LIMITS_DEFAULTS } from '../config.mjs';

export const LIMITS_VERSION = 1;
export const DEFAULT_MAX_PEERS = 2000;
export const DEFAULT_RATE_PER_MINUTE = TENANT_LIMITS_DEFAULTS.perUserRatePerMinute;
export const DEFAULT_MAX_MESSAGE_CHARS = TENANT_LIMITS_DEFAULTS.maxMessageChars;

/**
 * 把过长的消息截断，并在末尾标注原长。纯函数。
 *
 * 注记不计入 maxChars 配额：前 maxChars 个字是原文，注记附在后面。
 *
 * @param {string} text
 * @param {number} maxChars - <=0 / 非数字表示不限
 * @returns {{text: string, truncated: boolean, originalLength: number}}
 */
export function truncateForModel(text, maxChars) {
  const src = typeof text === 'string' ? text : '';
  const max = Number.isFinite(maxChars) && maxChars > 0 ? Math.floor(maxChars) : 0;
  if (max === 0 || src.length <= max) {
    return { text: src, truncated: false, originalLength: src.length };
  }
  return {
    text: `${src.slice(0, max)}\n\n（消息过长，已截断，原长 ${src.length} 字）`,
    truncated: true,
    originalLength: src.length,
  };
}

/**
 * 令牌桶：容量 = 每分钟速率，按时间连续补充。
 * 空闲 key 通过 Map 上限淘汰最旧，避免长时间运行无限增长。
 */
export class RateLimiter {
  /**
   * @param {object} [opts]
   * @param {number} [opts.perMinute=20]
   * @param {() => number} [opts.now]
   * @param {number} [opts.maxKeys=2000]
   */
  constructor({ perMinute = DEFAULT_RATE_PER_MINUTE, now = () => Date.now(), maxKeys = DEFAULT_MAX_PEERS } = {}) {
    this.capacity = Number.isFinite(perMinute) && perMinute >= 1 ? Math.floor(perMinute) : DEFAULT_RATE_PER_MINUTE;
    this.ratePerMs = this.capacity / 60_000;
    this.now = now;
    this.maxKeys = Number.isFinite(maxKeys) && maxKeys > 0 ? maxKeys : DEFAULT_MAX_PEERS;
    /** @type {Map<string, {tokens: number, at: number}>} */
    this.buckets = new Map();
  }

  /**
   * 消费一个令牌。
   * @param {string} key - 通常是 peerId
   * @returns {{ok: boolean, retryAfterMs?: number, remaining?: number}}
   */
  take(key) {
    const id = String(key ?? '');
    const now = this.now();
    let bucket = this.buckets.get(id);
    if (!bucket) {
      bucket = { tokens: this.capacity, at: now };
      this.buckets.set(id, bucket);
      this.#prune();
    } else {
      const elapsed = Math.max(0, now - bucket.at);
      bucket.tokens = Math.min(this.capacity, bucket.tokens + elapsed * this.ratePerMs);
      bucket.at = now;
    }

    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return { ok: true, remaining: Math.floor(bucket.tokens) };
    }
    return {
      ok: false,
      retryAfterMs: Math.max(1, Math.ceil((1 - bucket.tokens) / this.ratePerMs)),
    };
  }

  stats() {
    return { keys: this.buckets.size, perMinute: this.capacity };
  }

  #prune() {
    while (this.buckets.size > this.maxKeys) {
      const oldest = this.buckets.keys().next().value;
      this.buckets.delete(oldest);
    }
  }
}

/**
 * 每用户每日回合计数（本地日）。跨天整体重置；上限 0 = 不限。
 */
export class TurnCounter {
  /**
   * @param {object} opts
   * @param {string} opts.path - limits.json
   * @param {number} [opts.limit=0]
   * @param {number} [opts.maxPeers=2000]
   * @param {() => Date} [opts.now]
   * @param {(path: string, value: unknown, opts?: object) => Promise<void>} [opts.writeJson]
   */
  constructor({
    path,
    limit = 0,
    maxPeers = DEFAULT_MAX_PEERS,
    now = () => new Date(),
    writeJson = atomicWriteJson,
  }) {
    this.path = path;
    this.limit = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 0;
    this.maxPeers = Number.isFinite(maxPeers) && maxPeers > 0 ? maxPeers : DEFAULT_MAX_PEERS;
    this.now = now;
    this.writeJson = writeJson;
    this.day = dayKey(now());
    /** @type {Map<string, {turns: number, lastAt: number}>} */
    this.peers = new Map();
    this.dirty = false;
  }

  /** 读取；损坏时从空开始（计数损坏不该阻塞服务）。 */
  async load() {
    this.day = dayKey(this.now());
    if (!existsSync(this.path)) return this;
    try {
      const raw = JSON.parse(await readFile(this.path, 'utf8'));
      if (raw?.day === this.day && raw.peers && typeof raw.peers === 'object') {
        for (const [peerId, v] of Object.entries(raw.peers)) {
          if (!peerId || !v || typeof v !== 'object') continue;
          this.peers.set(peerId, {
            turns: Math.max(0, Number(v.turns) || 0),
            lastAt: Math.max(0, Number(v.lastAt) || 0),
          });
        }
      }
      // day 不一致 = 跨天：保持空 peers，下一天的计数从 0 开始
    } catch {
      this.peers.clear();
    }
    return this;
  }

  /**
   * 今天还能不能跑一回合。
   * @param {string} peerId
   * @returns {{ok: boolean, used: number, limit: number}}
   */
  allow(peerId) {
    this.#rollover();
    if (this.limit === 0) return { ok: true, used: 0, limit: 0 };
    const used = this.peers.get(peerId)?.turns ?? 0;
    return { ok: used < this.limit, used, limit: this.limit };
  }

  /**
   * 记一回合。每次写完立即落盘：跨重启后计数仍然有效。
   * @param {string} peerId
   */
  async recordTurn(peerId) {
    this.#rollover();
    const cur = this.peers.get(peerId) ?? { turns: 0, lastAt: 0 };
    cur.turns += 1;
    cur.lastAt = this.now().getTime();
    this.peers.set(peerId, cur);
    this.#prune();
    await this.writeJson(this.path, this.#snapshot(), { mode: 0o600 });
    this.dirty = false;
    return cur.turns;
  }

  /** 兼容 stop() 的刷盘调用；recordTurn 已经即时写盘。 */
  async flush() {
    if (!this.dirty) return false;
    await this.writeJson(this.path, this.#snapshot(), { mode: 0o600 });
    this.dirty = false;
    return true;
  }

  stats() {
    this.#rollover();
    return { day: this.day, peers: this.peers.size, limit: this.limit };
  }

  #rollover() {
    const today = dayKey(this.now());
    if (today !== this.day) {
      this.day = today;
      this.peers.clear();
      this.dirty = true;
    }
  }

  #prune() {
    if (this.peers.size <= this.maxPeers) return;
    const entries = [...this.peers.entries()].sort((a, b) => a[1].lastAt - b[1].lastAt);
    for (const [peerId] of entries.slice(0, this.peers.size - this.maxPeers)) {
      this.peers.delete(peerId);
    }
  }

  #snapshot() {
    const peers = {};
    for (const [peerId, v] of this.peers) {
      if (peerId) peers[peerId] = { turns: v.turns, lastAt: v.lastAt };
    }
    return { version: LIMITS_VERSION, day: this.day, peers };
  }
}

/**
 * 租户级输入限制门面：InboundPipeline 只依赖这一个小接口，
 * 不直接碰令牌桶/持久化细节。
 */
export class TenantLimits {
  /**
   * @param {object} opts
   * @param {string} opts.path
   * @param {number} [opts.queueMaxPerPeer=20]
   * @param {number} [opts.ratePerMinute=20]
   * @param {number} [opts.turnsPerDay=0]
   * @param {number} [opts.maxMessageChars=8000]
   * @param {() => Date} [opts.now]
   * @param {(path: string, value: unknown, opts?: object) => Promise<void>} [opts.writeJson]
   * @param {number} [opts.maxPeers]
   */
  constructor({
    path,
    queueMaxPerPeer = TENANT_LIMITS_DEFAULTS.queueMaxPerPeer,
    ratePerMinute = DEFAULT_RATE_PER_MINUTE,
    turnsPerDay = TENANT_LIMITS_DEFAULTS.perUserTurnsPerDay,
    maxMessageChars = DEFAULT_MAX_MESSAGE_CHARS,
    now = () => new Date(),
    writeJson = atomicWriteJson,
    maxPeers = DEFAULT_MAX_PEERS,
  }) {
    this.queueMaxPerPeer = Number.isFinite(queueMaxPerPeer)
      ? Math.max(1, Math.floor(queueMaxPerPeer))
      : TENANT_LIMITS_DEFAULTS.queueMaxPerPeer;
    this.maxMessageChars = Number.isFinite(maxMessageChars) && maxMessageChars > 0
      ? Math.floor(maxMessageChars)
      : DEFAULT_MAX_MESSAGE_CHARS;
    this.rate = new RateLimiter({ perMinute: ratePerMinute, now: () => now().getTime(), maxKeys: maxPeers });
    this.turns = new TurnCounter({ path, limit: turnsPerDay, maxPeers, now, writeJson });
    this.turnsPerDay = this.turns.limit;
  }

  async load() {
    await this.turns.load();
    return this;
  }

  /** 每用户速率：{ok, retryAfterMs} */
  take(peerId) {
    return this.rate.take(peerId);
  }

  /** 每用户每日回合：{ok, used, limit} */
  allowDay(peerId) {
    return this.turns.allow(peerId);
  }

  recordTurn(peerId) {
    return this.turns.recordTurn(peerId);
  }

  truncate(text) {
    return truncateForModel(text, this.maxMessageChars);
  }

  flush() {
    return this.turns.flush();
  }

  stats() {
    return {
      queueMaxPerPeer: this.queueMaxPerPeer,
      ratePerMinute: this.rate.capacity,
      turnsPerDay: this.turnsPerDay,
      maxMessageChars: this.maxMessageChars,
      rate: this.rate.stats(),
      turns: this.turns.stats(),
    };
  }
}
