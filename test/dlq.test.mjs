#!/usr/bin/env node
/**
 * 死信队列：上限、持久化、损坏恢复。
 */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DEFAULT_MAX_DLQ_ITEMS, DlqStore } from '../src/wechat/dlq.mjs';

import { createChecker } from './helpers/check.mjs';

const { check, done } = createChecker();

const root = await mkdtemp(join(tmpdir(), 'dlq-'));
const mode = async (p) => (await stat(p)).mode & 0o777;

await check('默认上限 200', () => {
  assert.strictEqual(DEFAULT_MAX_DLQ_ITEMS, 200);
});

await check('add + flush + reload 保留摘要字段', async () => {
  const p = join(root, 'dlq.json');
  const d = new DlqStore(p);
  await d.load();
  d.add({ peerId: 'u1', type: 'text', reason: 'HTTP 400', attempts: 2, preview: '你好' });
  d.add({ peerId: 'u2', type: 'media', reason: '文件不存在', attempts: 1 });
  assert.strictEqual(d.stats().items, 2);
  assert.strictEqual(await d.flush(), true);
  assert.strictEqual(await d.flush(), false, '没有变更不重复写');
  assert.strictEqual(await mode(p), 0o600);

  const d2 = new DlqStore(p);
  await d2.load();
  const [a, b] = d2.list();
  assert.strictEqual(a.peerId, 'u1');
  assert.strictEqual(a.reason, 'HTTP 400');
  assert.strictEqual(a.attempts, 2);
  assert.strictEqual(a.preview, '你好');
  assert.ok(a.at);
  assert.strictEqual(b.type, 'media');
  const raw = JSON.parse(await readFile(p, 'utf8'));
  assert.strictEqual(raw.version, 1);
});

await check('超过上限丢最旧', async () => {
  const d = new DlqStore(join(root, 'cap.json'), { maxItems: 2 });
  await d.load();
  d.add({ peerId: 'a' });
  d.add({ peerId: 'b' });
  d.add({ peerId: 'c' });
  assert.deepStrictEqual(d.list().map((x) => x.peerId), ['b', 'c']);
  assert.strictEqual(d.stats().dropped, 1);
});

await check('损坏文件从空列表开始并告警', async () => {
  const p = join(root, 'broken.json');
  await writeFile(p, '{oops');
  const d = new DlqStore(p);
  const r = await d.load();
  assert.strictEqual(r.items, 0);
  assert.match(r.warning, /损坏/);
  assert.deepStrictEqual(d.list(), []);
});

await check('文件不存在安全返回', async () => {
  const d = new DlqStore(join(root, 'missing.json'));
  const r = await d.load();
  assert.strictEqual(r.items, 0);
  assert.strictEqual(r.warning, undefined);
});

await check('写盘失败显式抛出（不静默丢）', async () => {
  const d = new DlqStore(join(root, 'fail.json'), {
    writeJson: async () => { throw new Error('EACCES'); },
  });
  await d.load();
  d.add({ peerId: 'u1' });
  await assert.rejects(() => d.flush(), /EACCES/);
});

await rm(root, { recursive: true, force: true });

done();
