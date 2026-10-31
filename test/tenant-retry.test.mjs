#!/usr/bin/env node
/**
 * Tenant × 出站失败重试（fake iLink，不连真实微信）：
 *   - 5xx 退避重试，最终送达；补发复用同一 clientId
 *   - 永久错误进 DLQ，并给 owner 发一条（节流）告警
 *   - token 失效：保留在 outbox，attempts 不增长
 *   - 媒体失败后，后续文字必须一起入队（保序）
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Tenant } from '../src/tenant.mjs';
import { IlinkClient } from '../src/wechat/ilink.mjs';
import { OutboxStore } from '../src/wechat/outbox.mjs';
import { DlqStore } from '../src/wechat/dlq.mjs';
import { ReplySender } from '../src/wechat/reply.mjs';

import { createChecker } from './helpers/check.mjs';

const { check, done } = createChecker();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- fake iLink

const sends = [];
/** 返回 { status, body }；默认成功 */
let onSend = () => ({ status: 200, body: { ret: 0 } });

const server = createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString('utf8');

  if (req.url === '/upload') {
    res.writeHead(200, { 'x-encrypted-param': 'enc-media' });
    res.end();
    return;
  }
  if (req.url.endsWith('/getuploadurl')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      ret: 0,
      upload_full_url: `http://127.0.0.1:${server.address().port}/upload`,
    }));
    return;
  }
  if (req.url.endsWith('/sendmessage')) {
    const msg = JSON.parse(raw).msg;
    sends.push({ msg, at: Date.now() });
    const out = onSend(msg);
    res.writeHead(out.status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(out.body ?? {}));
    return;
  }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ ret: 0, typing_ticket: null }));
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const baseUrl = `http://127.0.0.1:${server.address().port}/`;

// ---------------------------------------------------------------- 装配

const roots = [];
async function makeTenant(opts = {}) {
  const root = await mkdtemp(join(tmpdir(), 'tenant-retry-'));
  roots.push(root);
  const cwd = join(root, 'workspace');
  await mkdir(cwd, { recursive: true });

  const tokens = new Map([['user-1', 'ctx-new']]);
  const logs = [];
  const t = new Tenant({
    id: 't-retry',
    botId: 'test-bot',
    ownerId: 'user-1',
    allowUsers: ['user-1'],
    cwd,
    root,
    token: 'test-token',
    baseUrl,
    ackDelayMs: 60_000,
    maxChars: 1800,
  }, { log: (m) => logs.push(m) });

  t.session = {
    start: async () => {},
    stop: async () => {},
    ask: async () => '回复',
    reset: () => {},
    stats: () => ({ peers: 0, sessions: 0, busy: 0 }),
    getToken: (peer) => (opts.noToken ? undefined : tokens.get(peer)),
    setToken: (peer, token) => { if (token) tokens.set(peer, token); },
    flushTokens: async () => {},
  };
  t.ilink = new IlinkClient({ token: 'test-token', baseUrl, log: () => {} });
  t.dlq = new DlqStore(join(root, 'dlq.json'));
  await t.dlq.load();
  t.outbox = new OutboxStore(join(root, 'outbox.json'), { dlq: t.dlq });
  await t.outbox.load();
  return { t, root, cwd, logs };
}

/** 用注入时钟/零等待的 ReplySender 替换租户的发送器（测试退避曲线） */
function injectSender(t, { now, cwd }) {
  let clock = now;
  t.reply = new ReplySender({
    cwd,
    maxChars: 1800,
    ilink: t.ilink,
    outbox: t.outbox,
    dlq: t.dlq,
    onDlq: (info) => t.emit('test-dlq', info),
    log: () => {},
    getContextToken: (peer) => t.session.getToken(peer),
    now: () => clock,
    sleep: async () => {},
    random: () => 0,
  });
  return {
    reply: t.reply,
    advance: (ms) => { clock += ms; },
    now: () => clock,
  };
}

const tokenError = { status: 200, body: { ret: -1, errmsg: 'invalid context token' } };

// ---------------------------------------------------------------- 用例

await check('5xx 退避重试后送达，补发复用同一 clientId', async () => {
  const { t, cwd } = await makeTenant();
  const { reply, advance } = injectSender(t, { now: 1_000_000, cwd });

  let calls = 0;
  onSend = () => {
    calls++;
    return calls <= 3 ? { status: 500, body: {} } : { status: 200, body: { ret: 0 } };
  };
  sends.length = 0;

  // 首次 2 次（原地重试）失败 → 入队 attempts=1
  const result = await reply.send('user-1', '重试文本', 'ctx-new');
  assert.deepStrictEqual(result, { sent: 0, queued: 1 });
  const queued = t.outbox.list('user-1')[0];
  assert.strictEqual(queued.attempts, 1);
  assert.ok(queued.nextAttemptAt > 0);
  const clientId = queued.clientId;

  // 未到 nextAttemptAt：不补发
  await reply.flush('user-1');
  assert.strictEqual(t.outbox.list('user-1').length, 1);

  // 到点后第 3 次仍 500 → attempts=2
  advance(3_000);
  await reply.flush('user-1');
  assert.strictEqual(t.outbox.list('user-1')[0].attempts, 2);

  // 再推进，第 4 次成功
  advance(10_000);
  await reply.flush('user-1');
  assert.strictEqual(t.outbox.stats().items, 0);

  const retried = sends.slice(-2).map((s) => s.msg.client_id);
  assert.deepStrictEqual(retried, [clientId, clientId], '重试必须复用 clientId');
  assert.strictEqual(sends.at(-1).msg.item_list[0].text_item.text, '重试文本');
});

await check('永久错误：进 DLQ 并给 owner 发节流告警', async () => {
  const { t, root } = await makeTenant();
  // 用生产装配（Tenant.createReplySender）验证 onDlq → owner 通知链路
  t.reply = t.createReplySender();
  onSend = (msg) => {
    const text = String(msg.item_list?.[0]?.text_item?.text ?? '');
    // 只让用户消息失败；DLQ 告警本身必须能送达
    if (text === '坏消息' || text === '坏消息2' || text === '坏消息3') {
      return { status: 400, body: { ret: -2, errmsg: 'bad request' } };
    }
    return { status: 200, body: { ret: 0 } };
  };
  sends.length = 0;

  const result = await t.reply.send('user-1', '坏消息', 'ctx-new');
  assert.deepStrictEqual(result, { sent: 0, queued: 0 });
  await sleep(80); // 等 onDlq 的异步告警

  const dlq = await readFile(join(root, 'dlq.json'), 'utf8').then(JSON.parse);
  assert.strictEqual(dlq.items.length, 1);
  assert.strictEqual(dlq.items[0].peerId, 'user-1');
  assert.match(dlq.items[0].reason, /400|bad request/);

  // 告警本身直接走 ilink（不会再入队）
  const notice = sends.find((s) => String(s.msg.item_list?.[0]?.text_item?.text ?? '').includes('放弃'));
  assert.ok(notice, 'owner 应收到一条 DLQ 告警');
  assert.strictEqual(t.outbox.stats().items, 0);

  // 节流：第二条 DLQ 不再告警
  const before = sends.length;
  t.reply = t.createReplySender();
  await t.reply.send('user-1', '坏消息2', 'ctx-new');
  await sleep(50);
  const notices = () => sends.filter((s) => String(s.msg.item_list?.[0]?.text_item?.text ?? '').includes('放弃'));
  assert.strictEqual(notices().length, 1);
  assert.ok(sends.length >= before);

  // 窗口过后：把积压的失败条数汇总成一条「N 条」告警，而不是逐条打扰
  const clock = { now: Date.now() + 10 * 60_000 };
  t.noticeThrottle.now = () => clock.now;
  t.reply = t.createReplySender();
  await t.reply.send('user-1', '坏消息3', 'ctx-new');
  await sleep(50);
  assert.strictEqual(notices().length, 2, '窗口过后应再发一条汇总');
  assert.match(String(notices()[1].msg.item_list[0].text_item.text), /2 条消息发送失败/);
});

await check('token 失效：保留在 outbox，attempts 不增长', async () => {
  const { t, cwd } = await makeTenant();
  const { reply, advance } = injectSender(t, { now: 5_000, cwd });
  onSend = () => tokenError;
  sends.length = 0;

  await reply.send('user-1', '等 token', 'old');
  const item = t.outbox.list('user-1')[0];
  assert.strictEqual(item.attempts, 0);
  assert.strictEqual(item.nextAttemptAt, 0);

  advance(60_000);
  await reply.flush('user-1');
  assert.strictEqual(t.outbox.stats().items, 1, 'token 失效不能丢消息');
  assert.strictEqual(t.outbox.list('user-1')[0].attempts, 0, 'token 失效不消耗尝试次数');
});

await check('媒体失败后，文字一并入队（严格保序）', async () => {
  const { t, cwd } = await makeTenant();
  await writeFile(join(cwd, 'f.txt'), 'media body');
  const { reply } = injectSender(t, { now: 2_000, cwd });

  let textSends = 0;
  onSend = (msg) => {
    if (msg.item_list?.[0]?.type === 4) return { status: 500, body: {} }; // 文件发送失败
    textSends++;
    return { status: 200, body: { ret: 0 } };
  };
  sends.length = 0;

  const result = await reply.send('user-1', '[[file: f.txt]]\n\n正文', 'ctx-new');
  assert.deepStrictEqual(result, { sent: 0, queued: 2 });
  assert.deepStrictEqual(t.outbox.list('user-1').map((x) => x.type), ['media', 'text']);
  assert.strictEqual(textSends, 0, '媒体已入队时正文不能先发出去');
  assert.ok(t.outbox.list('user-1')[0].attempts >= 1);
});

// ---------------------------------------------------------------- 收尾

for (const root of roots) await rm(root, { recursive: true, force: true });
server.close();

done();
