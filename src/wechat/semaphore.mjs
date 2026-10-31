/**
 * 信号量：限制同时执行的回合数（每租户全局并发上限）。
 *
 * 语义：
 *   - acquire() 拿不到名额就排队等待，不拒绝（契约是「排队等待」）
 *   - 返回一个 release 函数；调用方必须在 finally 里释放
 *   - acquire({ timeoutMs }) 超时返回 null（当前只在测试/诊断用）
 *
 * 不引入依赖，30 行核心逻辑；统计字段供 status 使用。
 */

export class Semaphore {
  /** @param {number} limit - 同时执行上限（>=1） */
  constructor(limit = 1) {
    this.limit = Number.isFinite(limit) && limit >= 1 ? Math.floor(limit) : 1;
    this.active = 0;
    /** @type {{resolve: Function, timer: any}[]} */
    this.waiters = [];
  }

  /**
   * @param {{timeoutMs?: number}} [opts] - 0 表示一直等
   * @returns {Promise<(() => void)|null>} release 函数；超时返回 null
   */
  acquire({ timeoutMs = 0 } = {}) {
    if (this.active < this.limit) {
      this.active += 1;
      return Promise.resolve(this.#releaser());
    }

    return new Promise((resolve) => {
      const waiter = { resolve, timer: null };
      if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
        waiter.timer = setTimeout(() => {
          const i = this.waiters.indexOf(waiter);
          if (i >= 0) this.waiters.splice(i, 1);
          resolve(null);
        }, timeoutMs);
      }
      this.waiters.push(waiter);
    });
  }

  /** 释放一个名额；有等待者时直接把名额转交给队首（active 不变）。 */
  release() {
    const next = this.waiters.shift();
    if (next) {
      if (next.timer) clearTimeout(next.timer);
      next.resolve(this.#releaser());
      return;
    }
    this.active = Math.max(0, this.active - 1);
  }

  stats() {
    return { limit: this.limit, active: this.active, waiting: this.waiters.length };
  }

  /** 每个持有者拿到的 release 只能生效一次，避免重复释放放大并发。 */
  #releaser() {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.release();
    };
  }
}
