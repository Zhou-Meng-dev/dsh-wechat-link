/**
 * 带超时的等待：关闭流程里到处是「等在途工作，但必须共享同一个截止时间」。
 *
 * 定时器一律 unref()，避免一个等待中的超时把进程留活；
 * 超时不是错误，调用方只需要知道「等完了没有」，自己决定记哪些放弃项。
 */

const DONE = Symbol('done');
const TIMEOUT = Symbol('timeout');

/**
 * @param {Promise<unknown>|PromiseLike<unknown>} promise
 * @param {number} timeoutMs
 * @returns {Promise<{timedOut: boolean}>}
 */
export async function raceWithTimeout(promise, timeoutMs) {
  const ms = Math.max(0, Number(timeoutMs) || 0);
  let timer = null;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(TIMEOUT), ms);
    timer.unref?.();
  });

  const outcome = await Promise.race([Promise.resolve(promise).then(() => DONE), timeout]);
  if (timer) clearTimeout(timer);
  return { timedOut: outcome === TIMEOUT };
}
