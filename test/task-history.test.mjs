#!/usr/bin/env node
/**
 * 任务执行历史：追加、上限、持久化、快照与失败提示文案。
 */
import assert from 'node:assert';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  TaskHistory,
  DEFAULT_MAX_ENTRIES,
  formatTaskFailureNotice,
  writeTaskHistorySnapshot,
} from '../src/tasks/task-history.mjs';

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

const root = await mkdtemp(join(tmpdir(), 'task-history-'));
const ws = join(root, 'ws');

await check('默认最多保留 200 条', () => {
  assert.strictEqual(DEFAULT_MAX_ENTRIES, 200);
});

await check('append 记录成功/失败并保留最近记录', () => {
  const h = new TaskHistory(join(root, 'a.json'), { maxEntries: 3 });
  h.append({ taskId: 't1', title: 'A', ok: true, result: 'ok', durationMs: 12, delivery: 'sent' });
  h.append({ taskId: 't2', title: 'B', ok: false, result: 'boom', durationMs: 34 });
  h.append({ taskId: 't3', title: 'C', ok: true });
  h.append({ taskId: 't4', title: 'D', ok: false, result: 'x'.repeat(500) });

  const list = h.list(10);
  assert.strictEqual(list.length, 3);
  assert.deepStrictEqual(list.map((e) => e.taskId), ['t2', 't3', 't4']);
  assert.strictEqual(list[0].ok, false);
  assert.strictEqual(list[0].delivery, null);
  assert.ok(list[2].result.length <= 300, 'result 应截断');
  assert.ok(list[0].at);
});

await check('flush 落盘并可重新 load', async () => {
  const p = join(root, 'persist.json');
  const h = new TaskHistory(p);
  h.append({ taskId: 't1', title: '每日一题', ok: false, result: '超时', durationMs: 5000, delivery: 'failed' });
  assert.strictEqual(await h.flush(), true);
  assert.strictEqual(await h.flush(), false);

  const h2 = new TaskHistory(p);
  await h2.load();
  assert.strictEqual(h2.list().length, 1);
  assert.strictEqual(h2.list()[0].title, '每日一题');
  assert.strictEqual(h2.list()[0].ok, false);
  assert.strictEqual(h2.list()[0].delivery, 'failed');
});

await check('文件损坏时降级为空', async () => {
  const p = join(root, 'broken.json');
  await writeFile(p, 'not json{');
  const h = new TaskHistory(p);
  await h.load();
  assert.strictEqual(h.list().length, 0);
});

await check('快照写入 _tasks/history.json', async () => {
  await writeTaskHistorySnapshot(ws, [
    { at: '2026-10-29T01:00:00.000Z', taskId: 't1', title: '每日一题', ok: true, result: 'ok', delivery: 'sent' },
    { at: '2026-10-29T02:00:00.000Z', taskId: 't2', title: '开会', ok: false, result: 'token 失效', delivery: 'failed' },
  ]);
  const snap = JSON.parse(await readFile(join(ws, '_tasks', 'history.json'), 'utf8'));
  assert.strictEqual(snap.entries.length, 2);
  assert.strictEqual(snap.entries[1].ok, false);
  assert.strictEqual(snap.entries[1].title, '开会');
});

await check('失败提示包含任务名、原因和下一步动作', () => {
  const text = formatTaskFailureNotice({ title: '每日一题' }, new Error('agent 未返回内容'));
  assert.match(text, /定时任务「每日一题」执行失败/);
  assert.match(text, /agent 未返回内容/);
  assert.match(text, /回复任意消息/);
  assert.match(text, /取消 每日一题/);
});

await check('失败提示压平换行并截断超长原因', () => {
  const text = formatTaskFailureNotice({ title: 'X' }, new Error('第一行\n第二行' + 'x'.repeat(500)));
  assert.ok(text.includes('第一行 第二行'));
  assert.ok(text.length < 260, `长度 ${text.length}`);
});

await check('没有任务标题时也能给出提示', () => {
  const text = formatTaskFailureNotice({}, 'boom');
  assert.match(text, /定时任务执行失败/);
  assert.match(text, /取消这个任务/);
});

await rm(root, { recursive: true, force: true });

console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
