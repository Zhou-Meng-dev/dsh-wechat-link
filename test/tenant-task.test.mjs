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

await check('任务不存在时 runTaskNow 返回 false', async () => {
  assert.strictEqual(await t.runTaskNow('task-nope'), false);
});

await t.taskRuntime.stop();
await rm(root, { recursive: true, force: true });

console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
