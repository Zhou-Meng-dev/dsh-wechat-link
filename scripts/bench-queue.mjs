#!/usr/bin/env node
/**
 * 队列压测（手动，Node 内置模块）：
 *   连续 push N 条消息，统计 push 延迟分位与 heapUsed 增量。
 *
 * 用途：观察队列在大量消息下的延迟分位与内存占用；结果只做参考，
 * 不写进文档，避免数字随机器漂移。
 *
 * 用法：
 *   node scripts/bench-queue.mjs            # 默认 10000 条
 *   BENCH_N=50000 node scripts/bench-queue.mjs
 */

import { performance } from 'node:perf_hooks';

import { UserMessageQueue } from '../src/wechat/message-queue.mjs';

const N = Number(process.env.BENCH_N) > 0 ? Math.floor(Number(process.env.BENCH_N)) : 10_000;

const queue = new UserMessageQueue({
  windowMs: 60_000,
  maxWaitMs: 60_000,
  handle: async () => {},
});

const latencies = new Array(N);
const heapBefore = process.memoryUsage().heapUsed;

const startedAt = performance.now();
for (let i = 0; i < N; i++) {
  const t = performance.now();
  const r = queue.push('bench-peer', { text: `第 ${i} 条消息`, journalId: `m:${i}` });
  latencies[i] = performance.now() - t;
  if (!r.accepted) throw new Error(`第 ${i} 条被拒绝：${r.reason}`);
}
const elapsedMs = performance.now() - startedAt;
const heapAfter = process.memoryUsage().heapUsed;

const sorted = [...latencies].sort((a, b) => a - b);
const percentile = (p) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];

const statsBeforeDrain = queue.stats();
await queue.drain({ timeoutMs: 5_000 });
const statsAfterDrain = queue.stats();

console.log(JSON.stringify({
  pushes: N,
  totalMs: Number(elapsedMs.toFixed(1)),
  pushPerSec: Math.round(N / (elapsedMs / 1000)),
  p50Ms: Number(percentile(0.5).toFixed(4)),
  p99Ms: Number(percentile(0.99).toFixed(4)),
  maxMs: Number(sorted.at(-1).toFixed(4)),
  heapUsedMbBefore: Number((heapBefore / 1024 / 1024).toFixed(2)),
  heapUsedMbAfterPush: Number((heapAfter / 1024 / 1024).toFixed(2)),
  heapUsedDeltaMb: Number(((heapAfter - heapBefore) / 1024 / 1024).toFixed(2)),
  pendingBeforeDrain: statsBeforeDrain.pending,
  pendingAfterDrain: statsAfterDrain.pending,
}, null, 2));
