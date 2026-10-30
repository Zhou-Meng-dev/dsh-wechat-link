#!/usr/bin/env node
/**
 * 同用户消息队列：串行、500ms 合并、不丢消息、命令单独成批。
 *
 * 时间窗口用 20–60ms 跑，避免测试变慢；默认值（500ms）另有断言。
 */
import assert from 'node:assert';

import {
  UserMessageQueue,
  mergeQueueItems,
  DEFAULT_MERGE_WINDOW_MS,
  DEFAULT_MAX_WAIT_MS,
} from '../src/wechat/message-queue.mjs';

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
async function waitFor(predicate, timeoutMs = 2000) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('等待超时');
    await sleep(5);
  }
}

await check('默认合并窗口是 500ms，最长等待 3s', () => {
  assert.strictEqual(DEFAULT_MERGE_WINDOW_MS, 500);
  assert.ok(DEFAULT_MAX_WAIT_MS >= 500);
});

await check('mergeQueueItems：文本按到达顺序拼接，图片/文件合并，token 取最新', () => {
  const batch = mergeQueueItems([
    { text: '第一条', kind: 'text', contextToken: 't1', images: [{ id: 1 }] },
    { text: '第二条', kind: 'image', contextToken: 't2', files: [{ name: 'a.pdf' }] },
  ]);
  assert.strictEqual(batch.text, '第一条\n\n第二条');
  assert.deepStrictEqual(batch.images, [{ id: 1 }]);
  assert.deepStrictEqual(batch.files, [{ name: 'a.pdf' }]);
  assert.strictEqual(batch.contextToken, 't2');
  assert.strictEqual(batch.messageCount, 2);
});

await check('窗口内连续两条合并成一次提问', async () => {
  const batches = [];
  const q = new UserMessageQueue({
    windowMs: 60,
    handle: (_peer, batch) => { batches.push(batch); },
  });

  q.push('u1', { text: '第一条', kind: 'text', contextToken: 't1' });
  await sleep(20);
  q.push('u1', {
    text: '第二条',
    kind: 'text',
    contextToken: 't2',
    images: [{ id: 1 }],
    files: [{ name: 'a.pdf' }],
  });

  await waitFor(() => batches.length === 1);
  assert.strictEqual(batches[0].text, '第一条\n\n第二条');
  assert.strictEqual(batches[0].messageCount, 2);
  assert.strictEqual(batches[0].contextToken, 't2');
  assert.strictEqual(batches[0].images.length, 1);
  assert.strictEqual(batches[0].files.length, 1);
  q.stop();
});

await check('超出窗口的两条不合并，但都会执行（不丢消息）', async () => {
  const batches = [];
  const q = new UserMessageQueue({
    windowMs: 30,
    handle: (_peer, batch) => { batches.push(batch.text); },
  });

  q.push('u1', { text: 'A' });
  await waitFor(() => batches.length === 1);
  q.push('u1', { text: 'B' });
  await waitFor(() => batches.length === 2);

  assert.deepStrictEqual(batches, ['A', 'B']);
  q.stop();
});

await check('同一用户同时最多一个回合；处理中到达的消息排到下一批', async () => {
  let active = 0;
  let maxActive = 0;
  const seen = [];
  const q = new UserMessageQueue({
    windowMs: 10,
    handle: async (_peer, batch) => {
      active++;
      maxActive = Math.max(maxActive, active);
      await sleep(50);
      seen.push(batch.text);
      active--;
    },
  });

  q.push('u1', { text: 'A' });
  await waitFor(() => active === 1);
  q.push('u1', { text: 'B' });
  q.push('u1', { text: 'C' });

  await waitFor(() => seen.length === 2);
  assert.strictEqual(maxActive, 1, '出现了并发的用户回合');
  assert.strictEqual(seen[0], 'A');
  assert.strictEqual(seen[1], 'B\n\nC');
  q.stop();
});

await check('不同用户互不阻塞', async () => {
  const seen = [];
  const q = new UserMessageQueue({
    windowMs: 10,
    handle: async (peer) => {
      if (peer === 'slow') await sleep(50);
      seen.push(peer);
    },
  });

  q.push('slow', { text: '慢' });
  q.push('fast', { text: '快' });
  await waitFor(() => seen.length === 2);

  assert.deepStrictEqual(seen, ['fast', 'slow']);
  q.stop();
});

await check('突发 5 条全部进入批次，不丢内容', async () => {
  const batches = [];
  const q = new UserMessageQueue({
    windowMs: 30,
    handle: (_peer, batch) => { batches.push(batch); },
  });

  for (let i = 1; i <= 5; i++) q.push('u1', { text: `第${i}条` });
  await waitFor(() => batches.length === 1);

  assert.strictEqual(batches[0].messageCount, 5);
  for (let i = 1; i <= 5; i++) {
    assert.ok(batches[0].text.includes(`第${i}条`), `缺少第${i}条`);
  }
  q.stop();
});

await check('命令（mergeable=false）单独成批，前后顺序保持不变', async () => {
  const batches = [];
  const q = new UserMessageQueue({
    windowMs: 20,
    handle: (_peer, batch) => { batches.push(batch); },
  });

  q.push('u1', { text: '问题' });
  q.push('u1', { text: '/new', kind: 'command', mergeable: false });
  q.push('u1', { text: '新问题' });

  await waitFor(() => batches.length === 3);
  assert.deepStrictEqual(
    batches.map((b) => b.text),
    ['问题', '/new', '新问题'],
  );
  assert.deepStrictEqual(
    batches.map((b) => b.messageCount),
    [1, 1, 1],
  );
  q.stop();
});

await check('处理抛错不会卡死队列，后续消息仍会执行', async () => {
  let calls = 0;
  const q = new UserMessageQueue({
    windowMs: 10,
    handle: () => {
      calls++;
      if (calls === 1) throw new Error('模拟失败');
    },
  });

  q.push('u1', { text: 'A' });
  await waitFor(() => calls === 1);
  q.push('u1', { text: 'B' });
  await waitFor(() => calls === 2);
  q.stop();
});

await check('stop 后不再处理待合并消息', async () => {
  let calls = 0;
  const q = new UserMessageQueue({
    windowMs: 50,
    handle: () => { calls++; },
  });

  q.push('u1', { text: 'A' });
  q.stop();
  await sleep(120);
  assert.strictEqual(calls, 0);
});

await check('stats 能反映待处理与运行中的队列', async () => {
  const q = new UserMessageQueue({
    windowMs: 20,
    handle: async () => { await sleep(40); },
  });

  q.push('u1', { text: 'A' });
  q.push('u2', { text: 'B' });
  await waitFor(() => {
    const s = q.stats();
    return s.running === 2;
  });
  const s = q.stats();
  assert.strictEqual(s.peers, 2);
  assert.strictEqual(s.running, 2);
  assert.strictEqual(s.pending, 0);
  q.stop();
});

console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
