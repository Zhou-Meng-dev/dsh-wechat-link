/**
 * 待发队列：没送达的消息暂存下来，按用户严格 FIFO 补发。
 *
 * 为什么需要：
 *   iLink 的每条下行消息都依赖用户最近一次上行带来的 context_token。
 *   token 过期后 sendmessage 返回 ret=-1；更糟的是 5xx / 超时 / 网络错误
 *   以前只记一行日志就丢了。现在所有可恢复失败都落到 `outbox.json`。
 *
 * v2 条目形状：
 *   {
 *     seq,                 // 每个 peer 内严格递增，决定补发顺序
 *     type: 'text' | 'media' | 'media-file',
 *     text?,               // text
 *     media?,              // media：已上传到 CDN 的参数
 *     kind?, filePath?,    // media-file：上传阶段失败，补发时重新上传
 *     clientId,            // 幂等键，重试必须复用
 *     attempts,            // 失败次数（token 失效不计）
 *     nextAttemptAt,       // 毫秒时间戳；未到点不重发
 *     lastError,           // 最后一次失败原因（截断）
 *     queuedAt             // ISO 时间
 *   }
 *
 * 兼容：load() 能读 v1（只有 type/text/media/queuedAt/attempts），
 * 原地补齐 seq/clientId/nextAttemptAt/lastError；顶层仍是 `peers`，
 * 旧版本读 v2 文件时只是忽略多出的字段 —— 这是回滚安全线。
 */

import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { dirname } from 'node:path';

import { newClientId } from './ids.mjs';

const VERSION = 2;
export const OUTBOX_VERSION = VERSION;
export const DEFAULT_MAX_PER_PEER = 50;

function toInt(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

export class OutboxStore {
  /**
   * @param {string} path - outbox.json 的绝对路径
   * @param {object} [opts]
   * @param {number} [opts.maxPerPeer]
   * @param {import('./dlq.mjs').DlqStore|null} [opts.dlq] - moveToDlq 的目标
   * @param {() => number} [opts.now]
   */
  constructor(path, opts = {}) {
    this.path = path;
    this.maxPerPeer = Number.isFinite(opts.maxPerPeer) ? opts.maxPerPeer : DEFAULT_MAX_PER_PEER;
    this.dlq = opts.dlq ?? null;
    this.now = opts.now ?? (() => Date.now());
    /** @type {Map<string, object[]>} */
    this.peers = new Map();
    this.dirty = false;
    this.dropped = 0;
    /** 全局 seq 分配器；load 时推到已有最大值之后 */
    this.seqCounter = 0;
    /** 每次变更递增，用于判断写盘期间是否有新消息 */
    this.revision = 0;
    /** 串行化 flush，避免两个异步写同时 rename 同一个 tmp 文件 */
    this.flushChain = Promise.resolve();
  }

  async load() {
    if (!existsSync(this.path)) return this;
    try {
      const raw = JSON.parse(await readFile(this.path, 'utf8'));
      const peers = raw?.peers;
      if (peers && typeof peers === 'object') {
        for (const [peerId, items] of Object.entries(peers)) {
          if (!Array.isArray(items)) continue;
          const list = [];
          for (const item of items) {
            if (!item || typeof item !== 'object') continue;
            const seq = Number.isFinite(item.seq) ? item.seq : this.seqCounter;
            this.seqCounter = Math.max(this.seqCounter, seq + 1);
            list.push({
              ...item,
              seq,
              clientId: typeof item.clientId === 'string' && item.clientId ? item.clientId : newClientId(),
              attempts: toInt(item.attempts, 0),
              nextAttemptAt: toInt(item.nextAttemptAt, 0),
              lastError: typeof item.lastError === 'string' ? item.lastError : null,
              queuedAt: typeof item.queuedAt === 'string' && item.queuedAt
                ? item.queuedAt
                : new Date(this.now()).toISOString(),
            });
          }
          if (list.length > 0) this.peers.set(peerId, list);
        }
      }
    } catch {
      // 损坏时从空开始，不阻塞启动
      this.peers.clear();
      this.seqCounter = 0;
    }
    return this;
  }

  /**
   * 追加一条待发消息，分配 seq + clientId。
   *
   * @param {string} peerId
   * @param {object} item - {type:'text', text} / {type:'media', media} / {type:'media-file', kind, filePath}
   * @param {{attempts?: number, nextAttemptAt?: number, clientId?: string}} [meta]
   *        `clientId` 用于复用「首次发送失败时」的幂等键；不传则新生成。
   * @returns {number} 因超限被丢弃的条数（0 表示没丢）
   */
  add(peerId, item, meta = {}) {
    if (!peerId || !item) return 0;
    const list = this.peers.get(peerId) ?? [];
    const clientId = typeof meta.clientId === 'string' && meta.clientId
      ? meta.clientId
      : (typeof item.clientId === 'string' && item.clientId ? item.clientId : newClientId());
    list.push({
      ...item,
      seq: this.seqCounter++,
      clientId,
      attempts: toInt(meta.attempts ?? item.attempts, 0),
      nextAttemptAt: toInt(meta.nextAttemptAt ?? item.nextAttemptAt, 0),
      lastError: null,
      queuedAt: new Date(this.now()).toISOString(),
    });
    let dropped = 0;
    while (list.length > this.maxPerPeer) {
      list.shift();
      dropped++;
    }
    this.peers.set(peerId, list);
    this.dirty = true;
    this.revision++;
    this.dropped += dropped;
    return dropped;
  }

  /** 查看某个用户的待发队列（副本）。 */
  list(peerId) {
    return [...(this.peers.get(peerId) ?? [])];
  }

  /** 队首；不存在或未到 nextAttemptAt 时返回 null（严格 FIFO：不跳过队首）。 */
  dueHead(peerId, at = this.now()) {
    const head = this.peers.get(peerId)?.[0];
    if (!head) return null;
    if (toInt(head.nextAttemptAt, 0) > at) return null;
    return head;
  }

  /** 按 seq 取一条（诊断/测试用）。 */
  get(peerId, seq) {
    return (this.peers.get(peerId) ?? []).find((x) => x.seq === seq) ?? null;
  }

  /** 记录一次失败：attempts+1，写入下一次允许发送的时间。 */
  markAttempt(peerId, seq, { error = '', nextAt } = {}) {
    const item = this.get(peerId, seq);
    if (!item) return null;
    item.attempts = toInt(item.attempts, 0) + 1;
    item.nextAttemptAt = toInt(nextAt, this.now());
    item.lastError = String(error ?? '').slice(0, 200);
    this.dirty = true;
    this.revision++;
    return item;
  }

  /** 按 seq 移除一条（发送成功后调用）。 */
  remove(peerId, seq) {
    const list = this.peers.get(peerId);
    if (!list?.length) return false;
    const i = list.findIndex((x) => x.seq === seq);
    if (i < 0) return false;
    list.splice(i, 1);
    if (list.length === 0) this.peers.delete(peerId);
    this.dirty = true;
    this.revision++;
    return true;
  }

  /**
   * 放弃一条消息：写入 dlq.json，再从 outbox 删除。
   * @param {string} peerId
   * @param {number} seq
   * @param {string} reason
   * @returns {object|null} 写入的 DLQ 条目
   */
  moveToDlq(peerId, seq, reason) {
    const item = this.get(peerId, seq);
    if (!item) return null;
    const entry = this.dlq?.add({
      peerId,
      type: item.type,
      reason,
      attempts: item.attempts ?? 0,
      preview: previewOf(item),
    }) ?? null;
    this.remove(peerId, seq);
    return entry;
  }

  /** 从队首移除 n 条（兼容旧接口/测试）。 */
  shift(peerId, n = 1) {
    const list = this.peers.get(peerId);
    if (!list?.length) return 0;
    const count = Math.min(n, list.length);
    list.splice(0, count);
    if (list.length === 0) this.peers.delete(peerId);
    this.dirty = true;
    this.revision++;
    return count;
  }

  /** 清空某个用户（例如会话彻底不可用时）。 */
  clear(peerId) {
    const had = this.peers.delete(peerId);
    if (had) { this.dirty = true; this.revision++; }
    return had;
  }

  stats() {
    let items = 0;
    let retrying = 0;
    let oldestAt = null;
    for (const list of this.peers.values()) {
      for (const item of list) {
        items += 1;
        if (toInt(item.attempts, 0) > 0) retrying += 1;
        if (item.queuedAt && (!oldestAt || item.queuedAt < oldestAt)) oldestAt = item.queuedAt;
      }
    }
    return {
      peers: this.peers.size,
      items,
      dropped: this.dropped,
      retrying,
      oldestAt,
      dlq: this.dlq?.stats().items ?? 0,
    };
  }

  /** 原子写盘。多次并发调用会串行执行，返回各自的写入结果。 */
  flush() {
    const p = this.flushChain.then(() => this.#flushNow());
    // 链上只保留"已完成"，避免一次失败让后续 flush 永远 reject
    this.flushChain = p.catch(() => {});
    return p;
  }

  async #flushNow() {
    if (!this.dirty) return false;
    await mkdir(dirname(this.path), { recursive: true }).catch(() => {});
    const peers = {};
    for (const [peerId, items] of this.peers) {
      if (items.length > 0) peers[peerId] = items;
    }
    const rev = this.revision;
    const tmp = `${this.path}.tmp-${process.pid}-${randomBytes(3).toString('hex')}`;
    const data = { version: VERSION, seq: this.seqCounter, peers };
    await writeFile(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
    await rename(tmp, this.path);
    // 写盘期间如果又来了新消息，保持 dirty，下一轮继续写
    if (this.revision === rev) this.dirty = false;
    return true;
  }
}

/** DLQ 摘要：只留可读的短预览，不复制完整消息体。 */
export function previewOf(item) {
  if (!item) return '';
  if (item.type === 'text') return String(item.text ?? '').slice(0, 100);
  if (item.type === 'media') return `${item.media?.kind ?? 'media'}:${item.media?.name ?? ''}`;
  if (item.type === 'media-file') return `${item.kind ?? 'media'}:${item.filePath ?? ''}`;
  return String(item.type ?? '');
}
