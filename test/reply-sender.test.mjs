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
import { IlinkHttpError, IlinkSendError } from '../src/wechat/ilink.mjs';

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

/** 内存 outbox：只实现 ReplySender 用到的 v2 接口 */
class MemoryOutbox {
  constructor() {
    this.peers = new Map();
    this.seq = 0;
    /** moveToDlq 的记录（内存实现不写 dlq 文件） */
    this.moved = [];
  }

  add(peerId, item, meta = {}) {
    const list = this.peers.get(peerId) ?? [];
    list.push({
      ...item,
      seq: this.seq++,
      clientId: meta.clientId ?? item.clientId ?? `cid-${this.seq}`,
      attempts: meta.attempts ?? 0,
      nextAttemptAt: meta.nextAttemptAt ?? 0,
      lastError: null,
    });
    this.peers.set(peerId, list);
    return 0;
  }

  list(peerId) {
    return [...(this.peers.get(peerId) ?? [])];
  }

  dueHead(peerId, at = Date.now()) {
    const head = (this.peers.get(peerId) ?? [])[0];
    if (!head) return null;
    if ((head.nextAttemptAt ?? 0) > at) return null;
    return head;
  }

  markAttempt(peerId, seq, { error = '', nextAt = Date.now() } = {}) {
    const item = (this.peers.get(peerId) ?? []).find((x) => x.seq === seq);
    if (!item) return null;
    item.attempts = (item.attempts ?? 0) + 1;
    item.nextAttemptAt = nextAt;
    item.lastError = error;
    return item;
  }

  remove(peerId, seq) {
    const list = this.peers.get(peerId);
    if (!list) return false;
    const i = list.findIndex((x) => x.seq === seq);
    if (i < 0) return false;
    list.splice(i, 1);
    if (list.length === 0) this.peers.delete(peerId);
    return true;
  }

  moveToDlq(peerId, seq, reason = '') {
    const item = this.list(peerId).find((x) => x.seq === seq);
    this.remove(peerId, seq);
    if (item) this.moved.push({ ...item, reason });
    return item ?? null;
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

/** 内存 DLQ：只记录 add 调用 */
class MemoryDlq {
  constructor() {
    this.items = [];
  }

  add(entry) {
    this.items.push(entry);
    return entry;
  }

  stats() {
    return { items: this.items.length };
  }

  async flush() {
    return false;
  }
}

/**
 * 构造 ReplySender；返回记录下来的发送、日志和 outbox。
 */
function makeSender(opts = {}) {
  const sent = [];
  const logs = [];
  const outbox = opts.outbox ?? new MemoryOutbox();
  const dlq = opts.dlq ?? new MemoryDlq();
  const onDlq = [];
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
    dlq,
    onDlq: (info) => onDlq.push(info),
    log: (m) => logs.push(m),
    getContextToken: () => ('token' in opts ? opts.token : 'ctx-1'),
    now: opts.now,
    sleep: opts.sleep ?? (async () => {}),
    random: opts.random ?? (() => 0),
  });
  return { reply, sent, logs, outbox, ilink, dlq, onDlq };
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
  const fileClientIds = [];
  const { reply } = makeSender({
    outbox,
    ilink: {
      getUploadUrl: async () => ({ upload_full_url: uploadUrl }),
      sendFileItem: async (o) => {
        fileClientIds.push(o.clientId);
        throw tokenExpired();
      },
      sendText: async () => {
        textAttempts++;
        return { ret: 0 };
      },
    },
  });

  const result = await reply.send('user-1', '[[file: queued-media.txt]]\n\n正文', 'old');

  const queued = outbox.list('user-1');
  assert.deepStrictEqual(queued.map((x) => x.type), ['media', 'text']);
  assert.strictEqual(queued[0].clientId, fileClientIds[0], '入队媒体复用 token 失效前的 clientId');
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

// ---------------------------------------------------------------- 错误分类重试

const httpError = (status) => new IlinkHttpError(`HTTP ${status}`, { status, endpoint: 'sendmessage' });

await check('可重试错误：原地重试一次后成功，复用同一 clientId', async () => {
  const calls = [];
  const { reply, sent, outbox, logs } = makeSender({
    ilink: {
      sendText: async (o) => {
        calls.push(o);
        if (calls.length === 1) throw httpError(500);
        sent.push(o);
        return { ret: 0 };
      },
    },
  });

  const result = await reply.send('user-1', '回复A', 'ctx-1');
  assert.deepStrictEqual(result, { sent: 1, queued: 0 });
  assert.strictEqual(calls.length, 2);
  assert.match(calls[0].clientId, /^dsh-[0-9a-f]{12}$/);
  assert.strictEqual(calls[1].clientId, calls[0].clientId, '原地重试必须复用 clientId');
  assert.deepStrictEqual(sent.map((x) => x.text), ['回复A']);
  assert.strictEqual(outbox.stats().items, 0);
  assert.ok(logs.some((m) => m.includes('原地重试')));
});

await check('持续可重试错误：入队并复用首次发送的 clientId', async () => {
  const calls = [];
  const now = 1_000_000;
  const { reply, outbox } = makeSender({
    now: () => now,
    ilink: {
      sendText: async (o) => {
        calls.push(o);
        throw httpError(503);
      },
    },
  });

  const result = await reply.send('user-1', '回复B', 'ctx-1');
  assert.strictEqual(calls.length, 2, '首次 + 一次原地重试');
  assert.deepStrictEqual(result, { sent: 0, queued: 1 });
  const item = outbox.list('user-1')[0];
  assert.strictEqual(item.text, '回复B');
  assert.strictEqual(item.attempts, 1);
  assert.strictEqual(item.nextAttemptAt, now + 2_000);
  assert.strictEqual(item.clientId, calls[0].clientId, '入队条目必须复用首次发送的 clientId');
});

await check('媒体持续可重试错误：入队复用首次发送的 clientId', async () => {
  await writeFile(join(cwd, 'retry-media.txt'), 'media body');
  const outbox = new MemoryOutbox();
  const calls = [];
  const { reply } = makeSender({
    outbox,
    ilink: {
      getUploadUrl: async () => ({ upload_full_url: uploadUrl }),
      sendFileItem: async (o) => {
        calls.push(o.clientId);
        throw httpError(503);
      },
      sendText: async () => ({ ret: 0 }),
    },
  });

  await reply.send('user-1', '[[file: retry-media.txt]]\n\n正文', 'ctx-1');

  const item = outbox.list('user-1').find((x) => x.type === 'media');
  assert.ok(item, '媒体应进入待发队列');
  assert.strictEqual(calls.length, 2, '首次 + 一次原地重试');
  assert.strictEqual(calls[0], calls[1], '原地重试必须复用 clientId');
  assert.strictEqual(item.clientId, calls[0], '入队条目必须复用同一 clientId');
});

await check('永久错误：直接进 DLQ 并告警，不无限重试', async () => {
  const { reply, dlq, onDlq, logs } = makeSender({
    ilink: { sendText: async () => { throw httpError(400); } },
  });

  const result = await reply.send('user-1', '坏消息', 'ctx-1');
  assert.deepStrictEqual(result, { sent: 0, queued: 0 });
  assert.strictEqual(dlq.items.length, 1);
  assert.strictEqual(dlq.items[0].peerId, 'user-1');
  assert.match(dlq.items[0].reason, /400/);
  assert.strictEqual(onDlq.length, 1);
  assert.ok(logs.some((m) => m.includes('DLQ')));
});

await check('队首未到 nextAttemptAt：不跳过它发后面的（保序）', async () => {
  const now = 10_000;
  const outbox = new MemoryOutbox();
  // 直接构造两条：第一条 5s 后才允许发送
  outbox.add('user-1', { type: 'text', text: '第一条' }, { nextAttemptAt: now + 5_000 });
  outbox.add('user-1', { type: 'text', text: '第二条' });
  const { reply, sent } = makeSender({ outbox, now: () => now, token: 'new' });

  await reply.flush('user-1');
  assert.strictEqual(sent.length, 0, '队首阻塞时后一条不能插队');

  // 把首条发出去后，第二条才可以发
  const first = outbox.list('user-1')[0];
  outbox.remove('user-1', first.seq);
  await reply.flush('user-1');
  assert.deepStrictEqual(sent.map((x) => x.text), ['第二条']);
});

await check('补发复用同一 clientId（幂等键）', async () => {
  const outbox = new MemoryOutbox();
  outbox.add('user-1', { type: 'text', text: '积压' });
  const clientId = outbox.list('user-1')[0].clientId;
  const { reply, sent } = makeSender({ outbox, token: 'new' });

  await reply.flush('user-1');
  assert.strictEqual(sent[0].clientId, clientId);
});

await check('连续 6 次失败后进 DLQ', async () => {
  let now = 0;
  const outbox = new MemoryOutbox();
  outbox.add('user-1', { type: 'text', text: '一直失败' });
  const { reply } = makeSender({
    outbox,
    token: 'new',
    now: () => now,
    ilink: { sendText: async () => { throw httpError(500); } },
  });

  for (let i = 0; i < 6; i++) {
    await reply.flush('user-1');
    now += 10 * 60 * 1000; // 推进到下一次重试时间之后
  }

  assert.strictEqual(outbox.stats().items, 0);
  assert.strictEqual(outbox.moved.length, 1);
  assert.strictEqual(outbox.moved[0].attempts, 6);
});

server.close();
await rm(root, { recursive: true, force: true });
console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
