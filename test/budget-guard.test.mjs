#!/usr/bin/env node
/**
 * 预算硬拦截判定：warn 永远放行，block 只在 canSpend 拒绝时返回结果。
 */
import assert from 'node:assert/strict';

import { budgetBlocked } from '../src/ops/budget-guard.mjs';

import { createChecker } from './helpers/check.mjs';

const { check, done } = createChecker();

const denied = { ok: false, reason: 'user-day', scope: 'user', window: 'day', spent: 100, limit: 100 };

await check('warn 模式永远放行（超限由 usage 提醒）', () => {
  assert.strictEqual(budgetBlocked({ action: 'warn', canSpend: () => denied }, 'u1'), null);
});

await check('block 模式：canSpend 拒绝时返回检查结果', () => {
  assert.strictEqual(budgetBlocked({ action: 'block', canSpend: () => denied }, 'u1'), denied);
});

await check('block 模式：canSpend 放行时返回 null', () => {
  assert.strictEqual(budgetBlocked({ action: 'block', canSpend: () => ({ ok: true }) }, 'u1'), null);
});

await check('没有 guard / 没有 canSpend 时不拦截', () => {
  assert.strictEqual(budgetBlocked(null, 'u1'), null);
  assert.strictEqual(budgetBlocked(undefined, 'u1'), null);
  assert.strictEqual(budgetBlocked({ action: 'block' }, 'u1'), null);
});

done();
