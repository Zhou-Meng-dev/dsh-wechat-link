/**
 * 关闭控制器：第一次信号优雅退出，第二次/超时强制退出。
 *
 * 为什么要单独成模块：
 *   关闭逻辑一旦写在 serve.mjs 里就只能靠起真实进程测试。
 *   这里把「stopAll / exit / 定时器 / 时钟」全部注入，进程级测试可以直接断言
 *   退出码与调用参数，不需要真的 kill 自己。
 *
 * 行为：
 *   - 第一次 SIGTERM/SIGINT → 'graceful'：调 stopAll({timeoutMs})，完成后 exit(0)
 *   - 第二次信号            → 'forced'：立即 exit(130)
 *   - 超过 deadlineMs       → 强制 exit(130)
 *   - stopAll 抛错          → exit(1)
 *
 * 默认 deadline 来自 BRIDGE_SHUTDOWN_TIMEOUT_MS（20s），必须小于部署模板的
 * terminationGracePeriodSeconds / stop_grace_period（30s）。
 */

export const DEFAULT_SHUTDOWN_TIMEOUT_MS = 20_000;

/** 读取环境变量里的关闭超时；非法值回落到默认值。 */
export function shutdownTimeoutMs(env = process.env) {
  const n = Number(env?.BRIDGE_SHUTDOWN_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_SHUTDOWN_TIMEOUT_MS;
}

/**
 * @param {object} opts
 * @param {(opts: {timeoutMs: number}) => Promise<void>} opts.stopAll
 * @param {(msg: string) => void} [opts.log]
 * @param {(code: number) => void} [opts.exit] - 注入 process.exit（测试）
 * @param {number} [opts.deadlineMs]
 * @param {() => number} [opts.now]
 * @param {{setTimeout: Function, clearTimeout: Function}} [opts.timers]
 * @returns {{handle: (signal?: string) => 'graceful'|'forced'|'ignored',
 *            install: (target?: object, signals?: string[]) => object,
 *            running: boolean, finished: boolean, forced: boolean}}
 */
export function createShutdownController({
  stopAll,
  log = () => {},
  exit = (code) => process.exit(code),
  deadlineMs = shutdownTimeoutMs(),
  now = Date.now,
  timers = { setTimeout, clearTimeout },
  onForce = null,
} = {}) {
  if (typeof stopAll !== 'function') {
    throw new Error('createShutdownController 需要 stopAll 函数');
  }

  let startedAt = null;
  let finished = false;
  let forced = false;
  let deadlineTimer = null;

  /** 强制退出：只执行一次，之后所有信号都忽略。 */
  const forceExit = (reason, code) => {
    if (finished) return;
    forced = true;
    finished = true;
    // 强制退出前把「还有哪些消息没做完」写进日志，否则只能靠猜。
    // onForce 由调用方注入（serve.mjs 从 TenantRegistry 收集），失败不影响退出。
    if (typeof onForce === 'function') {
      try {
        const detail = onForce();
        if (detail) log(detail);
      } catch (err) {
        log(`强制退出前收集未完成消息失败: ${err?.message ?? err}`);
      }
    }
    log(reason);
    if (deadlineTimer) {
      try { timers.clearTimeout(deadlineTimer); } catch { /* ignore */ }
      deadlineTimer = null;
    }
    exit(code);
  };

  const api = {
    handle(signal = 'SIGTERM') {
      if (forced) return 'ignored';
      if (finished) return 'ignored';

      // 第二次信号：不再等
      if (startedAt !== null) {
        forceExit(`收到第二次 ${signal}，立即退出`, 130);
        return 'forced';
      }

      startedAt = now();
      log(`收到 ${signal}，开始优雅退出（最多 ${deadlineMs}ms）…`);

      deadlineTimer = timers.setTimeout(() => {
        forceExit(`优雅退出超时（${deadlineMs}ms），强制退出`, 130);
      }, Math.max(0, deadlineMs));
      deadlineTimer?.unref?.();

      Promise.resolve()
        .then(() => stopAll({ timeoutMs: Math.max(0, deadlineMs) }))
        .then(() => {
          if (finished) return;
          finished = true;
          if (deadlineTimer) {
            timers.clearTimeout(deadlineTimer);
            deadlineTimer = null;
          }
          log('已优雅退出');
          exit(0);
        })
        .catch((err) => {
          if (finished) return;
          finished = true;
          if (deadlineTimer) {
            timers.clearTimeout(deadlineTimer);
            deadlineTimer = null;
          }
          log(`优雅退出时出错: ${err?.message ?? err}`);
          exit(1);
        });

      return 'graceful';
    },

    /** 挂到 process（或测试注入的 EventEmitter）上。 */
    install(target = process, signals = ['SIGTERM', 'SIGINT']) {
      for (const signal of signals) {
        target.on(signal, () => api.handle(signal));
      }
      return api;
    },

    get running() {
      return startedAt !== null && !finished;
    },
    get finished() {
      return finished;
    },
    get forced() {
      return forced;
    },
  };

  return api;
}
