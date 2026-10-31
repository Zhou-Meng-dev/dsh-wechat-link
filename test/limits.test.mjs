#!/usr/bin/env node
/**
 * 输入上限：截断（纯函数）、令牌桶、每日回合计数、租户门面。
 *
 * 时间全部注入；跨天用假时钟，不依赖当天日期。
 */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  RateLimiter,
  TenantLimits,
  TurnCounter,
  truncateForModel,
} from '../src/wechat/limits.mjs';

let pass = 0;
let fail = 0;
async function check(desc, fn) {
  try {
    await fn();
    console.log(`✅ ${desc}`);
    pass++;
  } catch (err) {
    console.log(`❌ ${desc}\n   ${err.message}`);
    fail++;
  }
}

const root = await mkdtemp(join(tmpdir(), 'limits-'));

// ---------------------------------------------------------------- 截断

await check('truncateForModel：短消息原样返回', () => {
  const r = truncateForModel('短消息', 100);
  assert.deepStrictEqual(r, { text: '短消息', truncated: false, originalLength: 3 });
});

await check('truncateForModel：等于上限不截断', () => {
  const r = truncateForModel('12345', 5);
  assert.strictEqual(r.truncated, false);
  assert.strictEqual(r.text, '12345');
});

await check('truncateForModel：超长截断并标注原长', () => {
  const text = 'a'.repeat(20) + 'b'.repeat(10);
  const r = truncateForModel(text, 20);
  assert.strictEqual(r.truncated, true);
  assert.strictEqual(r.originalLength, 30);
  assert.ok(r.text.startsWith('a'.repeat(20)));
  assert.ok(!r.text.includes('b'.repeat(10)));
  assert.match(r.text, /消息过长，已截断，原长 30 字/);
});

await check('truncateForModel：maxChars<=0 或非数字视为不限', () => {
  assert.strictEqual(truncateForModel('abc', 0).truncated, false);
  assert.strictEqual(truncateForModel('abc', -5).truncated, false);
  assert.strictEqual(truncateForModel('abc', NaN).truncated, false);
});

// ---------------------------------------------------------------- 令牌桶

await check('令牌桶：容量等于每分钟速率，用完后拒绝并给出等待时间', () => {
  let now = 0;
  const limiter = new RateLimiter({ perMinute: 3, now: () => now });
  assert.strictEqual(limiter.take('u1').ok, true);
  assert.strictEqual(limiter.take('u1').ok, true);
  assert.strictEqual(limiter.take('u1').ok, true);
  const denied = limiter.take('u1');
  assert.strictEqual(denied.ok, false);
  assert.ok(denied.retryAfterMs > 0);
  // 3/min = 每 20s 补一个
  assert.ok(denied.retryAfterMs <= 20_000);
});

await check('令牌桶：按时间补充，不会一次充满', () => {
  let now = 0;
  const limiter = new RateLimiter({ perMinute: 60, now: () => now }); // 1 个/秒
  for (let i = 0; i < 60; i++) assert.strictEqual(limiter.take('u1').ok, true);
  assert.strictEqual(limiter.take('u1').ok, false);
  now += 1000;
  assert.strictEqual(limiter.take('u1').ok, true);
  assert.strictEqual(limiter.take('u1').ok, false);
});

await check('令牌桶：不同用户互不影响', () => {
  let now = 0;
  const limiter = new RateLimiter({ perMinute: 1, now: () => now });
  assert.strictEqual(limiter.take('a').ok, true);
  assert.strictEqual(limiter.take('a').ok, false);
  assert.strictEqual(limiter.take('b').ok, true);
});

await check('令牌桶：Map 上限淘汰最旧 key', () => {
  let now = 0;
  const limiter = new RateLimiter({ perMinute: 1, now: () => now, maxKeys: 2 });
  limiter.take('a');
  limiter.take('b');
  limiter.take('c');
  assert.strictEqual(limiter.stats().keys, 2);
  // a 被淘汰后重新拥有满桶
  assert.strictEqual(limiter.take('a').ok, true);
});

// ---------------------------------------------------------------- 每日回合

await check('每日回合：达到上限后拒绝，跨天自动重置', async () => {
  const path = join(root, 'limits-day.json');
  let day = new Date(2026, 9, 31, 10, 0, 0);
  const counter = new TurnCounter({ path, limit: 2, now: () => day });
  await counter.load();

  assert.deepStrictEqual(counter.allow('u1'), { ok: true, used: 0, limit: 2 });
  assert.strictEqual(await counter.recordTurn('u1'), 1);
  assert.strictEqual(await counter.recordTurn('u1'), 2);
  assert.deepStrictEqual(counter.allow('u1'), { ok: false, used: 2, limit: 2 });
  assert.strictEqual(counter.allow('u2').ok, true, '不同用户独立计数');

  // 跨天：整体重置
  day = new Date(2026, 10, 1, 0, 0, 1);
  assert.deepStrictEqual(counter.allow('u1'), { ok: true, used: 0, limit: 2 });
});

await check('每日回合：重启后从 limits.json 恢复', async () => {
  const path = join(root, 'limits-persist.json');
  const now = () => new Date(2026, 9, 31, 12, 0, 0);
  const a = new TurnCounter({ path, limit: 5, now });
  await a.load();
  await a.recordTurn('u1');
  await a.recordTurn('u1');

  const b = new TurnCounter({ path, limit: 5, now });
  await b.load();
  assert.deepStrictEqual(b.allow('u1'), { ok: true, used: 2, limit: 5 });
  const raw = JSON.parse(await readFile(path, 'utf8'));
  assert.strictEqual(raw.version, 1);
  assert.strictEqual(raw.day, '2026-10-31');
  assert.strictEqual(raw.peers.u1.turns, 2);
  assert.strictEqual((await stat(path)).mode & 0o777, 0o600);
});

await check('每日回合：上限 0 = 不限，不写盘也能 allow', () => {
  const counter = new TurnCounter({ path: join(root, 'unused.json'), limit: 0, now: () => new Date() });
  for (let i = 0; i < 100; i++) assert.strictEqual(counter.allow('u1').ok, true);
});

await check('每日回合：peers 上限按 lastAt 淘汰最旧', async () => {
  let now = new Date(2026, 9, 31, 12, 0, 0);
  const counter = new TurnCounter({ path: join(root, 'limits-cap.json'), limit: 10, maxPeers: 2, now: () => now });
  await counter.load();
  await counter.recordTurn('a');
  now = new Date(2026, 9, 31, 12, 0, 1);
  await counter.recordTurn('b');
  now = new Date(2026, 9, 31, 12, 0, 2);
  await counter.recordTurn('c');
  assert.strictEqual(counter.stats().peers, 2);
  assert.strictEqual(counter.allow('a').used, 0, '最旧的 a 已被淘汰');
  assert.strictEqual(counter.allow('c').used, 1);
});

// ---------------------------------------------------------------- 门面

await check('TenantLimits：默认值与统一入口', async () => {
  const limits = new TenantLimits({
    path: join(root, 'facade.json'),
    queueMaxPerPeer: 5,
    ratePerMinute: 2,
    turnsPerDay: 3,
    maxMessageChars: 10,
    now: () => new Date(2026, 9, 31, 12, 0, 0),
  });
  await limits.load();
  assert.strictEqual(limits.queueMaxPerPeer, 5);
  assert.strictEqual(limits.take('u1').ok, true);
  assert.strictEqual(limits.take('u1').ok, true);
  assert.strictEqual(limits.take('u1').ok, false);
  assert.strictEqual(limits.allowDay('u1').ok, true);
  await limits.recordTurn('u1');
  assert.strictEqual(limits.truncate('a'.repeat(20)).truncated, true);
  const s = limits.stats();
  assert.strictEqual(s.queueMaxPerPeer, 5);
  assert.strictEqual(s.ratePerMinute, 2);
  assert.strictEqual(s.turnsPerDay, 3);
  assert.strictEqual(s.maxMessageChars, 10);
  assert.strictEqual(s.turns.day, '2026-10-31');
});

await rm(root, { recursive: true, force: true });

console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
