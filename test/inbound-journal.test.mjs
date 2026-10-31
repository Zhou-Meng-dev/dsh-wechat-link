#!/usr/bin/env node
/**
 * 入站日志：去重键、原子落盘、游标与 pending 的崩溃语义、损坏恢复。
 */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  DEFAULT_MAX_PENDING,
  DEFAULT_MAX_PROCESSED,
  InboundJournal,
  inboundFieldNames,
  inboundMessageKey,
  stripContextToken,
} from '../src/wechat/inbound-journal.mjs';

import { createChecker } from './helpers/check.mjs';

const { check, done } = createChecker();

const root = await mkdtemp(join(tmpdir(), 'inbound-journal-'));
const mode = async (p) => (await stat(p)).mode & 0o777;

function msg(id, text = 'hi', extra = {}) {
  return {
    message_id: id,
    from_user_id: 'u1',
    message_type: 1,
    item_list: [{ type: 1, text_item: { text } }],
    context_token: `token-${id}`,
    ...extra,
  };
}

// ---------------------------------------------------------------- 去重键

await check('message_id 是强键（官方 WeixinMessage 字段）', () => {
  assert.deepStrictEqual(inboundMessageKey({ message_id: 'abc' }), { id: 'm:abc', strength: 'strong' });
  assert.deepStrictEqual(inboundMessageKey({ message_id: 123 }), { id: 'm:123', strength: 'strong' });
});

await check('顶层 msg_id 不作为消息 id（官方只有 item 级 msg_id）', () => {
  assert.deepStrictEqual(inboundMessageKey({ msg_id: 'x1' }), { id: null, strength: 'none' });
  // 同时出现时也只认 message_id
  assert.strictEqual(inboundMessageKey({ message_id: 'a', msg_id: 'b' }).id, 'm:a');
});

await check('空 id 不算强键', () => {
  assert.strictEqual(inboundMessageKey({ message_id: '   ' }).strength, 'none');
  assert.strictEqual(inboundMessageKey({ message_id: null }).strength, 'none');
});

await check('无 id 但有 from + create_time_ms：弱键且可复现', () => {
  const a = { from_user_id: 'u1', create_time_ms: 1761000000000, item_list: [{ type: 1, text_item: { text: 'hi' } }] };
  const b = { ...a, item_list: [{ type: 1, text_item: { text: 'hi' } }] };
  const c = { ...a, item_list: [{ type: 1, text_item: { text: 'bye' } }] };
  const keyA = inboundMessageKey(a);
  assert.strictEqual(keyA.strength, 'weak');
  assert.match(keyA.id, /^w:[0-9a-f]{16}$/);
  assert.strictEqual(inboundMessageKey(b).id, keyA.id);
  assert.notStrictEqual(inboundMessageKey(c).id, keyA.id);
});

await check('缺 create_time_ms 时不硬凑哈希（避免误丢连发图片）', () => {
  const m = { from_user_id: 'u1', item_list: [{ type: 2 }] };
  assert.deepStrictEqual(inboundMessageKey(m), { id: null, strength: 'none' });
});

await check('stripContextToken 不修改原对象，只剥顶层凭据', () => {
  const original = msg('x');
  const stripped = stripContextToken(original);
  assert.ok(original.context_token);
  assert.strictEqual(stripped.context_token, undefined);
  assert.strictEqual(stripped.message_id, 'x');
});

// ---------------------------------------------------------------- 落盘

await check('默认上限：pending 200 / processed 200', () => {
  assert.strictEqual(DEFAULT_MAX_PENDING, 200);
  assert.strictEqual(DEFAULT_MAX_PROCESSED, 200);
});

await check('文件缺失时从空状态开始', async () => {
  const j = new InboundJournal(join(root, 'missing.json'));
  const r = await j.load();
  assert.deepStrictEqual(r.pending, []);
  assert.strictEqual(r.recovered, false);
  assert.strictEqual(j.cursor, '');
});

await check('admit 落盘游标 + pending，剥掉 context_token，权限 0600', async () => {
  const p = join(root, 'admit.json');
  const j = new InboundJournal(p);
  await j.load();
  const r = await j.admit('B1', [{ id: 'm:1', msg: msg('1'), receivedAt: 111 }]);
  assert.strictEqual(r.accepted.length, 1);
  assert.deepStrictEqual(r.duplicates, []);
  assert.strictEqual(j.cursor, 'B1');
  assert.strictEqual(j.stats().pending, 1);

  const raw = JSON.parse(await readFile(p, 'utf8'));
  assert.strictEqual(raw.version, 1);
  assert.strictEqual(raw.cursor, 'B1');
  assert.strictEqual(raw.pending[0].id, 'm:1');
  assert.strictEqual(raw.pending[0].receivedAt, 111);
  assert.strictEqual(raw.pending[0].msg.context_token, undefined, 'context_token 不落盘');
  assert.strictEqual(r.accepted[0].msg.context_token, 'token-1', '返回给调用方的消息保留 context_token');
  assert.strictEqual(await mode(p), 0o600);
});

await check('inboundFieldNames 只返回字段名，不泄露值（诊断）', () => {
  const names = inboundFieldNames({
    message_id: 'secret-id',
    context_token: 'secret-token',
    from_user_id: 'u1',
    item_list: [],
  });
  assert.deepStrictEqual(names, ['context_token', 'from_user_id', 'item_list', 'message_id']);
  assert.strictEqual(names.some((n) => n.includes('secret')), false);
  assert.deepStrictEqual(inboundFieldNames(null), []);
});

await check('重复批次只收一次，但游标仍然推进', async () => {
  const p = join(root, 'dedupe.json');
  const j = new InboundJournal(p);
  await j.load();
  await j.admit('B1', [{ id: 'm:1', msg: msg('1') }, { id: 'm:2', msg: msg('2') }]);
  const second = await j.admit('B2', [{ id: 'm:1', msg: msg('1') }, { id: 'm:2', msg: msg('2') }]);
  assert.deepStrictEqual(second.accepted, []);
  assert.deepStrictEqual(second.duplicates.sort(), ['m:1', 'm:2']);
  assert.strictEqual(j.cursor, 'B2');

  const reloaded = new InboundJournal(p);
  await reloaded.load();
  assert.strictEqual(reloaded.cursor, 'B2');
  assert.strictEqual(reloaded.stats().pending, 2);
});

await check('同一批里的重复 id 只收一次', async () => {
  const j = new InboundJournal(join(root, 'in-batch.json'));
  await j.load();
  const r = await j.admit('B', [{ id: 'm:1', msg: msg('1') }, { id: 'm:1', msg: msg('1') }]);
  assert.strictEqual(r.accepted.length, 1);
  assert.deepStrictEqual(r.duplicates, ['m:1']);
});

await check('游标缺失时保留旧值（不清空）', async () => {
  const j = new InboundJournal(join(root, 'cursor.json'));
  await j.load();
  await j.admit('KEEP', [{ id: 'm:1', msg: msg('1') }]);
  await j.admit(undefined, [{ id: 'm:2', msg: msg('2') }]);
  assert.strictEqual(j.cursor, 'KEEP');
  assert.strictEqual(j.stats().pending, 2);
});

await check('commitMany：移除 pending、加入 processed 环', async () => {
  const p = join(root, 'commit.json');
  const j = new InboundJournal(p, { maxProcessed: 3 });
  await j.load();
  await j.admit('B1', [{ id: 'm:1', msg: msg('1') }, { id: 'm:2', msg: msg('2') }]);
  await j.admit('B2', [{ id: 'm:3', msg: msg('3') }, { id: 'm:4', msg: msg('4') }]);

  assert.strictEqual(await j.commitMany(['m:1', 'm:2']), true);
  assert.strictEqual(j.stats().pending, 2);
  assert.strictEqual(j.stats().processed, 2);
  assert.strictEqual(await j.commitMany(['m:3', 'm:4']), true);
  assert.strictEqual(j.stats().pending, 0);
  assert.strictEqual(j.stats().processed, 3, 'processed 环上限 3');

  const raw = JSON.parse(await readFile(p, 'utf8'));
  assert.deepStrictEqual(raw.processed, ['m:2', 'm:3', 'm:4']);
  assert.strictEqual(raw.cursor, 'B2');
  // 未知 id 不写盘、不报错
  assert.strictEqual(await j.commitMany(['m:ghost']), false);
});

await check('写盘失败：内存游标与 pending 都不前进', async () => {
  const p = join(root, 'write-fail.json');
  const ok = new InboundJournal(p);
  await ok.load();
  await ok.admit('OLD', [{ id: 'm:old', msg: msg('old') }]);

  const j = new InboundJournal(p, {
    writeJson: async () => { throw new Error('ENOSPC: no space left'); },
  });
  await j.load();
  await assert.rejects(
    () => j.admit('NEW', [{ id: 'm:new', msg: msg('new') }]),
    /ENOSPC/,
  );
  assert.strictEqual(j.cursor, 'OLD');
  assert.deepStrictEqual(j.pending().map((e) => e.id), ['m:old']);

  // 磁盘上仍是旧状态
  const reloaded = new InboundJournal(p);
  await reloaded.load();
  assert.strictEqual(reloaded.cursor, 'OLD');
  assert.deepStrictEqual(reloaded.pending().map((e) => e.id), ['m:old']);
});

await check('重启恢复 pending（含 receivedAt/weak）', async () => {
  const p = join(root, 'recover.json');
  const j = new InboundJournal(p);
  await j.load();
  await j.admit('B', [
    { id: 'm:1', msg: msg('1'), receivedAt: 5, weak: false },
    { id: 'w:abc', msg: msg('2'), receivedAt: 6, weak: true },
  ]);
  const j2 = new InboundJournal(p);
  const r = await j2.load();
  assert.strictEqual(r.recovered, true);
  assert.strictEqual(r.pending.length, 2);
  assert.strictEqual(r.pending[0].receivedAt, 5);
  assert.strictEqual(r.pending[1].weak, true);
  assert.strictEqual(j2.cursor, 'B');
});

await check('损坏文件改名留证，从空状态启动并告警', async () => {
  const p = join(root, 'corrupt.json');
  await writeFile(p, '{oops', { mode: 0o600 });
  const j = new InboundJournal(p);
  const r = await j.load();
  assert.strictEqual(r.recovered, false);
  assert.match(r.warning, /损坏/);
  assert.match(r.warning, /corrupt-/);
  assert.strictEqual(j.cursor, '');
  const names = await readdir(root);
  assert.ok(names.some((n) => n.startsWith('corrupt.json.corrupt-')), '旧文件应改名保留');
});

await check('isFull 是软上限', async () => {
  const j = new InboundJournal(join(root, 'full.json'), { maxPending: 2 });
  await j.load();
  assert.strictEqual(j.isFull(), false);
  await j.admit('B', [{ id: 'm:1', msg: msg('1') }, { id: 'm:2', msg: msg('2') }]);
  assert.strictEqual(j.isFull(), true);
  // 一个批次让 pending 略超上限是允许的：下一轮轮询才反压
  const r = await j.admit('B2', [{ id: 'm:3', msg: msg('3') }]);
  assert.strictEqual(r.accepted.length, 1);
  assert.strictEqual(j.stats().pending, 3);
  assert.strictEqual(j.isFull(), true);
});

await rm(root, { recursive: true, force: true });

done();
