#!/usr/bin/env node
/**
 * Tenant × 预算硬拦截（fake iLink，不连真实微信/dsh）：
 *   - block：超租户/用户预算后不调用模型，回复含 /usage
 *   - warn：保持现状，照常调用模型
 *   - 每用户配额只影响该用户
 *   - 跨天自动放行（注入假时钟）
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Tenant } from '../src/tenant.mjs';
import { IlinkClient } from '../src/wechat/ilink.mjs';
import { OutboxStore } from '../src/wechat/outbox.mjs';
import { DlqStore } from '../src/wechat/dlq.mjs';

import { createChecker } from './helpers/check.mjs';

const { check, done } = createChecker();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(predicate, timeoutMs = 5000, label = '条件') {
  const start = Date.now();
  while (!(await predicate())) {
    if (Date.now() - start > timeoutMs) throw new Error(`等待超时：${label}`);
    await sleep(10);
  }
}

const sends = [];
const server = createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = Buffer.concat(chunks).toString('utf8');
  if (req.url.endsWith('/sendmessage')) {
    const msg = JSON.parse(body).msg;
    sends.push({
      to: msg.to_user_id,
      text: msg.item_list?.[0]?.text_item?.text ?? '',
      at: Date.now(),
    });
  }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ ret: 0, typing_ticket: null }));
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const baseUrl = `http://127.0.0.1:${server.address().port}/`;

const roots = [];
async function makeTenant(tenantOverrides = {}) {
  const root = await mkdtemp(join(tmpdir(), 'tenant-budget-'));
  roots.push(root);
  const cwd = join(root, 'workspace');
  await mkdir(cwd, { recursive: true });
  const logs = [];
  const asks = [];
  const tokens = new Map([['user-1', 'ctx-1'], ['user-2', 'ctx-2']]);

  const t = new Tenant({
    id: 't-budget',
    botId: 'test-bot',
    ownerId: 'user-1',
    allowUsers: ['user-1', 'user-2'],
    cwd,
    root,
    token: 'test-token',
    baseUrl,
    ackDelayMs: 60_000,
    maxChars: 1800,
    budgetAction: 'block',
    ...tenantOverrides,
  }, { log: (m) => logs.push(m) });

  t.session = {
    start: async () => {},
    stop: async () => {},
    ask: async (peer, text) => {
      asks.push({ peer, text });
      return '回复';
    },
    reset: () => {},
    stats: () => null,
    getToken: (peer) => tokens.get(peer),
    setToken: (peer, token) => { if (token) tokens.set(peer, token); },
    flushTokens: async () => {},
  };
  t.ilink = new IlinkClient({ token: 'test-token', baseUrl, log: () => {} });
  t.dlq = new DlqStore(join(root, 'dlq.json'));
  await t.dlq.load();
  t.outbox = new OutboxStore(join(root, 'outbox.json'), { dlq: t.dlq });
  await t.outbox.load();
  // 先不装配 reply：用例先记账，避免预算告警抢占 sends[0]
  return { t, root, logs, asks };
}

/** 预算是记账之后才触发的：装配 reply + inbound 放到记账之后。 */
function wire(t) {
  t.reply = t.createReplySender();
  t.inbound = t.createInboundPipeline();
  return t;
}

function textMsg(text, from = 'user-1') {
  return {
    from_user_id: from,
    message_type: 1,
    item_list: [{ type: 1, text_item: { text } }],
    context_token: `ctx-${from}`,
  };
}

await check('block：租户日预算超限 → 不调模型，回复含 /usage', async () => {
  const { t, asks } = await makeTenant({ budgetTokensPerDay: 100 });
  // reply 还没装配时记账，避免预算告警抢占 sends[0]
  t.usage.record({ peerId: 'user-1', usage: { totalTokens: 120 } });
  sends.length = 0;

  wire(t);
  t.inbound.push(textMsg('还想问'));
  await waitFor(() => sends.length >= 1);

  assert.strictEqual(asks.length, 0, '超预算后不能调用模型');
  assert.match(sends[0].text, /\/usage/);
  assert.match(sends[0].text, /预算|token/);
  assert.strictEqual(t.inbound.stats().budgetBlocked, 1);
  t.inbound.stop();
});

await check('warn：超预算照常调用模型（保持现状）', async () => {
  const { t, asks } = await makeTenant({ budgetTokensPerDay: 100, budgetAction: 'warn' });
  t.usage.record({ peerId: 'user-1', usage: { totalTokens: 120 } });
  sends.length = 0;

  wire(t);
  t.inbound.push(textMsg('照常提问'));
  await waitFor(() => asks.length === 1);
  assert.strictEqual(asks[0].text, '照常提问');
  assert.strictEqual(t.inbound.stats().budgetBlocked, 0);
  t.inbound.stop();
});

await check('每用户配额：只拦超限用户，其他用户不受影响', async () => {
  const { t, asks } = await makeTenant({ perUserBudgetTokensPerDay: 50 });
  t.usage.record({ peerId: 'user-1', usage: { totalTokens: 60 } });
  sends.length = 0;

  wire(t);
  t.inbound.push(textMsg('用户1 超限', 'user-1'));
  t.inbound.push(textMsg('用户2 正常', 'user-2'));

  await waitFor(() => asks.length === 1);
  assert.strictEqual(asks[0].peer, 'user-2');
  assert.strictEqual(asks[0].text, '用户2 正常');
  await waitFor(() => sends.some((s) => s.to === 'user-1' && /\/usage/.test(s.text)));
  t.inbound.stop();
});

await check('跨天：预算桶重置后自动放行', async () => {
  const { t, asks } = await makeTenant({ budgetTokensPerDay: 100 });
  let clock = new Date(2026, 9, 30, 10, 0, 0);
  t.usage.now = () => clock;
  t.usage.record({ peerId: 'user-1', usage: { totalTokens: 120 } });

  wire(t);
  t.inbound.push(textMsg('今天被拦'));
  await waitFor(() => t.inbound.stats().budgetBlocked === 1);
  assert.strictEqual(asks.length, 0);

  // 第二天：日预算从 0 开始
  clock = new Date(2026, 9, 31, 0, 0, 1);
  t.inbound.push(textMsg('第二天'));
  await waitFor(() => asks.length === 1, 5000, '跨天后放行');
  assert.strictEqual(asks[0].text, '第二天');
  t.inbound.stop();
});

await check('租户月预算同样生效', async () => {
  const { t, asks } = await makeTenant({ budgetTokensPerMonth: 100 });
  // 月初记一笔，当天不会触发日预算
  t.usage.record({ at: new Date(2026, 9, 2, 10, 0, 0), peerId: 'user-1', usage: { totalTokens: 120 } });
  t.usage.now = () => new Date(2026, 9, 15, 10, 0, 0);
  sends.length = 0;

  wire(t);
  t.inbound.push(textMsg('月预算'));
  await waitFor(() => sends.length >= 1);
  assert.strictEqual(asks.length, 0);
  assert.match(sends[0].text, /本月|月/);
  t.inbound.stop();
});

// ---------------------------------------------------------------- 收尾

for (const root of roots) await rm(root, { recursive: true, force: true });
server.close();

done();
