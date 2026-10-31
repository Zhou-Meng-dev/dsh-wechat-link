/**
 * 出站重试的退避策略（纯函数，便于注入假时钟/假随机）。
 *
 * 退避曲线：baseMs × factor^(attempts-1)，上限 maxDelayMs，再加 0–20% 抖动。
 * 默认 2s → 4s → 8s → 16s → 32s → 64s（上限 5 分钟）。
 *
 * `attempts` 的语义是「已经失败过的次数」：attempts=1 表示第一次失败后
 * 该等多久再试。这样调用方在 markAttempt 时可以直接传累加后的值。
 */

/** 第一次重试前的等待 */
export const DEFAULT_RETRY_BASE_MS = 2_000;
/** 指数退避的倍数 */
export const DEFAULT_RETRY_FACTOR = 2;
/** 单次等待上限（5 分钟） */
export const DEFAULT_MAX_DELAY_MS = 300_000;
/** 失败达到这个次数就进 DLQ */
export const DEFAULT_MAX_ATTEMPTS = 6;

/**
 * 计算下一次重试前的等待时间。
 *
 * @param {number} attempts - 已经失败的次数（>=1）
 * @param {object} [opts]
 * @param {number} [opts.baseMs]
 * @param {number} [opts.factor]
 * @param {number} [opts.maxDelayMs]
 * @param {() => number} [opts.random] - 注入随机源，返回 [0,1)
 * @param {number} [opts.jitter=0.2]  - 抖动比例上限
 * @returns {number} 毫秒
 */
export function nextAttemptDelay(attempts, {
  baseMs = DEFAULT_RETRY_BASE_MS,
  factor = DEFAULT_RETRY_FACTOR,
  maxDelayMs = DEFAULT_MAX_DELAY_MS,
  random = Math.random,
  jitter = 0.2,
} = {}) {
  const n = Math.max(1, Math.floor(Number(attempts) || 1));
  const raw = baseMs * Math.pow(factor, n - 1);
  const capped = Math.min(raw, maxDelayMs);
  const r = Math.max(0, Math.min(1, Number(random()) || 0));
  const jittered = capped * (1 + r * Math.max(0, jitter));
  return Math.round(Math.min(jittered, maxDelayMs));
}
