#!/usr/bin/env node
/**
 * agent 创建任务的收件箱机制测试。
 */
import assert from 'node:assert';
import { mkdtemp, mkdir, writeFile, readdir, rm, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { TaskStore, formatNextRun } from '../src/tasks/tasks.mjs';
import {
  processPendingTaskRequests, writeTaskSnapshot, TASK_CAPABILITY_PROMPT,
  formatTaskResultNotice, ensureTaskCtl,
} from '../src/tasks/task-inbox.mjs';

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

const root = await mkdtemp(join(tmpdir(), 'task-inbox-'));
const ws = join(root, 'ws');
const tasksPath = join(root, 'tasks.json');
const pendingDir = join(ws, '_tasks', 'pending');
await mkdir(pendingDir, { recursive: true });

const logs = [];
const log = (m) => logs.push(m);

let storeSeq = 0;
async function freshStore() {
  // 每个用例独立文件，避免前面的数据影响断言
  const s = new TaskStore(join(root, `tasks-${++storeSeq}.json`));
  await s.load();
  return s;
}

function futureAt(minutesAhead = 60) {
  const d = new Date(Date.now() + minutesAhead * 60_000);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// ---------- 正常创建 ----------
await check('agent 写 once 任务 → 被采纳', async () => {
  const store = await freshStore();
  await writeFile(
    join(pendingDir, 'a.json'),
    JSON.stringify({ action: 'add', title: '开会', schedule: { kind: 'once', at: futureAt(60) }, prompt: '提醒开会' }),
  );
  const n = await processPendingTaskRequests({ workspace: ws, store, log });
  assert.strictEqual(n, 1);
  const tasks = store.list();
  assert.strictEqual(tasks.length, 1);
  assert.strictEqual(tasks[0].title, '开会');
  assert.ok(tasks[0].nextRunAt > Date.now());
});

await check('请求文件处理后删除', async () => {
  const left = await readdir(pendingDir);
  assert.deepStrictEqual(left, []);
});

await check('处理结果写入 _tasks/results/<请求>.json', async () => {
  const resultPath = join(ws, '_tasks', 'results', 'a.json');
  assert.ok(existsSync(resultPath), '缺少结果文件');
  const data = JSON.parse(await readFile(resultPath, 'utf8'));
  assert.strictEqual(data.ok, true);
  assert.strictEqual(data.action, 'add');
  assert.match(data.text, /已生效/);
  assert.ok(data.task?.id);
});

await check('agent 写 daily 任务 → 被采纳', async () => {
  const store = await freshStore();
  await writeFile(
    join(pendingDir, 'b.json'),
    JSON.stringify({ action: 'add', title: '每日一题', schedule: { kind: 'daily', time: '09:00' }, prompt: '出题' }),
  );
  await processPendingTaskRequests({ workspace: ws, store, log });
  const t = store.list().find((x) => x.title === '每日一题');
  assert.ok(t);
  assert.strictEqual(t.schedule.kind, 'daily');
});

await check('agent 写 every 任务 → 被采纳', async () => {
  const store = await freshStore();
  await writeFile(
    join(pendingDir, 'c.json'),
    JSON.stringify({ action: 'add', title: '喝水', schedule: { kind: 'every', minutes: 30 }, prompt: '提醒喝水' }),
  );
  await processPendingTaskRequests({ workspace: ws, store, log });
  assert.ok(store.list().some((x) => x.title === '喝水'));
});

// ---------- 校验与拒绝 ----------
await check('缺 schedule → 拒绝并留原因', async () => {
  const store = await freshStore();
  await writeFile(join(pendingDir, 'd.json'), JSON.stringify({ action: 'add', prompt: 'x' }));
  await processPendingTaskRequests({ workspace: ws, store, log });
  const rej = await readdir(join(ws, '_tasks', 'rejected'));
  assert.ok(rej.some((f) => f.endsWith('.reason.txt')));
  const reason = await readFile(join(ws, '_tasks', 'rejected', rej.find((f) => f.endsWith('.reason.txt'))), 'utf8');
  assert.ok(reason.includes('schedule'));
});

await check('拒绝也会写结果文件，供 taskctl 读取', async () => {
  const resultPath = join(ws, '_tasks', 'results', 'd.json');
  assert.ok(existsSync(resultPath), '缺少失败结果文件');
  const data = JSON.parse(await readFile(resultPath, 'utf8'));
  assert.strictEqual(data.ok, false);
  assert.match(data.text, /未生效/);
  assert.match(data.reason, /schedule/);
});

await check('缺 prompt → 拒绝', async () => {
  const store = await freshStore();
  await writeFile(join(pendingDir, 'e.json'), JSON.stringify({ action: 'add', schedule: { kind: 'daily', time: '09:00' } }));
  await processPendingTaskRequests({ workspace: ws, store, log });
  assert.strictEqual(store.list().length, 0);
});

await check('时间已过去 → 拒绝', async () => {
  const store = await freshStore();
  await writeFile(
    join(pendingDir, 'f.json'),
    JSON.stringify({ action: 'add', schedule: { kind: 'once', at: '2020-01-01 00:00' }, prompt: 'x' }),
  );
  await processPendingTaskRequests({ workspace: ws, store, log });
  assert.strictEqual(store.list().length, 0);
});

await check('非法 JSON → 拒绝并保留原文', async () => {
  const store = await freshStore();
  await writeFile(join(pendingDir, 'g.json'), '{ 这不是 json');
  await processPendingTaskRequests({ workspace: ws, store, log });
  const rej = await readdir(join(ws, '_tasks', 'rejected'));
  assert.ok(rej.length > 0);
});

await check('schedule 非法 → 拒绝', async () => {
  const store = await freshStore();
  await writeFile(
    join(pendingDir, 'h.json'),
    JSON.stringify({ action: 'add', schedule: { kind: 'daily', time: '99:99' }, prompt: 'x' }),
  );
  await processPendingTaskRequests({ workspace: ws, store, log });
  assert.strictEqual(store.list().length, 0);
});

await check('未知 action → 拒绝', async () => {
  const store = await freshStore();
  await writeFile(join(pendingDir, 'i.json'), JSON.stringify({ action: 'launch_missiles' }));
  await processPendingTaskRequests({ workspace: ws, store, log });
  assert.strictEqual(store.list().length, 0);
});

// ---------- 删除 / 启停 ----------
await check('agent 可删除任务', async () => {
  const store = await freshStore();
  const t = store.add({ schedule: { kind: 'daily', time: '09:00' }, prompt: 'x', title: 'to-remove' });
  await store.flush();
  await writeFile(join(pendingDir, 'j.json'), JSON.stringify({ action: 'rm', id: t.id }));
  await processPendingTaskRequests({ workspace: ws, store, log });
  assert.strictEqual(store.get(t.id), undefined);
});

await check('删除不存在的任务 → 拒绝', async () => {
  const store = await freshStore();
  await writeFile(join(pendingDir, 'k.json'), JSON.stringify({ action: 'rm', id: 'task-nope' }));
  await processPendingTaskRequests({ workspace: ws, store, log });
  const rej = await readdir(join(ws, '_tasks', 'rejected'));
  assert.ok(rej.some((f) => f.includes('k.json')));
});

// ---------- 处理结果回报（桥接据此发确认消息） ----------
await check('onResult 报告 add 成功，带 task 与文件名', async () => {
  const store = await freshStore();
  const results = [];
  await writeFile(
    join(pendingDir, 'n1.json'),
    JSON.stringify({ action: 'add', title: '确认测试', schedule: { kind: 'daily', time: '09:00' }, prompt: 'p' }),
  );
  await processPendingTaskRequests({ workspace: ws, store, log, onResult: (r) => results.push(r) });
  assert.strictEqual(results.length, 1);
  assert.strictEqual(results[0].ok, true);
  assert.strictEqual(results[0].action, 'add');
  assert.strictEqual(results[0].file, 'n1.json');
  assert.strictEqual(results[0].task.title, '确认测试');
  assert.ok(results[0].task.nextRunAt > Date.now());
});

await check('onResult 报告 rm 成功，保留被删任务信息', async () => {
  const store = await freshStore();
  const task = store.add({ schedule: { kind: 'daily', time: '09:00' }, prompt: 'x', title: '待删除' });
  await store.flush();
  const results = [];
  await writeFile(join(pendingDir, 'n2.json'), JSON.stringify({ action: 'rm', id: task.id }));
  await processPendingTaskRequests({ workspace: ws, store, log, onResult: (r) => results.push(r) });
  assert.strictEqual(results[0].ok, true);
  assert.strictEqual(results[0].action, 'rm');
  assert.strictEqual(results[0].task.title, '待删除');
  assert.strictEqual(store.get(task.id), undefined);
});

await check('onResult 报告 disable / enable 成功', async () => {
  const store = await freshStore();
  const task = store.add({ schedule: { kind: 'daily', time: '09:00' }, prompt: 'x', title: '可暂停' });
  await store.flush();

  let results = [];
  await writeFile(join(pendingDir, 'n3.json'), JSON.stringify({ action: 'disable', id: task.id }));
  await processPendingTaskRequests({ workspace: ws, store, log, onResult: (r) => results.push(r) });
  assert.strictEqual(results[0].ok, true);
  assert.strictEqual(results[0].action, 'disable');
  assert.strictEqual(results[0].task.enabled, false);

  results = [];
  await writeFile(join(pendingDir, 'n4.json'), JSON.stringify({ action: 'enable', id: task.id }));
  await processPendingTaskRequests({ workspace: ws, store, log, onResult: (r) => results.push(r) });
  assert.strictEqual(results[0].action, 'enable');
  assert.strictEqual(results[0].task.enabled, true);
  assert.ok(results[0].task.nextRunAt > Date.now());
});

await check('onResult 报告失败原因（删除不存在的任务）', async () => {
  const store = await freshStore();
  const results = [];
  await writeFile(join(pendingDir, 'n5.json'), JSON.stringify({ action: 'rm', id: 'task-nope' }));
  await processPendingTaskRequests({ workspace: ws, store, log, onResult: (r) => results.push(r) });
  assert.strictEqual(results[0].ok, false);
  assert.strictEqual(results[0].action, 'rm');
  assert.match(results[0].reason, /没有找到任务/);
});

// ---------- 标题操作 / 改时间 / 稍后提醒 ----------
await check('按标题取消任务', async () => {
  const store = await freshStore();
  const task = store.add({ schedule: { kind: 'daily', time: '09:00' }, prompt: 'x', title: '标题删除' });
  await store.flush();
  const results = [];
  await writeFile(join(pendingDir, 't1.json'), JSON.stringify({ action: 'rm', title: '标题删除' }));
  await processPendingTaskRequests({ workspace: ws, store, log, onResult: (r) => results.push(r) });
  assert.strictEqual(results[0].ok, true);
  assert.strictEqual(results[0].action, 'rm');
  assert.strictEqual(store.get(task.id), undefined);
});

await check('按标题暂停/恢复任务', async () => {
  const store = await freshStore();
  const task = store.add({ schedule: { kind: 'daily', time: '09:00' }, prompt: 'x', title: '标题暂停' });
  await store.flush();

  let results = [];
  await writeFile(join(pendingDir, 't2.json'), JSON.stringify({ action: 'disable', title: '标题暂停' }));
  await processPendingTaskRequests({ workspace: ws, store, log, onResult: (r) => results.push(r) });
  assert.strictEqual(results[0].ok, true);
  assert.strictEqual(store.get(task.id).enabled, false);

  results = [];
  await writeFile(join(pendingDir, 't3.json'), JSON.stringify({ action: 'enable', title: '标题暂停' }));
  await processPendingTaskRequests({ workspace: ws, store, log, onResult: (r) => results.push(r) });
  assert.strictEqual(results[0].ok, true);
  assert.strictEqual(store.get(task.id).enabled, true);
});

await check('按标题改时间', async () => {
  const store = await freshStore();
  const task = store.add({ schedule: { kind: 'daily', time: '09:00' }, prompt: 'x', title: '改时间' });
  await store.flush();
  const results = [];
  await writeFile(
    join(pendingDir, 't4.json'),
    JSON.stringify({ action: 'update', title: '改时间', schedule: { kind: 'daily', time: '08:00' } }),
  );
  await processPendingTaskRequests({ workspace: ws, store, log, onResult: (r) => results.push(r) });
  assert.strictEqual(results[0].ok, true);
  assert.strictEqual(results[0].action, 'update');
  assert.strictEqual(store.get(task.id).schedule.time, '08:00');
  assert.ok(results[0].task.nextRunAt > Date.now());
});

await check('update 支持 at 简写', async () => {
  const store = await freshStore();
  const task = store.add({ schedule: { kind: 'daily', time: '09:00' }, prompt: 'x', title: '改一次性' });
  await store.flush();
  await writeFile(
    join(pendingDir, 't5.json'),
    JSON.stringify({ action: 'update', title: '改一次性', at: futureAt(90) }),
  );
  await processPendingTaskRequests({ workspace: ws, store, log });
  assert.strictEqual(store.get(task.id).schedule.kind, 'once');
});

await check('update 时间已过去 → 拒绝', async () => {
  const store = await freshStore();
  store.add({ schedule: { kind: 'daily', time: '09:00' }, prompt: 'x', title: '过去时间' });
  await store.flush();
  const results = [];
  await writeFile(
    join(pendingDir, 't6.json'),
    JSON.stringify({ action: 'update', title: '过去时间', schedule: { kind: 'once', at: '2020-01-01 00:00' } }),
  );
  await processPendingTaskRequests({ workspace: ws, store, log, onResult: (r) => results.push(r) });
  assert.strictEqual(results[0].ok, false);
  assert.match(results[0].reason, /已经过去/);
});

await check('按标题稍后提醒（默认 10 分钟）', async () => {
  const store = await freshStore();
  const task = store.add({ schedule: { kind: 'daily', time: '09:00' }, prompt: 'x', title: '稍后提醒' });
  await store.flush();
  const before = Date.now();
  const results = [];
  await writeFile(join(pendingDir, 't7.json'), JSON.stringify({ action: 'snooze', title: '稍后提醒' }));
  await processPendingTaskRequests({ workspace: ws, store, log, onResult: (r) => results.push(r) });
  assert.strictEqual(results[0].ok, true);
  assert.strictEqual(results[0].action, 'snooze');

  const next = store.get(task.id).nextRunAt;
  assert.ok(next >= before + 9 * 60_000, '应推迟约 10 分钟');
  assert.ok(next <= Date.now() + 11 * 60_000);
});

await check('只有一条任务时 snooze 可省略目标', async () => {
  const store = await freshStore();
  const task = store.add({ schedule: { kind: 'daily', time: '09:00' }, prompt: 'x', title: '唯一任务' });
  await store.flush();
  await writeFile(join(pendingDir, 't8.json'), JSON.stringify({ action: 'snooze', minutes: 30 }));
  await processPendingTaskRequests({ workspace: ws, store, log });
  assert.ok(store.get(task.id).nextRunAt >= Date.now() + 29 * 60_000);
});

await check('多条任务时 snooze 省略目标 → 拒绝并提示', async () => {
  const store = await freshStore();
  store.add({ schedule: { kind: 'daily', time: '09:00' }, prompt: 'x', title: 'A' });
  store.add({ schedule: { kind: 'daily', time: '10:00' }, prompt: 'x', title: 'B' });
  await store.flush();
  const results = [];
  await writeFile(join(pendingDir, 't9.json'), JSON.stringify({ action: 'snooze' }));
  await processPendingTaskRequests({ workspace: ws, store, log, onResult: (r) => results.push(r) });
  assert.strictEqual(results[0].ok, false);
  assert.match(results[0].reason, /id 或 title/);
});

await check('标题有歧义 → 拒绝并列出候选', async () => {
  const store = await freshStore();
  store.add({ schedule: { kind: 'daily', time: '09:00' }, prompt: 'x', title: '每日一题' });
  store.add({ schedule: { kind: 'daily', time: '10:00' }, prompt: 'x', title: '每日新闻' });
  await store.flush();
  const results = [];
  await writeFile(join(pendingDir, 't10.json'), JSON.stringify({ action: 'rm', title: '每日' }));
  await processPendingTaskRequests({ workspace: ws, store, log, onResult: (r) => results.push(r) });
  assert.strictEqual(results[0].ok, false);
  assert.match(results[0].reason, /匹配到多个任务/);
});

await check('onResult 报告非法 JSON 的失败', async () => {
  const store = await freshStore();
  const results = [];
  await writeFile(join(pendingDir, 'n6.json'), '{ 坏 json');
  await processPendingTaskRequests({ workspace: ws, store, log, onResult: (r) => results.push(r) });
  assert.strictEqual(results[0].ok, false);
  assert.match(results[0].reason, /JSON 解析失败/);
});

// ---------- 确认消息格式 ----------
await check('确认消息：add daily 带计划与下次时间', () => {
  const nextRunAt = Date.now() + 3600_000;
  const text = formatTaskResultNotice({
    ok: true, action: 'add', file: 'x.json',
    task: { title: '每日一题', schedule: { kind: 'daily', time: '09:00' }, nextRunAt },
  });
  assert.strictEqual(text, `✅ 定时任务已生效：「每日一题」每天 09:00，下次 ${formatNextRun(nextRunAt)}`);
});

await check('确认消息：add once 不重复"下次"', () => {
  const text = formatTaskResultNotice({
    ok: true, action: 'add', file: 'x.json',
    task: { title: '开会', schedule: { kind: 'once', at: '2026-10-29 12:30' }, nextRunAt: Date.now() + 3600_000 },
  });
  assert.ok(text.includes('一次 @'));
  assert.ok(!text.includes('下次'));
});

await check('确认消息：rm / disable / enable', () => {
  const nextRunAt = Date.now() + 3600_000;
  assert.strictEqual(
    formatTaskResultNotice({ ok: true, action: 'rm', task: { title: '每日一题' } }),
    '✅ 已取消定时任务「每日一题」',
  );
  assert.strictEqual(
    formatTaskResultNotice({ ok: true, action: 'disable', task: { title: '每日一题' } }),
    '✅ 已暂停定时任务「每日一题」',
  );
  assert.strictEqual(
    formatTaskResultNotice({ ok: true, action: 'enable', task: { title: '每日一题', nextRunAt } }),
    `✅ 已恢复定时任务「每日一题」，下次 ${formatNextRun(nextRunAt)}`,
  );
});

await check('确认消息：update / snooze', () => {
  const nextRunAt = Date.now() + 3600_000;
  assert.strictEqual(
    formatTaskResultNotice({
      ok: true, action: 'update',
      task: { title: '每日一题', schedule: { kind: 'daily', time: '08:00' }, nextRunAt },
    }),
    `✅ 已修改定时任务「每日一题」：每天 08:00，下次 ${formatNextRun(nextRunAt)}`,
  );
  assert.strictEqual(
    formatTaskResultNotice({
      ok: true, action: 'snooze',
      task: { title: '每日一题', schedule: { kind: 'daily', time: '08:00' }, nextRunAt },
    }),
    `✅ 已推迟定时任务「每日一题」，下次 ${formatNextRun(nextRunAt)}`,
  );
});

await check('确认消息：失败带原因且截断', () => {
  assert.strictEqual(
    formatTaskResultNotice({ ok: false, reason: '没有找到任务 task-x' }),
    '⚠️ 定时任务请求未生效：没有找到任务 task-x',
  );
  const long = 'x'.repeat(500);
  const text = formatTaskResultNotice({ ok: false, reason: long });
  assert.ok(text.length < 340, `长度 ${text.length}`);
});

// ---------- 快照 ----------
await check('快照写入 current.json 且含任务', async () => {
  const store = await freshStore();
  store.add({ schedule: { kind: 'daily', time: '09:00' }, prompt: 'p', title: '快照测试' });
  await writeTaskSnapshot(ws, store);
  const snap = JSON.parse(await readFile(join(ws, '_tasks', 'current.json'), 'utf8'));
  assert.ok(Array.isArray(snap.tasks));
  assert.ok(snap.tasks.some((t) => t.title === '快照测试'));
  assert.ok(snap.tasks[0].nextRunAt);
});

// ---------- 幂等 ----------
await check('重复处理同一目录不会重复建任务', async () => {
  const store = await freshStore();
  const before = store.list().length;
  await processPendingTaskRequests({ workspace: ws, store, log });
  assert.strictEqual(store.list().length, before);
});

// ---------- 能力说明 ----------
await check('能力说明提到 pending 目录与四种 schedule', () => {
  assert.ok(TASK_CAPABILITY_PROMPT.includes('_tasks/pending/'));
  assert.ok(TASK_CAPABILITY_PROMPT.includes('once'));
  assert.ok(TASK_CAPABILITY_PROMPT.includes('daily'));
  assert.ok(TASK_CAPABILITY_PROMPT.includes('weekly'));
  assert.ok(TASK_CAPABILITY_PROMPT.includes('every'));
});

await check('能力说明包含 pause/resume/remove 与 taskctl 同步等待', () => {
  assert.ok(TASK_CAPABILITY_PROMPT.includes('"action":"disable"'));
  assert.ok(TASK_CAPABILITY_PROMPT.includes('"action":"enable"'));
  assert.ok(TASK_CAPABILITY_PROMPT.includes('"action":"rm"'));
  assert.ok(TASK_CAPABILITY_PROMPT.includes('"action":"update"'));
  assert.ok(TASK_CAPABILITY_PROMPT.includes('"action":"snooze"'));
  assert.ok(TASK_CAPABILITY_PROMPT.includes('也可以用标题代替 id'));
  assert.ok(TASK_CAPABILITY_PROMPT.includes('10 分钟后再提醒'));
  assert.ok(TASK_CAPABILITY_PROMPT.includes('_tools/taskctl.py wait'));
  assert.ok(TASK_CAPABILITY_PROMPT.includes('等待任务结果超时'));
  assert.ok(TASK_CAPABILITY_PROMPT.includes('不要自己猜结果'));
  assert.ok(!TASK_CAPABILITY_PROMPT.includes('以随后那条确认消息为准'));
});

const PY = spawnSync('python3', ['--version'], { encoding: 'utf8' });
const HAS_PYTHON = !PY.error && PY.status === 0;

await check('taskctl.py 写入 _tools 并等待成功结果', async () => {
  const p = await ensureTaskCtl(ws);
  assert.ok(existsSync(p), 'taskctl.py 未写入');
  const src = await readFile(p, 'utf8');
  assert.ok(src.includes('_tasks'));

  if (!HAS_PYTHON) {
    console.log('   (跳过实际等待：没有 python3)');
    return;
  }

  await mkdir(join(ws, '_tasks', 'results'), { recursive: true });
  await writeFile(
    join(ws, '_tasks', 'results', 'manual.json'),
    JSON.stringify({ ok: true, text: '✅ 已取消定时任务「X」' }),
  );
  const r = spawnSync('python3', [p, 'wait', 'manual.json'], {
    cwd: ws, encoding: 'utf8', timeout: 5000,
  });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes('✅ 已取消定时任务「X」'));
  assert.ok(!existsSync(join(ws, '_tasks', 'results', 'manual.json')), '结果文件未删除');
});

await check('taskctl.py 失败结果退出码 1', async () => {
  if (!HAS_PYTHON) return;
  const p = join(ws, '_tools', 'taskctl.py');
  await writeFile(
    join(ws, '_tasks', 'results', 'manual-fail.json'),
    JSON.stringify({ ok: false, text: '⚠️ 没有找到任务 task-x' }),
  );
  const r = spawnSync('python3', [p, 'wait', 'manual-fail.json'], {
    cwd: ws, encoding: 'utf8', timeout: 5000,
  });
  assert.strictEqual(r.status, 1, r.stderr);
  assert.ok(r.stdout.includes('没有找到任务'));
});

await check('pending 目录不存在时安全返回 0', async () => {
  const store = await freshStore();
  const emptyWs = join(root, 'empty-ws');
  await mkdir(emptyWs, { recursive: true });
  const n = await processPendingTaskRequests({ workspace: emptyWs, store, log });
  assert.strictEqual(n, 0);
});

await rm(root, { recursive: true, force: true });

console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
