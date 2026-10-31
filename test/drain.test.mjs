#!/usr/bin/env node
/**
 * 优雅退出与排空：
 *   - UserMessageQueue.drain 立刻结算合并窗口并等在途回合
 *   - drain 期间 push 被拒绝（消息保留在 sync.json.pending）
 *   - 超时返回 abandoned journalId，不丢 pending
 *   - Tenant.stop：先排空、发完回复、再关 dsh
 *   - 关闭期间 token 失效 → 回复进 outbox.json
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Tenant } from '../src/tenant.mjs';
import { UserMessageQueue } from '../src/wechat/message-queue.mjs';
import { InboundJournal } from '../src/wechat/inbound-journal.mjs';

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
async function waitFor(predicate, timeoutMs = 5000, label = '条件') {
  const start = Date.now();
  while (!(await predicate())) {
    if (Date.now() - start > timeoutMs) throw new Error(`等待超时：${label}`);
    await sleep(10);
  }
}

// ---------------------------------------------------------------- 队列层

await check('drain 立刻结算 5s 合并窗口，不等静默', async () => {
  const seen = [];
  const q = new UserMessageQueue({
    windowMs: 5_000,
    handle: (_peer, batch) => { seen.push(batch.text); },
  });

  q.push('u1', { text: 'A' });
  assert.strictEqual(seen.length, 0, '按窗口本应等待');
  // timeoutMs 远小于 5s 合并窗口：若 drain 没有立刻结算，这里会超时返回 idle:false
  const r = await q.drain({ timeoutMs: 200 });
  assert.deepStrictEqual(r, { idle: true, abandoned: [] });
  assert.deepStrictEqual(seen, ['A']);
  q.stop();
});

await check('drain 等待在途回合跑完', async () => {
  let finished = false;
  const q = new UserMessageQueue({
    windowMs: 5,
    handle: async () => {
      await sleep(60);
      finished = true;
    },
  });

  q.push('u1', { text: 'A' });
  await waitFor(() => q.stats().running === 1, 1000, '回合开始');
  const r = await q.drain({ timeoutMs: 2000 });
  assert.strictEqual(r.idle, true);
  assert.strictEqual(finished, true, 'drain 返回时回合必须已经完成');
  q.stop();
});

await check('drain 期间 push 被拒绝且不静默丢弃', async () => {
  const q = new UserMessageQueue({ windowMs: 5, handle: () => {} });
  await q.drain({ timeoutMs: 100 });
  assert.deepStrictEqual(q.push('u1', { text: 'late' }), { accepted: false, reason: 'draining' });
  assert.strictEqual(q.stats().accepting, false);
  q.stop();
});

await check('超时：返回未 commit 的 journalId', async () => {
  const q = new UserMessageQueue({
    windowMs: 5,
    handle: () => new Promise(() => {}), // 永不结束
  });
  q.push('u1', { text: 'running', journalId: 'm:running' });
  await waitFor(() => q.stats().running === 1, 1000, '回合开始');
  q.push('u1', { text: 'pending', journalId: 'm:pending' }); // 排队等下一批

  const r = await q.drain({ timeoutMs: 80 });
  assert.strictEqual(r.idle, false);
  assert.deepStrictEqual(r.abandoned.sort(), ['m:pending', 'm:running']);
  assert.strictEqual(q.stats().abandoned, 2);
  q.stop();
});

// ---------------------------------------------------------------- Tenant 层

let current = { buf: 'b0', msgs: [] };
const sends = [];
let sendResponse = () => ({ ret: 0 });

const server = createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = Buffer.concat(chunks).toString('utf8');
  await sleep(5);

  if (req.url.endsWith('/getupdates')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ret: 0, get_updates_buf: current.buf, msgs: current.msgs }));
    return;
  }
  if (req.url.endsWith('/sendmessage')) {
    const msg = JSON.parse(body).msg;
    sends.push({ text: msg.item_list?.[0]?.text_item?.text, at: Date.now() });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(sendResponse(msg)));
    return;
  }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ ret: 0, typing_ticket: null }));
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const baseUrl = `http://127.0.0.1:${server.address().port}/`;

const roots = [];
async function makeTenant({ ask, tokens = new Map([['user-1', 'ctx-1']]) } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'drain-'));
  roots.push(root);
  const cwd = join(root, 'workspace');
  await mkdir(cwd, { recursive: true });
  const logs = [];
  const t = new Tenant({
    id: 't-drain',
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
  const events = [];
  t.session = {
    start: async () => {},
    stop: async () => { events.push({ at: Date.now(), name: 'session-stop' }); },
    ask: ask ?? (async (_peer, text) => {
      events.push({ at: Date.now(), name: 'ask-start', text });
      await sleep(80);
      events.push({ at: Date.now(), name: 'ask-end', text });
      return `回复:${text}`;
    }),
    reset: () => {},
    waitIdle: async () => ({ idle: true, busy: 0 }),
    stats: () => ({ peers: 0, sessions: 0, busy: 0 }),
    getToken: (peer) => tokens.get(peer),
    setToken: (peer, token) => { if (token) tokens.set(peer, token); },
    flushTokens: async () => {},
  };
  return { t, root, logs, events };
}

function textMsg(id, text) {
  return {
    message_id: id,
    from_user_id: 'user-1',
    message_type: 1,
    item_list: [{ type: 1, text_item: { text } }],
    context_token: 'ctx-1',
  };
}

await check('Tenant.stop 排空：回复先发出，再关会话', async () => {
  const { t, events } = await makeTenant();
  current = { buf: 's1', msgs: [textMsg('s1', '在途问题')] };
  sendResponse = () => ({ ret: 0 });
  sends.length = 0;

  await t.start();
  await waitFor(() => events.some((e) => e.name === 'ask-start'), 5000, '回合开始');

  await t.stop({ timeoutMs: 5000 });
  assert.strictEqual(t.state, 'stopped');
  const sent = sends.find((s) => s.text === '回复:在途问题');
  assert.ok(sent, '在途回合的回复必须发出');
  const sessionStop = events.find((e) => e.name === 'session-stop');
  assert.ok(sessionStop, '会话必须被关闭');
  assert.ok(sent.at <= sessionStop.at, '回复应在关闭 dsh 之前发出');

  const sync = JSON.parse(await readFile(join(roots.at(-1), 'sync.json'), 'utf8'));
  assert.deepStrictEqual(sync.pending, [], '完成的回合应 commit');
});

await check('关闭期间 token 失效：回复落在 outbox.json', async () => {
  const { t, root, events } = await makeTenant();
  current = { buf: 't1', msgs: [textMsg('t1', '需要补发')] };
  sendResponse = () => ({ ret: -1, errmsg: 'invalid context token' });
  sends.length = 0;

  await t.start();
  await waitFor(() => events.some((e) => e.name === 'ask-start'), 5000, '回合开始');
  await t.stop({ timeoutMs: 5000 });

  const outbox = JSON.parse(await readFile(join(root, 'outbox.json'), 'utf8'));
  const items = outbox.peers['user-1'] ?? [];
  assert.ok(items.some((x) => x.text === '回复:需要补发'), '回复必须进入 outbox，而不是丢失');
  const sync = JSON.parse(await readFile(join(root, 'sync.json'), 'utf8'));
  assert.deepStrictEqual(sync.pending, [], '已交给 outbox 的消息应 commit');
});

await check('drain 超时：日志记录放弃项，pending 保留在 sync.json', async () => {
  const { t, root, logs } = await makeTenant({
    ask: () => new Promise(() => {}), // 永不结束
  });
  current = { buf: 'u1', msgs: [textMsg('u1', '永远跑不完')] };

  await t.start();
  await waitFor(async () => {
    if (!existsSync(join(root, 'sync.json'))) return false;
    const sync = JSON.parse(await readFile(join(root, 'sync.json'), 'utf8'));
    return sync.pending.length > 0;
  }, 5000, '消息进入 pending');

  await t.stop({ timeoutMs: 120 });
  assert.match(logs.join('\n'), /关闭超时/);
  const sync = JSON.parse(await readFile(join(root, 'sync.json'), 'utf8'));
  assert.deepStrictEqual(sync.pending.map((e) => e.id), ['m:u1']);
});

await check('热重载（drain:false）不排空，pending 留给新 Tenant 重放', async () => {
  const { t, root } = await makeTenant({
    ask: () => new Promise(() => {}),
  });
  current = { buf: 'v1', msgs: [textMsg('v1', '热重载中')] };

  await t.start();
  await waitFor(async () => {
    if (!existsSync(join(root, 'sync.json'))) return false;
    const sync = JSON.parse(await readFile(join(root, 'sync.json'), 'utf8'));
    return sync.pending.length > 0;
  }, 5000, '消息进入 pending');
  const startedAt = Date.now();
  await t.stop({ drain: false, timeoutMs: 5000 });
  // 只验证「没有等满 5s 的 drain 截止时间」；阈值放宽，避免重载 CI 上抖成 flaky
  assert.ok(Date.now() - startedAt < 3000, '不排空时必须快速返回');

  const sync = JSON.parse(await readFile(join(root, 'sync.json'), 'utf8'));
  assert.strictEqual(sync.pending.length, 1);
  assert.strictEqual(sync.pending[0].id, 'm:v1');
});

// ---------------------------------------------------------------- 收尾

for (const root of roots) await rm(root, { recursive: true, force: true });
server.close();

console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
