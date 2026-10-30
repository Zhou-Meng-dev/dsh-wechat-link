/**
 * 待发队列：context_token 失效时，把没能送达的消息暂存下来。
 *
 * 为什么需要：
 *   iLink 的每条下行消息都依赖用户最近一次上行带来的 context_token。
 *   token 过期后 sendmessage 返回 ret=-1；发送失败的回复需要暂存，否则会丢。
 *
 * 行为：
 *   - 发送失败（token 失效）→ 消息按顺序进入 `outbox.json`
 *   - 用户下次发消息时，Tenant 先用新 token 补发队列，再处理新消息
 *   - 进程重启后队列仍在（落盘到租户根目录，agent 改不到）
 *   - 每个用户最多保留 50 条，超出时丢最旧的并记日志
 *
 * 队列项形状：
 *   { type: 'text',  text }
 *   { type: 'media', media: { kind, name, bytes, mimeType, params } }  // 已上传到 CDN
 */

import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { dirname } from 'node:path';

const VERSION = 1;
export const DEFAULT_MAX_PER_PEER = 50;

export class OutboxStore {
  /**
   * @param {string} path - outbox.json 的绝对路径
   * @param {object} [opts]
   * @param {number} [opts.maxPerPeer]
   */
  constructor(path, opts = {}) {
    this.path = path;
    this.maxPerPeer = Number.isFinite(opts.maxPerPeer) ? opts.maxPerPeer : DEFAULT_MAX_PER_PEER;
    /** @type {Map<string, object[]>} */
    this.peers = new Map();
    this.dirty = false;
    this.dropped = 0;
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
          if (Array.isArray(items) && items.length > 0) {
            this.peers.set(peerId, items.filter((x) => x && typeof x === 'object'));
          }
        }
      }
    } catch {
      // 损坏时从空开始，不阻塞启动
      this.peers.clear();
    }
    return this;
  }

  /**
   * 追加一条待发消息。
   * @param {string} peerId
   * @param {object} item - {type:'text', text} 或 {type:'media', media}
   * @returns {number} 因超限被丢弃的条数（0 表示没丢）
   */
  add(peerId, item) {
    if (!peerId || !item) return 0;
    const list = this.peers.get(peerId) ?? [];
    list.push({ ...item, queuedAt: new Date().toISOString(), attempts: 0 });
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

  /** 从队首移除 n 条（发送成功后调用）。 */
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
    for (const list of this.peers.values()) items += list.length;
    return { peers: this.peers.size, items, dropped: this.dropped };
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
    await writeFile(tmp, JSON.stringify({ version: VERSION, peers }, null, 2), { mode: 0o600 });
    await rename(tmp, this.path);
    // 写盘期间如果又来了新消息，保持 dirty，下一轮继续写
    if (this.revision === rev) this.dirty = false;
    return true;
  }
}
