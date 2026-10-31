#!/usr/bin/env node
/**
 * 任务执行链路：成功/失败记录、_tasks/history.json 快照、失败提示。
 *
 * 不启动 dsh/iLink；用假 conv/ilink 装配 TaskRuntime，再通过
 * Tenant.runTaskNow() 触发，任务数据走公开的 runtime.tasks。
 */
import assert from 'node:assert';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Tenant } from '../src/tenant.mjs';
import { OutboxStore } from '../src/wechat/outbox.mjs';

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

const root = await mkdtemp(join(tmpdir(), 'tenant-task-'));
const ws = join(root, 'workspace');
await mkdir(ws, { recursive: true });

const sent = [];
const t = new Tenant({
  id: 't-test',
  botId: 'test-bot',
  ownerId: 'user-1',
  allowUsers: ['user-1'],
  cwd: ws,
  root,
  token: 'test-token',
  baseUrl: 'http://127.0.0.1:1/',
  ackDelayMs: 60_000,
  maxChars: 1800,
}, { log: () => {} });

t.ilink = {
  sendText: async ({ toUserId, text, contextToken }) => {
    sent.push({ toUserId, text, contextToken });
    return { ret: 0 };
  },
  getConfig: async () => null,
  sendTyping: async () => {},
  notifyStop: async () => {},
};
const tokens = new Map([['user-1', 'ctx-1']]);
t.session = {
  ask: async () => { throw new Error('用例应覆盖 session.ask'); },
  reset: () => {},
  stats: () => null,
  getToken: (peer) => tokens.get(peer),
  setToken: (peer, token) => { if (token) tokens.set(peer, token); },
  flushTokens: async () => {},
};
t.outbox = new OutboxStore(join(root, 'outbox.json'));
await t.outbox.load();
// 使用生产同款装配工厂。
t.reply = t.createReplySender();
// 任务存储/历史由 TaskRuntime 创建；预置数据走公开的 runtime.tasks
t.taskRuntime = t.createTaskRuntime();
await t.taskRuntime.start();

await check('任务失败：记录历史 + 给 owner 发可操作提示', async () => {
  const task = t.taskRuntime.tasks.add({
    schedule: { kind: 'daily', time: '09:00' },
    prompt: '出题',
    title: '每日一题',
  });
  await t.taskRuntime.tasks.flush();

  t.session.ask = async () => { throw new Error('模型超时'); };
  const ok = await t.runTaskNow(task.id);
  assert.strictEqual(ok, true);

  assert.strictEqual(sent.length, 1);
  assert.strictEqual(sent[0].toUserId, 'user-1');
  assert.match(sent[0].text, /定时任务「每日一题」执行失败/);
  assert.match(sent[0].text, /模型超时/);
  assert.match(sent[0].text, /回复任意消息/);

  const after = t.taskRuntime.tasks.get(task.id);
  assert.match(after.lastResult, /模型超时/);

  const entry = t.taskRuntime.taskHistory.list().at(-1);
  assert.strictEqual(entry.ok, false);
  assert.strictEqual(entry.delivery, 'failed');
  assert.strictEqual(entry.title, '每日一题');
  assert.match(entry.result, /模型超时/);
  assert.ok(entry.durationMs >= 0);

  const snap = JSON.parse(await readFile(join(ws, '_tasks', 'history.json'), 'utf8'));
  assert.ok(snap.entries.some((e) => e.title === '每日一题' && e.ok === false));
});

await check('任务成功：记录结果但不额外打扰用户', async () => {
  sent.length = 0;
  const task = t.taskRuntime.tasks.add({
    schedule: { kind: 'daily', time: '10:00' },
    prompt: '出题',
    title: '成功任务',
  });
  await t.taskRuntime.tasks.flush();

  t.session.ask = async () => '今天的题目是：1+1 等于几？';
  await t.runTaskNow(task.id);

  assert.strictEqual(sent.length, 1);
  assert.strictEqual(sent[0].text, '今天的题目是：1+1 等于几？');
  assert.strictEqual(t.taskRuntime.tasks.get(task.id).lastResult, 'ok');

  const entry = t.taskRuntime.taskHistory.list().at(-1);
  assert.strictEqual(entry.ok, true);
  assert.strictEqual(entry.delivery, 'sent');
  assert.strictEqual(entry.taskId, task.id);
});

await check('任务返回 [[skip]]：记录结果但不发送消息', async () => {
  sent.length = 0;
  const task = t.taskRuntime.tasks.add({
    schedule: { kind: 'daily', time: '11:00' },
    prompt: '出题',
    title: '跳过任务',
  });
  await t.taskRuntime.tasks.flush();

  t.session.ask = async () => '[[skip]]';
  await t.runTaskNow(task.id);

  assert.strictEqual(sent.length, 0, 'skip 不应发送任何消息');
  assert.strictEqual(t.taskRuntime.tasks.get(task.id).lastResult, 'skipped');
  const entry = t.taskRuntime.taskHistory.list().at(-1);
  assert.strictEqual(entry.ok, true);
  assert.strictEqual(entry.delivery, 'skipped');
  assert.strictEqual(entry.result, 'skipped');
});

await check('任务不存在时 runTaskNow 返回 false', async () => {
  assert.strictEqual(await t.runTaskNow('task-nope'), false);
});

await check('预算 block：跳过任务、不调用 agent、历史 reason=budget', async () => {
  sent.length = 0;
  const task = t.taskRuntime.tasks.add({
    schedule: { kind: 'daily', time: '12:00' },
    prompt: '出题',
    title: '预算任务',
  });
  await t.taskRuntime.tasks.flush();

  let asks = 0;
  t.session.ask = async () => { asks += 1; return '不该被调用'; };
  t.taskRuntime.budgetGuard = {
    action: 'block',
    canSpend: () => ({ ok: false, reason: 'tenant-day', scope: 'tenant', window: 'day', spent: 100, limit: 100 }),
  };

  await t.runTaskNow(task.id);
  assert.strictEqual(asks, 0, '预算不足时不能调用 agent');
  assert.strictEqual(sent.length, 1);
  assert.match(sent[0].text, /预算/);
  assert.match(sent[0].text, /\/usage/);

  const entry = t.taskRuntime.taskHistory.list().at(-1);
  assert.strictEqual(entry.result, 'skipped');
  assert.strictEqual(entry.reason, 'budget');
  assert.strictEqual(entry.delivery, 'skipped');

  // 同一天第二个任务跳过时不再重复提示（每天一次）
  sent.length = 0;
  const task2 = t.taskRuntime.tasks.add({
    schedule: { kind: 'daily', time: '13:00' },
    prompt: '出题',
    title: '预算任务2',
  });
  await t.taskRuntime.tasks.flush();
  await t.runTaskNow(task2.id);
  assert.strictEqual(asks, 0);
  assert.strictEqual(sent.length, 0);
});

await check('预算跳过提示发给 owner（即使任务指向别的 peer）', async () => {
  sent.length = 0;
  t.noticeThrottle.reset('user-1', 'task-budget');
  const task = t.taskRuntime.tasks.add({
    peerId: 'user-2',
    schedule: { kind: 'daily', time: '15:00' },
    prompt: '出题',
    title: '他人任务',
  });
  await t.taskRuntime.tasks.flush();

  let asks = 0;
  t.session.ask = async () => { asks += 1; return '不该被调用'; };
  t.taskRuntime.budgetGuard = {
    action: 'block',
    canSpend: () => ({ ok: false, reason: 'tenant-day', scope: 'tenant', window: 'day', spent: 1, limit: 1 }),
  };

  await t.runTaskNow(task.id);
  assert.strictEqual(asks, 0);
  assert.strictEqual(sent.length, 1);
  assert.strictEqual(sent[0].toUserId, 'user-1', '预算提示必须发给 owner');
  t.taskRuntime.budgetGuard = null;
});

await check('预算 warn：任务照常执行', async () => {
  sent.length = 0;
  const task = t.taskRuntime.tasks.add({
    schedule: { kind: 'daily', time: '14:00' },
    prompt: '出题',
    title: 'warn 任务',
  });
  await t.taskRuntime.tasks.flush();

  let asks = 0;
  t.session.ask = async () => { asks += 1; return '正常回复'; };
  t.taskRuntime.budgetGuard = {
    action: 'warn',
    canSpend: () => ({ ok: false, reason: 'tenant-day', scope: 'tenant', window: 'day', spent: 999, limit: 100 }),
  };

  await t.runTaskNow(task.id);
  assert.strictEqual(asks, 1);
  assert.strictEqual(sent.at(-1).text, '正常回复');
  t.taskRuntime.budgetGuard = null;
});

await check('stop() 等在途任务结束（不超过 timeoutMs）', async () => {
  sent.length = 0;
  t.taskRuntime.budgetGuard = null;
  const task = t.taskRuntime.tasks.add({
    schedule: { kind: 'daily', time: '16:00' },
    prompt: '出题',
    title: '慢任务',
  });
  await t.taskRuntime.tasks.flush();

  let done = false;
  t.session.ask = async () => {
    await new Promise((r) => setTimeout(r, 80));
    done = true;
    return '慢回复';
  };

  const running = t.runTaskNow(task.id);
  await new Promise((r) => setTimeout(r, 10));
  await t.taskRuntime.stop({ timeoutMs: 1000 });

  assert.strictEqual(done, true, 'stop 必须等在途任务完成');
  assert.strictEqual(t.taskRuntime.inflight.size, 0);
  await running;
});

await rm(root, { recursive: true, force: true });

console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
