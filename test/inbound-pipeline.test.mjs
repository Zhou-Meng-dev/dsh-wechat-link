#!/usr/bin/env node
/**
 * InboundPipeline 单元测试：全部使用 fake conv/reply/media/ilink，不联网。
 *
 * 覆盖：
 *   - owner / allowUsers 访问控制，未授权不进队列
 *   - 同用户 500ms 合并；不同用户互不影响
 *   - 内置命令单独成批，不与前后消息合并
 *   - 慢请求 ack 计时器先发「正在处理」
 *   - context_token 入队前缓存，后续消息复用
 */
import assert from 'node:assert';

import { InboundPipeline } from '../src/wechat/inbound.mjs';

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

/** 构造一条最小 WeixinMessage；type=1 文本，type=2 图片 */
function textMsg(text, opts = {}) {
  const msg = {
    from_user_id: opts.from ?? 'owner',
    message_type: opts.messageType ?? 1,
    item_list: [{ type: 1, text_item: { text } }],
  };
  if ('token' in opts) msg.context_token = opts.token;
  return msg;
}

/** 装配一套 fake 依赖；返回所有可断言的调用记录 */
function makeHarness(tenantOverrides = {}, deps = {}) {
  const record = {
    logs: [],
    asks: [],
    resets: [],
    sends: [],
    flushes: [],
    queuedTexts: [],
    tokenSets: [],
    tokenFlushes: [],
    ilinkTexts: [],
    loadImages: [],
    loadFiles: [],
  };
  const tokenMap = new Map();

  const tenant = {
    id: 't-inbound',
    ownerId: 'owner',
    allowUsers: [],
    ackDelayMs: 60_000,
    ...tenantOverrides,
  };

  const conv = {
    ask: async (peer, text, images) => {
      record.asks.push({ peer, text, images });
      return '回复';
    },
    reset: (peer) => record.resets.push(peer),
  };
  const reply = {
    send: async (to, text, ctx) => {
      record.sends.push({ to, text, ctx });
      return { sent: 1, queued: 0 };
    },
    flush: async (peer) => record.flushes.push(peer),
    queueTextBody: (to, text) => {
      record.queuedTexts.push({ to, text });
      return 1;
    },
  };
  const media = {
    loadImages: async (from, raw) => {
      record.loadImages.push({ from, raw });
      return [];
    },
    loadFiles: async (raw) => {
      record.loadFiles.push(raw);
      return '';
    },
  };
  const ilink = {
    getConfig: async () => 'ticket-1',
    sendTyping: async () => {},
    sendText: async (o) => {
      record.ilinkTexts.push(o);
      return { ret: 0 };
    },
  };
  const tokens = {
    get: (peer) => tokenMap.get(peer),
    set: (peer, token) => {
      record.tokenSets.push([peer, token]);
      tokenMap.set(peer, token);
    },
    flush: async (force) => {
      record.tokenFlushes.push(force);
    },
  };

  const pipeline = new InboundPipeline({
    tenant,
    ilink,
    conv,
    reply,
    media,
    tokens,
    links: deps.links ?? null,
    commands: deps.commands ?? null,
    log: (m) => record.logs.push(m),
  });

  return { pipeline, tenant, conv, reply, media, ilink, tokens, tokenMap, ...record };
}

// ---------------------------------------------------------------- 访问控制

await check('空白名单：只允许 owner，未授权用户只记日志', async () => {
  const h = makeHarness();

  h.pipeline.push(textMsg('你好', { from: 'stranger' }));
  assert.strictEqual(h.pipeline.stats().peers, 0, '未授权消息不应进队列');
  assert.ok(h.logs.some((m) => m.includes('拒绝未授权用户: stranger')));

  h.pipeline.push(textMsg('我是主人', { from: 'owner', token: 'ctx-o' }));
  assert.strictEqual(h.pipeline.stats().peers, 1);

  await waitFor(() => h.asks.length === 1);
  assert.strictEqual(h.asks[0].peer, 'owner');
  assert.strictEqual(h.asks[0].text, '我是主人');
  assert.deepStrictEqual(h.flushes, ['owner'], '回合开始前应先补发积压');

  h.pipeline.stop();
});

await check('allowUsers 非空：以名单为准，owner 也会被拒', async () => {
  const h = makeHarness({ allowUsers: ['friend'] });

  h.pipeline.push(textMsg('owner msg', { from: 'owner' }));
  h.pipeline.push(textMsg('friend msg', { from: 'friend', token: 'ctx-f' }));

  await waitFor(() => h.asks.length === 1);
  assert.strictEqual(h.asks[0].peer, 'friend');
  assert.strictEqual(h.asks[0].text, 'friend msg');
  assert.ok(h.logs.some((m) => m.includes('拒绝未授权用户: owner')));
  h.pipeline.stop();
});

await check('bot 自己发的消息（message_type=2）直接忽略', async () => {
  const h = makeHarness();
  h.pipeline.push(textMsg('bot echo', { from: 'owner', messageType: 2 }));
  assert.strictEqual(h.pipeline.stats().peers, 0);
  h.pipeline.stop();
});

// ---------------------------------------------------------------- 合并

await check('同用户 500ms 内连发两条 → 只问一次，两条都在', async () => {
  const h = makeHarness();

  h.pipeline.push(textMsg('第一条', { from: 'owner', token: 'c1' }));
  await sleep(50);
  h.pipeline.push(textMsg('第二条', { from: 'owner', token: 'c2' }));

  await waitFor(() => h.asks.length === 1);
  assert.strictEqual(h.asks[0].text, '第一条\n\n第二条');
  assert.strictEqual(h.asks[0].peer, 'owner');
  h.pipeline.stop();
});

await check('内置命令单独成批，不与前后消息合并', async () => {
  const h = makeHarness();

  h.pipeline.push(textMsg('前一条', { from: 'owner', token: 'c1' }));
  h.pipeline.push(textMsg('/new', { from: 'owner', token: 'c2' }));
  h.pipeline.push(textMsg('后一条', { from: 'owner', token: 'c3' }));

  await waitFor(() => h.asks.length === 2 && h.resets.length === 1);
  assert.deepStrictEqual(h.asks.map((a) => a.text), ['前一条', '后一条']);
  assert.deepStrictEqual(h.resets, ['owner']);
  assert.ok(h.ilinkTexts.some((t) => t.text.includes('已开启新会话')));
  assert.deepStrictEqual(h.tokenFlushes, [true], '命令应强制刷盘会话映射');
  h.pipeline.stop();
});

await check('/new 只清空该用户的链接缓存', async () => {
  const linkResets = [];
  const h = makeHarness({}, {
    links: {
      enrich: async () => '',
      reset: (peer) => linkResets.push(peer),
    },
  });

  h.pipeline.push(textMsg('/new', { from: 'owner', token: 'c1' }));
  await waitFor(() => linkResets.length === 1);
  assert.deepStrictEqual(linkResets, ['owner']);
  h.pipeline.stop();
});

// ---------------------------------------------------------------- 内置命令（UX-004）

function commandHarness() {
  return makeHarness({}, {
    commands: {
      getStatus: () => ({
        id: 't-inbound',
        label: 'bot@im.bot',
        state: 'running',
        sessions: { peers: 1, sessions: 1, busy: 0 },
        queue: { peers: 0, pending: 0, running: 0 },
        outbox: { items: 0, peers: 0 },
        tasks: { total: 2, enabled: 1 },
        usage: {
          day: { key: '2026-10-30', turns: 1, failedTurns: 0, totalTokens: 30 },
          month: { key: '2026-10', turns: 1, failedTurns: 0, totalTokens: 30 },
        },
      }),
      listTasks: () => [{
        id: 'task-1',
        title: '早报',
        enabled: true,
        schedule: { kind: 'daily', time: '09:00' },
        nextRunAt: new Date(2026, 9, 31, 9, 0, 0).getTime(),
      }],
      usage: {
        summary: () => ({
          day: { key: '2026-10-30', turns: 1, failedTurns: 0, totalTokens: 30, models: {} },
          month: { key: '2026-10', turns: 1, failedTurns: 0, totalTokens: 30, models: {} },
          budget: {},
        }),
      },
    },
  });
}

await check('/status /tasks /usage /help 绕过模型并回复文本', async () => {
  const h = commandHarness();

  for (const cmd of ['/status', '/tasks', '/usage', '/help']) {
    h.pipeline.push(textMsg(cmd, { from: 'owner', token: `ctx-${cmd}` }));
  }

  await waitFor(() => h.ilinkTexts.length === 4);
  assert.strictEqual(h.asks.length, 0, '内置命令不应进入模型');
  const texts = h.ilinkTexts.map((t) => t.text).join('\n---\n');
  assert.match(texts, /📊 运行状态/);
  assert.match(texts, /🗓 定时任务/);
  assert.match(texts, /📈 用量统计/);
  assert.match(texts, /🧰 内置命令/);
  assert.ok(h.logs.some((m) => m.includes('⌘')), '命令应留痕');
  h.pipeline.stop();
});

await check('命令回复遇到 token 失效 → 进入待发队列', async () => {
  const h = commandHarness();
  h.ilink.sendText = async () => {
    throw Object.assign(new Error('invalid context token'), { ret: -1 });
  };

  h.pipeline.push(textMsg('/help', { from: 'owner', token: 'ctx-1' }));
  await waitFor(() => h.queuedTexts.length === 1);
  assert.match(h.queuedTexts[0].text, /内置命令/);
  h.pipeline.stop();
});

await check('未知 /xxx 不拦截，照常交给模型', async () => {
  const h = makeHarness();
  h.pipeline.push(textMsg('/unknown', { from: 'owner', token: 'c1' }));

  await waitFor(() => h.asks.length === 1);
  assert.strictEqual(h.asks[0].text, '/unknown');
  h.pipeline.stop();
});

// ---------------------------------------------------------------- 链接抓取（INGEST-001）

await check('消息里的链接先抓取，正文作为上下文注入', async () => {
  const enrichCalls = [];
  const h = makeHarness({}, {
    links: {
      enrich: async (text) => {
        enrichCalls.push(text);
        return text.includes('https://') ? '【链接正文】这是抓到的内容' : '';
      },
    },
  });

  h.pipeline.push(textMsg('帮我看看 https://example.com/a', { from: 'owner', token: 'c1' }));
  await waitFor(() => h.asks.length === 1);
  assert.deepStrictEqual(enrichCalls, ['帮我看看 https://example.com/a']);
  assert.match(h.asks[0].text, /【链接正文】这是抓到的内容/);
  assert.match(h.asks[0].text, /帮我看看/);
  h.pipeline.stop();
});

await check('链接抓取异常不影响正常回合', async () => {
  const h = makeHarness({}, {
    links: { enrich: async () => { throw new Error('抓取器崩了'); } },
  });

  h.pipeline.push(textMsg('看看 https://example.com', { from: 'owner', token: 'c1' }));
  await waitFor(() => h.asks.length === 1);
  assert.strictEqual(h.asks[0].text, '看看 https://example.com');
  assert.ok(h.logs.some((m) => m.includes('链接抓取失败')));
  h.pipeline.stop();
});

// ---------------------------------------------------------------- 慢请求 ack

await check('慢请求：ack 计时器先发「正在处理」，再发最终回复', async () => {
  const h = makeHarness({ ackDelayMs: 40 });
  h.conv.ask = async (peer, text) => {
    h.asks.push({ peer, text });
    await sleep(150);
    return '最终回复';
  };

  h.pipeline.push(textMsg('需要思考一下', { from: 'owner', token: 'c1' }));

  await waitFor(() => h.sends.length >= 2);
  assert.match(h.sends[0].text, /正在处理/);
  assert.strictEqual(h.sends[0].ctx, 'c1');
  assert.strictEqual(h.sends[1].text, '最终回复');
  assert.ok(h.logs.some((m) => m.includes('已提前发送"处理中"提示')));
  h.pipeline.stop();
});

// ---------------------------------------------------------------- token 缓存

await check('context_token：入队前缓存，后续消息复用最新值', async () => {
  const h = makeHarness();

  h.pipeline.push(textMsg('A', { from: 'owner', token: 'ctx-1' }));
  assert.deepStrictEqual(h.tokenSets, [['owner', 'ctx-1']]);

  await waitFor(() => h.asks.length === 1);
  assert.strictEqual(h.sends[0].ctx, 'ctx-1');

  // 第二条不带 context_token：仍应使用缓存里的最新值
  h.pipeline.push(textMsg('B', { from: 'owner' }));
  await waitFor(() => h.asks.length === 2);
  assert.strictEqual(h.sends[1].ctx, 'ctx-1');
  assert.deepStrictEqual(h.tokenSets, [['owner', 'ctx-1']], '没有新 token 就不应重复写入');
  h.pipeline.stop();
});

console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
