#!/usr/bin/env node
/**
 * 窗口随机 schedule：分层随机、每天 count 个点、错过跳过、跨天。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  computeNextRun,
  computeWindowTimes,
  describeSchedule,
  validateWindowSchedule,
  TaskStore,
  WINDOW_MISSED_GRACE_MS,
} from '../src/tasks/tasks.mjs';

const SCHEDULE = { kind: 'window', start: '08:00', end: '23:00', count: 10 };
const DAY = new Date(2026, 9, 31, 0, 0, 0, 0).getTime();
const minutesOf = (ts) => Math.floor((ts - DAY) / 60_000);

test('分层随机：10 个点、升序、每 90 分钟槽内一个', () => {
  const times = computeWindowTimes(SCHEDULE, DAY, 'task-test');
  assert.equal(times.length, 10);
  assert.deepEqual(times, [...times].sort((a, b) => a - b));

  for (let i = 0; i < times.length; i++) {
    const m = minutesOf(times[i]);
    assert.ok(m >= 480 + i * 90, `第 ${i} 个点早于槽位: ${m}`);
    assert.ok(m < 480 + (i + 1) * 90, `第 ${i} 个点晚于槽位: ${m}`);
  }
});

test('同一天同一 seed 结果固定，不同 seed 会变化', () => {
  const a = computeWindowTimes(SCHEDULE, DAY, 'task-a');
  const b = computeWindowTimes(SCHEDULE, DAY, 'task-a');
  const c = computeWindowTimes(SCHEDULE, DAY, 'task-b');
  assert.deepEqual(a, b);
  assert.notDeepEqual(a, c);
});

test('窗口与数量可配置：09:15–12:45 随机 4 次', () => {
  const schedule = { kind: 'window', start: '09:15', end: '12:45', count: 4 };
  const times = computeWindowTimes(schedule, DAY, 'x');
  assert.equal(times.length, 4);
  const start = 9 * 60 + 15;
  const slot = (12 * 60 + 45 - start) / 4;
  for (let i = 0; i < times.length; i++) {
    const m = minutesOf(times[i]);
    assert.ok(m >= Math.floor(start + i * slot));
    assert.ok(m < Math.floor(start + (i + 1) * slot) + 1);
  }
});

test('computeNextRun 跳过已经过去的点', () => {
  const from = new Date(2026, 9, 31, 9, 10, 0).getTime();
  const next = computeNextRun(SCHEDULE, from, { seed: 'task-test' });
  assert.ok(next > from);
  assert.ok(minutesOf(next) < 23 * 60);
});

test('当天窗口结束后顺延到第二天', () => {
  const from = new Date(2026, 9, 31, 23, 30, 0).getTime();
  const next = computeNextRun(SCHEDULE, from, { seed: 'task-test' });
  const d = new Date(next);
  assert.equal(d.getDate(), 1);
  assert.equal(d.getMonth(), 10); // 11 月
  assert.ok(d.getHours() >= 8 && d.getHours() < 23);
});

test('连续推进 count 次后进入第二天', () => {
  const times = computeWindowTimes(SCHEDULE, DAY, 'task-test');
  assert.equal(times.length, 10);
  const afterLast = computeNextRun(SCHEDULE, times.at(-1), { seed: 'task-test' });
  assert.equal(new Date(afterLast).getDate(), 1);
  assert.equal(new Date(afterLast).getMonth(), 10);
});

test('非法窗口被拒绝', () => {
  const bad = [
    { kind: 'window', start: '23:00', end: '08:00', count: 3 },
    { kind: 'window', start: '08:00', end: '09:00', count: 0 },
    { kind: 'window', start: '08:00', end: '09:00', count: 61 },
    { kind: 'window', start: '8点', end: '9点', count: 3 },
    { kind: 'window', start: '08:00', end: '09:00', count: 3, spacing: 'uniform' },
  ];
  for (const schedule of bad) {
    assert.ok(validateWindowSchedule(schedule), JSON.stringify(schedule));
    assert.equal(computeWindowTimes(schedule, DAY, 'x'), null);
    assert.equal(computeNextRun(schedule, DAY, { seed: 'x' }), null);
  }
});

test('describeSchedule 展示窗口与次数', () => {
  assert.match(describeSchedule(SCHEDULE), /08:00–23:00/);
  assert.match(describeSchedule(SCHEDULE), /随机 10 次/);
});

test('TaskStore：错过窗口点后 skipMissed 推进到未来', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'window-task-'));
  const store = new TaskStore(join(dir, 'tasks.json'));
  await store.load();

  const task = store.add({
    schedule: { kind: 'window', start: '08:00', end: '23:00', count: 10 },
    prompt: '出题',
    title: '窗口任务',
  });
  assert.ok(task.nextRunAt > 0);

  const now = task.nextRunAt + WINDOW_MISSED_GRACE_MS + 60_000;
  assert.equal(store.skipMissed(task.id, now), true);
  assert.ok(store.get(task.id).nextRunAt > now);

  await rm(dir, { recursive: true, force: true });
});
