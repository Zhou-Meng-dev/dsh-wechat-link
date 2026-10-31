#!/usr/bin/env node
/**
 * 退避策略（retry-policy）：指数增长、5 分钟上限、可注入抖动、非法输入兜底。
 *
 * 与 send-errors.test.mjs 分开：错误分类与「等多久再试」是两个模块，
 * 前者决定要不要重试，后者决定退避曲线。
 */
import assert from 'node:assert/strict';

import {
  DEFAULT_MAX_DELAY_MS,
  DEFAULT_RETRY_BASE_MS,
  nextAttemptDelay,
} from '../src/wechat/retry-policy.mjs';

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

await check('默认基线与上限', () => {
  assert.strictEqual(DEFAULT_RETRY_BASE_MS, 2_000);
  assert.strictEqual(DEFAULT_MAX_DELAY_MS, 300_000);
});

await check('指数退避：2s 起、按倍数增长', () => {
  const noJitter = { random: () => 0 };
  assert.strictEqual(nextAttemptDelay(1, noJitter), 2_000);
  assert.strictEqual(nextAttemptDelay(2, noJitter), 4_000);
  assert.strictEqual(nextAttemptDelay(3, noJitter), 8_000);
  assert.strictEqual(nextAttemptDelay(4, noJitter), 16_000);
});

await check('上限 5 分钟', () => {
  for (const attempts of [30, 100, 1000]) {
    assert.strictEqual(nextAttemptDelay(attempts, { random: () => 1 }), DEFAULT_MAX_DELAY_MS);
  }
});

await check('抖动不超过 20%，且可注入随机源', () => {
  const low = nextAttemptDelay(1, { random: () => 0 });
  const high = nextAttemptDelay(1, { random: () => 1 });
  assert.strictEqual(low, 2_000);
  assert.strictEqual(high, 2_400);
  assert.ok(high / low <= 1.2 + 1e-9);
});

await check('非法 attempts 按 1 处理', () => {
  assert.strictEqual(nextAttemptDelay(0, { random: () => 0 }), 2_000);
  assert.strictEqual(nextAttemptDelay(-5, { random: () => 0 }), 2_000);
  assert.strictEqual(nextAttemptDelay(NaN, { random: () => 0 }), 2_000);
});

console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
