#!/usr/bin/env node
/**
 * ReplySender 单元测试：纯内存 fake iLink + 内存 outbox，不访问真实微信网络。
 *
 * 覆盖：
 *   - Markdown 清理（微信不渲染 Markdown）
 *   - 超长回复 → 先发 .md 文件、再发摘要（本地 HTTP 模拟 CDN 上传）
 *   - 媒体数量上限 5 个
 *   - token 失效 → 文字/媒体按顺序进入待发队列
 *   - flush 成功 / 仍失效 / 无 token
 */
import assert from 'node:assert';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ReplySender } from '../src/wechat/reply.mjs';
import { IlinkSendError } from '../src/wechat/ilink.mjs';

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

/** 内存 outbox：只实现 ReplySender 用到的接口 */
class MemoryOutbox {
  constructor() {
    this.peers = new Map();
  }

  add(peerId, item) {
    const list = this.peers.get(peerId) ?? [];
    list.push({ ...item, attempts: 0 });
    this.peers.set(peerId, list);
    return 0;
  }

  list(peerId) {
    return [...(this.peers.get(peerId) ?? [])];
  }

  shift(peerId, n = 1) {
    const list = this.peers.get(peerId);
    if (!list?.length) return 0;
    const count = Math.min(n, list.length);
    list.splice(0, count);
    if (list.length === 0) this.peers.delete(peerId);
    return count;
  }

  stats() {
    let items = 0;
    for (const list of this.peers.values()) items += list.length;
    return { peers: this.peers.size, items };
  }

  async flush() {
    return false;
  }
}

// ---------------------------------------------------------------- fake CDN

const server = createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  if (req.url === '/upload') {
    res.writeHead(200, { 'x-encrypted-param': 'enc-param-test' });
    res.end();
    return;
  }
  res.writeHead(404);
  res.end();
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const uploadUrl = `http://127.0.0.1:${server.address().port}/upload`;

const root = await mkdtemp(join(tmpdir(), 'reply-sender-'));
const cwd = join(root, 'workspace');
await mkdir(cwd, { recursive: true });

/**
 * 构造 ReplySender；返回记录下来的发送、日志和 outbox。
 */
function makeSender(opts = {}) {
  const sent = [];
  const logs = [];
  const outbox = opts.outbox ?? new MemoryOutbox();
  const ilink = opts.ilink ?? {
    sendText: async (o) => {
      sent.push(o);
      return { ret: 0, message_id: 'm-1' };
    },
    getUploadUrl: async () => {
      throw new Error('本用例不应上传媒体');
    },
  };
  const reply = new ReplySender({
    cwd,
    maxChars: 1800,
    ilink,
    outbox,
    log: (m) => logs.push(m),
    getContextToken: () => ('token' in opts ? opts.token : 'ctx-1'),
  });
  return { reply, sent, logs, outbox, ilink };
}

const tokenExpired = () => new IlinkSendError('sendmessage 失败', {
  ret: -1,
  errmsg: 'invalid context token',
});

// ---------------------------------------------------------------- Markdown

await check('Markdown 清理：发送前转成纯文本', async () => {
  const { reply, sent } = makeSender();
  const result = await reply.send(
    'user-1',
    '## 结果\n**加粗** 和 [链接](https://example.com/x)',
    'ctx-1',
  );

  assert.deepStrictEqual(result, { sent: 1, queued: 0 });
  assert.strictEqual(sent.length, 1);
  assert.strictEqual(sent[0].toUserId, 'user-1');
  assert.strictEqual(sent[0].contextToken, 'ctx-1');
  assert.strictEqual(sent[0].text, '【结果】\n加粗 和 链接 (https://example.com/x)');
});

// ---------------------------------------------------------------- 超长转文件

await check('超长回复 → 先发 .md 文件（内容完整），再发摘要', async () => {
  const sent = [];
  const longReply = '# 长报告\n\n' + '正文内容。'.repeat(900); // 4506 字
  const { reply } = makeSender({
    ilink: {
      getUploadUrl: async () => ({ upload_full_url: uploadUrl }),
      sendFileItem: async (o) => {
        sent.push({ ...o, type: 'file' });
        return { ret: 0 };
      },
      sendText: async (o) => {
        sent.push({ ...o, type: 'text' });
        return { ret: 0 };
      },
    },
  });

  const result = await reply.send('user-1', longReply, 'ctx-1');
  assert.strictEqual(result.queued, 0);
  assert.strictEqual(sent.length, 2);

  const [fileMsg, summary] = sent;
  assert.strictEqual(fileMsg.type, 'file');
  assert.match(fileMsg.fileName, /^reply-\d{8}-\d{6}-[0-9a-f]{4}\.md$/);
  assert.strictEqual(fileMsg.encryptQueryParam, 'enc-param-test');

  // 落盘文件内容完整，没有因为转文件丢字
  const saved = await readFile(join(cwd, '_outbox', fileMsg.fileName), 'utf8');
  assert.strictEqual(saved, `${longReply}\n`);

  assert.strictEqual(summary.type, 'text');
  assert.match(summary.text, new RegExp(`内容较长（约 ${longReply.length} 字）`));
  assert.match(summary.text, new RegExp(fileMsg.fileName.replace(/\./g, '\\.')));
  assert.match(summary.text, /摘要：【长报告】 正文内容。/);
});

// ---------------------------------------------------------------- 媒体上限

await check('媒体数量上限：只尝试 5 个，其余忽略并警告', async () => {
  let uploads = 0;
  const directives = [];
  for (let i = 1; i <= 6; i++) {
    await writeFile(join(cwd, `limit-${i}.txt`), `file ${i}`);
    directives.push(`[[file: limit-${i}.txt]]`);
  }

  const { reply, sent } = makeSender({
    ilink: {
      getUploadUrl: async () => {
        uploads++;
        throw new Error('CDN 不可用');
      },
      sendText: async (o) => {
        sent.push(o);
        return { ret: 0 };
      },
    },
  });

  const result = await reply.send('user-1', `${directives.join('\n')}\n\n正文`, 'ctx-1');

  assert.strictEqual(uploads, 5, '第 6 个媒体不应触发上传');
  assert.strictEqual(result.sent, 1); // 只有文字发出去
  const text = sent[0].text;
  assert.match(text, /一次最多发送 5 个媒体/);
  assert.match(text, /其余 1 个已忽略/);
  assert.strictEqual((text.match(/文件「limit-\d\.txt」发送失败/g) ?? []).length, 5);
});

// ---------------------------------------------------------------- token 失效

await check('token 失效：文字进入待发队列，不丢内容', async () => {
  const outbox = new MemoryOutbox();
  let attempts = 0;
  const { reply, logs } = makeSender({
    outbox,
    ilink: {
      sendText: async () => {
        attempts++;
        throw tokenExpired();
      },
    },
  });

  const result = await reply.send('user-1', '回复A', 'old');
  assert.deepStrictEqual(result, { sent: 0, queued: 1 });
  assert.strictEqual(attempts, 1);
  assert.deepStrictEqual(outbox.list('user-1').map((x) => [x.type, x.text]), [['text', '回复A']]);
  assert.ok(logs.some((m) => m.includes('待发队列')));
});

await check('媒体 token 失效：媒体与文字按顺序入队', async () => {
  await writeFile(join(cwd, 'queued-media.txt'), 'media body');
  const outbox = new MemoryOutbox();
  let textAttempts = 0;
  const { reply } = makeSender({
    outbox,
    ilink: {
      getUploadUrl: async () => ({ upload_full_url: uploadUrl }),
      sendFileItem: async () => {
        throw tokenExpired();
      },
      sendText: async () => {
        textAttempts++;
        return { ret: 0 };
      },
    },
  });

  const result = await reply.send('user-1', '[[file: queued-media.txt]]\n\n正文', 'old');

  assert.deepStrictEqual(outbox.list('user-1').map((x) => x.type), ['media', 'text']);
  assert.deepStrictEqual(result, { sent: 0, queued: 2 });
  assert.strictEqual(textAttempts, 0, '已有媒体入队时，文字不应再尝试实时发送');
});

// ---------------------------------------------------------------- flush

await check('flush 成功：用最新 token 补发并清空队列', async () => {
  const outbox = new MemoryOutbox();
  outbox.add('user-1', { type: 'text', text: '积压1' });
  outbox.add('user-1', { type: 'text', text: '积压2' });
  const { reply, sent } = makeSender({ outbox, token: 'new' });

  await reply.flush('user-1');

  assert.deepStrictEqual(sent.map((x) => x.text), ['积压1', '积压2']);
  assert.deepStrictEqual(sent.map((x) => x.contextToken), ['new', 'new']);
  assert.strictEqual(outbox.stats().items, 0);
});

await check('flush 仍失效：保留剩余消息，不丢弃', async () => {
  const outbox = new MemoryOutbox();
  outbox.add('user-1', { type: 'text', text: '积压1' });
  outbox.add('user-1', { type: 'text', text: '积压2' });
  const { reply, logs } = makeSender({
    outbox,
    token: 'still-old',
    ilink: { sendText: async () => { throw tokenExpired(); } },
  });

  await reply.flush('user-1');

  assert.deepStrictEqual(outbox.list('user-1').map((x) => x.text), ['积压1', '积压2']);
  assert.ok(logs.some((m) => m.includes('补发暂停')));
});

await check('flush 无 token：不发送，积压继续保留', async () => {
  const outbox = new MemoryOutbox();
  outbox.add('user-1', { type: 'text', text: '积压' });
  const { reply, sent, logs } = makeSender({ outbox, token: null });

  await reply.flush('user-1');

  assert.strictEqual(sent.length, 0);
  assert.strictEqual(outbox.stats().items, 1);
  assert.ok(logs.some((m) => m.includes('缺少 context_token')));
});

server.close();
await rm(root, { recursive: true, force: true });

console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
