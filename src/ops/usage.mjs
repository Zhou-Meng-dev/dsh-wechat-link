/**
 * 用量统计：按租户累计 turn 数、token 用量与模型，支持日/月汇总与预算告警。
 *
 * 数据来源：DSH 的 `assistant/message` 事件带 `usage`（TokenUsage），
 * 由 ConversationManager 在每个回合结束后回调；一次回合可能有多条
 * assistant/message（工具调用循环），这里全部累加。
 *
 * 存储：租户根目录 `usage.json`（0600），按**本地日期**分桶：
 * {
 *   "version": 1,
 *   "days": {
 *     "2026-10-30": {
 *       "turns": 3, "failedTurns": 0,
 *       "inputTokens": 1200, "outputTokens": 800,
 *       "cacheReadTokens": 0, "cacheWriteTokens": 0,
 *       "totalTokens": 2000, "models": { "deepseek-flash": 3 }
 *     }
 *   },
 *   "alerts": { "day:2026-10-30": { "spent": 100000, "limit": 100000 } }
 * }
 *
 * 预算只看 token 总量（不猜价格：各模型单价会变，硬编码价格会撒谎）。
 * 阈值来自租户配置 `budgetTokensPerDay` / `budgetTokensPerMonth`；
 * 每个日/月周期只告警一次，避免每回合刷屏。
 */

import { EventEmitter } from 'node:events';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname } from 'node:path';

const VERSION = 1;
/** 明细按天保留多少天；月汇总由天桶推导，120 天足够覆盖当前月与上季度。 */
const DEFAULT_RETENTION_DAYS = 120;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

const TOKEN_FIELDS = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens'];

/** 本地日期键：YYYY-MM-DD（和日志/定时任务用同一个时区语义）。 */
export function dayKey(date = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}`;
}

/** 本地月份键：YYYY-MM */
export function monthKey(date = new Date()) {
  return dayKey(date).slice(0, 7);
}

/** 一个空的统计桶。 */
export function emptyBucket() {
  return {
    turns: 0,
    failedTurns: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 0,
    models: {},
  };
}

/** 把任意 TokenUsage 归一化成计数（缺失字段按 0）。 */
export function normalizeTokenUsage(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const out = {};
  for (const k of TOKEN_FIELDS) {
    const n = Number(src[k]);
    out[k] = Number.isFinite(n) && n > 0 ? n : 0;
  }
  const total = Number(src.totalTokens);
  out.totalTokens = Number.isFinite(total) && total > 0
    ? total
    : TOKEN_FIELDS.reduce((sum, k) => sum + out[k], 0);
  return out;
}

/** 把 src 的计数累加进 target；models 单独合并。 */
function addInto(target, src, turns = 0) {
  for (const k of TOKEN_FIELDS) target[k] += src[k] ?? 0;
  target.totalTokens += src.totalTokens ?? 0;
  target.turns += turns;
}

/** 深拷贝统计桶（避免调用方改到内部状态）。 */
function cloneBucket(bucket) {
  return {
    ...bucket,
    models: { ...bucket.models },
  };
}

/** 数字加千分位，日志/微信里都好读。 */
export function formatTokens(n) {
  const v = Math.max(0, Math.round(Number(n) || 0));
  return String(v).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** 解析 usage.json；结构不对时按空数据 --- 统计损坏不该阻塞服务。 */
function parseData(raw) {
  const data = { version: VERSION, days: {}, alerts: {} };
  if (!raw || typeof raw !== 'object') return data;
  if (raw.days && typeof raw.days === 'object') {
    for (const [key, value] of Object.entries(raw.days)) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(key) || !value || typeof value !== 'object') continue;
      const bucket = emptyBucket();
      bucket.turns = Math.max(0, Number(value.turns) || 0);
      bucket.failedTurns = Math.max(0, Number(value.failedTurns) || 0);
      for (const k of [...TOKEN_FIELDS, 'totalTokens']) {
        bucket[k] = Math.max(0, Number(value[k]) || 0);
      }
      if (value.models && typeof value.models === 'object') {
        for (const [model, count] of Object.entries(value.models)) {
          const n = Math.max(0, Number(count) || 0);
          if (n > 0) bucket.models[model] = n;
        }
      }
      data.days[key] = bucket;
    }
  }
  if (raw.alerts && typeof raw.alerts === 'object') {
    for (const [key, value] of Object.entries(raw.alerts)) {
      if (!value || typeof value !== 'object') continue;
      data.alerts[key] = {
        spent: Math.max(0, Number(value.spent) || 0),
        limit: Math.max(0, Number(value.limit) || 0),
      };
    }
  }
  return data;
}

/**
 * 汇总某个月的所有天桶。
 * @param {Record<string, object>} days
 * @param {string} month - YYYY-MM
 */
export function aggregateMonth(days, month) {
  const out = emptyBucket();
  const prefix = `${month}-`;
  for (const [key, bucket] of Object.entries(days ?? {})) {
    if (!key.startsWith(prefix)) continue;
    out.turns += bucket.turns;
    out.failedTurns += bucket.failedTurns;
    addInto(out, bucket);
    for (const [model, count] of Object.entries(bucket.models ?? {})) {
      out.models[model] = (out.models[model] ?? 0) + count;
    }
  }
  return out;
}

/**
 * 渲染一段给微信/CLI 看的用量报告。
 *
 * @param {object} summary - store.summary() 的返回
 * @param {object} [opts]
 * @param {string} [opts.title]
 * @param {boolean} [opts.showDay=true]
 * @param {boolean} [opts.showMonth=true]
 * @returns {string}
 */
export function formatUsageSummary(summary, opts = {}) {
  const title = opts.title ?? '用量统计';
  const lines = [`📈 ${title}`];

  const scopes = [
    ['day', '今日', opts.showDay !== false],
    ['month', '本月', opts.showMonth !== false],
  ];
  for (const [scope, label, visible] of scopes) {
    if (!visible) continue;
    const b = summary?.[scope];
    if (!b) continue;
    const key = b.key ? ` ${b.key}` : '';
    if (!b.turns) {
      lines.push(`${label}${key}: 暂无记录`);
      continue;
    }
    const failed = b.failedTurns > 0 ? `（失败 ${b.failedTurns}）` : '';
    lines.push(`${label}${key}: ${b.turns} 回合${failed} / ${formatTokens(b.totalTokens)} tokens`);
    lines.push(
      `  输入 ${formatTokens(b.inputTokens)}`
      + `（缓存读 ${formatTokens(b.cacheReadTokens)} / 写 ${formatTokens(b.cacheWriteTokens)}）`
      + ` · 输出 ${formatTokens(b.outputTokens)}`,
    );
  }

  const models = summary?.month?.models && Object.keys(summary.month.models).length
    ? summary.month.models
    : summary?.day?.models ?? {};
  const modelList = Object.entries(models)
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1]);
  if (modelList.length > 0) {
    lines.push(`模型: ${modelList.map(([name, n]) => `${name} × ${n}`).join('、')}`);
  }

  const budget = summary?.budget ?? {};
  const budgetParts = [];
  if (Number.isFinite(budget.day) && budget.day > 0) {
    budgetParts.push(`日 ${formatTokens(budget.day)}${budgetPercent(summary?.day?.totalTokens, budget.day)}`);
  }
  if (Number.isFinite(budget.month) && budget.month > 0) {
    budgetParts.push(`月 ${formatTokens(budget.month)}${budgetPercent(summary?.month?.totalTokens, budget.month)}`);
  }
  if (budgetParts.length > 0) lines.push(`预算: ${budgetParts.join(' / ')}`);

  return lines.join('\n');
}

function budgetPercent(spent, limit) {
  if (!Number.isFinite(spent) || !Number.isFinite(limit) || limit <= 0) return '';
  const pct = (spent / limit) * 100;
  return `（${pct >= 999 ? '999+' : pct.toFixed(1)}%）`;
}

export class UsageStore extends EventEmitter {
  /**
   * @param {object} opts
   * @param {string} opts.path - usage.json 的绝对路径
   * @param {{day?: number, month?: number}} [opts.budget] - token 预算
   * @param {() => Date} [opts.now] - 测试注入时钟
   * @param {number} [opts.retentionDays]
   */
  constructor({ path, budget = {}, now = () => new Date(), retentionDays = DEFAULT_RETENTION_DAYS }) {
    super();
    this.path = path;
    this.now = now;
    this.retentionDays = retentionDays;
    this.budget = {
      day: Number.isFinite(budget?.day) && budget.day > 0 ? budget.day : null,
      month: Number.isFinite(budget?.month) && budget.month > 0 ? budget.month : null,
    };
    this.data = { version: VERSION, days: {}, alerts: {} };
    this.dirty = false;
  }

  async load() {
    if (!existsSync(this.path)) return this;
    try {
      const raw = JSON.parse(await readFile(this.path, 'utf8'));
      this.data = parseData(raw);
    } catch {
      // 损坏就从空开始，不阻塞启动；下一次 record 会覆盖写回
      this.data = { version: VERSION, days: {}, alerts: {} };
    }
    if (this.#prune()) this.dirty = true;
    return this;
  }

  /**
   * 记录一个回合。
   *
   * @param {object} [info]
   * @param {Date} [info.at]
   * @param {string|null} [info.peerId]
   * @param {string} [info.model]
   * @param {object|null} [info.usage] - TokenUsage（可能缺字段）
   * @param {boolean} [info.ok=true]
   * @returns {object} 该回合累加后的日桶
   */
  record({ at = this.now(), peerId = null, model = 'unknown', usage = null, ok = true } = {}) {
    const key = dayKey(at);
    const bucket = this.#bucket(key);
    bucket.turns += 1;
    if (!ok) bucket.failedTurns += 1;

    const normalized = normalizeTokenUsage(usage);
    addInto(bucket, normalized, 0);

    const modelName = typeof model === 'string' && model.trim() ? model.trim() : 'unknown';
    bucket.models[modelName] = (bucket.models[modelName] ?? 0) + 1;

    this.dirty = true;
    this.#prune(at);
    this.#checkBudget(at);
    return cloneBucket(bucket);
  }

  /**
   * 日/月汇总。
   *
   * @param {object} [opts]
   * @param {Date} [opts.at]
   * @param {string} [opts.day]   - YYYY-MM-DD
   * @param {string} [opts.month] - YYYY-MM
   */
  summary({ at = this.now(), day = dayKey(at), month = day.slice(0, 7) } = {}) {
    return {
      day: { key: day, ...cloneBucket(this.#bucketOrEmpty(day)) },
      month: { key: month, ...cloneBucket(aggregateMonth(this.data.days, month)) },
      budget: { ...this.budget },
      updatedAt: at.toISOString(),
    };
  }

  /** 当前日桶（诊断/测试用）。 */
  dayBucket(day = dayKey(this.now())) {
    return cloneBucket(this.#bucketOrEmpty(day));
  }

  /** 原子写盘；无变更且未 force 时跳过。 */
  async flush(force = false) {
    if (!this.dirty && !force) return false;
    const dir = dirname(this.path);
    await mkdir(dir, { recursive: true }).catch(() => {});
    const tmp = `${this.path}.tmp-${process.pid}`;
    await writeFile(tmp, `${JSON.stringify(this.data, null, 2)}\n`, { mode: 0o600 });
    await rename(tmp, this.path);
    this.dirty = false;
    return true;
  }

  // ---------------------------------------------------------------- internals

  #bucket(key) {
    let bucket = this.data.days[key];
    if (!bucket) {
      bucket = emptyBucket();
      this.data.days[key] = bucket;
    }
    return bucket;
  }

  #bucketOrEmpty(key) {
    return this.data.days[key] ?? emptyBucket();
  }

  /** 清掉保留期外的天桶与过期告警键；返回是否有改动。 */
  #prune(at = this.now()) {
    let changed = false;
    const cutoffKey = dayKey(new Date(at.getTime() - this.retentionDays * MS_PER_DAY));
    for (const key of Object.keys(this.data.days)) {
      if (key < cutoffKey) {
        delete this.data.days[key];
        changed = true;
      }
    }

    const today = dayKey(at);
    const thisMonth = today.slice(0, 7);
    for (const key of Object.keys(this.data.alerts)) {
      const keep = key === `day:${today}` || key === `month:${thisMonth}`;
      if (!keep) {
        delete this.data.alerts[key];
        changed = true;
      }
    }
    return changed;
  }

  /** 跨过预算阈值时发一次事件；每个日/月周期只发一次。 */
  #checkBudget(at) {
    const today = dayKey(at);
    const thisMonth = today.slice(0, 7);
    const checks = [
      ['day', this.budget.day, today, this.data.days[today]?.totalTokens ?? 0],
      ['month', this.budget.month, thisMonth, aggregateMonth(this.data.days, thisMonth).totalTokens],
    ];

    for (const [scope, limit, key, spent] of checks) {
      if (!Number.isFinite(limit) || limit <= 0) continue;
      if (spent < limit) continue;
      const alertKey = `${scope}:${key}`;
      if (this.data.alerts[alertKey]) continue;
      this.data.alerts[alertKey] = { spent, limit };
      this.dirty = true;
      this.emit('alert', { scope, key, spent, limit });
    }
  }
}
