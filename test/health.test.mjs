#!/usr/bin/env node
/**
 * 健康检查：/healthz 只看进程存活，/readyz 只认配置中的租户全部 running。
 *
 * 用真实 HTTP 请求覆盖状态码、响应体与 404/405，不只测纯函数。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createHealthServer, livenessReport, readinessReport } from '../src/ops/health.mjs';

const RUNNING = { id: 't-1', state: 'running' };

test('liveness：没有租户也返回 200', () => {
  const r = livenessReport(
    { expected: 0, tenants: [], failures: [] },
    { startedAt: 1_000, now: () => 61_000 },
  );
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  assert.equal(r.body.uptimeSec, 60);
  assert.equal(r.body.running, 0);
  assert.equal(r.body.total, 0);
});

test('readiness：没有租户 → 503 no-tenants', () => {
  const r = readinessReport({ expected: 0, tenants: [], failures: [] });
  assert.equal(r.status, 503);
  assert.equal(r.body.ready, false);
  assert.equal(r.body.reason, 'no-tenants');
});

test('readiness：全部 running → 200 ready', () => {
  const r = readinessReport({
    expected: 2,
    tenants: [RUNNING, { id: 't-2', state: 'running' }],
    failures: [],
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.ready, true);
  assert.equal(r.body.reason, 'ready');
  assert.equal(r.body.running, 2);
  assert.equal(r.body.unhealthy, 0);
});

test('readiness：租户未运行（启动中/失败/登录失效）→ 503 tenants-not-running', () => {
  for (const state of ['starting', 'failed', 'stopped', 'idle']) {
    const r = readinessReport({
      expected: 2,
      tenants: [RUNNING, { id: 't-2', state }],
      failures: [],
    });
    assert.equal(r.status, 503, state);
    assert.equal(r.body.reason, 'tenants-not-running', state);
    assert.equal(r.body.unhealthy, 1, state);
  }
});

test('readiness：载入失败 → 503 load-failures', () => {
  const r = readinessReport({
    expected: 2,
    tenants: [RUNNING],
    failures: [{ id: 't-2', error: '缺少 token' }],
  });
  assert.equal(r.status, 503);
  assert.equal(r.body.reason, 'load-failures');
  assert.equal(r.body.unhealthy, 1);
  assert.deepEqual(r.body.failures, [{ id: 't-2', error: '缺少 token' }]);
});

test('readiness：registry 里多出已不该存在的租户 → 503 tenant-count-mismatch', () => {
  const r = readinessReport({
    expected: 1,
    tenants: [RUNNING, { id: 't-2', state: 'running' }],
    failures: [],
  });
  assert.equal(r.status, 503);
  assert.equal(r.body.reason, 'tenant-count-mismatch');
});

test('HTTP：/healthz 200、/readyz 503、未知路径 404、POST 405、HEAD 无响应体', async () => {
  const server = createHealthServer({
    snapshot: () => ({ expected: 0, tenants: [], failures: [] }),
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;

  try {
    const health = await fetch(`${base}/healthz`);
    assert.equal(health.status, 200);
    assert.equal((await health.json()).ok, true);

    const ready = await fetch(`${base}/readyz`);
    assert.equal(ready.status, 503);
    assert.equal((await ready.json()).reason, 'no-tenants');

    assert.equal((await fetch(`${base}/nope`)).status, 404);

    const post = await fetch(`${base}/healthz`, { method: 'POST' });
    assert.equal(post.status, 405);
    assert.equal(post.headers.get('allow'), 'GET, HEAD');

    const head = await fetch(`${base}/healthz`, { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(await head.text(), '');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('HTTP：snapshot 抛错时返回 503，不拖垮进程', async () => {
  const logs = [];
  const server = createHealthServer({
    snapshot: () => { throw new Error('registry 崩了'); },
    log: (m) => logs.push(m),
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  try {
    const res = await fetch(`http://127.0.0.1:${port}/healthz`);
    assert.equal(res.status, 503);
    assert.equal((await res.json()).ok, false);
    assert.ok(logs.some((m) => m.includes('registry 崩了')));
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
