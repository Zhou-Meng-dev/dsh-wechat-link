/**
 * 死信队列：超过最大尝试次数、或遇到永久错误的消息，落在 `dlq.json`。
 *
 * 为什么不直接丢：
 *   「发不出去」必须可见。DLQ 只保留可读摘要（谁、什么类型、为什么、尝试几次），
 *   用于事后排查与 owner 告警；完整消息体不在这里复制，避免重复存用户内容。
 *
 * 上限 200 条，超出丢最旧，文件 0600。
 */

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';

import { atomicWriteJson } from '../ops/atomic-file.mjs';

export const DLQ_VERSION = 1;
export const DEFAULT_MAX_DLQ_ITEMS = 200;

export class DlqStore {
  /**
   * @param {string} path - dlq.json 的绝对路径
   * @param {object} [opts]
   * @param {number} [opts.maxItems]
   * @param {() => number} [opts.now]
   * @param {(path: string, value: unknown, opts?: object) => Promise<void>} [opts.writeJson]
   */
  constructor(path, {
    maxItems = DEFAULT_MAX_DLQ_ITEMS,
    now = () => Date.now(),
    writeJson = atomicWriteJson,
  } = {}) {
    this.path = path;
    this.maxItems = Number.isFinite(maxItems) && maxItems > 0 ? maxItems : DEFAULT_MAX_DLQ_ITEMS;
    this.now = now;
    this.writeJson = writeJson;
    this.items = [];
    this.dirty = false;
    this.dropped = 0;
    this.chain = Promise.resolve();
  }

  /**
   * 加载；损坏时从空开始（DLQ 是诊断数据，不阻塞启动）。
   * @returns {Promise<{items: number, warning?: string}>}
   */
  async load() {
    if (!existsSync(this.path)) return { items: 0 };
    try {
      const raw = JSON.parse(await readFile(this.path, 'utf8'));
      const list = Array.isArray(raw?.items) ? raw.items : [];
      this.items = list
        .filter((x) => x && typeof x === 'object' && typeof x.peerId === 'string')
        .map((x) => ({
          at: typeof x.at === 'string' ? x.at : new Date(this.now()).toISOString(),
          peerId: x.peerId,
          type: typeof x.type === 'string' ? x.type : 'unknown',
          reason: typeof x.reason === 'string' ? x.reason.slice(0, 300) : '',
          attempts: Math.max(0, Number(x.attempts) || 0),
          preview: typeof x.preview === 'string' ? x.preview.slice(0, 120) : '',
        }))
        .slice(-this.maxItems);
      return { items: this.items.length };
    } catch (err) {
      this.items = [];
      return { items: 0, warning: `dlq.json 损坏（${err.message}），已从空列表开始` };
    }
  }

  /**
   * 追加一条死信。
   * @param {{peerId: string, type?: string, reason?: string, attempts?: number, preview?: string}} entry
   * @returns {object} 规范化后的条目
   */
  add(entry) {
    const item = {
      at: new Date(this.now()).toISOString(),
      peerId: String(entry?.peerId ?? ''),
      type: typeof entry?.type === 'string' ? entry.type : 'unknown',
      reason: String(entry?.reason ?? '').slice(0, 300),
      attempts: Math.max(0, Number(entry?.attempts) || 0),
      preview: String(entry?.preview ?? '').slice(0, 120),
    };
    this.items.push(item);
    while (this.items.length > this.maxItems) {
      this.items.shift();
      this.dropped += 1;
    }
    this.dirty = true;
    return item;
  }

  list() {
    return [...this.items];
  }

  stats() {
    return {
      items: this.items.length,
      dropped: this.dropped,
      oldestAt: this.items[0]?.at ?? null,
    };
  }

  flush() {
    const p = this.chain.then(() => this.#flushNow());
    this.chain = p.catch(() => {});
    return p;
  }

  async #flushNow() {
    if (!this.dirty) return false;
    await this.writeJson(this.path, { version: DLQ_VERSION, items: this.items }, { mode: 0o600 });
    this.dirty = false;
    return true;
  }
}
