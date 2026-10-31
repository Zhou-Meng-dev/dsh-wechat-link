#!/usr/bin/env node
/**
 * 用量统计：日/月汇总、模型计数、失败回合、预算告警、持久化、CLI usage。
 */
import assert from 'node:assert';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  UsageStore,
  dayKey,
  formatTokens,
  formatUsageSummary,
  monthKey,
} from '../src/ops/usage.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ENTRY = join(ROOT, 'src', 'main.mjs');

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

const root = await mkdtemp(join(tmpdir(), 'usage-'));
const usagePath = join(root, 'usage.json');

/** 本地时间构造，避免测试机时区不同导致日期键漂移。 */
function localDate(y, m, d, h = 10) {
  return new Date(y, m - 1, d, h, 0, 0);
}

const day1 = localDate(2026, 10, 30);
let clock = day1;

const store = new UsageStore({
  path: usagePath,
  budget: { day: 100, month: 1000 },
  now: () => clock,
});

const alerts = [];
store.on('alert', (a) => alerts.push(a));

await check('记录回合：累加 token 并计入模型', () => {
  store.record({
    at: clock,
    peerId: 'u1',
    model: 'deepseek-flash',
    usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 20 },
  });
  const s = store.summary({ at: clock });
  assert.strictEqual(s.day.key, dayKey(day1));
  assert.strictEqual(s.day.turns, 1);
  assert.strictEqual(s.day.failedTurns, 0);
  assert.strictEqual(s.day.inputTokens, 100);
  assert.strictEqual(s.day.outputTokens, 50);
  assert.strictEqual(s.day.cacheReadTokens, 20);
  assert.strictEqual(s.day.totalTokens, 170);
  assert.deepStrictEqual(s.day.models, { 'deepseek-flash': 1 });
});

await check('失败回合单独计数，但仍算一次 turn', () => {
  store.record({ at: clock, peerId: 'u1', model: 'deepseek-flash', usage: { outputTokens: 10 }, ok: false });
  const s = store.summary({ at: clock });
  assert.strictEqual(s.day.turns, 2);
  assert.strictEqual(s.day.failedTurns, 1);
  assert.strictEqual(s.day.totalTokens, 180);
});

await check('预算按日告警，且同一周期只告警一次', () => {
  assert.strictEqual(alerts.length, 1);
  assert.strictEqual(alerts[0].scope, 'day');
  assert.strictEqual(alerts[0].key, dayKey(day1));
  assert.strictEqual(alerts[0].limit, 100);

  store.record({ at: clock, peerId: 'u1', model: 'deepseek-flash', usage: { outputTokens: 5 } });
  assert.strictEqual(alerts.length, 1, '同一周期不应重复告警');
});

await check('跨月累计：日桶按本地日期、月汇总跨天', () => {
  clock = localDate(2026, 10, 31);
  store.record({ at: clock, peerId: 'u1', model: 'deepseek-pro', usage: { inputTokens: 90, outputTokens: 20 } });
  const s = store.summary({ at: clock });
  assert.strictEqual(s.day.key, '2026-10-31');
  assert.strictEqual(s.day.totalTokens, 110);
  assert.strictEqual(s.month.key, '2026-10');
  assert.strictEqual(s.month.turns, 4);
  assert.strictEqual(s.month.totalTokens, 295);
  assert.deepStrictEqual(s.month.models, { 'deepseek-flash': 3, 'deepseek-pro': 1 });
});

await check('新的一天重新触发日预算告警', () => {
  assert.ok(alerts.some((a) => a.scope === 'day' && a.key === '2026-10-31'));
});

await check('月预算告警在跨过阈值时触发', () => {
  const monthStore = new UsageStore({
    path: join(root, 'month.json'),
    budget: { month: 50 },
    now: () => day1,
  });
  const seen = [];
  monthStore.on('alert', (a) => seen.push(a));
  monthStore.record({ at: day1, usage: { inputTokens: 30 } });
  assert.strictEqual(seen.length, 0);
  monthStore.record({ at: day1, usage: { inputTokens: 30 } });
  assert.strictEqual(seen.length, 1);
  assert.strictEqual(seen[0].scope, 'month');
  assert.strictEqual(seen[0].spent, 60);
});

await check('持久化：flush 后重新 load，数据一致', async () => {
  await store.flush(true);
  const reloaded = new UsageStore({ path: usagePath, now: () => clock });
  await reloaded.load();
  const s = reloaded.summary({ at: clock });
  assert.strictEqual(s.month.turns, 4);
  assert.strictEqual(s.month.totalTokens, 295);
});

await check('保留期：过期天桶在记录时被清理', async () => {
  const path = join(root, 'retention.json');
  const old = new UsageStore({ path, retentionDays: 30, now: () => localDate(2026, 1, 1) });
  old.record({ at: localDate(2026, 1, 1), usage: { outputTokens: 1 } });
  const now = new UsageStore({ path, retentionDays: 30, now: () => localDate(2026, 10, 30) });
  await now.load();
  now.record({ at: localDate(2026, 10, 30), usage: { outputTokens: 2 } });
  await now.flush(true);
  const raw = JSON.parse(await readFile(path, 'utf8'));
  assert.deepStrictEqual(Object.keys(raw.days), ['2026-10-30']);
});

await check('formatTokens / formatUsageSummary 可读且带预算', () => {
  assert.strictEqual(formatTokens(1234567), '1,234,567');
  assert.strictEqual(formatTokens(0), '0');

  const text = formatUsageSummary(store.summary({ at: clock }), { title: '测试用量' });
  assert.match(text, /测试用量/);
  assert.match(text, /今日 2026-10-31/);
  assert.match(text, /本月 2026-10/);
  assert.match(text, /deepseek-flash/);
  assert.match(text, /预算: 日 100/);
});

await check('CLI usage：默认/--day/--json 都能读到租户 usage.json', async () => {
  const home = join(root, 'bridge-home');
  const tenantId = 't-test';
  const tenantRoot = join(home, 'tenants', tenantId);
  await mkdir(tenantRoot, { recursive: true });
  await writeFile(join(home, 'config.json'), JSON.stringify({
    version: 2,
    tenants: [{ id: tenantId, ownerId: 'owner@im.wechat' }],
  }, null, 2));
  await writeFile(join(home, 'secrets.json'), JSON.stringify({
    version: 1,
    tenants: { [tenantId]: { token: 'bot123@im.bot:secret' } },
  }, null, 2));

  // 默认输出用的是“今天”，测试机跨天时不能写死日期
  const cliDay = new Date();
  const cliKey = dayKey(cliDay);
  const cliStore = new UsageStore({ path: join(tenantRoot, 'usage.json'), now: () => cliDay });
  cliStore.record({
    at: cliDay,
    model: 'deepseek-flash',
    usage: { inputTokens: 1234, outputTokens: 66 },
  });
  await cliStore.flush(true);

  const run = (args) => new Promise((resolve) => {
    execFile(process.execPath, [ENTRY, 'usage', tenantId, ...args], {
      cwd: ROOT,
      env: { ...process.env, BRIDGE_HOME: home },
    }, (err, stdout, stderr) => resolve({ code: err ? 1 : 0, stdout, stderr }));
  });

  const normal = await run([]);
  assert.strictEqual(normal.code, 0, normal.stderr);
  assert.match(normal.stdout, /租户 bot123@im\.bot 用量/);
  assert.ok(normal.stdout.includes(`今日 ${cliKey}`), normal.stdout);
  assert.match(normal.stdout, /1,300 tokens/);

  const json = await run(['--day', cliKey, '--json']);
  assert.strictEqual(json.code, 0, json.stderr);
  const parsed = JSON.parse(json.stdout);
  assert.strictEqual(parsed.day.key, cliKey);
  assert.strictEqual(parsed.day.totalTokens, 1300);

  const bad = await run(['--day', '2026/10/30']);
  assert.strictEqual(bad.code, 1);
  assert.match(bad.stderr, /YYYY-MM-DD/);
});

// ---------------------------------------------------------------- 预算预检与每用户配额

await check('canSpend：记录 peer 用量，无配额时放行', () => {
  let now = localDate(2026, 10, 30);
  const st = new UsageStore({ path: join(root, 'q1.json'), budget: {}, now: () => now });
  st.record({ at: now, peerId: 'u1', usage: { totalTokens: 30 } });
  assert.strictEqual(st.peersSummary()[0].dayTokens, 30);
  assert.strictEqual(st.canSpend({ peerId: 'u1' }).ok, true);
});

await check('canSpend：租户日预算，spent >= limit 即拒绝', () => {
  let now = localDate(2026, 10, 30);
  const st = new UsageStore({ path: join(root, 'q2.json'), budget: { day: 100 }, now: () => now });
  st.record({ at: now, peerId: 'u1', usage: { totalTokens: 60 } });
  assert.strictEqual(st.canSpend({ at: now }).ok, true);
  st.record({ at: now, peerId: 'u1', usage: { totalTokens: 40 } });
  const r = st.canSpend({ at: now });
  assert.strictEqual(r.ok, false, '等于预算也必须拦');
  assert.strictEqual(r.reason, 'tenant-day');
  assert.strictEqual(r.spent, 100);
  assert.strictEqual(r.limit, 100);
});

await check('canSpend：每用户日配额，两个 peer 互不影响', () => {
  const now = localDate(2026, 10, 30);
  const st = new UsageStore({
    path: join(root, 'q3.json'),
    budget: { userDay: 50 },
    now: () => now,
  });
  st.record({ at: now, peerId: 'u1', usage: { totalTokens: 50 } });
  st.record({ at: now, peerId: 'u2', usage: { totalTokens: 10 } });

  const r1 = st.canSpend({ peerId: 'u1', at: now });
  assert.strictEqual(r1.ok, false);
  assert.strictEqual(r1.reason, 'user-day');
  assert.strictEqual(r1.scope, 'user');
  assert.strictEqual(st.canSpend({ peerId: 'u2', at: now }).ok, true);
  assert.strictEqual(st.canSpend({ peerId: 'u3', at: now }).ok, true);
});

await check('canSpend：租户月 / 用户月配额', () => {
  let now = localDate(2026, 10, 5);
  const st = new UsageStore({
    path: join(root, 'q4.json'),
    budget: { month: 500, userMonth: 200 },
    now: () => now,
  });
  st.record({ at: now, peerId: 'u1', usage: { totalTokens: 200 } });
  now = localDate(2026, 10, 20);
  st.record({ at: now, peerId: 'u2', usage: { totalTokens: 300 } });

  const r = st.canSpend({ peerId: 'u1', at: now });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'tenant-month');
  assert.strictEqual(r.limit, 500);
});

await check('canSpend：跨天 / 跨月自动放行', () => {
  let now = localDate(2026, 10, 30);
  const st = new UsageStore({
    path: join(root, 'q5.json'),
    budget: { day: 500, month: 5000, userDay: 50, userMonth: 200 },
    now: () => now,
  });
  st.record({ at: now, peerId: 'u1', usage: { totalTokens: 40 } });
  st.record({ at: now, peerId: 'u2', usage: { totalTokens: 40 } });
  assert.strictEqual(st.canSpend({ peerId: 'u1', at: now }).ok, true, '40 < 用户日配额 50');
  st.record({ at: now, peerId: 'u1', usage: { totalTokens: 10 } });
  assert.strictEqual(st.canSpend({ peerId: 'u1', at: now }).ok, false, '用户日配额 50 已到');

  // 跨天：租户日与用户日都清零
  now = localDate(2026, 10, 31);
  assert.strictEqual(st.canSpend({ peerId: 'u1', at: now }).ok, true, '跨天后应放行');

  // 下个月：月桶清零
  now = localDate(2026, 11, 1);
  assert.strictEqual(st.canSpend({ peerId: 'u1', at: now }).ok, true);
});

await check('v1 usage.json 可读：peers 为空，下一次写盘升 v2', async () => {
  const p = join(root, 'legacy', 'usage.json');
  await mkdir(dirname(p), { recursive: true });
  await writeFile(p, JSON.stringify({
    version: 1,
    days: { '2026-10-30': { turns: 2, totalTokens: 55, inputTokens: 30, outputTokens: 25 } },
    alerts: {},
  }));
  let now = localDate(2026, 10, 30);
  const st = new UsageStore({ path: p, budget: {}, now: () => now });
  await st.load();
  assert.deepStrictEqual(st.peersSummary(), []);
  assert.strictEqual(st.summary().day.totalTokens, 55);
  st.record({ at: now, peerId: 'u1', usage: { totalTokens: 5 } });
  await st.flush();
  const raw = JSON.parse(await readFile(p, 'utf8'));
  assert.strictEqual(raw.version, 2);
  assert.strictEqual(raw.peers.u1.dayTokens, 5);
});

await check('peersSummary 按本月用量排序', () => {
  const now = localDate(2026, 10, 30);
  const st = new UsageStore({ path: join(root, 'q6.json'), budget: {}, now: () => now });
  st.record({ at: now, peerId: 'a', usage: { totalTokens: 10 } });
  st.record({ at: now, peerId: 'b', usage: { totalTokens: 30 } });
  assert.deepStrictEqual(st.peersSummary().map((x) => x.peerId), ['b', 'a']);
});

await check('peers 超过上限：按 lastAt 淘汰最旧', () => {
  let now = localDate(2026, 10, 30);
  const st = new UsageStore({ path: join(root, 'cap.json'), budget: {}, now: () => now, maxPeers: 2 });
  st.record({ at: now, peerId: 'old', usage: { totalTokens: 1 } });
  now = new Date(now.getTime() + 1000);
  st.record({ at: now, peerId: 'mid', usage: { totalTokens: 1 } });
  now = new Date(now.getTime() + 1000);
  st.record({ at: now, peerId: 'new', usage: { totalTokens: 1 } });
  assert.deepStrictEqual(st.peersSummary().map((x) => x.peerId).sort(), ['mid', 'new']);
  assert.strictEqual(st.peersSummary().some((x) => x.peerId === 'old'), false);
});

await rm(root, { recursive: true, force: true });

console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
