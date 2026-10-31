#!/usr/bin/env node
/**
 * 关闭控制器：双信号、deadline、退出码、stopAll 参数。
 * 全部注入 exit/定时器，不真的结束测试进程。
 */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import {
  DEFAULT_SHUTDOWN_TIMEOUT_MS,
  createShutdownController,
  shutdownTimeoutMs,
} from '../src/ops/shutdown.mjs';

import { createChecker } from './helpers/check.mjs';

const { check, done } = createChecker();

const tick = () => new Promise((r) => setTimeout(r, 0));

await check('默认 20s，环境变量可覆盖，非法值回落', () => {
  assert.strictEqual(DEFAULT_SHUTDOWN_TIMEOUT_MS, 20_000);
  assert.strictEqual(shutdownTimeoutMs({}), 20_000);
  assert.strictEqual(shutdownTimeoutMs({ BRIDGE_SHUTDOWN_TIMEOUT_MS: '5000' }), 5_000);
  assert.strictEqual(shutdownTimeoutMs({ BRIDGE_SHUTDOWN_TIMEOUT_MS: '0' }), 20_000);
  assert.strictEqual(shutdownTimeoutMs({ BRIDGE_SHUTDOWN_TIMEOUT_MS: 'abc' }), 20_000);
});

await check('第一次信号：优雅退出，stopAll 拿到 timeoutMs，exit(0)', async () => {
  const calls = [];
  const exits = [];
  const c = createShutdownController({
    stopAll: async (opts) => { calls.push(opts); },
    exit: (code) => exits.push(code),
    deadlineMs: 3000,
    log: () => {},
  });

  assert.strictEqual(c.handle('SIGTERM'), 'graceful');
  assert.strictEqual(c.running, true);
  await tick();
  assert.deepStrictEqual(calls, [{ timeoutMs: 3000 }]);
  assert.deepStrictEqual(exits, [0]);
  assert.strictEqual(c.finished, true);
  assert.strictEqual(c.running, false);
  // 完成后的信号被忽略
  assert.strictEqual(c.handle('SIGTERM'), 'ignored');
  assert.deepStrictEqual(exits, [0]);
});

await check('第二次信号：立即强制退出（exit 130）', async () => {
  const exits = [];
  let resolveStop;
  const stopPromise = new Promise((r) => { resolveStop = r; });
  const c = createShutdownController({
    stopAll: () => stopPromise,
    exit: (code) => exits.push(code),
    deadlineMs: 60_000,
    log: () => {},
  });

  assert.strictEqual(c.handle('SIGTERM'), 'graceful');
  assert.strictEqual(c.handle('SIGTERM'), 'forced');
  assert.deepStrictEqual(exits, [130]);
  assert.strictEqual(c.forced, true);

  // 之后 stopAll 完成也不能再 exit(0)
  resolveStop();
  await tick();
  assert.deepStrictEqual(exits, [130]);
});

await check('超过 deadline：强制退出（exit 130）', async () => {
  const exits = [];
  let armed = null;
  const timers = {
    setTimeout: (fn, ms) => { armed = { fn, ms }; return { unref() {} }; },
    clearTimeout: () => {},
  };
  const c = createShutdownController({
    stopAll: () => new Promise(() => {}),
    exit: (code) => exits.push(code),
    deadlineMs: 1234,
    timers,
    log: () => {},
  });

  c.handle('SIGTERM');
  assert.ok(armed, '应设置 deadline 定时器');
  assert.strictEqual(armed.ms, 1234);
  armed.fn();
  assert.deepStrictEqual(exits, [130]);
  assert.strictEqual(c.forced, true);
});

await check('强制退出前调用 onForce 记录未完成消息', () => {
  const logs = [];
  let called = 0;
  const exits = [];
  const c = createShutdownController({
    stopAll: () => new Promise(() => {}),
    exit: (code) => exits.push(code),
    deadlineMs: 50,
    onForce: () => {
      called += 1;
      return '强制退出：2 条消息未完成（m:1, m:2）';
    },
    timers: {
      setTimeout: (fn) => { fn(); return { unref() {} }; },
      clearTimeout: () => {},
    },
    log: (m) => logs.push(m),
  });

  c.handle('SIGTERM');
  assert.strictEqual(called, 1, 'onForce 只应调用一次');
  assert.ok(logs.some((m) => m.includes('2 条消息未完成')), '日志应包含放弃明细');
  assert.deepStrictEqual(exits, [130]);
});

await check('onForce 抛错不影响强制退出', () => {
  const logs = [];
  const exits = [];
  const c = createShutdownController({
    stopAll: () => new Promise(() => {}),
    exit: (code) => exits.push(code),
    deadlineMs: 50,
    onForce: () => { throw new Error('registry boom'); },
    timers: {
      setTimeout: (fn) => { fn(); return { unref() {} }; },
      clearTimeout: () => {},
    },
    log: (m) => logs.push(m),
  });

  c.handle('SIGTERM');
  assert.ok(logs.some((m) => m.includes('收集未完成消息失败')));
  assert.deepStrictEqual(exits, [130]);
});

await check('stopAll 抛错：exit(1)', async () => {
  const exits = [];
  const c = createShutdownController({
    stopAll: async () => { throw new Error('boom'); },
    exit: (code) => exits.push(code),
    log: () => {},
  });
  c.handle('SIGINT');
  await tick();
  assert.deepStrictEqual(exits, [1]);
});

await check('install 绑定 SIGTERM/SIGINT', async () => {
  const target = new EventEmitter();
  const calls = [];
  const c = createShutdownController({
    stopAll: async (opts) => { calls.push(opts); },
    exit: () => {},
    deadlineMs: 100,
    log: () => {},
  });
  c.install(target);
  target.emit('SIGINT');
  await tick();
  assert.strictEqual(calls.length, 1);
  assert.deepStrictEqual(calls[0], { timeoutMs: 100 });
});

await check('缺 stopAll 时显式报错', () => {
  assert.throws(() => createShutdownController({}), /stopAll/);
});

done();
