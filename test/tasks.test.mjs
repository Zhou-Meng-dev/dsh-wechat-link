#!/usr/bin/env node
/**
 * 定时任务：时间解析、下次运行计算、到期判定、存储。
 */
import assert from 'node:assert';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseWhen,
  computeNextRun,
  describeSchedule,
  TaskStore,
  DUE_GRACE_MS,
  normalizeDays,
  isoWeekday,
  nextDueDelay,
} from '../src/tasks/tasks.mjs';

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

const dir = await mkdtemp(join(tmpdir(), 'dsh-tasks-'));
const path = join(dir, 'tasks.json');

// ---------- 时间解析 ----------
await check('解析 "YYYY-MM-DD HH:mm" 为本地时间', () => {
  const ts = parseWhen('2026-10-28 12:30');
  const d = new Date(ts);
  assert.strictEqual(d.getFullYear(), 2026);
  assert.strictEqual(d.getMonth(), 9);
  assert.strictEqual(d.getDate(), 28);
  assert.strictEqual(d.getHours(), 12);
  assert.strictEqual(d.getMinutes(), 30);
});

await check('解析带秒的格式', () => {
  const d = new Date(parseWhen('2026-10-28 12:30:45'));
  assert.strictEqual(d.getSeconds(), 45);
});

await check('解析 ISO 字符串', () => {
  const ts = parseWhen('2026-10-28T12:30:00+08:00');
  assert.strictEqual(ts, Date.UTC(2026, 9, 28, 4, 30, 0));
});

await check('非法时间返回 null', () => {
  assert.strictEqual(parseWhen('明天中午'), null);
  assert.strictEqual(parseWhen(''), null);
  assert.strictEqual(parseWhen(null), null);
});

// ---------- 下次运行 ----------
await check('once 返回固定时间点', () => {
  const at = parseWhen('2030-01-01 00:00');
  assert.strictEqual(computeNextRun({ kind: 'once', at: '2030-01-01 00:00' }), at);
});

await check('daily 在今天剩余时间取今天', () => {
  const from = new Date(2026, 9, 28, 8, 0, 0).getTime();
  const next = new Date(computeNextRun({ kind: 'daily', time: '09:00' }, from));
  assert.strictEqual(next.getDate(), 28);
  assert.strictEqual(next.getHours(), 9);
});

await check('daily 已过时刻则顺延到明天', () => {
  const from = new Date(2026, 9, 28, 10, 0, 0).getTime();
  const next = new Date(computeNextRun({ kind: 'daily', time: '09:00' }, from));
  assert.strictEqual(next.getDate(), 29);
  assert.strictEqual(next.getHours(), 9);
});

await check('daily 非法时刻返回 null', () => {
  assert.strictEqual(computeNextRun({ kind: 'daily', time: '25:00' }), null);
  assert.strictEqual(computeNextRun({ kind: 'daily', time: '9:00' }), null);
  assert.strictEqual(computeNextRun({ kind: 'daily' }), null);
});

await check('every 按分钟推进', () => {
  const from = 1_000_000_000_000;
  assert.strictEqual(computeNextRun({ kind: 'every', minutes: 30 }, from), from + 30 * 60_000);
});

await check('every 非法值返回 null', () => {
  assert.strictEqual(computeNextRun({ kind: 'every', minutes: 0 }), null);
  assert.strictEqual(computeNextRun({ kind: 'every', minutes: -5 }), null);
  assert.strictEqual(computeNextRun({ kind: 'every' }), null);
});

await check('未知 kind 返回 null', () => {
  assert.strictEqual(computeNextRun({ kind: 'weird' }), null);
  assert.strictEqual(computeNextRun(null), null);
});

await check('describeSchedule 可读', () => {
  assert.ok(describeSchedule({ kind: 'daily', time: '09:00' }).includes('每天 09:00'));
  assert.ok(describeSchedule({ kind: 'every', minutes: 15 }).includes('15 分钟'));
});

// ---------- 存储与到期 ----------
await check('add 计算 nextRunAt', async () => {
  const s = new TaskStore(path);
  await s.load();
  const t = s.add({ schedule: { kind: 'daily', time: '09:00' }, prompt: 'x' });
  assert.ok(typeof t.nextRunAt === 'number');
  assert.strictEqual(t.enabled, true);
});

await check('flush 后可读回', async () => {
  const s = new TaskStore(path);
  await s.load();
  s.add({ schedule: { kind: 'once', at: '2030-01-01 00:00' }, prompt: 'p' });
  await s.flush();
  const s2 = new TaskStore(path);
  await s2.load();
  assert.ok(s2.list().length >= 1);
});

await check('due 只返回已到点的启用任务', async () => {
  const p2 = join(dir, 'due.json');
  const s = new TaskStore(p2);
  await s.load();
  const past = s.add({ schedule: { kind: 'once', at: '2020-01-01 00:00' }, prompt: 'a' });
  const future = s.add({ schedule: { kind: 'once', at: '2099-01-01 00:00' }, prompt: 'b' });
  const off = s.add({ schedule: { kind: 'once', at: '2020-01-01 00:00' }, prompt: 'c', enabled: false });

  const dueIds = s.due(Date.now()).map((t) => t.id);
  assert.ok(dueIds.includes(past.id));
  assert.ok(!dueIds.includes(future.id));
  assert.ok(!dueIds.includes(off.id));
});

await check('due 只认已到点，不会提前触发', async () => {
  const p3 = join(dir, 'grace.json');
  const s = new TaskStore(p3);
  await s.load();
  const t = s.add({ schedule: { kind: 'every', minutes: 1 }, prompt: 'x' });
  // 未来 30 秒：不该触发（提醒宁可晚到，也不能早到）
  t.nextRunAt = Date.now() + 30_000;
  assert.ok(!s.due(Date.now()).some((x) => x.id === t.id), '未来任务不应触发');
  // 已经过去：应该触发
  t.nextRunAt = Date.now() - 1000;
  assert.ok(s.due(Date.now()).some((x) => x.id === t.id), '已到点应触发');
  // 容差内（下一秒）：允许
  t.nextRunAt = Date.now() + Math.floor(DUE_GRACE_MS / 2);
  assert.ok(s.due(Date.now()).some((x) => x.id === t.id), '容差内应触发');
});

await check('once 任务跑完自动停用', async () => {
  const p4 = join(dir, 'once.json');
  const s = new TaskStore(p4);
  await s.load();
  const t = s.add({ schedule: { kind: 'once', at: '2020-01-01 00:00' }, prompt: 'x' });
  s.markRun(t.id, { ok: true });
  const after = s.get(t.id);
  assert.strictEqual(after.enabled, false);
  assert.strictEqual(after.nextRunAt, null);
  assert.strictEqual(after.lastResult, 'ok');
});

await check('daily 跑完后下次一定在未来', async () => {
  const p5 = join(dir, 'daily.json');
  const s = new TaskStore(p5);
  await s.load();
  const t = s.add({ schedule: { kind: 'daily', time: '09:00' }, prompt: 'x' });
  s.markRun(t.id, { ok: true });
  const after = s.get(t.id);
  assert.strictEqual(after.enabled, true);
  assert.ok(after.nextRunAt > Date.now(), '下次应在未来');
});

await check('daily 时刻已过则顺延到明天（模拟 09:00 跑完）', async () => {
  const p5b = join(dir, 'daily2.json');
  const s = new TaskStore(p5b);
  await s.load();
  // 用一个"现在已过去"的时刻，模拟任务刚跑完
  const past = new Date(Date.now() - 3600_000);
  const hh = String(past.getHours()).padStart(2, '0');
  const mm = String(past.getMinutes()).padStart(2, '0');
  const t = s.add({ schedule: { kind: 'daily', time: `${hh}:${mm}` }, prompt: 'x' });
  s.markRun(t.id, { ok: true });
  const after = s.get(t.id);
  // 下次应是明天（24 小时后左右），而不是"现在"
  assert.ok(after.nextRunAt > Date.now() + 20 * 3600_000, '应顺延到约 24 小时后');
});


// ---------- weekly ----------
await check('isoWeekday: 周一=1 周日=7', () => {
  assert.strictEqual(isoWeekday(new Date(2026, 9, 26)), 1); // 2026-10-26 是周一
  assert.strictEqual(isoWeekday(new Date(2026, 9, 28)), 3); // 周三
  assert.strictEqual(isoWeekday(new Date(2026, 10, 1)), 7); // 周日
});

await check('normalizeDays 支持数字与英文', () => {
  assert.deepStrictEqual(normalizeDays([1, 3, 5]), [1, 3, 5]);
  assert.deepStrictEqual(normalizeDays('mon,wed,fri'), [1, 3, 5]);
  assert.deepStrictEqual(normalizeDays('mon tue'), [1, 2]);
});

await check('normalizeDays 支持中文', () => {
  assert.deepStrictEqual(normalizeDays('周一,周五'), [1, 5]);
  assert.deepStrictEqual(normalizeDays('周一、周三'), [1, 3]);
  assert.deepStrictEqual(normalizeDays('一 三 五'), [1, 3, 5]);
});

await check('normalizeDays 支持工作日/周末', () => {
  assert.deepStrictEqual(normalizeDays('工作日'), [1, 2, 3, 4, 5]);
  assert.deepStrictEqual(normalizeDays('周末'), [6, 7]);
  assert.deepStrictEqual(normalizeDays('weekend'), [6, 7]);
});

await check('normalizeDays 去重升序', () => {
  assert.deepStrictEqual(normalizeDays('5,1,3,1'), [1, 3, 5]);
});

await check('normalizeDays 非法输入返回 null', () => {
  assert.strictEqual(normalizeDays('xyz'), null);
  assert.strictEqual(normalizeDays(''), null);
  assert.strictEqual(normalizeDays('8'), null);
  assert.strictEqual(normalizeDays(null), null);
});

await check('weekly 计算下一个匹配的星期', () => {
  // 基准：2026-10-28（周三）10:00
  const from = new Date(2026, 9, 28, 10, 0, 0).getTime();
  // 每周五 09:00 → 2026-10-30（周五）
  const fri = new Date(computeNextRun({ kind: 'weekly', days: [5], time: '09:00' }, from));
  assert.strictEqual(fri.getDate(), 30);
  assert.strictEqual(fri.getHours(), 9);
  assert.strictEqual(isoWeekday(fri), 5);
});

await check('weekly 今天但时刻已过 → 顺延到下周', () => {
  // 基准：2026-10-28（周三）10:00，找周三 09:00
  const from = new Date(2026, 9, 28, 10, 0, 0).getTime();
  const next = new Date(computeNextRun({ kind: 'weekly', days: [3], time: '09:00' }, from));
  assert.strictEqual(isoWeekday(next), 3);
  assert.ok(next.getTime() > from + 6 * 24 * 3600_000, '应顺延约一周');
});

await check('weekly 今天且时刻未到 → 就是今天', () => {
  // 基准：2026-10-28（周三）08:00，找周三 09:00
  const from = new Date(2026, 9, 28, 8, 0, 0).getTime();
  const next = new Date(computeNextRun({ kind: 'weekly', days: [3], time: '09:00' }, from));
  assert.strictEqual(next.getDate(), 28);
  assert.strictEqual(next.getHours(), 9);
});

await check('weekly 多个星期取最近的', () => {
  const from = new Date(2026, 9, 28, 10, 0, 0).getTime(); // 周三
  const next = new Date(computeNextRun({ kind: 'weekly', days: [1, 5], time: '09:00' }, from));
  assert.strictEqual(next.getDate(), 30); // 周五比下周一近
  assert.strictEqual(isoWeekday(next), 5);
});

await check('weekly 支持字符串形式 days', () => {
  const from = new Date(2026, 9, 28, 10, 0, 0).getTime();
  const next = computeNextRun({ kind: 'weekly', days: '周五', time: '09:00' }, from);
  assert.strictEqual(new Date(next).getDate(), 30);
});

await check('weekly 非法参数返回 null', () => {
  assert.strictEqual(computeNextRun({ kind: 'weekly' }), null);
  assert.strictEqual(computeNextRun({ kind: 'weekly', days: [], time: '09:00' }), null);
  assert.strictEqual(computeNextRun({ kind: 'weekly', days: [5] }), null);
  assert.strictEqual(computeNextRun({ kind: 'weekly', days: [5], time: '99:00' }), null);
  assert.strictEqual(computeNextRun({ kind: 'weekly', days: 'xyz', time: '09:00' }), null);
});

await check('describeSchedule 说清 weekly', () => {
  const d = describeSchedule({ kind: 'weekly', days: [1, 5], time: '09:00' });
  assert.ok(d.includes('每周'));
  assert.ok(d.includes('周一'));
  assert.ok(d.includes('周五'));
  assert.ok(d.includes('09:00'));
});

await check('weekly 任务 markRun 后推进到下一次', async () => {
  const p9 = join(dir, 'weekly.json');
  const st = new TaskStore(p9);
  await st.load();
  const t = st.add({ schedule: { kind: 'weekly', days: [3], time: '09:00' }, prompt: 'x' });
  st.markRun(t.id, { ok: true });
  const after = st.get(t.id);
  assert.strictEqual(after.enabled, true);
  assert.ok(after.nextRunAt > Date.now());
});


// ---------- 并发安全：外部删除不被内存覆盖 ----------
await check('外部删除后，服务写盘不会把它复活', async () => {
  const p10 = join(dir, 'race.json');
  const svc = new TaskStore(p10);
  await svc.load();
  const a = svc.add({ schedule: { kind: 'daily', time: '09:00' }, prompt: 'a', title: 'A' });
  const b = svc.add({ schedule: { kind: 'daily', time: '10:00' }, prompt: 'b', title: 'B' });
  await svc.flush();

  // 模拟另一个进程（CLI）删掉了 A
  const cli = new TaskStore(p10);
  await cli.load();
  cli.remove(a.id);
  await cli.flush();
  await new Promise((r) => setTimeout(r, 20)); // 确保 mtime 变化

  // 服务这边标记 B 已运行（会产生写盘）
  svc.markRun(b.id, { ok: true });
  await svc.flush();

  const back = new TaskStore(p10);
  await back.load();
  assert.strictEqual(back.get(a.id), undefined, 'A 应保持被删除，不能被复活');
  assert.ok(back.get(b.id), 'B 应仍在');
  assert.strictEqual(back.get(b.id).lastResult, 'ok');
});

await check('外部新增的任务不会被服务写盘覆盖掉', async () => {
  const p11 = join(dir, 'race2.json');
  const svc = new TaskStore(p11);
  await svc.load();
  const a = svc.add({ schedule: { kind: 'daily', time: '09:00' }, prompt: 'a' });
  await svc.flush();

  // CLI 新增一个任务
  const cli = new TaskStore(p11);
  await cli.load();
  const c = cli.add({ schedule: { kind: 'daily', time: '11:00' }, prompt: 'c', title: 'C' });
  await cli.flush();
  await new Promise((r) => setTimeout(r, 20));

  svc.markRun(a.id, { ok: true });
  await svc.flush();

  const back = new TaskStore(p11);
  await back.load();
  assert.ok(back.get(c.id), 'CLI 新增的 C 不应丢失');
  assert.strictEqual(back.get(a.id).lastResult, 'ok');
});

await check('remove 生效', async () => {
  const p6 = join(dir, 'rm.json');
  const s = new TaskStore(p6);
  await s.load();
  const t = s.add({ schedule: { kind: 'daily', time: '09:00' }, prompt: 'x' });
  assert.strictEqual(s.remove(t.id), true);
  assert.strictEqual(s.get(t.id), undefined);
  assert.strictEqual(s.remove('nope'), false);
});

await check('setEnabled 可开关', async () => {
  const p7 = join(dir, 'en.json');
  const s = new TaskStore(p7);
  await s.load();
  const t = s.add({ schedule: { kind: 'daily', time: '09:00' }, prompt: 'x' });
  s.setEnabled(t.id, false);
  assert.strictEqual(s.get(t.id).enabled, false);
  s.setEnabled(t.id, true);
  assert.strictEqual(s.get(t.id).enabled, true);
});

// ---------- 按标题查找 / 改时间 / 稍后提醒 ----------
await check('findByTitle 先精确、再包含匹配', async () => {
  const p = join(dir, 'title.json');
  const s = new TaskStore(p);
  await s.load();
  const a = s.add({ schedule: { kind: 'daily', time: '09:00' }, prompt: 'x', title: '每日一题' });
  const b = s.add({ schedule: { kind: 'daily', time: '10:00' }, prompt: 'x', title: '每日新闻' });

  assert.deepStrictEqual(s.findByTitle('每日一题').map((t) => t.id), [a.id]);
  assert.deepStrictEqual(s.findByTitle('每').map((t) => t.id).sort(), [a.id, b.id].sort());
  assert.deepStrictEqual(s.findByTitle(''), []);
});

await check('resolve 支持 id 与标题，找不到返回 undefined', async () => {
  const p = join(dir, 'resolve.json');
  const s = new TaskStore(p);
  await s.load();
  const t = s.add({ schedule: { kind: 'daily', time: '09:00' }, prompt: 'x', title: '开会提醒' });
  assert.strictEqual(s.resolve(t.id).id, t.id);
  assert.strictEqual(s.resolve('开会').id, t.id);
  assert.strictEqual(s.resolve('不存在'), undefined);
});

await check('resolve 标题有歧义时抛错并列出候选', async () => {
  const p = join(dir, 'ambiguous.json');
  const s = new TaskStore(p);
  await s.load();
  s.add({ schedule: { kind: 'daily', time: '09:00' }, prompt: 'x', title: '每日一题' });
  s.add({ schedule: { kind: 'daily', time: '10:00' }, prompt: 'x', title: '每日新闻' });
  assert.throws(() => s.resolve('每日'), /匹配到多个任务/);
  assert.throws(() => s.resolve('每日'), /每日一题/);
});

await check('setSchedule 改时间并重新启用', async () => {
  const p = join(dir, 'update.json');
  const s = new TaskStore(p);
  await s.load();
  const t = s.add({ schedule: { kind: 'daily', time: '09:00' }, prompt: 'x', title: '改时间' });
  s.setEnabled(t.id, false);
  assert.strictEqual(s.get(t.id).enabled, false);

  const ok = s.setSchedule(t.id, { kind: 'daily', time: '08:30' });
  assert.strictEqual(ok, true);
  const after = s.get(t.id);
  assert.strictEqual(after.schedule.time, '08:30');
  assert.strictEqual(after.enabled, true);
  assert.ok(after.nextRunAt > Date.now());

  assert.strictEqual(s.setSchedule(t.id, { kind: 'daily', time: '99:99' }), false);
  assert.strictEqual(s.setSchedule('nope', { kind: 'daily', time: '09:00' }), false);
});

await check('snooze 推迟周期任务的下次运行', async () => {
  const p = join(dir, 'snooze.json');
  const s = new TaskStore(p);
  await s.load();
  const t = s.add({ schedule: { kind: 'daily', time: '09:00' }, prompt: 'x', title: '稍后' });
  const from = Date.now();
  assert.strictEqual(s.snooze(t.id, 10, from), true);
  const after = s.get(t.id);
  assert.strictEqual(after.nextRunAt, from + 10 * 60_000);
  assert.strictEqual(after.schedule.time, '09:00'); // 原计划不变
  assert.strictEqual(after.enabled, true);
});

await check('snooze 对 once 任务同时更新 schedule.at', async () => {
  const p = join(dir, 'snooze-once.json');
  const s = new TaskStore(p);
  await s.load();
  const t = s.add({ schedule: { kind: 'once', at: '2099-01-01 00:00' }, prompt: 'x', title: '一次性' });
  const from = Date.now();
  s.snooze(t.id, 5, from);
  const after = s.get(t.id);
  assert.strictEqual(after.schedule.at, from + 5 * 60_000);
  assert.strictEqual(after.nextRunAt, from + 5 * 60_000);
});

await check('snooze 非法分钟数返回 false', async () => {
  const p = join(dir, 'snooze-bad.json');
  const s = new TaskStore(p);
  await s.load();
  const t = s.add({ schedule: { kind: 'daily', time: '09:00' }, prompt: 'x' });
  assert.strictEqual(s.snooze(t.id, 0), false);
  assert.strictEqual(s.snooze(t.id, -1), false);
  assert.strictEqual(s.snooze(t.id, 'abc'), false);
  assert.strictEqual(s.snooze('nope', 10), false);
});

await check('改时间 / snooze 可持久化并读回', async () => {
  const p = join(dir, 'persist-update.json');
  const s = new TaskStore(p);
  await s.load();
  const t = s.add({ schedule: { kind: 'daily', time: '09:00' }, prompt: 'x', title: '持久化' });
  s.setSchedule(t.id, { kind: 'daily', time: '07:00' });
  s.snooze(t.id, 15);
  await s.flush();

  const s2 = new TaskStore(p);
  await s2.load();
  const after = s2.get(t.id);
  assert.strictEqual(after.schedule.time, '07:00');
  assert.ok(after.nextRunAt > Date.now());
});

await check('文件损坏时降级为空', async () => {
  const p8 = join(dir, 'bad.json');
  const { writeFile } = await import('node:fs/promises');
  await writeFile(p8, 'not json{');
  const s = new TaskStore(p8);
  await s.load();
  assert.strictEqual(s.list().length, 0);
});

await rm(dir, { recursive: true, force: true });

// ---------- 精确到点定时器 ----------
await check('nextDueDelay：没有启用任务返回 null', () => {
  assert.strictEqual(nextDueDelay([], 1000), null);
  assert.strictEqual(nextDueDelay([{ enabled: false, nextRunAt: 2000 }], 1000), null);
  assert.strictEqual(nextDueDelay([{ enabled: true, nextRunAt: undefined }], 1000), null);
});

await check('nextDueDelay：已到点/已过期返回 0（立即触发）', () => {
  assert.strictEqual(nextDueDelay([{ enabled: true, nextRunAt: 500 }], 1000), 0);
});

await check('nextDueDelay：取最近的 nextRunAt', () => {
  const d = nextDueDelay([
    { enabled: true, nextRunAt: 10_000 },
    { enabled: true, nextRunAt: 5_000 },
    { enabled: false, nextRunAt: 1_000 },
  ], 1_000);
  assert.strictEqual(d, 4_020); // 5000-1000+20
});

await check('nextDueDelay：最远只排 1 小时', () => {
  assert.strictEqual(
    nextDueDelay([{ enabled: true, nextRunAt: 1_000 + 10 * 3600_000 }], 1_000),
    3600_000,
  );
});

console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
