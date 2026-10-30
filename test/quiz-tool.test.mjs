#!/usr/bin/env node
/**
 * quiz.py：pending / ask / record / 计分 / reset。
 *
 * 没有 python3 时只校验脚本写入，跳过实际执行。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

import { ensureQuizTool } from '../src/tasks/quiz.mjs';

const PY = spawnSync('python3', ['--version'], { encoding: 'utf8' });
const HAS_PYTHON = !PY.error && PY.status === 0;

function run(script, args, cwd) {
  return spawnSync('python3', [script, ...args], {
    cwd,
    encoding: 'utf8',
    timeout: 10_000,
    env: { ...process.env },
  });
}

test('ensureQuizTool 写入 _tools/quiz.py，内容含子命令', async () => {
  const ws = await mkdtemp(join(tmpdir(), 'quiz-tool-'));
  const path = await ensureQuizTool(ws);
  assert.ok(existsSync(path));
  const src = await readFile(path, 'utf8');
  assert.match(src, /def cmd_ask/);
  assert.match(src, /def cmd_record/);
  await rm(ws, { recursive: true, force: true });
});

test('quiz.py 完整流程：ask → pending → record → 计分', async (t) => {
  if (!HAS_PYTHON) {
    t.skip('没有 python3');
    return;
  }

  const ws = await mkdtemp(join(tmpdir(), 'quiz-run-'));
  const script = await ensureQuizTool(ws);

  try {
    let r = run(script, ['status', '--json'], ws);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(JSON.parse(r.stdout).totals.asked, 0);

    r = run(script, ['pending'], ws);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /NONE/);

    r = run(script, ['ask', '--question', 'Go 的 GMP 是什么？', '--answer', '调度模型'], ws);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /第 1 题/);

    r = run(script, ['pending'], ws);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /GMP/);

    r = run(script, ['ask', '--question', '第二题'], ws);
    assert.equal(r.status, 2, '已有 pending 时应拒绝');

    r = run(script, ['record', 'correct'], ws);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /正确 1/);

    r = run(script, ['status', '--json'], ws);
    const state = JSON.parse(r.stdout);
    assert.equal(state.pending, null);
    assert.deepEqual(state.totals, { asked: 1, answered: 1, correct: 1, wrong: 0, skipped: 0 });
    assert.equal(state.streak.current, 1);
    assert.equal(state.streak.best, 1);

    r = run(script, ['record', 'wrong', '--note', '没答出来'], ws);
    assert.equal(r.status, 2, '没有 pending 时应拒绝');
  } finally {
    await rm(ws, { recursive: true, force: true });
  }
});

test('quiz.py：wrong 重置连续正确，skip 不计入已答', async (t) => {
  if (!HAS_PYTHON) {
    t.skip('没有 python3');
    return;
  }

  const ws = await mkdtemp(join(tmpdir(), 'quiz-streak-'));
  const script = await ensureQuizTool(ws);

  try {
    run(script, ['ask', '--question', 'Q1'], ws);
    run(script, ['record', 'correct'], ws);
    run(script, ['ask', '--question', 'Q2'], ws);
    let r = run(script, ['record', 'wrong'], ws);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /连续正确: 0（最高 1）/);

    run(script, ['ask', '--question', 'Q3'], ws);
    r = run(script, ['record', 'skip'], ws);
    assert.equal(r.status, 0, r.stderr);

    r = run(script, ['status', '--json'], ws);
    const state = JSON.parse(r.stdout);
    assert.equal(state.totals.asked, 3);
    assert.equal(state.totals.answered, 2);
    assert.equal(state.totals.correct, 1);
    assert.equal(state.totals.wrong, 1);
    assert.equal(state.totals.skipped, 1);
  } finally {
    await rm(ws, { recursive: true, force: true });
  }
});
