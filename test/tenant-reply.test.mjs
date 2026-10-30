#!/usr/bin/env node
/**
 * Tenant 出站链路集成测试（不启动 dsh / iLink 真实连接）：
 *   - 同用户连发两条 → 合并成一次 conv.ask
 *   - Markdown → 纯文本
 *   - 超长回复 → 先发 FILE，再发摘要 TEXT
 *
 * 用本地 HTTP 服务模拟 iLink 的 getconfig / getuploadurl / CDN upload / sendmessage。
 */
import assert from 'node:assert';
import { createServer } from 'node:http';
import { createDecipheriv } from 'node:crypto';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Tenant } from '../src/tenant.mjs';
import { IlinkClient } from '../src/wechat/ilink.mjs';

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

// ---------------------------------------------------------------- fake iLink

let sentMessages = [];
let uploadedCipher = null;
let uploadKey = null;

const server = createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = Buffer.concat(chunks);

  const json = (obj) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(obj));
  };

  if (req.url === '/ilink/bot/getconfig') return json({ typing_ticket: null });
  if (req.url === '/ilink/bot/getuploadurl') {
    const parsed = JSON.parse(body.toString('utf8'));
    uploadKey = Buffer.from(parsed.aeskey, 'hex');
    return json({ upload_full_url: `http://127.0.0.1:${server.address().port}/upload` });
  }
  if (req.url === '/upload') {
    uploadedCipher = body;
    res.writeHead(200, { 'x-encrypted-param': 'enc-param-tenant-test' });
    return res.end();
  }
  if (req.url === '/ilink/bot/sendmessage') {
    sentMessages.push(JSON.parse(body.toString('utf8')));
    return json({ ret: 0 });
  }
  res.writeHead(404);
  res.end();
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;

const root = await mkdtemp(join(tmpdir(), 'tenant-reply-'));
const ws = join(root, 'workspace');
await mkdir(ws, { recursive: true });

function makeTenant(reply, asks = []) {
  const tenant = {
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
  };
  const t = new Tenant(tenant, { log: () => {} });
  t.ilink = new IlinkClient({ token: 'test-token', baseUrl: tenant.baseUrl });
  const tokens = new Map();
  t.session = {
    ask: async (peer, text) => {
      asks.push({ peer, text });
      return typeof reply === 'function' ? reply(text) : reply;
    },
    reset: () => {},
    stats: () => ({ peers: 1, sessions: 1, busy: 0 }),
    getToken: (peer) => tokens.get(peer),
    setToken: (peer, token) => { if (token) tokens.set(peer, token); },
    flushTokens: async () => {},
  };
  // 使用生产同款装配工厂。
  t.reply = t.createReplySender();
  t.inbound = t.createInboundPipeline();
  return t;
}

function pushText(t, text, contextToken = 'ctx-1') {
  t.inbound.push({
    from_user_id: 'user-1',
    message_type: 1,
    context_token: contextToken,
    item_list: [{ type: 1, text_item: { text } }],
  });
}

// ---------------------------------------------------------------- 合并

await check('同用户 500ms 内连发两条 → 只调用一次 conv.ask，两条都在', async () => {
  const asks = [];
  const t = makeTenant('收到', asks);

  pushText(t, '第一条');
  await sleep(50);
  pushText(t, '第二条');

  await waitFor(() => asks.length === 1);
  assert.strictEqual(asks[0].text, '第一条\n\n第二条');
  assert.strictEqual(asks[0].peer, 'user-1');

  // 等回复发完，避免和下一个用例交错
  await waitFor(() => sentMessages.length === 1);
  t.inbound.stop();
});

// ---------------------------------------------------------------- Markdown

await check('回复里的 Markdown 被转成纯文本再发送', async () => {
  sentMessages = [];
  const asks = [];
  const reply = '## 结果\n**加粗** 和 [链接](https://example.com/x)';
  const t = makeTenant(reply, asks);

  pushText(t, '给我结果');
  await waitFor(() => sentMessages.length === 1);

  const msg = sentMessages[0].msg;
  assert.strictEqual(msg.message_type, 2);
  assert.strictEqual(msg.context_token, 'ctx-1');
  const text = msg.item_list[0].text_item.text;
  assert.strictEqual(text, '【结果】\n加粗 和 链接 (https://example.com/x)');
  t.inbound.stop();
});

// ---------------------------------------------------------------- 超长转文件

await check('超长回复 → 先发 FILE（内容完整）、再发一句摘要', async () => {
  sentMessages = [];
  uploadedCipher = null;
  uploadKey = null;
  const longReply = '# 长报告\n\n' + '正文内容。'.repeat(900); // 4506 字
  const t = makeTenant(longReply);

  pushText(t, '写一份长报告');
  await waitFor(() => sentMessages.length === 2);

  const [fileMsg, summaryMsg] = sentMessages.map((m) => m.msg);

  // 1) 文件消息
  assert.strictEqual(fileMsg.item_list[0].type, 4);
  const fileItem = fileMsg.item_list[0].file_item;
  assert.match(fileItem.file_name, /^reply-\d{8}-\d{6}-[0-9a-f]{4}\.md$/);
  assert.strictEqual(fileItem.media.encrypt_query_param, 'enc-param-tenant-test');
  assert.strictEqual(fileItem.len, String(Buffer.byteLength(`${longReply}\n`)));

  // 2) 上传的密文能解回完整原文（内容没丢）
  const d = createDecipheriv('aes-128-ecb', uploadKey, null);
  const plain = Buffer.concat([d.update(uploadedCipher), d.final()]);
  assert.strictEqual(plain.toString('utf8'), `${longReply}\n`);

  // 3) 摘要消息
  const summary = summaryMsg.item_list[0].text_item.text;
  assert.match(summary, new RegExp(`内容较长（约 ${longReply.length} 字）`));
  assert.match(summary, new RegExp(fileItem.file_name.replace(/\./g, '\\.')));
  assert.match(summary, /摘要：【长报告】 正文内容。/);

  t.inbound.stop();
});

// ---------------------------------------------------------------- 串行

await check('处理中到达的消息进入下一批，不会并发执行两个回合', async () => {
  sentMessages = [];
  const asks = [];
  let active = 0;
  let maxActive = 0;

  const t = makeTenant('收到', asks);
  t.session.ask = async (_peer, text) => {
    asks.push(text);
    active++;
    maxActive = Math.max(maxActive, active);
    await sleep(120);
    active--;
    return '收到';
  };

  pushText(t, 'A');
  await waitFor(() => asks.length === 1);
  pushText(t, 'B');
  pushText(t, 'C');

  await waitFor(() => asks.length === 2);
  assert.strictEqual(maxActive, 1, '同一用户出现了并发回合');
  assert.strictEqual(asks[0], 'A');
  assert.strictEqual(asks[1], 'B\n\nC');
  t.inbound.stop();
});

server.close();
await rm(root, { recursive: true, force: true });

console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
