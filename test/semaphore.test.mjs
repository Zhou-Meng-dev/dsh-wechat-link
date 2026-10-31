#!/usr/bin/env node
/**
 * 并发信号量：排队、超时、释放幂等。
 */
import assert from 'node:assert/strict';

import { Semaphore } from '../src/wechat/semaphore.mjs';

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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await check('limit=2：第 3 个排队，释放后继续', async () => {
  const sem = new Semaphore(2);
  const order = [];
  const r1 = await sem.acquire();
  const r2 = await sem.acquire();
  assert.deepStrictEqual(sem.stats(), { limit: 2, active: 2, waiting: 0 });

  let thirdStarted = false;
  const third = sem.acquire().then((release) => {
    thirdStarted = true;
    order.push('third');
    return release;
  });
  await sleep(10);
  assert.strictEqual(thirdStarted, false, '超过上限必须排队');
  assert.strictEqual(sem.stats().waiting, 1);

  r1();
  const r3 = await third;
  assert.strictEqual(thirdStarted, true);
  assert.deepStrictEqual(order, ['third']);
  assert.strictEqual(sem.stats().active, 2, '名额是转交，不是新增');

  r2(); r3();
  assert.deepStrictEqual(sem.stats(), { limit: 2, active: 0, waiting: 0 });
});

await check('release 幂等：重复调用不会放大并发', async () => {
  const sem = new Semaphore(1);
  const release = await sem.acquire();
  release();
  release();
  assert.strictEqual(sem.stats().active, 0);
  const again = await sem.acquire();
  assert.ok(again);
  again();
});

await check('acquire({timeoutMs}) 超时返回 null 且不留下等待者', async () => {
  const sem = new Semaphore(1);
  const release = await sem.acquire();
  const got = await sem.acquire({ timeoutMs: 20 });
  assert.strictEqual(got, null);
  assert.deepStrictEqual(sem.stats(), { limit: 1, active: 1, waiting: 0 });
  release();
});

await check('limit 非法时回落到 1', () => {
  assert.strictEqual(new Semaphore(0).stats().limit, 1);
  assert.strictEqual(new Semaphore(NaN).stats().limit, 1);
});

console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
