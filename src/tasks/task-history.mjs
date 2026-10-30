/**
 * 任务执行历史：记录每次到点执行的结果，并在失败时生成一条可操作提示。
 *
 * 为什么需要：
 *   tasks.json 里的 lastResult 只保留"上一次"，而且 agent 看不到；
 *   任务半夜失败时，用户第二天只会发现"没收到提醒"，不知道为什么。
 *
 * 机制：
 *   - 每次执行写一条简短记录到 <租户根>/task-history.json（最多 200 条）
 *   - 同时把最近 50 条快照到工作区 _tasks/history.json，agent 可自查
 *   - 失败时由 Tenant 给 owner 发一条提示（token 失效则进待发队列）
 */

import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

const VERSION = 1;
export const DEFAULT_MAX_ENTRIES = 200;
export const DEFAULT_SNAPSHOT_ENTRIES = 50;

export class TaskHistory {
  /**
   * @param {string} path
   * @param {object} [opts]
   * @param {number} [opts.maxEntries]
   */
  constructor(path, opts = {}) {
    this.path = path;
    this.maxEntries = Number.isFinite(opts.maxEntries) ? opts.maxEntries : DEFAULT_MAX_ENTRIES;
    /** @type {object[]} 旧 → 新 */
    this.entries = [];
    this.dirty = false;
  }

  async load() {
    if (!existsSync(this.path)) return this;
    try {
      const raw = JSON.parse(await readFile(this.path, 'utf8'));
      if (Array.isArray(raw?.entries)) {
        this.entries = raw.entries.filter((e) => e && typeof e === 'object').slice(-this.maxEntries);
      }
    } catch {
      this.entries = [];
    }
    return this;
  }

  /**
   * 追加一条执行记录。
   * @param {object} entry
   * @param {string} entry.taskId
   * @param {string} [entry.title]
   * @param {boolean} entry.ok
   * @param {string} [entry.result]
   * @param {number} [entry.durationMs]
   * @param {string} [entry.delivery] - sent / queued / failed
   */
  append(entry) {
    this.entries.push({
      at: entry.at ?? new Date().toISOString(),
      taskId: String(entry.taskId ?? ''),
      title: String(entry.title ?? ''),
      ok: Boolean(entry.ok),
      result: String(entry.result ?? '').slice(0, 300),
      durationMs: Number.isFinite(entry.durationMs) ? entry.durationMs : null,
      delivery: entry.delivery ? String(entry.delivery) : null,
    });
    while (this.entries.length > this.maxEntries) this.entries.shift();
    this.dirty = true;
    return this.entries[this.entries.length - 1];
  }

  /** 取最近 n 条（旧 → 新）。 */
  list(limit = DEFAULT_SNAPSHOT_ENTRIES) {
    if (!Number.isFinite(limit) || limit <= 0) return [...this.entries];
    return this.entries.slice(-limit);
  }

  async flush() {
    if (!this.dirty) return false;
    await mkdir(dirname(this.path), { recursive: true }).catch(() => {});
    const tmp = `${this.path}.tmp-${process.pid}`;
    await writeFile(
      tmp,
      JSON.stringify({ version: VERSION, entries: this.entries }, null, 2),
      { mode: 0o600 },
    );
    await rename(tmp, this.path);
    this.dirty = false;
    return true;
  }
}

/**
 * 把最近的历史快照到工作区，供 agent 在用户问「为什么没提醒」时自查。
 * @param {string} workspace
 * @param {object[]} entries
 */
export async function writeTaskHistorySnapshot(workspace, entries) {
  const dir = join(workspace, '_tasks');
  await mkdir(dir, { recursive: true }).catch(() => {});
  const payload = {
    updatedAt: new Date().toISOString(),
    entries: entries.map((e) => ({
      at: e.at,
      taskId: e.taskId,
      title: e.title,
      ok: e.ok,
      result: e.result,
      delivery: e.delivery,
    })),
  };
  await writeFile(
    join(dir, 'history.json'),
    JSON.stringify(payload, null, 2),
    { mode: 0o644 },
  ).catch(() => {});
}

/**
 * 失败时发给 owner 的提示：要短、要说明原因、要给出下一步动作。
 *
 * @param {{title?: string}} task
 * @param {string|Error} err
 * @returns {string}
 */
export function formatTaskFailureNotice(task, err) {
  const title = task?.title ? `「${task.title}」` : '';
  const reason = String(err?.message ?? err ?? '未知错误').replace(/\s+/g, ' ').trim().slice(0, 160);
  return [
    `⚠️ 定时任务${title}执行失败：${reason}`,
    '你可以回复任意消息让我重试，或直接说「取消' + (task?.title ? ` ${task.title}` : '这个任务') + '」停用它。',
  ].join('\n');
}
