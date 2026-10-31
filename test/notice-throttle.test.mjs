#!/usr/bin/env node
/**
 * 提示节流：同一 peer + key 在窗口内只发一次，Map 有上限。
 */
import assert from 'node:assert/strict';

import { DEFAULT_NOTICE_WINDOW_MS, NoticeThrottle } from '../src/wechat/notice-throttle.mjs';

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

await check('同一 peer + key 在窗口内只放行一次', () => {
  let now = 0;
  const t = new NoticeThrottle({ windowMs: 1000, now: () => now });
  assert.strictEqual(t.canSend('u1', 'dlq'), true);
  assert.strictEqual(t.canSend('u1', 'dlq'), false);
  now += 999;
  assert.strictEqual(t.canSend('u1', 'dlq'), false);
  now += 1;
  assert.strictEqual(t.canSend('u1', 'dlq'), true);
});

await check('不同 peer / 不同 key 互不影响', () => {
  let now = 0;
  const t = new NoticeThrottle({ windowMs: 1000, now: () => now });
  assert.strictEqual(t.canSend('u1', 'dlq'), true);
  assert.strictEqual(t.canSend('u2', 'dlq'), true);
  assert.strictEqual(t.canSend('u1', 'rate'), true);
  assert.strictEqual(t.canSend('u1', 'dlq'), false);
});

await check('默认窗口 5 分钟', () => {
  assert.strictEqual(DEFAULT_NOTICE_WINDOW_MS, 5 * 60 * 1000);
});

await check('Map 上限：超出后淘汰最旧 key', () => {
  let now = 0;
  const t = new NoticeThrottle({ windowMs: 0, maxEntries: 2, now: () => now });
  assert.strictEqual(t.canSend('a', 'x'), true);
  assert.strictEqual(t.canSend('b', 'x'), true);
  assert.strictEqual(t.canSend('c', 'x'), true);
  assert.strictEqual(t.stats().keys, 2);
  // a 已被淘汰，再问一次会重新放行
  assert.strictEqual(t.canSend('a', 'x'), true);
});

await check('reset 可清掉指定 key', () => {
  const t = new NoticeThrottle({ windowMs: 60_000, now: () => 0 });
  assert.strictEqual(t.canSend('u1', 'k'), true);
  assert.strictEqual(t.canSend('u1', 'k'), false);
  t.reset('u1', 'k');
  assert.strictEqual(t.canSend('u1', 'k'), true);
});

await check('单次调用可覆盖窗口（任务预算提示按每天一次）', () => {
  let now = 0;
  const t = new NoticeThrottle({ windowMs: 5 * 60 * 1000, now: () => now });
  const DAY = 24 * 60 * 60 * 1000;
  assert.strictEqual(t.canSend('owner', 'task-budget', { windowMs: DAY }), true);
  now += 6 * 60 * 1000;
  assert.strictEqual(t.canSend('owner', 'task-budget', { windowMs: DAY }), false, '未到 24h 不应放行');
  now += DAY;
  assert.strictEqual(t.canSend('owner', 'task-budget', { windowMs: DAY }), true);
});

console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
