#!/usr/bin/env node
/**
 * OPS-001 的采集端：ConversationManager 在回合结束/失败/超时后回调 onTurn，
 * 并累加 assistant/message 与 compaction/summary 上的 TokenUsage。
 */
import assert from 'node:assert';
import { EventEmitter } from 'node:events';

import { ConversationManager } from '../src/agent/conversation.mjs';

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

/** 最小 fake DshClient：prompt 后由测试决定发什么事件。 */
class FakeClient extends EventEmitter {
  constructor() {
    super();
    this.resume = async () => false;
    this.promptImpl = null;
  }

  async prompt(sessionId, text, images) {
    this.lastPrompt = { sessionId, text, images };
    await this.promptImpl?.(sessionId);
  }
}

function assistantEvent(sessionId, { text = '', usage } = {}) {
  const content = text ? [{ type: 'text', text }] : [];
  return {
    sessionId,
    event: {
      type: 'assistant/message',
      data: { message: { content }, stream: [], usage },
    },
  };
}

function idle(client, sessionId) {
  client.emit('event', { sessionId, event: { type: 'turn/end', data: { reason: { kind: 'completed' } } } });
  client.emit('status', { sessionId, status: 'idle' });
}

await check('成功回合：返回文本，onTurn 带 usage 与 peerId', async () => {
  const client = new FakeClient();
  const turns = [];
  const cm = new ConversationManager(client, { onTurn: (info) => turns.push(info) });

  client.promptImpl = async (sessionId) => {
    client.emit('status', { sessionId, status: 'running' });
    client.emit('event', assistantEvent(sessionId, {
      text: '答案',
      usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 2 },
    }));
    idle(client, sessionId);
  };

  const reply = await cm.ask('u1', '问题');
  assert.strictEqual(reply, '答案');
  assert.strictEqual(turns.length, 1);
  assert.strictEqual(turns[0].peerId, 'u1');
  assert.ok(turns[0].sessionId.startsWith('wx-u1-'));
  assert.strictEqual(turns[0].ok, true);
  assert.strictEqual(turns[0].error, null);
  assert.deepStrictEqual(turns[0].usage, { inputTokens: 10, outputTokens: 5, cacheReadTokens: 2 });
  assert.ok(turns[0].durationMs >= 0);
});

await check('工具调用循环：多次 assistant/message 的 usage 累加', async () => {
  const client = new FakeClient();
  const turns = [];
  const cm = new ConversationManager(client, { onTurn: (info) => turns.push(info) });

  client.promptImpl = async (sessionId) => {
    client.emit('status', { sessionId, status: 'running' });
    client.emit('event', assistantEvent(sessionId, { usage: { inputTokens: 100, outputTokens: 10 } }));
    client.emit('event', assistantEvent(sessionId, {
      text: '最终答案',
      usage: { inputTokens: 200, outputTokens: 20, totalTokens: 220 },
    }));
    client.emit('event', {
      sessionId,
      event: { type: 'compaction/summary', data: { usage: { inputTokens: 50, outputTokens: 5 } } },
    });
    idle(client, sessionId);
  };

  const reply = await cm.ask('u2', '问题');
  assert.strictEqual(reply, '最终答案');
  assert.deepStrictEqual(turns[0].usage, {
    inputTokens: 350,
    outputTokens: 35,
    totalTokens: 220,
  });
});

await check('失败回合：无正文时抛错，onTurn 记 ok=false', async () => {
  const client = new FakeClient();
  const turns = [];
  const cm = new ConversationManager(client, { onTurn: (info) => turns.push(info) });

  client.promptImpl = async (sessionId) => {
    client.emit('status', { sessionId, status: 'running' });
    client.emit('event', {
      sessionId,
      event: {
        type: 'turn/end',
        data: { reason: { kind: 'error', error: { message: '模型挂了' } } },
      },
    });
    client.emit('status', { sessionId, status: 'idle' });
  };

  await assert.rejects(cm.ask('u3', '问题'), /模型挂了/);
  assert.strictEqual(turns.length, 1);
  assert.strictEqual(turns[0].ok, false);
  assert.match(turns[0].error, /模型挂了/);
});

await check('回合超时：也会回调一次 ok=false', async () => {
  const client = new FakeClient();
  const turns = [];
  const cm = new ConversationManager(client, { onTurn: (info) => turns.push(info), turnTimeoutMs: 40 });

  client.promptImpl = async (sessionId) => {
    client.emit('status', { sessionId, status: 'running' });
    // 故意不发 idle
  };

  await assert.rejects(cm.ask('u4', '问题'), /回合超时/);
  assert.strictEqual(turns.length, 1);
  assert.strictEqual(turns[0].ok, false);
});

await check('prompt 失败：onTurn 记失败后原样抛出', async () => {
  const client = new FakeClient();
  const turns = [];
  const cm = new ConversationManager(client, { onTurn: (info) => turns.push(info) });

  client.promptImpl = async () => { throw new Error('连接已关闭'); };

  await assert.rejects(cm.ask('u5', '问题'), /连接已关闭/);
  assert.strictEqual(turns.length, 1);
  assert.strictEqual(turns[0].ok, false);
  assert.match(turns[0].error, /连接已关闭/);
});

await check('onTurn 抛错不影响对话结果', async () => {
  const client = new FakeClient();
  const cm = new ConversationManager(client, {
    onTurn: () => { throw new Error('统计写坏了'); },
  });

  client.promptImpl = async (sessionId) => {
    client.emit('status', { sessionId, status: 'running' });
    client.emit('event', assistantEvent(sessionId, { text: '正常回复' }));
    idle(client, sessionId);
  };

  assert.strictEqual(await cm.ask('u6', '问题'), '正常回复');
});

console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
