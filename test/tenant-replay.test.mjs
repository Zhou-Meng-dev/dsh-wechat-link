#!/usr/bin/env node
/**
 * Tenant × 入站日志集成测试（fake iLink，不连真实微信/dsh）：
 *   - 同一批重复投递只跑一次回合
 *   - 正常重启：游标 + 已处理 id 恢复，不重跑旧消息
 *   - 崩溃后重放：admit 后未 commit → 新 Tenant 重新入队一次
 *   - sync.json 损坏：启动成功 + 告警 + 旧文件改名留证
 *   - 被拒绝的消息也要 commit，不能永远留在 pending
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Tenant } from '../src/tenant.mjs';
import { InboundJournal } from '../src/wechat/inbound-journal.mjs';

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

let current = { buf: 'b0', msgs: [] };
const sent = [];
const requests = [];

const server = createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = Buffer.concat(chunks).toString('utf8');
  requests.push({ url: req.url, body });

  // 稍作延迟，避免轮询循环把 CPU 打满（真实环境是 35s 长轮询）
  await sleep(10);

  if (req.url.endsWith('/getupdates')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ret: 0, get_updates_buf: current.buf, msgs: current.msgs }));
    return;
  }
  if (req.url.endsWith('/sendmessage')) {
    const msg = JSON.parse(body).msg;
    sent.push({
      text: msg.item_list?.[0]?.text_item?.text,
      clientId: msg.client_id,
      token: msg.context_token,
    });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ret: 0 }));
    return;
  }
  if (req.url.endsWith('/getconfig')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ typing_ticket: null }));
    return;
  }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ ret: 0 }));
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const baseUrl = `http://127.0.0.1:${port}/`;

const roots = [];
function makeSession(asks, tokens = new Map()) {
  return {
    start: async () => {},
    stop: async () => {},
    ask: async (peer, text) => {
      asks.push({ peer, text });
      return `回复:${text}`;
    },
    reset: () => {},
    stats: () => ({ peers: 0, sessions: 0, busy: 0 }),
    getToken: (peerId) => tokens.get(peerId),
    setToken: (peerId, token) => tokens.set(peerId, token),
    flushTokens: async () => {},
  };
}

async function makeTenant(root, logs, asks, tokens = new Map()) {
  const ws = join(root, 'workspace');
  await mkdir(ws, { recursive: true });
  const t = new Tenant({
    id: 't-replay',
    botId: 'test-bot',
    ownerId: 'user-1',
    allowUsers: ['user-1'],
    cwd: ws,
    root,
    token: 'test-token',
    baseUrl,
    ackDelayMs: 60_000,
    maxChars: 1800,
  }, { log: (m) => logs.push(m) });
  t.session = makeSession(asks, tokens);
  return t;
}

async function newRoot(name) {
  const root = await mkdtemp(join(tmpdir(), `tenant-replay-${name}-`));
  roots.push(root);
  return root;
}

function textMsg(id, text, from = 'user-1') {
  return {
    message_id: id,
    from_user_id: from,
    message_type: 1,
    item_list: [{ type: 1, text_item: { text } }],
    context_token: `ctx-${id}`,
  };
}

async function readSync(root) {
  return JSON.parse(await readFile(join(root, 'sync.json'), 'utf8'));
}

// ---------------------------------------------------------------- 1. 重复投递

await check('同一批消息被重复返回时只跑一次回合', async () => {
  const root = await newRoot('dedupe');
  const logs = [];
  const asks = [];
  current = { buf: 'b1', msgs: [textMsg('m1', 'hello')] };

  const t = await makeTenant(root, logs, asks);
  await t.start();
  await waitFor(() => asks.length === 1, 5000, '首次回合');
  await sleep(200); // 让轮询把同一批再拉几次
  assert.strictEqual(asks.length, 1, '同一 message_id 不能跑第二个回合');

  const sync = await readSync(root);
  assert.strictEqual(sync.cursor, 'b1');
  assert.deepStrictEqual(sync.pending, []);
  assert.deepStrictEqual(sync.processed, ['m:m1']);

  await t.stop();
});

// ---------------------------------------------------------------- 2. 正常重启

await check('重启后从游标继续，不重跑已处理消息', async () => {
  const root = await newRoot('restart');
  const logs = [];
  const asks = [];
  current = { buf: 'r1', msgs: [textMsg('r1', '第一条')] };

  const t1 = await makeTenant(root, logs, asks);
  await t1.start();
  await waitFor(() => asks.length === 1, 5000, '第一个回合');
  await t1.stop();
  await sleep(50);

  current = { buf: 'r2', msgs: [textMsg('r2', '第二条')] };
  const t2 = await makeTenant(root, logs, asks);
  await t2.start();
  await waitFor(() => asks.length === 2, 5000, '第二个回合');
  await sleep(150);
  assert.deepStrictEqual(asks.map((a) => a.text), ['第一条', '第二条']);
  const sync = await readSync(root);
  assert.strictEqual(sync.cursor, 'r2');
  await t2.stop();
});

// ---------------------------------------------------------------- 3. 崩溃后重放

await check('admit 后未 commit：新 Tenant 重新入队且只跑一次', async () => {
  const root = await newRoot('crash');
  const logs = [];
  const asks = [];

  // 模拟「消息已落盘、回合还没跑完就被 kill」
  const journal = new InboundJournal(join(root, 'sync.json'));
  await journal.load();
  await journal.admit('c1', [{
    id: 'm:crash',
    msg: { message_id: 'crash', from_user_id: 'user-1', message_type: 1, item_list: [{ type: 1, text_item: { text: '崩溃前的消息' } }] },
  }]);
  assert.strictEqual(journal.stats().pending, 1);

  current = { buf: 'c1', msgs: [] };
  const t = await makeTenant(root, logs, asks);
  await t.start();
  await waitFor(() => asks.length === 1, 5000, '重放回合');
  assert.match(logs.join('\n'), /恢复 1 条未处理消息/);
  await waitFor(async () => (await readSync(root)).pending.length === 0, 5000, 'pending 清空');
  assert.deepStrictEqual(asks.map((a) => a.text), ['崩溃前的消息']);
  await sleep(100);
  assert.strictEqual(asks.length, 1, '重放不能被重复入队');
  await t.stop();
});

// ---------------------------------------------------------------- 4. 损坏

await check('sync.json 损坏：启动成功、告警并改名留证', async () => {
  const root = await newRoot('corrupt');
  const logs = [];
  const asks = [];
  await writeFile(join(root, 'sync.json'), '{oops', { mode: 0o600 });
  current = { buf: 'z1', msgs: [] };

  const t = await makeTenant(root, logs, asks);
  await t.start();
  await waitFor(() => t.state === 'running', 5000, '启动完成');
  const text = logs.join('\n');
  assert.match(text, /损坏/);
  assert.match(text, /corrupt-/);
  const names = await readdir(root);
  assert.ok(names.some((n) => n.startsWith('sync.json.corrupt-')), '旧文件应保留');
  await t.stop();
});

// ---------------------------------------------------------------- 5. 拒绝也要 commit

await check('未授权消息被拒绝后从 pending 移除（不无限重放）', async () => {
  const root = await newRoot('denied');
  const logs = [];
  const asks = [];
  current = { buf: 'd1', msgs: [textMsg('deny1', '陌生人', 'stranger')] };

  const t = await makeTenant(root, logs, asks);
  await t.start();
  await waitFor(async () => existsSync(join(root, 'sync.json')), 5000, 'sync.json 创建');
  await waitFor(async () => (await readSync(root)).pending.length === 0, 5000, 'pending 清空');
  assert.strictEqual(asks.length, 0);
  assert.match(logs.join('\n'), /拒绝未授权用户/);
  const sync = await readSync(root);
  assert.deepStrictEqual(sync.processed, ['m:deny1']);
  await t.stop();
});

// ---------------------------------------------------------------- 5.1 同一实例二次 start

await check('dsh 重启（同一 Tenant 二次 start）后游标继续前进，不丢 pending', async () => {
  const root = await newRoot('inplace');
  const logs = [];
  const asks = [];
  current = { buf: 'y1', msgs: [textMsg('y1', '重启前')] };

  const t = await makeTenant(root, logs, asks);
  await t.start();
  await waitFor(() => asks.length === 1, 5000, '重启前回合');
  await sleep(100);

  // dsh 子进程退出 → state='failed' → start()：流水线与队列复用，
  // 但 journal 是新建实例；commit 必须落到新实例，否则游标会回退。
  t.state = 'failed';
  current = { buf: 'y2', msgs: [textMsg('y2', '重启后')] };
  await t.start();
  await waitFor(() => asks.length === 2, 5000, '重启后回合');
  await sleep(150);

  const sync = await readSync(root);
  console.log('DEBUG sync=', JSON.stringify(sync));
  assert.strictEqual(sync.cursor, 'y2', '二次 start() 后游标必须继续前进');
  assert.deepStrictEqual(sync.pending, [], '已处理的 pending 必须清空');
  assert.deepStrictEqual(sync.processed.sort(), ['m:y1', 'm:y2']);
  await t.stop();
});

// ---------------------------------------------------------------- 6. 一批多条

await check('一批多条消息：合并成一次回合，重复投递不重复', async () => {
  const root = await newRoot('batch');
  const logs = [];
  const asks = [];
  current = { buf: 'e1', msgs: [textMsg('e1', '一'), textMsg('e2', '二')] };

  const t = await makeTenant(root, logs, asks);
  await t.start();
  await waitFor(() => asks.length === 1, 5000, '合并回合');
  await sleep(200);
  assert.strictEqual(asks.length, 1);
  assert.strictEqual(asks[0].text, '一\n\n二', '同用户 500ms 窗口内合并');
  const sync = await readSync(root);
  assert.deepStrictEqual(sync.processed.sort(), ['m:e1', 'm:e2']);
  await t.stop();
});

// ---------------------------------------------------------------- 7. context_token 交接

await check('入站 context_token 写入会话并用于回复', async () => {
  const root = await newRoot('token');
  const logs = [];
  const asks = [];
  const tokens = new Map();
  const before = sent.length;
  current = { buf: 'k1', msgs: [textMsg('k1', '带 token 的消息')] };

  const t = await makeTenant(root, logs, asks, tokens);
  await t.start();
  await waitFor(() => asks.length === 1 && sent.length > before, 5000, '回合与回复');
  await sleep(100);

  assert.strictEqual(tokens.get('user-1'), 'ctx-k1', '本轮 context_token 必须写入会话缓存');
  assert.strictEqual(sent[before]?.token, 'ctx-k1', '回复必须带上本轮的 context_token');

  const sync = await readSync(root);
  assert.strictEqual(sync.pending.length, 0);
  assert.strictEqual(sync.processed.includes('m:k1'), true);

  // status() 必须始终暴露这些运行指标
  const st = t.status();
  assert.strictEqual(st.journal.processed, 1);
  assert.strictEqual(typeof st.outbox.items, 'number');
  assert.strictEqual(typeof st.dlq.items, 'number');
  assert.strictEqual(typeof st.limits.ratePerMinute, 'number');
  assert.strictEqual(typeof st.queue.rejected, 'number');
  assert.strictEqual(typeof st.queue.budgetBlocked, 'number');
  await t.stop();
});

// ---------------------------------------------------------------- 收尾

for (const root of roots) await rm(root, { recursive: true, force: true });
server.close();

done();
