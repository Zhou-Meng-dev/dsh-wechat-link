/**
 * 入站长轮询：从 iLink 拉一批消息，先落盘（游标 + 待处理消息），再交给流水线。
 *
 * 从 Tenant 里拆出来的原因：这段逻辑（反压、游标时机、匿名 id、磁盘失败退避）
 * 有自己的不变量，和租户装配（会话/任务/用量/关闭）不是同一类改动。
 *
 * 不变量（详见 docs 计划 §3.2）：
 *   - `admit` 写盘成功之前，游标绝不前进；
 *   - pending 满时反压轮询（等待），不丢消息；
 *   - 写盘失败时退避并重拉同一批；
 *   - 关闭中不进入长退避（否则会吃掉整个关闭预算）。
 */

import { inboundFieldNames, inboundMessageKey } from './inbound-journal.mjs';

const INITIAL_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 15_000;
/** pending 满时反压等待：服务端会保留未拉取的消息 */
const BACKPRESSURE_WAIT_MS = 500;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * @param {object} opts
 * @param {{getUpdates(): Promise<object>, advanceCursor(buf?: string): void}} opts.ilink
 * @param {{isFull(): boolean, get cursor(): string, admit(buf: string, entries: object[]): Promise<{accepted: object[]}>}|null} opts.journal
 * @param {{push(msg: object, meta?: object): object}} opts.inbound
 * @param {(msg: string) => void} opts.log
 * @param {() => boolean} opts.isRunning - 每轮循环检查：租户是否仍在运行
 * @param {() => void} [opts.onExpired] - 登录失效（errcode -14）时回调
 * @param {boolean} [opts.debugInboundIds] - 打印首条消息的字段名（只打键名，不打内容）
 */
export function createInboundPoller({
  ilink,
  journal,
  inbound,
  log,
  isRunning,
  onExpired,
  debugInboundIds = false,
}) {
  let backoff = INITIAL_BACKOFF_MS;
  let anonSeq = 0;
  let idProbeLogged = false;

  return {
    async run() {
      while (isRunning()) {
        // pending 满时反压轮询，而不是丢消息：服务端会保留未拉取的消息。
        if (journal?.isFull()) {
          await sleep(BACKPRESSURE_WAIT_MS);
          continue;
        }

        let resp;
        try {
          resp = await ilink.getUpdates();
        } catch (err) {
          // 关闭中：不要用一个 15s 的退避吃掉整个关闭预算
          if (!isRunning()) break;
          // 长轮询超时属正常
          backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
          await sleep(backoff);
          continue;
        }
        backoff = INITIAL_BACKOFF_MS;

        // 会话失效
        if (resp.errcode === -14) {
          log('❌ 登录已失效（errcode -14），本租户停止。请重新扫码添加。');
          onExpired?.();
          return;
        }

        const msgs = Array.isArray(resp.msgs) ? resp.msgs : [];
        // 诊断：确认去重 id 的字段名（只打印字段名，不打内容），每条连接一次
        if (!idProbeLogged && msgs.length > 0 && debugInboundIds) {
          idProbeLogged = true;
          log(`🔍 入站消息字段名（诊断用）: ${inboundFieldNames(msgs[0]).join(', ')}`);
        }
        if (!journal) {
          // 理论上 start() 一定会装配 journal；退化路径保持旧行为，不阻塞收消息
          ilink.advanceCursor(resp.get_updates_buf);
          for (const msg of msgs) inbound.push(msg);
          continue;
        }

        if (msgs.length === 0
          && (!resp.get_updates_buf || resp.get_updates_buf === journal.cursor)) {
          continue;
        }

        const entries = [];
        let anon = 0;
        for (const msg of msgs) {
          const key = inboundMessageKey(msg);
          let id = key.id;
          if (!id) {
            anonSeq += 1;
            id = `anon-${Date.now().toString(36)}-${anonSeq}`;
            anon += 1;
          }
          entries.push({ id, msg, weak: key.strength === 'weak' });
        }
        if (anon > 0) {
          log(`⚠️ ${anon} 条消息缺少可用 id，无法可靠去重（已按一次性 id 处理）`);
        }

        let admitted;
        try {
          // 先落盘游标 + 待处理消息；这一步成功之前游标绝不前进
          admitted = await journal.admit(resp.get_updates_buf, entries);
        } catch (err) {
          if (!isRunning()) break;
          // 写盘失败（磁盘满等）：内存游标不前进，退避后重试同一批
          backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
          log(`❌ 入站日志写盘失败（游标未推进，${backoff}ms 后重试）: ${err.message}`);
          await sleep(backoff);
          continue;
        }

        ilink.advanceCursor(resp.get_updates_buf);
        for (const entry of admitted.accepted) {
          inbound.push(entry.msg, { journalId: entry.id });
        }
      }
    },
  };
}
