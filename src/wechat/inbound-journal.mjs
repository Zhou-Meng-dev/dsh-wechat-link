/**
 * 入站日志：游标 + 待处理消息 + 已处理 id 环。
 *
 * 这是入站的持久化边界：`sync.json` 是「哪些消息已经收下、哪些已经处理完」
 * 的唯一真相。时序固定为：
 *
 *   getUpdates → admit()（先把游标与消息一起落盘）→ 入队 → 回合结束 → commitMany()
 *
 * 崩溃点分析：
 *   - admit 写盘前崩溃：游标没动，服务端会重投
 *   - admit 后、处理完前崩溃：pending 里有它，重启后重新入队
 *   - 回复已发出、commit 前崩溃：回合再跑一次（接受「至少一次」，不承诺 exactly-once）
 *
 * 数据形状（0600）：
 * {
 *   "version": 1,
 *   "cursor": "…get_updates_buf…",
 *   "updatedAt": "2026-10-31T03:00:00.000Z",
 *   "pending": [{ "id": "m:abc", "receivedAt": 1761000000000, "weak": false, "msg": {…} }],
 *   "processed": ["m:abc", "m:def"]
 * }
 *
 * 写盘前剥掉 msg.context_token：它等价于一次会话凭据，bridge-state.json 已有最新值，
 * 没必要在第二个文件里再存一份。
 */

import { createHash } from 'node:crypto';
import { readFile, rename } from 'node:fs/promises';

import { atomicWriteJson } from '../ops/atomic-file.mjs';

export const JOURNAL_VERSION = 1;
export const DEFAULT_MAX_PENDING = 200;
export const DEFAULT_MAX_PROCESSED = 200;

/**
 * 强 id 字段：服务端消息 id。
 *
 * 已对照腾讯官方仓库 `Tencent/openclaw-weixin` 的 `src/api/types.ts` 确认：
 * `WeixinMessage.message_id`（uint64，JSON 里按字符串无损传递）是唯一的顶层消息 id；
 * 顶层没有 `msg_id` / `msgid` / `server_id`（`MessageItem.msg_id` 是条目级引用，不是消息 id）。
 */
const STRONG_ID_FIELDS = ['message_id'];

function isNonEmptyId(v) {
  if (typeof v === 'string') return v.trim() !== '';
  return typeof v === 'number' && Number.isFinite(v);
}

/**
 * 计算一条入站消息的去重键。
 *
 * 强度：
 *   - strong：服务端消息 id
 *   - weak：   from_user_id + create_time_ms + item_list 哈希（同秒同内容才会碰撞）
 *   - none：   拿不到任何可用键，调用方必须生成一次性 id 并告警
 *
 * 刻意不对无 create_time_ms 的消息硬凑哈希：图片/文件消息的文本占位固定
 * （`[图片]`），两条连发会被误判为重复而丢消息，违反 I1。
 *
 * @param {object} msg
 * @returns {{id: string|null, strength: 'strong'|'weak'|'none'}}
 */
export function inboundMessageKey(msg) {
  if (!msg || typeof msg !== 'object') return { id: null, strength: 'none' };

  for (const field of STRONG_ID_FIELDS) {
    const v = msg[field];
    if (isNonEmptyId(v)) return { id: `m:${String(v).trim()}`, strength: 'strong' };
  }

  const from = typeof msg.from_user_id === 'string' ? msg.from_user_id.trim() : '';
  const createdAt = Number(msg.create_time_ms);
  if (from && Number.isFinite(createdAt) && createdAt > 0) {
    const content = createHash('sha256')
      .update(JSON.stringify(msg.item_list ?? []))
      .digest('hex');
    const id = createHash('sha256')
      .update(`${from}|${createdAt}|${content}`)
      .digest('hex')
      .slice(0, 16);
    return { id: `w:${id}`, strength: 'weak' };
  }

  return { id: null, strength: 'none' };
}

/**
 * 诊断用：返回入站消息的顶层字段名（**不含任何值/内容**）。
 *
 * 服务端消息 id 的字段名已对照腾讯官方 `Tencent/openclaw-weixin` 的
 * `src/api/types.ts` 确认是 `message_id`；`BRIDGE_DEBUG_INBOUND_IDS=1`
 * 保留一次性字段名打印，用于线上回归核对。
 *
 * @param {object} msg
 * @returns {string[]} 排序后的顶层字段名
 */
export function inboundFieldNames(msg) {
  return isObject(msg) ? Object.keys(msg).sort() : [];
}

/** 写盘前剥掉顶层 context_token（不复制会话凭据）。 */
export function stripContextToken(msg) {
  if (!msg || typeof msg !== 'object') return msg;
  if (!('context_token' in msg)) return msg;
  const { context_token: _drop, ...rest } = msg;
  return rest;
}

function isObject(x) {
  return Boolean(x) && typeof x === 'object' && !Array.isArray(x);
}

/** 把磁盘内容规整成可信状态；结构不对的条目直接丢弃（不阻塞启动）。 */
function parseJournal(raw, maxProcessed) {
  const data = { version: JOURNAL_VERSION, cursor: '', pending: [], processed: [] };
  if (!isObject(raw)) return data;

  if (typeof raw.cursor === 'string') data.cursor = raw.cursor;

  const processed = [];
  const seen = new Set();
  for (const id of Array.isArray(raw.processed) ? raw.processed : []) {
    if (typeof id !== 'string' || !id || seen.has(id)) continue;
    seen.add(id);
    processed.push(id);
  }
  // 保留最近 maxProcessed 条（数组尾部最新）
  data.processed = processed.slice(-maxProcessed);

  const processedSet = new Set(data.processed);
  const pendingIds = new Set();
  for (const entry of Array.isArray(raw.pending) ? raw.pending : []) {
    if (!isObject(entry)) continue;
    const id = typeof entry.id === 'string' ? entry.id : '';
    if (!id || processedSet.has(id) || pendingIds.has(id)) continue;
    if (!isObject(entry.msg)) continue;
    pendingIds.add(id);
    data.pending.push({
      id,
      receivedAt: Number.isFinite(entry.receivedAt) ? entry.receivedAt : 0,
      weak: entry.weak === true,
      msg: entry.msg,
    });
  }
  return data;
}

export class InboundJournal {
  /**
   * @param {string} path - sync.json 的绝对路径
   * @param {object} [opts]
   * @param {number} [opts.maxPending]
   * @param {number} [opts.maxProcessed]
   * @param {() => number} [opts.now] - 注入时钟（测试用）
   * @param {(path: string, value: unknown) => Promise<void>} [opts.writeJson]
   *        注入写盘实现（测试「写盘失败时游标不前进」）
   */
  constructor(path, {
    maxPending = DEFAULT_MAX_PENDING,
    maxProcessed = DEFAULT_MAX_PROCESSED,
    now = () => Date.now(),
    writeJson = atomicWriteJson,
  } = {}) {
    this.path = path;
    this.maxPending = Number.isFinite(maxPending) && maxPending > 0 ? maxPending : DEFAULT_MAX_PENDING;
    this.maxProcessed = Number.isFinite(maxProcessed) && maxProcessed > 0 ? maxProcessed : DEFAULT_MAX_PROCESSED;
    this.now = now;
    this.writeJson = writeJson;
    this.data = { version: JOURNAL_VERSION, cursor: '', pending: [], processed: [] };
    /** 累计去重次数（诊断用） */
    this.duplicates = 0;
    /** 串行化所有读写，避免 admit 与 commit 交错写盘 */
    this.chain = Promise.resolve();
  }

  /**
   * 从磁盘加载。文件缺失返回空状态；损坏时改名留证（不阻塞启动）。
   *
   * @returns {Promise<{pending: object[], recovered: boolean, warning?: string}>}
   */
  async load() {
    let raw;
    try {
      raw = JSON.parse(await readFile(this.path, 'utf8'));
    } catch (err) {
      if (err?.code === 'ENOENT') {
        return { pending: [], recovered: false };
      }
      const backup = `${this.path}.corrupt-${Date.now()}`;
      await rename(this.path, backup).catch(() => {});
      this.data = { version: JOURNAL_VERSION, cursor: '', pending: [], processed: [] };
      return {
        pending: [],
        recovered: false,
        warning: `sync.json 损坏（${err.message}），已改名为 ${backup}，本次从空游标开始`,
      };
    }

    this.data = parseJournal(raw, this.maxProcessed);
    return {
      pending: this.pending(),
      recovered: this.data.pending.length > 0,
    };
  }

  /** 当前游标；'' 表示从头开始。 */
  get cursor() {
    return this.data.cursor;
  }

  /** 待处理快照（副本）。 */
  pending() {
    return this.data.pending.map((e) => ({ ...e }));
  }

  /** pending 是否已达软上限。达到后调用方应反压轮询，而不是丢消息。 */
  isFull() {
    return this.data.pending.length >= this.maxPending;
  }

  /**
   * 收下一批消息并推进游标。**先落盘，成功后才更新内存游标**。
   *
   * - 重复 id（processed ∪ pending）只计入 duplicates，不重复入队
   * - 整批都是重复时仍然落盘并推进游标（否则同一批会被无限重拉）
   * - 写盘失败直接抛出，内存游标保持旧值
   *
   * @param {string|undefined} cursor - 服务端的 get_updates_buf
   * @param {{id: string, msg: object, weak?: boolean, receivedAt?: number}[]} entries
   * @returns {Promise<{accepted: object[], duplicates: string[]}>}
   *          `accepted[].msg` 是**原始消息**（保留 context_token，供流水线刷新会话凭据）；
   *          落盘的 pending 副本才剥掉 context_token。
   */
  admit(cursor, entries) {
    return this.#enqueue(async () => {
      const accepted = [];
      const duplicates = [];
      const pending = [...this.data.pending];
      const taken = new Set(pending.map((e) => e.id));
      const processed = new Set(this.data.processed);

      for (const entry of Array.isArray(entries) ? entries : []) {
        const id = typeof entry?.id === 'string' ? entry.id : '';
        if (!id || !isObject(entry.msg)) continue;
        if (processed.has(id) || taken.has(id)) {
          duplicates.push(id);
          continue;
        }
        const receivedAt = Number.isFinite(entry.receivedAt) ? entry.receivedAt : this.now();
        // 交给调用方（流水线）的条目保留原始消息：本轮的 context_token 是回复凭据，
        // 流水线要靠它刷新会话 token。只有持久化副本才剥掉（D7）。
        const item = { id, receivedAt, weak: entry.weak === true, msg: entry.msg };
        const stored = { ...item, msg: stripContextToken(entry.msg) };
        pending.push(stored);
        taken.add(id);
        accepted.push(item);
      }

      const nextCursor = typeof cursor === 'string' && cursor ? cursor : this.data.cursor;
      this.duplicates += duplicates.length;
      if (accepted.length === 0 && nextCursor === this.data.cursor) {
        return { accepted, duplicates };
      }

      const next = {
        version: JOURNAL_VERSION,
        cursor: nextCursor,
        updatedAt: new Date(this.now()).toISOString(),
        pending,
        processed: this.data.processed,
      };
      // 写盘成功之前绝不改内存状态：写失败 = 游标不前进
      await this.writeJson(this.path, next, { mode: 0o600 });
      this.data = next;
      return { accepted, duplicates };
    });
  }

  /**
   * 标记一批消息处理完毕：pending -= ids，processed += ids（环形，保留最近 N 条）。
   * 未知 id 静默忽略（例如恢复后重复 commit）。
   *
   * @param {string[]} ids
   */
  commitMany(ids) {
    const list = (Array.isArray(ids) ? ids : []).filter((id) => typeof id === 'string' && id);
    if (list.length === 0) return Promise.resolve(false);

    return this.#enqueue(async () => {
      const committed = new Set();
      const pending = this.data.pending.filter((e) => {
        if (!list.includes(e.id)) return true;
        committed.add(e.id);
        return false;
      });
      if (committed.size === 0) return false;

      const known = new Set(this.data.processed);
      const processed = [
        ...this.data.processed,
        ...[...committed].filter((id) => !known.has(id)),
      ].slice(-this.maxProcessed);

      const next = {
        version: JOURNAL_VERSION,
        cursor: this.data.cursor,
        updatedAt: new Date(this.now()).toISOString(),
        pending,
        processed,
      };
      await this.writeJson(this.path, next, { mode: 0o600 });
      this.data = next;
      return true;
    });
  }

  /** 等待所有在途写盘完成。所有变更都是即写，所以这里只清空链。 */
  async flush() {
    await this.chain.catch(() => {});
    return false;
  }

  /** 诊断字段。 */
  stats() {
    return {
      pending: this.data.pending.length,
      processed: this.data.processed.length,
      cursor: Boolean(this.data.cursor),
      duplicates: this.duplicates,
    };
  }

  #enqueue(fn) {
    const p = this.chain.then(fn);
    // 链上只保留「已结束」，一次失败不能毒化后续写
    this.chain = p.then(() => {}, () => {});
    return p;
  }
}
