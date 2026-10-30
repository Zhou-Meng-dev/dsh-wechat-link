#!/usr/bin/env node
/**
 * Tenant × 待发队列集成测试：
 *   token 失效 → 回复进入 outbox → 用户下次发消息 → 先用新 token 补发 → 再处理新消息。
 */
import assert from 'node:assert';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Tenant } from '../src/tenant.mjs';
import { IlinkClient } from '../src/wechat/ilink.mjs';
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(predicate, timeoutMs = 5000) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('等待超时');
    await sleep(10);
  }
}

let expireToken = true;
const attempts = [];

const server = createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = Buffer.concat(chunks).toString('utf8');

  if (req.url === '/ilink/bot/getconfig') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ typing_ticket: null }));
    return;
  }
  if (req.url === '/ilink/bot/sendmessage') {
    const msg = JSON.parse(body).msg;
    attempts.push({
      text: msg.item_list?.[0]?.text_item?.text,
      contextToken: msg.context_token,
    });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(expireToken
      ? { ret: -1, errmsg: 'invalid context token' }
      : { ret: 0 }));
    return;
  }
  res.writeHead(404);
  res.end();
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;

const root = await mkdtemp(join(tmpdir(), 'tenant-outbox-'));
const ws = join(root, 'workspace');
await mkdir(ws, { recursive: true });

const logs = [];
const t = new Tenant({
  id: 't-test',
  botId: 'test-bot',
  ownerId: 'user-1',
  allowUsers: ['user-1'],
  cwd: ws,
  root,
  token: 'test-token',
  baseUrl: `http://127.0.0.1:${port}/`,
  ackDelayMs: 60_000,
  maxChars: 1800,
}, { log: (m) => logs.push(m) });

t.ilink = new IlinkClient({ token: 'test-token', baseUrl: `http://127.0.0.1:${port}/` });
t.outbox = new OutboxStore(join(root, 'outbox.json'));
await t.outbox.load();
const tokens = new Map();
t.session = {
  ask: async (_peer, text) => (text.includes('A') ? '回复A' : '回复B'),
  reset: () => {},
  stats: () => ({ peers: 1, sessions: 1, busy: 0 }),
  getToken: (peer) => tokens.get(peer),
  setToken: (peer, token) => { if (token) tokens.set(peer, token); },
  flushTokens: async () => {},
};
// 使用生产同款装配工厂。
t.reply = t.createReplySender();
t.inbound = t.createInboundPipeline();

function pushText(text, contextToken) {
  t.inbound.push({
    from_user_id: 'user-1',
    message_type: 1,
    context_token: contextToken,
    item_list: [{ type: 1, text_item: { text } }],
  });
}

await check('token 失效的回复进入待发队列（不丢、不当作失败）', async () => {
  t.session.setToken('user-1', 'old');
  pushText('问题 A', 'old');
  await waitFor(() => t.outbox.stats().items === 1);

  const item = t.outbox.list('user-1')[0];
  assert.strictEqual(item.type, 'text');
  assert.strictEqual(item.text, '回复A');
  assert.strictEqual(attempts.length, 1);
  assert.strictEqual(attempts[0].contextToken, 'old');
  assert.ok(logs.some((m) => m.includes('待发队列')), '日志应提到待发队列');

  // 等异步落盘完成，下一用例要重新 load 文件
  await t.outbox.flush();
});

await check('待发队列已落盘，重启后可恢复', async () => {
  const reloaded = new OutboxStore(join(root, 'outbox.json'));
  await reloaded.load();
  assert.strictEqual(reloaded.stats().items, 1);
  assert.strictEqual(reloaded.list('user-1')[0].text, '回复A');
});

await check('用户下次发消息 → 先用新 token 补发，再处理新消息', async () => {
  expireToken = false;
  t.session.setToken('user-1', 'new');
  pushText('问题 B', 'new');
  await waitFor(() => attempts.length >= 3);
  await waitFor(() => t.outbox.stats().items === 0);

  assert.deepStrictEqual(attempts.map((a) => a.text), ['回复A', '回复A', '回复B']);
  assert.deepStrictEqual(attempts.map((a) => a.contextToken), ['old', 'new', 'new']);
  assert.ok(logs.some((m) => m.includes('补发')), '日志应提到补发');
});

await check('token 仍然失效时保留剩余消息，不反复丢弃', async () => {
  attempts.length = 0;
  expireToken = true;
  t.session.setToken('user-1', 'still-old');
  pushText('问题 A2', 'still-old');
  await waitFor(() => t.outbox.stats().items === 1);

  // 用户再发一条，但 token 仍然失效：补发失败后保留，新回复也继续入队
  pushText('问题 B2', 'still-old');
  await waitFor(() => t.outbox.stats().items >= 2);
  assert.ok(t.outbox.stats().items >= 2);
});

t.inbound.stop();
server.close();
await rm(root, { recursive: true, force: true });

console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
