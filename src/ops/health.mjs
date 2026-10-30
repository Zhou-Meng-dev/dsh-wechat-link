/**
 * 健康检查：/healthz（存活）与 /readyz（就绪）。
 *
 * 两者语义必须分开：
 *   - /healthz 只回答「进程还在、事件循环还能响应」。没有租户、租户正在重连，
 *     进程本身仍然是活的，不该被 liveness 探针杀掉。
 *   - /readyz 回答「现在能真正处理消息吗」。配置里的租户全部 running 才 200；
 *     无租户、载入失败、租户未启动/登录失效时返回 503，并在响应体里给出 reason。
 *
 * 就绪失败只影响流量与发布判定，不影响进程存活。
 */

import { createServer } from 'node:http';

import { VERSION } from '../version.mjs';

/**
 * 归一化调用方传入的快照。
 * @param {object} snapshot
 * @param {number} [snapshot.expected] - 配置里的租户数（含载入失败的）
 * @param {object[]} [snapshot.tenants] - registry.list() 的结果
 * @param {{id?: string, error?: string}[]} [snapshot.failures] - 无法载入的租户
 */
function normalizeSnapshot(snapshot) {
  const src = snapshot && typeof snapshot === 'object' ? snapshot : {};
  const tenants = Array.isArray(src.tenants) ? src.tenants : [];
  const failures = Array.isArray(src.failures) ? src.failures : [];
  const expected = Number.isInteger(src.expected) ? src.expected : tenants.length;
  return { tenants, failures, expected };
}

function tenantList(tenants) {
  return tenants.map((t) => ({ id: t?.id ?? '(unknown)', state: t?.state ?? 'unknown' }));
}

/**
 * 存活报告：只要进程能构造出这个响应就算存活。
 * @param {object} snapshot
 * @param {object} [opts]
 * @param {number} [opts.startedAt]
 * @param {() => number} [opts.now]
 */
export function livenessReport(snapshot, { startedAt = Date.now(), now = () => Date.now() } = {}) {
  const { tenants, expected } = normalizeSnapshot(snapshot);
  const running = tenants.filter((t) => t?.state === 'running').length;

  return {
    status: 200,
    body: {
      ok: true,
      version: VERSION,
      uptimeSec: Math.max(0, Math.floor((now() - startedAt) / 1000)),
      running,
      total: expected,
      tenants: tenantList(tenants),
    },
  };
}

/**
 * 就绪报告：配置中的租户全部 running 才 200。
 * @param {object} snapshot
 */
export function readinessReport(snapshot) {
  const { tenants, failures, expected } = normalizeSnapshot(snapshot);
  const running = tenants.filter((t) => t?.state === 'running').length;
  const notRunning = tenants.length - running;
  const unhealthy = failures.length + notRunning;

  let reason = 'ready';
  if (expected === 0) {
    reason = 'no-tenants';
  } else if (failures.length > 0) {
    reason = 'load-failures';
  } else if (notRunning > 0) {
    reason = 'tenants-not-running';
  } else if (running !== expected) {
    // registry 里还有已经不该存在的租户（例如刚被移除、尚未停完）
    reason = 'tenant-count-mismatch';
  }

  return {
    status: reason === 'ready' ? 200 : 503,
    body: {
      ready: reason === 'ready',
      reason,
      running,
      total: expected,
      unhealthy,
      tenants: tenantList(tenants),
      failures: failures.map((f) => ({ id: f?.id ?? '(unknown)', error: f?.error ?? '' })),
    },
  };
}

function sendJson(res, status, body, { head = false } = {}) {
  const payload = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  });
  res.end(head ? undefined : payload);
}

/**
 * 创建健康检查 HTTP 服务。只监听 GET/HEAD；未知路径 404，其它方法 405。
 *
 * @param {object} opts
 * @param {() => object} opts.snapshot - 返回 { expected, tenants, failures }
 * @param {number} [opts.startedAt]
 * @param {() => number} [opts.now] - 测试注入时钟
 * @param {(msg: string) => void} [opts.log]
 */
export function createHealthServer({
  snapshot,
  startedAt = Date.now(),
  now = () => Date.now(),
  log = () => {},
} = {}) {
  if (typeof snapshot !== 'function') {
    throw new Error('createHealthServer 需要 snapshot() 回调');
  }

  return createServer((req, res) => {
    const path = String(req.url ?? '/').split('?')[0];
    const isHealth = path === '/healthz';
    const isReady = path === '/readyz';

    if (!isHealth && !isReady) {
      sendJson(res, 404, { ok: false, error: 'not found' });
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.setHeader('allow', 'GET, HEAD');
      sendJson(res, 405, { ok: false, error: 'method not allowed' });
      return;
    }

    let state;
    try {
      state = snapshot();
    } catch (err) {
      log(`健康检查快照失败: ${err.message}`);
      sendJson(res, 503, { ok: false, error: 'snapshot failed' });
      return;
    }

    const report = isHealth
      ? livenessReport(state, { startedAt, now })
      : readinessReport(state);
    sendJson(res, report.status, report.body, { head: req.method === 'HEAD' });
  });
}
