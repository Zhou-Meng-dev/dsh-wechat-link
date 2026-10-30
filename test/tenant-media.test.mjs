#!/usr/bin/env node
/**
 * 入站图片链路集成：CDN 下载/解密 → 原图留存 → 归一化 → 送入 conv.ask。
 * 用本地 HTTP 服务模拟 CDN，不需要真实微信。
 */
import assert from 'node:assert';
import { createServer } from 'node:http';
import { createCipheriv } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Tenant } from '../src/tenant.mjs';

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

// 1x1 PNG
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
const KEY = Buffer.from('0123456789abcdef0123456789abcdef', 'hex');
const cipher = createCipheriv('aes-128-ecb', KEY, null);
const CIPHERTEXT = Buffer.concat([cipher.update(PNG), cipher.final()]);

const server = createServer((req, res) => {
  if (req.url.startsWith('/img')) {
    res.writeHead(200, { 'content-length': String(CIPHERTEXT.length) });
    res.end(CIPHERTEXT);
    return;
  }
  res.writeHead(404);
  res.end();
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;

const root = await mkdtemp(join(tmpdir(), 'tenant-media-'));
const ws = join(root, 'workspace');
await mkdir(ws, { recursive: true });

const asks = [];
const sent = [];
const logs = [];
const t = new Tenant({
  id: 't-test',
  botId: 'test-bot',
  ownerId: 'user-1',
  allowUsers: ['user-1'],
  cwd: ws,
  root,
  token: 'test-token',
  baseUrl: 'http://127.0.0.1:1/',
  ackDelayMs: 60_000,
  maxChars: 1800,
}, { log: (m) => logs.push(m) });

t.ilink = {
  sendText: async (o) => { sent.push(o); return { ret: 0 }; },
  getConfig: async () => null,
  sendTyping: async () => {},
};
const tokens = new Map();
t.session = {
  ask: async (peer, text, images) => {
    asks.push({ peer, text, images });
    return '收到图片';
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

const imageItem = {
  media: { full_url: `http://127.0.0.1:${port}/img` },
  aeskey: '0123456789abcdef0123456789abcdef',
};

await check('入站图片解密后作为图片块送入模型，并保留原图', async () => {
  t.inbound.push({
    from_user_id: 'user-1',
    message_type: 1,
    context_token: 'ctx-1',
    item_list: [
      { type: 1, text_item: { text: '这是什么？' } },
      { type: 2, image_item: imageItem },
    ],
  });

  await waitFor(() => asks.length === 1);
  const ask = asks[0];
  assert.strictEqual(ask.text.includes('这是什么？'), true);
  assert.strictEqual(ask.images.length, 1);
  assert.strictEqual(ask.images[0].mimeType, 'image/png');
  assert.ok(Buffer.from(ask.images[0].data, 'base64').equals(PNG));

  // 原图落盘路径也注入 prompt，方便 agent 追溯
  assert.match(ask.text, /原图已保留在工作区/);
  const originalPath = ask.images[0].originalPath;
  assert.ok(originalPath, '缺少 originalPath');
  assert.ok((await readFile(originalPath)).equals(PNG));

  await waitFor(() => sent.length === 1);
  assert.strictEqual(sent[0].text, '收到图片');
  t.inbound.stop();
});

server.close();
await rm(root, { recursive: true, force: true });

console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
