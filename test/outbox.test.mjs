#!/usr/bin/env node
/**
 * 待发队列：token 失效时的消息暂存、顺序、上限与持久化。
 */
import assert from 'node:assert';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { OutboxStore, DEFAULT_MAX_PER_PEER, OUTBOX_VERSION } from '../src/wechat/outbox.mjs';
import { DlqStore } from '../src/wechat/dlq.mjs';

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

const root = await mkdtemp(join(tmpdir(), 'outbox-'));
const path = join(root, 'outbox.json');

await check('默认每用户最多 50 条', () => {
  assert.strictEqual(DEFAULT_MAX_PER_PEER, 50);
});

await check('add / list 保持到达顺序', () => {
  const o = new OutboxStore(path);
  o.add('u1', { type: 'text', text: '第一' });
  o.add('u1', { type: 'text', text: '第二' });
  assert.deepStrictEqual(o.list('u1').map((x) => x.text), ['第一', '第二']);
  assert.strictEqual(o.stats().items, 2);
  assert.ok(o.list('u1')[0].queuedAt);
});

await check('不同用户互不影响', () => {
  const o = new OutboxStore(path);
  o.add('u1', { type: 'text', text: 'a' });
  o.add('u2', { type: 'text', text: 'b' });
  assert.deepStrictEqual(o.list('u1').map((x) => x.text), ['a']);
  assert.deepStrictEqual(o.list('u2').map((x) => x.text), ['b']);
  assert.strictEqual(o.stats().peers, 2);
});

await check('shift 从队首移除，空队列删除该用户', () => {
  const o = new OutboxStore(path);
  o.add('u1', { type: 'text', text: 'a' });
  o.add('u1', { type: 'text', text: 'b' });
  assert.strictEqual(o.shift('u1', 1), 1);
  assert.deepStrictEqual(o.list('u1').map((x) => x.text), ['b']);
  assert.strictEqual(o.shift('u1', 5), 1);
  assert.deepStrictEqual(o.list('u1'), []);
  assert.strictEqual(o.stats().peers, 0);
  assert.strictEqual(o.shift('u1', 1), 0);
});

await check('超过上限丢最旧的并返回丢弃数', () => {
  const o = new OutboxStore(path, { maxPerPeer: 3 });
  assert.strictEqual(o.add('u1', { type: 'text', text: '1' }), 0);
  assert.strictEqual(o.add('u1', { type: 'text', text: '2' }), 0);
  assert.strictEqual(o.add('u1', { type: 'text', text: '3' }), 0);
  assert.strictEqual(o.add('u1', { type: 'text', text: '4' }), 1);
  assert.deepStrictEqual(o.list('u1').map((x) => x.text), ['2', '3', '4']);
  assert.strictEqual(o.stats().dropped, 1);
});

await check('clear 清空指定用户', () => {
  const o = new OutboxStore(path);
  o.add('u1', { type: 'text', text: 'a' });
  assert.strictEqual(o.clear('u1'), true);
  assert.deepStrictEqual(o.list('u1'), []);
  assert.strictEqual(o.clear('u1'), false);
});

await check('flush 落盘并可重新 load', async () => {
  const p = join(root, 'persist.json');
  const o = new OutboxStore(p);
  o.add('u1', { type: 'text', text: '积压消息' });
  o.add('u2', { type: 'media', media: { kind: 'image', name: 'a.png', params: { encryptQueryParam: 'x' } } });
  assert.strictEqual(await o.flush(), true);
  assert.strictEqual(await o.flush(), false, '没有变更时不应重复写');

  const o2 = new OutboxStore(p);
  await o2.load();
  assert.strictEqual(o2.stats().items, 2);
  assert.strictEqual(o2.list('u1')[0].text, '积压消息');
  assert.strictEqual(o2.list('u2')[0].media.name, 'a.png');
});


await check('并发 flush 串行执行，不互相覆盖', async () => {
  const p = join(root, 'concurrent.json');
  const o = new OutboxStore(p);
  o.add('u1', { type: 'text', text: '并发' });
  const results = await Promise.all([o.flush(), o.flush(), o.flush()]);
  assert.ok(results.some(Boolean));

  const o2 = new OutboxStore(p);
  await o2.load();
  assert.strictEqual(o2.list('u1')[0].text, '并发');
});

await check('outbox.json 不包含明文敏感字段之外的东西且权限为 0600', async () => {
  const p = join(root, 'perm.json');
  const o = new OutboxStore(p);
  o.add('u1', { type: 'text', text: 'x' });
  await o.flush();
  const raw = JSON.parse(await readFile(p, 'utf8'));
  assert.strictEqual(raw.version, OUTBOX_VERSION);
  assert.strictEqual(raw.version, 2);
  assert.ok(raw.peers.u1, '顶层保持 peers 形状（旧版本可读）');
  assert.strictEqual((await stat(p)).mode & 0o777, 0o600);
});

await check('文件损坏时从空队列开始', async () => {
  const p = join(root, 'broken.json');
  await writeFile(p, 'not json{');
  const o = new OutboxStore(p);
  await o.load();
  assert.strictEqual(o.stats().items, 0);
});

await check('文件不存在时 load 安全返回', async () => {
  const o = new OutboxStore(join(root, 'missing', 'outbox.json'));
  await o.load();
  assert.strictEqual(o.stats().items, 0);
});

await check('flush 会自动创建父目录', async () => {
  const p = join(root, 'nested', 'dir', 'outbox.json');
  const o = new OutboxStore(p);
  o.add('u1', { type: 'text', text: 'x' });
  await o.flush();
  const raw = JSON.parse(await readFile(p, 'utf8'));
  assert.ok(raw.peers.u1);
});

// ---------------------------------------------------------------- v2：重试元数据

await check('v2：add 分配递增 seq 与稳定 clientId', async () => {
  const p = join(root, 'v2-add.json');
  const o = new OutboxStore(p);
  o.add('u1', { type: 'text', text: 'a' });
  o.add('u1', { type: 'text', text: 'b' });
  const [a, b] = o.list('u1');
  assert.ok(b.seq > a.seq);
  assert.match(a.clientId, /^dsh-[0-9a-f]{12}$/);
  assert.notStrictEqual(a.clientId, b.clientId);
  assert.strictEqual(a.attempts, 0);
  assert.strictEqual(a.nextAttemptAt, 0);
  assert.strictEqual(a.lastError, null);
});

await check('v1 文件可读：补齐 seq/clientId/nextAttemptAt，flush 写回 v2', async () => {
  const p = join(root, 'v1-compat.json');
  await writeFile(p, JSON.stringify({
    version: 1,
    peers: {
      u1: [
        { type: 'text', text: '旧消息1', queuedAt: '2026-10-01T00:00:00.000Z', attempts: 0 },
        { type: 'media', media: { kind: 'image', name: 'a.png' }, queuedAt: '2026-10-01T00:00:01.000Z', attempts: 0 },
      ],
    },
  }));
  const o = new OutboxStore(p);
  await o.load();
  const [a, b] = o.list('u1');
  assert.ok(Number.isFinite(a.seq) && Number.isFinite(b.seq));
  assert.ok(b.seq > a.seq);
  assert.match(a.clientId, /^dsh-/);
  assert.strictEqual(a.attempts, 0);
  assert.strictEqual(a.nextAttemptAt, 0);

  o.add('u1', { type: 'text', text: '新消息' });
  await o.flush();
  const raw = JSON.parse(await readFile(p, 'utf8'));
  assert.strictEqual(raw.version, 2);
  assert.strictEqual(raw.peers.u1.length, 3);
  assert.ok(Number.isFinite(raw.seq));
});

await check('dueHead：只看队首，未到 nextAttemptAt 返回 null', () => {
  let now = 1000;
  const o = new OutboxStore(join(root, 'due.json'), { now: () => now });
  o.add('u1', { type: 'text', text: '1' });
  o.add('u1', { type: 'text', text: '2' });
  const head = o.dueHead('u1', now);
  assert.strictEqual(head.text, '1');

  o.markAttempt('u1', head.seq, { error: 'network', nextAt: now + 2000 });
  assert.strictEqual(o.dueHead('u1', now), null, '队首未到点：不能跳过它');
  now += 2000;
  assert.strictEqual(o.dueHead('u1', now).text, '1');
  const item = o.get('u1', head.seq);
  assert.strictEqual(item.attempts, 1);
  assert.strictEqual(item.lastError, 'network');
});

await check('remove 按 seq 移除；remove 后队首推进', () => {
  const o = new OutboxStore(join(root, 'remove.json'));
  o.add('u1', { type: 'text', text: '1' });
  o.add('u1', { type: 'text', text: '2' });
  const [a, b] = o.list('u1');
  assert.strictEqual(o.remove('u1', a.seq), true);
  assert.strictEqual(o.remove('u1', a.seq), false);
  assert.strictEqual(o.dueHead('u1', Date.now()).seq, b.seq);
  assert.strictEqual(o.remove('u1', b.seq), true);
  assert.strictEqual(o.stats().peers, 0);
});

await check('moveToDlq：从 outbox 删除并写入 dlq.json', async () => {
  const dlqPath = join(root, 'dlq', 'dlq.json');
  const dlq = new DlqStore(dlqPath);
  await dlq.load();
  const o = new OutboxStore(join(root, 'dlq-outbox.json'), { dlq });
  o.add('u1', { type: 'text', text: '永远失败' });
  const item = o.list('u1')[0];
  const entry = o.moveToDlq('u1', item.seq, 'HTTP 400');
  assert.ok(entry);
  assert.strictEqual(entry.peerId, 'u1');
  assert.strictEqual(entry.reason, 'HTTP 400');
  assert.match(entry.preview, /永远失败/);
  assert.strictEqual(o.list('u1').length, 0);
  assert.strictEqual(o.stats().dlq, 1);

  await dlq.flush();
  const raw = JSON.parse(await readFile(dlqPath, 'utf8'));
  assert.strictEqual(raw.version, 1);
  assert.strictEqual(raw.items.length, 1);
});

await check('stats：retrying / oldestAt / dlq', () => {
  let now = 5000;
  const o = new OutboxStore(join(root, 'stats.json'), { now: () => now });
  o.add('u1', { type: 'text', text: 'a' });
  now = 6000;
  o.add('u1', { type: 'text', text: 'b' });
  const head = o.list('u1')[0];
  o.markAttempt('u1', head.seq, { nextAt: now + 1 });
  const s = o.stats();
  assert.strictEqual(s.items, 2);
  assert.strictEqual(s.retrying, 1);
  assert.ok(s.oldestAt);
});

await rm(root, { recursive: true, force: true });

console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
