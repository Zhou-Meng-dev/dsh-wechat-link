/**
 * 任务运行时：任务存储/历史、文件监听、准点定时器、agent 请求收件箱、执行与失败提示。
 *
 * 一块行为，三个入口：
 *   - start()  加载任务与历史、监听 pending/tasks.json、起 60s 兜底
 *   - stop()   停掉所有定时器/监听，并把任务与历史刷盘
 *   - runNow() 立即执行某个任务（手动触发/测试）
 *
 * 调度时序：
 *   - pending 目录：fs.watch → 150ms 防抖，创建/取消秒级生效
 *   - tasks.json：watch 租户根，CLI 改动立即重载（忽略自己刚写过的事件）
 *   - 到点：按最近的 nextRunAt 设 setTimeout（最多 1 小时后重排）
 *   - 兜底：60s 对账一次，防 inotify 漏事件 / 目录被重建
 *   - pending 请求文件等 300ms 稳定后再处理
 *
 * 不读 Tenant 私有字段：会话询问、发送、token 查询、运行状态都由构造参数注入。
 */

import { existsSync, watch } from 'node:fs';
import { mkdir, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { TaskStore, formatNextRun, nextDueDelay } from './tasks.mjs';
import {
  TaskHistory,
  formatTaskFailureNotice,
  writeTaskHistorySnapshot,
} from './task-history.mjs';

export class TaskRuntime {
  /**
   * @param {object} opts
   * @param {object} opts.tenant             - 租户视图（cwd / root / ownerId）
   * @param {(peerId: string, prompt: string) => Promise<string>} opts.ask
   * @param {{send: (peerId: string, text: string, token?: string) => Promise<{sent:number,queued:number}>}} opts.reply
   * @param {(peerId: string) => string|undefined} [opts.getContextToken]
   * @param {() => boolean} [opts.isActive]  - 是否处于 running，用状态机判断而不是读私有字段
   * @param {(msg: string) => void} [opts.log]
   */
  constructor({
    tenant,
    ask,
    reply,
    getContextToken = () => undefined,
    isActive = () => true,
    log = () => {},
  }) {
    this.tenant = tenant;
    this.ask = ask;
    this.reply = reply;
    this.getContextToken = getContextToken;
    this.isActive = isActive;
    this.log = log;

    /** @type {TaskStore|null} */
    this.tasks = null;
    /** @type {TaskHistory|null} */
    this.taskHistory = null;
    /** 60 秒兜底对账 */
    this.schedulerTimer = null;
    /** 文件事件防抖 */
    this.reconcileTimer = null;
    /** 按 nextRunAt 设的准点定时器 */
    this.dueTimer = null;
    /** @type {import('node:fs').FSWatcher[]} */
    this.watchers = [];
    this.tickRunning = false;
    this.tickPending = false;
    /** 自己刚写过 tasks.json 的时间，用于忽略自激事件 */
    this.tasksSelfWriteAt = 0;
    this.tasksMtime = 0;
    this.stopped = false;
  }

  /** 加载任务存储/历史并启动监听。重复调用只重载数据，不会重复起定时器。 */
  async start() {
    this.stopped = false;

    this.tasks = new TaskStore(join(this.tenant.root, 'tasks.json'));
    await this.tasks.load();
    this.tasksMtime = this.tasks.loadedMtime || 0;
    const enabled = this.tasks.list().filter((t) => t.enabled).length;
    if (enabled > 0) this.log(`已加载 ${enabled} 个启用的定时任务`);

    this.taskHistory = new TaskHistory(join(this.tenant.root, 'task-history.json'));
    await this.taskHistory.load();
    const runCount = this.taskHistory.list(Number.MAX_SAFE_INTEGER).length;
    if (runCount > 0) this.log(`已加载 ${runCount} 条任务执行记录`);

    await this.#startScheduler();

    // 首次启动会装配监听；重启时 #startScheduler 提前返回，这里统一补一次对账。
    // 0ms 定时器晚于 Tenant 在 await start() 之后把状态置为 running 的赋值。
    this.#scheduleReconcile(0);
  }

  /** 停掉调度器/监听并刷盘任务与历史；可重复调用。 */
  async stop() {
    if (this.stopped) return;
    this.stopped = true;
    if (this.schedulerTimer) { clearInterval(this.schedulerTimer); this.schedulerTimer = null; }
    if (this.reconcileTimer) { clearTimeout(this.reconcileTimer); this.reconcileTimer = null; }
    if (this.dueTimer) { clearTimeout(this.dueTimer); this.dueTimer = null; }
    for (const w of this.watchers) {
      try { w.close(); } catch { /* ignore */ }
    }
    this.watchers = [];
    await this.tasks?.flush().catch(() => {});
    await this.taskHistory?.flush().catch(() => {});
  }

  /** 立即执行指定任务（手动触发/测试用）。任务不存在时返回 false。 */
  async runNow(taskId) {
    const task = this.tasks?.get(taskId);
    if (!task) return false;
    await this.#runTask(task);
    return true;
  }

  // ---------------------------------------------------------------- 调度

  /**
   * 任务调度：事件驱动优先，低频兜底。
   *
   * - pending 目录：fs.watch → 150ms 防抖，创建/取消秒级生效
   * - tasks.json：watch 租户根，CLI 改动立即重载（忽略自己刚写过的事件）
   * - 到点：按最近的 nextRunAt 设 setTimeout（最多 1 小时后重排）
   * - 兜底：60s 对账一次，防 inotify 漏事件 / 目录被重建
   */
  async #startScheduler() {
    if (this.schedulerTimer) return;

    const pendingDir = join(this.tenant.cwd, '_tasks', 'pending');
    await mkdir(pendingDir, { recursive: true }).catch(() => {});

    this.#watchDir(pendingDir, (name) => !name || name.endsWith('.json'), 'pending');
    this.#watchDir(this.tenant.root, (name) => name === 'tasks.json', 'tasks.json');

    this.schedulerTimer = setInterval(() => {
      this.#reconcileTasks().catch((e) => this.log(`[task] 兜底对账失败: ${e.message}`));
    }, 60_000);
    this.schedulerTimer.unref?.();
  }

  /** 监听目录；出错时 1 秒后重建，重建也失败就靠兜底 */
  #watchDir(dir, accept, label) {
    try {
      const w = watch(dir, { persistent: false }, (_event, filename) => {
        const name = filename ? String(filename) : null;
        if (accept(name)) this.#scheduleReconcile(150);
      });
      w.on('error', (err) => {
        this.log(`[task] 监听 ${label} 出错: ${err.message}，1s 后重建`);
        try { w.close(); } catch { /* ignore */ }
        this.watchers = this.watchers.filter((x) => x !== w);
        const t = setTimeout(() => {
          if (!this.stopped) this.#watchDir(dir, accept, label);
        }, 1_000);
        t.unref?.();
      });
      this.watchers.push(w);
    } catch (err) {
      this.log(`[task] 无法监听 ${label}: ${err.message}（依赖 60s 兜底）`);
    }
  }

  /** 防抖：连续事件只跑一次对账 */
  #scheduleReconcile(delayMs = 150) {
    if (this.stopped) return;
    if (this.reconcileTimer) clearTimeout(this.reconcileTimer);
    this.reconcileTimer = setTimeout(() => {
      this.reconcileTimer = null;
      this.#reconcileTasks().catch((e) => this.log(`[task] 对账失败: ${e.message}`));
    }, delayMs);
    this.reconcileTimer.unref?.();
  }

  /** 所有触发源（文件事件 / 准点 / 兜底）共用 */
  async #reconcileTasks() {
    if (this.stopped || !this.isActive() || !this.tasks) return;
    if (this.tickRunning) {
      this.tickPending = true;
      return;
    }

    this.tickRunning = true;
    try {
      await this.#reloadTasksIfChanged();

      // 请求文件可能还在写：等它稳定 300ms 再处理
      if (await this.#pendingSettled()) {
        await this.#processTaskInbox();
      } else {
        this.#scheduleReconcile(350);
      }

      for (const task of this.tasks.due()) {
        await this.runNow(task.id);
      }

      const { writeTaskSnapshot } = await import('./task-inbox.mjs');
      await writeTaskSnapshot(this.tenant.cwd, this.tasks);
      this.#armDueTimer();
    } finally {
      this.tickRunning = false;
      if (this.tickPending) {
        this.tickPending = false;
        this.#scheduleReconcile(0);
      }
    }
  }

  /** CLI 改了 tasks.json 就重载（mtime 比内存新） */
  async #reloadTasksIfChanged() {
    try {
      const st = await stat(this.tasks.path).catch(() => null);
      if (!st) return;
      // 自己刚写完：这次事件是我们造成的，不必重读
      if (this.tasksSelfWriteAt && Date.now() - this.tasksSelfWriteAt < 1_000) return;
      if (this.tasksMtime && st.mtimeMs <= this.tasksMtime) return;
      this.tasksMtime = st.mtimeMs;
      const before = this.tasks.list().length;
      await this.tasks.load();
      const after = this.tasks.list().length;
      if (after !== before) this.log(`[task] 任务列表已更新（${before} → ${after}）`);
    } catch { /* 忽略 */ }
  }

  /** pending 目录里的 .json 是否都已写完（mtime 至少 300ms 前） */
  async #pendingSettled() {
    const dir = join(this.tenant.cwd, '_tasks', 'pending');
    if (!existsSync(dir)) return true;
    const names = (await readdir(dir).catch(() => [])).filter((n) => n.endsWith('.json'));
    if (names.length === 0) return true;
    const now = Date.now();
    for (const n of names) {
      const st = await stat(join(dir, n)).catch(() => null);
      if (st && now - st.mtimeMs < 300) return false;
    }
    return true;
  }

  /** 处理 agent 提交的任务请求；结果写入 _tasks/results/，由 agent 的 taskctl 读取 */
  async #processTaskInbox() {
    try {
      const { processPendingTaskRequests } = await import('./task-inbox.mjs');
      const n = await processPendingTaskRequests({
        workspace: this.tenant.cwd,
        store: this.tasks,
        log: (m) => this.log(m),
      });
      if (n > 0) {
        this.log(`[task] 处理了 ${n} 条 agent 请求，结果已写入 _tasks/results/`);
        this.tasksSelfWriteAt = Date.now();
        this.tasksMtime = 0;
      }
    } catch (err) {
      this.log(`[task] 处理请求失败: ${err.message}`);
    }
  }

  /** 把下一次到点排成精确的 setTimeout；最多 1 小时后重新评估 */
  #armDueTimer() {
    if (this.dueTimer) { clearTimeout(this.dueTimer); this.dueTimer = null; }
    if (this.stopped || !this.tasks) return;
    const delay = nextDueDelay(this.tasks.list(), Date.now());
    if (delay === null) return;
    this.dueTimer = setTimeout(() => {
      this.dueTimer = null;
      this.#reconcileTasks().catch((e) => this.log(`[task] 到点对账失败: ${e.message}`));
    }, delay);
    this.dueTimer.unref?.();
  }

  /** 写任务表并记下"刚写过"，避免 watch 自激 */
  async #flushTasks() {
    if (!this.tasks) return;
    await this.tasks.flush().catch(() => {});
    this.tasksSelfWriteAt = Date.now();
    this.tasksMtime = 0;
  }

  // ---------------------------------------------------------------- 执行

  /**
   * 执行一个任务：把 prompt 送进会话，agent 生成回复后主动推送。
   * 失败只记录，不抛出（避免一个任务拖垮调度循环），并给 owner 发一条可操作提示。
   */
  async #runTask(task) {
    const peer = task.peerId ?? this.tenant.ownerId;
    const token = this.getContextToken(peer);
    const startedAt = Date.now();
    this.log(`[task] 触发「${task.title}」→ ${peer?.slice(0, 12) ?? '?'}…`);

    if (!peer) {
      this.tasks.markRun(task.id, { ok: false, result: '没有可推送的用户' });
      await this.#recordTaskRun(task, {
        ok: false,
        result: '没有可推送的用户',
        delivery: 'failed',
        durationMs: Date.now() - startedAt,
      });
      await this.#flushTasks();
      return;
    }
    if (!token) {
      this.log('[task] 缺少 context_token：先生成回复，发送失败后进入待发队列，等用户下次发消息补发');
    }

    try {
      const reply = await this.ask(peer, task.prompt);
      if (!reply) throw new Error('agent 未返回内容');
      const delivery = await this.reply.send(peer, reply, token);
      const queued = delivery.queued > 0;
      const result = queued ? `queued:${delivery.queued}` : 'ok';

      this.tasks.markRun(task.id, { ok: true, result });
      this.log(queued
        ? `[task] 📮 「${task.title}」有 ${delivery.queued} 条内容进入待发队列`
        : `[task] ✅ 已推送「${task.title}」`);
      await this.#recordTaskRun(task, {
        ok: true,
        result,
        delivery: queued ? 'queued' : 'sent',
        durationMs: Date.now() - startedAt,
      });

      const t = this.tasks.get(task.id);
      if (t?.nextRunAt) this.log(`[task] 下次: ${formatNextRun(t.nextRunAt)}`);
    } catch (err) {
      this.log(`[task] ❌ 「${task.title}」失败: ${err.message}`);
      this.tasks.markRun(task.id, { ok: false, result: err.message });
      await this.#recordTaskRun(task, {
        ok: false,
        result: err.message,
        delivery: 'failed',
        durationMs: Date.now() - startedAt,
      });
      await this.#notifyTaskFailure(peer, task, err, token);
    } finally {
      await this.#flushTasks();
      await this.taskHistory?.flush().catch(() => {});
    }
  }

  /** 记录一次任务执行结果，并刷新 agent 可读的 _tasks/history.json 快照。 */
  async #recordTaskRun(task, info) {
    if (!this.taskHistory) return;
    this.taskHistory.append({
      taskId: task.id,
      title: task.title,
      ...info,
    });
    await writeTaskHistorySnapshot(this.tenant.cwd, this.taskHistory.list()).catch(() => {});
  }

  /** 失败时给 owner 一条提示；token 失效时这条提示也会进待发队列。 */
  async #notifyTaskFailure(peer, task, err, token) {
    if (!peer) return;
    try {
      const notice = formatTaskFailureNotice(task, err);
      const delivery = await this.reply.send(peer, notice, token);
      this.log(
        `[task] 已发送失败提示给 ${peer.slice(0, 12)}…${delivery.queued > 0 ? '（进入待发队列）' : ''}`,
      );
    } catch (notifyErr) {
      this.log(`[task] 发送失败提示也失败: ${notifyErr.message}`);
    }
  }
}
