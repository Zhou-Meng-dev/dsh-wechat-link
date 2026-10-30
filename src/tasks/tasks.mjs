/**
 * 定时任务：存储与时间计算。
 *
 * 任务不是"死模板"，而是一段**给 agent 的提示词**。到点后：
 *   桥接把 prompt 送进该租户的会话 → agent 生成回复 → 用持久化的
 *   context_token 主动推到微信。
 *
 * 这样 agent 能带上下文地说话（比如知道上次出到第几题、你答对几道）。
 *
 * 时间语义：
 *   - once  : 绝对时间点，跑一次就停
 *   - daily : 每天固定时刻（本地时区），按 nextRunAt 推进
 *   - every : 固定间隔（分钟）
 */

import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

const VERSION = 1;
/**
 * 到点判定的容差。
 *
 * 语义是「允许**提前**多少毫秒触发」，只用来吸收 tick 抖动，
 * 绝不能设大 —— 否则 12:30 的提醒会在 12:29 就响，用户会困惑。
 * 宁可晚一点（tick 间隔 30s），也不要早。
 */
export const DUE_GRACE_MS = 1_000;

/**
 * 解析 "YYYY-MM-DD HH:mm" 或 ISO 字符串为时间戳。
 * 不带时区的按**本地时区**解释。
 * @param {string} input
 * @returns {number|null}
 */
export function parseWhen(input) {
  if (!input) return null;
  const s = String(input).trim();

  // "2026-10-28 12:30" / "2026-10-28 12:30:00"
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (m) {
    const [, y, mo, d, h, mi, sec] = m;
    return new Date(
      Number(y), Number(mo) - 1, Number(d),
      Number(h), Number(mi), Number(sec ?? 0),
    ).getTime();
  }

  const t = Date.parse(s);
  return Number.isNaN(t) ? null : t;
}

/**
 * 计算下一次运行时间。
 * @param {object} schedule - {kind:'once'|'daily'|'every', ...}
 * @param {number} [from]   - 基准时间戳，默认现在
 * @returns {number|null}
 */
export function computeNextRun(schedule, from = Date.now()) {
  if (!schedule || typeof schedule !== 'object') return null;

  if (schedule.kind === 'once') {
    const at = typeof schedule.at === 'number' ? schedule.at : parseWhen(schedule.at);
    return at ?? null;
  }

  if (schedule.kind === 'daily') {
    const m = String(schedule.time ?? '').match(/^(\d{2}):(\d{2})$/);
    if (!m) return null;
    const [hh, mm] = [Number(m[1]), Number(m[2])];
    if (hh > 23 || mm > 59) return null;

    const base = new Date(from);
    const next = new Date(base);
    next.setHours(hh, mm, 0, 0);
    if (next.getTime() <= from) next.setDate(next.getDate() + 1);
    return next.getTime();
  }

  if (schedule.kind === 'weekly') {
    const days = normalizeDays(schedule.days);
    if (!days || days.length === 0) return null;
    const m = String(schedule.time ?? '').match(/^(\d{2}):(\d{2})$/);
    if (!m) return null;
    const [hh, mm] = [Number(m[1]), Number(m[2])];
    if (hh > 23 || mm > 59) return null;

    // 从今天起最多看 8 天（今天稍晚 + 一整周）
    const base = new Date(from);
    for (let offset = 0; offset <= 7; offset++) {
      const cand = new Date(base);
      cand.setDate(cand.getDate() + offset);
      cand.setHours(hh, mm, 0, 0);
      if (cand.getTime() <= from) continue;
      if (!days.includes(isoWeekday(cand))) continue;
      return cand.getTime();
    }
    return null;
  }

  if (schedule.kind === 'every') {
    const mins = Number(schedule.minutes);
    if (!Number.isFinite(mins) || mins <= 0) return null;
    return from + mins * 60_000;
  }

  return null;
}


/** ISO 星期：周一=1 … 周日=7 */
export function isoWeekday(date) {
  const d = date.getDay(); // 0=周日
  return d === 0 ? 7 : d;
}

/** 单个 day 记号 → ISO 数字（1-7），无法识别返回 null */
function parseDayToken(tok) {
  const t = String(tok).trim().toLowerCase();
  if (!t) return null;
  if (/^[1-7]$/.test(t)) return Number(t);

  const names = {
    mon: 1, monday: 1, 周一: 1, 星期一: 1,
    tue: 2, tues: 2, tuesday: 2, 周二: 2, 星期二: 2,
    wed: 3, wednesday: 3, 周三: 3, 星期三: 3,
    thu: 4, thur: 4, thurs: 4, thursday: 4, 周四: 4, 星期四: 4,
    fri: 5, friday: 5, 周五: 5, 星期五: 5,
    sat: 6, saturday: 6, 周六: 6, 星期六: 6,
    sun: 7, sunday: 7, 周日: 7, 周天: 7, 星期日: 7, 星期天: 7,
    // 单个汉字（在 days 上下文里不会歧义）
    一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 7, 天: 7,
  };
  return names[t] ?? null;
}

/**
 * 归一化 days：支持数组或逗号/空格分隔的字符串。
 * 接受 1-7、英文缩写、中文星期。也接受 "weekdays"/"工作日"、weekend/周末。
 * @returns {number[]|null} 去重升序的 ISO 星期数组
 */
export function normalizeDays(input) {
  if (input === undefined || input === null) return null;

  // 分隔符：英文逗号/分号/空白 + 中文逗号、顿号
  const SEP = /[,;\s，、；／/]+/;
  const tokens = Array.isArray(input)
    ? input.flatMap((x) => String(x).split(SEP))
    : String(input).split(SEP);

  const out = new Set();
  for (const raw of tokens) {
    const t = String(raw).trim().toLowerCase();
    if (!t) continue;
    if (t === 'weekdays' || t === '工作日') { [1, 2, 3, 4, 5].forEach((d) => out.add(d)); continue; }
    if (t === 'weekend' || t === '周末') { [6, 7].forEach((d) => out.add(d)); continue; }
    const d = parseDayToken(t);
    if (d === null) return null; // 有无法识别的记号就整体判为非法
    out.add(d);
  }
  return out.size ? [...out].sort((a, b) => a - b) : null;
}

const WEEKDAY_LABEL = ['', '周一', '周二', '周三', '周四', '周五', '周六', '周日'];

/** 人类可读的下次运行时间 */
export function formatNextRun(ts) {
  if (!ts) return '(无)';
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 描述 schedule */
export function describeSchedule(s) {
  if (!s) return '(未知)';
  if (s.kind === 'once') return `一次 @ ${formatNextRun(typeof s.at === 'number' ? s.at : parseWhen(s.at))}`;
  if (s.kind === 'daily') return `每天 ${s.time}`;
  if (s.kind === 'weekly') {
    const days = normalizeDays(s.days) ?? [];
    const label = days.map((d) => WEEKDAY_LABEL[d]).join('、');
    return `每周 ${label} ${s.time}`;
  }
  if (s.kind === 'every') return `每 ${s.minutes} 分钟`;
  return JSON.stringify(s);
}

/**
 * 距离下一个到点任务还有多少毫秒（供精确 setTimeout 使用）。
 *
 * - 没有启用的任务 → null
 * - 已到点/已过期 → 0（立即触发）
 * - 最远只排 `maxDelayMs`（默认 1 小时），避免长定时器被休眠/时钟跳变影响；
 *   到点后重新评估一次即可。
 *
 * @param {object[]} tasks
 * @param {number} [now]
 * @param {number} [maxDelayMs]
 * @returns {number|null}
 */
export function nextDueDelay(tasks, now = Date.now(), maxDelayMs = 60 * 60 * 1000) {
  let next = null;
  for (const t of tasks ?? []) {
    if (!t?.enabled || typeof t.nextRunAt !== 'number') continue;
    if (next === null || t.nextRunAt < next) next = t.nextRunAt;
  }
  if (next === null) return null;
  // +20ms 保证触发时 now >= nextRunAt，配合 due() 的 1s 容差
  return Math.min(Math.max(0, next - now + 20), maxDelayMs);
}

export class TaskStore {
  /** @param {string} path - tasks.json 的绝对路径 */
  constructor(path) {
    this.path = path;
    this.data = { version: VERSION, tasks: [] };
    this.dirty = false;
    /** 加载时文件的 mtime，用于检测"外部改过" */
    this.loadedMtime = 0;
    /**
     * 自上次加载以来的本地变更（操作日志）。
     * 写盘前若发现文件被外部改过，会重放这些操作，避免把 CLI 的改动覆盖掉。
     */
    this.ops = [];
  }

  async load() {
    const { stat } = await import('node:fs/promises');
    const st = await stat(this.path).catch(() => null);
    this.loadedMtime = st?.mtimeMs ?? 0;
    if (!existsSync(this.path)) return this;
    try {
      const raw = JSON.parse(await readFile(this.path, 'utf8'));
      if (raw && Array.isArray(raw.tasks)) {
        this.data = { version: VERSION, tasks: raw.tasks.filter((t) => t && t.id) };
      }
    } catch {
      this.data = { version: VERSION, tasks: [] };
    }
    // 补齐缺失的 nextRunAt
    for (const t of this.data.tasks) {
      if (!t.nextRunAt) {
        t.nextRunAt = computeNextRun(t.schedule, Date.now());
        this.dirty = true;
      }
    }
    return this;
  }

  async flush() {
    if (!this.dirty) return false;

    // 关键：写盘前检查文件是否被外部（CLI/另一个进程）改过。
    // 被改过就先读回磁盘，再重放我们自己的操作，避免用陈旧内存覆盖别人。
    const { stat } = await import('node:fs/promises');
    const st = await stat(this.path).catch(() => null);
    if (st && st.mtimeMs > this.loadedMtime && this.ops.length > 0) {
      const myOps = this.ops;
      await this.load();          // 读回外部最新状态
      this.ops = [];
      for (const op of myOps) this.#replay(op);   // 再叠加我们的变更
    }

    await mkdir(dirname(this.path), { recursive: true }).catch(() => {});
    const tmp = `${this.path}.tmp-${process.pid}`;
    await writeFile(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    await rename(tmp, this.path);
    const after = await stat(this.path).catch(() => null);
    this.loadedMtime = after?.mtimeMs ?? this.loadedMtime;
    this.ops = [];
    this.dirty = false;
    return true;
  }

  /** 把一条操作重放到当前内存状态（不记录日志，纯应用） */
  #replay(op) {
    if (op.kind === 'add') {
      if (!this.data.tasks.some((t) => t.id === op.task.id)) this.data.tasks.push(op.task);
      return;
    }
    if (op.kind === 'remove') {
      const i = this.data.tasks.findIndex((t) => t.id === op.id);
      if (i >= 0) this.data.tasks.splice(i, 1);
      return;
    }
    const t = this.data.tasks.find((x) => x.id === op.id);
    if (!t) return;
    if (op.kind === 'enabled') t.enabled = op.enabled;
    if (op.kind === 'schedule') {
      t.schedule = op.schedule;
      t.nextRunAt = op.nextRunAt;
      t.enabled = true;
    }
    if (op.kind === 'snooze') {
      if (op.schedule) t.schedule = op.schedule;
      t.nextRunAt = op.nextRunAt;
      t.enabled = true;
    }
    if (op.kind === 'run') {
      t.lastRunAt = new Date().toISOString();
      t.lastResult = op.ok ? 'ok' : String(op.result ?? 'error').slice(0, 200);
      if (t.schedule?.kind === 'once') {
        t.enabled = false;
        t.nextRunAt = null;
      } else {
        t.nextRunAt = computeNextRun(t.schedule, Date.now());
      }
    }
  }

  list() {
    return [...this.data.tasks];
  }

  get(id) {
    return this.data.tasks.find((t) => t.id === id);
  }

  /**
   * 按标题查找。先精确匹配，再双向包含匹配（忽略大小写与首尾空白）。
   * @param {string} query
   * @returns {object[]}
   */
  findByTitle(query) {
    const q = String(query ?? '').trim().toLowerCase();
    if (!q) return [];

    const titleOf = (t) => String(t.title ?? '').trim().toLowerCase();
    const exact = this.data.tasks.filter((t) => titleOf(t) === q);
    if (exact.length > 0) return exact;

    return this.data.tasks.filter((t) => {
      const title = titleOf(t);
      return title.includes(q) || q.includes(title);
    });
  }

  /**
   * 按 id 或标题解析任务。标题匹配到多个时抛出带候选列表的错误。
   * @param {string} selector
   * @returns {object|undefined}
   */
  resolve(selector) {
    const raw = String(selector ?? '').trim();
    if (!raw) return undefined;

    const byId = this.get(raw);
    if (byId) return byId;

    const matches = this.findByTitle(raw);
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) {
      const names = matches.map((t) => `「${t.title}」(${t.id})`).join('、');
      throw new Error(`「${raw}」匹配到多个任务：${names}，请改用 id`);
    }
    return undefined;
  }

  /**
   * @param {object} input
   * @param {object} input.schedule
   * @param {string} input.prompt
   * @param {string} [input.title]
   * @param {string} [input.peerId] - 默认用租户 ownerId
   * @param {boolean} [input.enabled]
   */
  add(input) {
    const task = {
      id: `task-${randomUUID().slice(0, 8)}`,
      title: input.title ?? input.prompt.slice(0, 20),
      enabled: input.enabled !== false,
      schedule: input.schedule,
      prompt: input.prompt,
      peerId: input.peerId ?? null,
      createdAt: new Date().toISOString(),
      lastRunAt: null,
      lastResult: null,
      nextRunAt: computeNextRun(input.schedule, Date.now()),
    };
    this.data.tasks.push(task);
    this.ops.push({ kind: 'add', task });
    this.dirty = true;
    return task;
  }

  remove(id) {
    const i = this.data.tasks.findIndex((t) => t.id === id);
    if (i < 0) return false;
    this.data.tasks.splice(i, 1);
    this.ops.push({ kind: 'remove', id });
    this.dirty = true;
    return true;
  }

  setEnabled(id, enabled) {
    const t = this.get(id);
    if (!t) return false;
    t.enabled = Boolean(enabled);
    if (t.enabled && !t.nextRunAt) {
      t.nextRunAt = computeNextRun(t.schedule, Date.now());
    }
    this.ops.push({ kind: 'enabled', id, enabled: Boolean(enabled) });
    this.dirty = true;
    return true;
  }

  /**
   * 修改计划时间，并按新计划重新计算下次运行。
   * 改时间等价于"这个任务重新生效"，因此会同时启用任务。
   *
   * @param {string} id
   * @param {object} schedule
   * @param {number} [from]
   * @returns {boolean} schedule 无法计算或任务不存在时返回 false
   */
  setSchedule(id, schedule, from = Date.now()) {
    const t = this.get(id);
    if (!t) return false;
    const next = computeNextRun(schedule, from);
    if (!next) return false;

    t.schedule = schedule;
    t.nextRunAt = next;
    t.enabled = true;
    this.ops.push({ kind: 'schedule', id, schedule, nextRunAt: next });
    this.dirty = true;
    return true;
  }

  /**
   * 稍后提醒：把下一次运行推迟到 now + minutes。
   * once 任务同时更新 schedule.at，保证列表/快照显示的是新时间；
   * 周期任务只改 nextRunAt，跑完后仍按原计划推进。
   *
   * @param {string} id
   * @param {number} [minutes]
   * @param {number} [from]
   * @returns {boolean}
   */
  snooze(id, minutes = 10, from = Date.now()) {
    const t = this.get(id);
    if (!t) return false;
    const mins = Number(minutes);
    if (!Number.isFinite(mins) || mins <= 0) return false;

    const nextRunAt = from + Math.round(mins * 60_000);
    let schedule = null;
    if (t.schedule?.kind === 'once') {
      schedule = { ...t.schedule, at: nextRunAt };
      t.schedule = schedule;
    }
    t.nextRunAt = nextRunAt;
    t.enabled = true;
    this.ops.push({ kind: 'snooze', id, nextRunAt, schedule });
    this.dirty = true;
    return true;
  }

  /**
   * 找出所有到点的任务。**不执行**，只返回。
   * @param {number} [now]
   * @returns {object[]}
   */
  due(now = Date.now()) {
    return this.data.tasks.filter(
      (t) => t.enabled && typeof t.nextRunAt === 'number' && t.nextRunAt <= now + DUE_GRACE_MS,
    );
  }

  /**
   * 标记任务已运行，并推进下次时间。
   * once 任务跑完自动停用（历史保留，便于查看）。
   */
  markRun(id, { ok, result }) {
    const t = this.get(id);
    if (!t) return;
    t.lastRunAt = new Date().toISOString();
    t.lastResult = ok ? 'ok' : String(result ?? 'error').slice(0, 200);
    if (t.schedule?.kind === 'once') {
      t.enabled = false;
      t.nextRunAt = null;
    } else {
      // 从"现在"推下一次，避免积压时连发
      const next = computeNextRun(t.schedule, Date.now());
      t.nextRunAt = next;
    }
    this.ops.push({ kind: 'run', id, ok, result: t.lastResult });
    this.dirty = true;
  }
}
