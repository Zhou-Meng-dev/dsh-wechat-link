/**
 * 会话映射持久化：peerId（微信用户）→ sessionId（DSH 会话）。
 *
 * 为什么需要：ConversationManager 的映射只在内存里，服务一重启就丢，
 * 用户会莫名其妙"失忆"。把映射落到磁盘，重启后用 session/resume 恢复上下文。
 *
 * 存储位置：租户根目录下的 bridge-state.json（**不在** dsh-home 里，
 * 因此不进沙箱，agent 改不到）。
 */

import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname } from 'node:path';

const VERSION = 1;

export class SessionStore {
  /** @param {string} path - bridge-state.json 的绝对路径 */
  constructor(path) {
    this.path = path;
    this.data = { version: VERSION, peers: {}, tokens: {} };
    this.dirty = false;
  }

  async load() {
    if (!existsSync(this.path)) return this;
    try {
      const raw = JSON.parse(await readFile(this.path, 'utf8'));
      if (raw && typeof raw === 'object' && raw.peers && typeof raw.peers === 'object') {
        this.data = {
          version: VERSION,
          peers: raw.peers,
          tokens: (raw.tokens && typeof raw.tokens === 'object') ? raw.tokens : {},
        };
      }
    } catch {
      // 损坏时从空开始，不阻塞启动
      this.data = { version: VERSION, peers: {}, tokens: {} };
    }
    return this;
  }

  /** @param {string} peerId @returns {string | undefined} */
  get(peerId) {
    return this.data.peers[peerId]?.sessionId;
  }

  /** 该 peer 是否已存在映射（用于决定要不要 resume） */
  has(peerId) {
    return Boolean(this.data.peers[peerId]?.sessionId);
  }

  set(peerId, sessionId) {
    this.data.peers[peerId] = { sessionId, updatedAt: new Date().toISOString() };
    this.dirty = true;
  }

  delete(peerId) {
    if (this.data.peers[peerId]) {
      delete this.data.peers[peerId];
      this.dirty = true;
    }
  }

  /**
   * 原子写盘。只写当有变更时。
   * @returns {Promise<boolean>} 是否真的写了
   */
  async flush(force = false) {
    if (!this.dirty && !force) return false;
    await mkdir(dirname(this.path), { recursive: true }).catch(() => {});
    const tmp = `${this.path}.tmp-${process.pid}`;
    await writeFile(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    await rename(tmp, this.path);
    this.dirty = false;
    return true;
  }

  /** 定期刷盘（防频繁 IO，也防进程被 kill 时全丢） */
  startAutoFlush(intervalMs = 5000) {
    const timer = setInterval(() => {
      this.flush().catch(() => {});
    }, intervalMs);
    timer.unref?.();
    return () => clearInterval(timer);
  }

  peers() {
    return Object.keys(this.data.peers);
  }

  // ---------------------------------------------------------------- context_token
  //
  // iLink 的每条下行消息都必须带 context_token，它由用户的**上行消息**下发。
  // 定时任务需要主动推送，所以必须把它持久化，否则重启后就推不出去。

  /** @param {string} peerId @returns {string|undefined} */
  getToken(peerId) {
    return this.data.tokens[peerId]?.token;
  }

  setToken(peerId, token) {
    if (!token) return;
    const cur = this.data.tokens[peerId];
    if (cur?.token === token) return; // 相同则不标脏
    this.data.tokens[peerId] = { token, updatedAt: new Date().toISOString() };
    this.dirty = true;
  }

  tokenPeers() {
    return Object.keys(this.data.tokens);
  }
}
