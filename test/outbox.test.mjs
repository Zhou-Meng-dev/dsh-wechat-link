#!/usr/bin/env node
/**
 * 待发队列：token 失效时的消息暂存、顺序、上限与持久化。
 */
import assert from 'node:assert';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { OutboxStore, DEFAULT_MAX_PER_PEER } from '../src/wechat/outbox.mjs';

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
  assert.strictEqual(raw.version, 1);
  assert.ok(raw.peers.u1);
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

await rm(root, { recursive: true, force: true });

console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
