#!/usr/bin/env node
/**
 * UX-004：内置命令解析与渲染（纯函数）。
 */
import assert from 'node:assert';

import {
  BUILTIN_COMMAND_NAMES,
  formatHelp,
  formatStatus,
  formatTasks,
  parseBuiltinCommand,
  renderCommand,
} from '../src/wechat/commands.mjs';
import { formatUsageSummary } from '../src/ops/usage.mjs';

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

await check('parseBuiltinCommand：英文/中文别名与大小写', () => {
  assert.deepStrictEqual(parseBuiltinCommand('/status'), { name: 'status', token: '/status' });
  assert.strictEqual(parseBuiltinCommand('/TASKS')?.name, 'tasks');
  assert.strictEqual(parseBuiltinCommand('/任务')?.name, 'tasks');
  assert.strictEqual(parseBuiltinCommand('/用量')?.name, 'usage');
  assert.strictEqual(parseBuiltinCommand('/重置')?.name, 'new');
  assert.strictEqual(parseBuiltinCommand('/help   带参数')?.name, 'help');
});

await check('parseBuiltinCommand：未知命令/普通消息不拦截', () => {
  assert.strictEqual(parseBuiltinCommand('/unknown'), null);
  assert.strictEqual(parseBuiltinCommand('请帮我 /status'), null);
  assert.strictEqual(parseBuiltinCommand(''), null);
  assert.strictEqual(parseBuiltinCommand(undefined), null);
});

await check('BUILTIN_COMMAND_NAMES 覆盖文档里的命令', () => {
  for (const name of ['new', 'help', 'status', 'tasks', 'usage']) {
    assert.ok(BUILTIN_COMMAND_NAMES.includes(name), `缺少 ${name}`);
  }
});

await check('formatHelp 列出全部常用命令', () => {
  const text = formatHelp();
  for (const cmd of ['/new', '/status', '/tasks', '/usage', '/help']) {
    assert.ok(text.includes(cmd), `帮助里缺少 ${cmd}`);
  }
  assert.match(text, /不消耗模型额度/);
});

await check('formatStatus：状态/会话/队列/任务/用量完整可读', () => {
  const text = formatStatus({
    id: 't-abc',
    label: 'bot@im.bot',
    ownerId: 'owner@im.wechat',
    cwd: '/tmp/ws',
    state: 'running',
    sessions: { peers: 2, sessions: 2, busy: 1 },
    queue: { peers: 1, pending: 3, running: 1 },
    outbox: { items: 4, peers: 1 },
    tasks: { total: 5, enabled: 3 },
    usage: {
      day: { turns: 2, failedTurns: 0, totalTokens: 1234 },
      month: { turns: 9, failedTurns: 1, totalTokens: 5678 },
    },
  });
  assert.match(text, /运行状态/);
  assert.match(text, /bot@im\.bot（t-abc）/);
  assert.match(text, /状态: 运行中/);
  assert.match(text, /会话: 2 个用户 \/ 1 个忙碌/);
  assert.match(text, /队列: 1 个用户 \/ 3 条待处理/);
  assert.match(text, /待发: 4 条/);
  assert.match(text, /定时任务: 5 个（启用 3 个）/);
  assert.match(text, /今日 2 回合 \/ 1,234 tokens/);
  assert.match(text, /本月 9 回合 \/ 5,678 tokens/);
});

await check('formatStatus：缺字段时优雅降级', () => {
  const text = formatStatus({ id: 't-x', state: 'unknown-state' });
  assert.match(text, /t-x/);
  assert.match(text, /状态: unknown-state/);
  assert.doesNotMatch(text, /undefined/);
});

await check('formatTasks：空列表给出添加提示', () => {
  const text = formatTasks([]);
  assert.match(text, /还没有定时任务/);
  assert.match(text, /--daily/);
});

await check('formatTasks：启用/暂停、下次时间与截断', () => {
  const tasks = [
    {
      id: 'task-1',
      title: '早报',
      enabled: true,
      schedule: { kind: 'daily', time: '09:00' },
      nextRunAt: new Date(2026, 9, 31, 9, 0, 0).getTime(),
    },
    { id: 'task-2', title: '周报', enabled: false, schedule: { kind: 'weekly', days: [1], time: '10:00' } },
  ];
  const text = formatTasks(tasks);
  assert.match(text, /共 2 个，启用 1 个/);
  assert.match(text, /✅ 「早报」 每天 09:00；下次 2026-10-31 09:00/);
  assert.match(text, /⏸ 「周报」 每周 周一 10:00/);

  const many = Array.from({ length: 25 }, (_, i) => ({
    id: `t${i}`,
    title: `任务 ${i}`,
    enabled: true,
    schedule: { kind: 'every', minutes: 60 },
  }));
  const truncated = formatTasks(many);
  assert.match(truncated, /还有 15 个任务/);
});

await check('renderCommand：help/status/tasks/usage 都能出文本', () => {
  assert.match(renderCommand('help'), /内置命令/);
  assert.match(renderCommand('status', { status: { id: 't-1', state: 'running' } }), /运行状态/);
  assert.match(renderCommand('tasks', { tasks: [] }), /还没有定时任务/);

  const usageSummary = {
    day: { key: '2026-10-30', turns: 1, failedTurns: 0, totalTokens: 10 },
    month: { key: '2026-10', turns: 1, failedTurns: 0, totalTokens: 10 },
    budget: {},
  };
  assert.match(renderCommand('usage', { usage: usageSummary }), /用量统计/);
  assert.match(renderCommand('usage'), /暂无记录/);
  assert.strictEqual(renderCommand('nope'), '');
});

await check('formatUsageSummary：没有数据时也给出日期', () => {
  const text = formatUsageSummary({
    day: { key: '2026-10-30', turns: 0, failedTurns: 0, totalTokens: 0 },
    month: { key: '2026-10', turns: 0, failedTurns: 0, totalTokens: 0 },
    budget: {},
  });
  assert.match(text, /今日 2026-10-30: 暂无记录/);
  assert.match(text, /本月 2026-10: 暂无记录/);
});

console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
