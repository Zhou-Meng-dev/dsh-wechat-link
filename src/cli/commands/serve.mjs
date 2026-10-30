/**
 * 常驻服务：沙箱/依赖自检、首次配置、加载租户、热重载、健康检查与优雅退出。
 */

import { existsSync } from 'node:fs';

import { apiKeyFingerprint, bridgeHome, maskKey, resolveDefaultApiKey, sandboxRoot, setupMarkerPath, workspacesRoot } from '../../config.mjs';
import { assertPreflight } from '../../ops/preflight.mjs';
import { runSetup, shouldRunSetup } from '../../ops/setup.mjs';
import { applySandboxEnv, resolveSandbox } from '../../sandbox/sandbox-env.mjs';
import { TenantRegistry } from '../../tenant-registry.mjs';
import { CLI, CONFIG_PATH, log, store, warn } from '../context.mjs';

/**
 * 服务启动时的首次配置：依赖自检之后、加载租户之前。
 *
 * 只在「明显是第一次」且 stdin 是交互终端时询问 API key；
 * systemd / Docker / 管道环境保持安静（可设 BRIDGE_DEFAULT_API_KEY 或跑 setup）。
 *
 * @returns {Promise<boolean>} 是否真的走了向导
 */
async function maybeFirstRunSetup() {
  if (process.env.BRIDGE_SKIP_SETUP === '1') return false;

  const cfg = await store.read(); // 版本不兼容直接抛给外层，绝不静默改写
  if (cfg.tenants.length > 0) return false;

  const markerExists = existsSync(setupMarkerPath());
  const secrets = await store.secrets.read();
  const hasApiKey = Boolean(resolveDefaultApiKey(secrets));
  const isTTY = Boolean(process.stdin.isTTY);

  const run = shouldRunSetup({
    markerExists,
    tenantCount: cfg.tenants.length,
    hasApiKey,
    isTTY,
  });
  if (!run) {
    if (!isTTY && !markerExists && !hasApiKey) {
      log('未检测到终端，跳过首次配置向导；可设 BRIDGE_DEFAULT_API_KEY 或运行 setup');
    }
    return false;
  }

  await runSetup({ store, log, warn });
  return true;
}

export async function cmdServe() {
  // 默认把 dsh 关进 bwrap；DSH_SANDBOX=0 才显式关闭，容器模式用 BRIDGE_DSH_MODE=container。
  let sandbox;
  try {
    sandbox = await resolveSandbox();
    applySandboxEnv(sandbox);
  } catch (err) {
    console.error(`❌ 无法启用 dsh 沙箱: ${err.message}`);
    console.error('   容器部署请设置 BRIDGE_DSH_MODE=container；确认不需要沙箱可设 DSH_SANDBOX=0（不推荐）。');
    process.exit(1);
  }
  if (sandbox.mode === 'bwrap') {
    log(`dsh 沙箱: 开启（工具根 ${sandbox.toolRoot} → /opt/volta）`);
  } else if (sandbox.mode === 'container') {
    log('dsh 隔离: 容器模式（不套 bwrap）');
  } else {
    warn('dsh 沙箱已关闭（DSH_SANDBOX=0），agent 可读写宿主文件');
  }

  // 先检查 Node / dsh / Python / Pillow / 目录权限，失败直接给出可操作提示
  await assertPreflight();

  // 依赖通过后，首次启动才询问必需配置（非 TTY 自动跳过）
  await maybeFirstRunSetup();

  const { config: cfg, secrets, tenants, failures } = await store.resolveAll();

  log(`桥接根: ${bridgeHome()}`);
  log(`配置: ${CONFIG_PATH}`);
  log(`凭据: ${store.secretsPath}`);
  log(`租户数据: ${sandboxRoot()}`);
  log(`工作区根: ${workspacesRoot()}`);

  // 预设 key 来源（新增 bot 会继承；已有 bot 用各自凭据或宿主凭据）
  const presetKey = resolveDefaultApiKey(secrets);
  if (presetKey) {
    const src = secrets.defaultApiKey
      ? '凭据文件'
      : '环境变量 BRIDGE_DEFAULT_API_KEY';
    log(`预设 API key: ${maskKey(presetKey)}（来源：${src}，新增 bot 会继承）`);
  } else {
    log('预设 API key: 未设置（新增 bot 将回退使用宿主机凭据）');
  }
  if (cfg.tenants.length === 0) {
    log('尚未有任何 bot —— 服务会空跑等待，有人扫码登录后自动接入');
    log(`  添加第一个 bot: ${CLI} login`);
  } else {
    log(`载入 ${cfg.tenants.length} 个租户…`);
  }
  for (const f of failures) {
    warn(`租户 ${f.id} 无法载入: ${f.error}`);
  }

  // 配置的增删改只走 CLI；服务侧只读取合并视图，绝不回写配置文件
  const registry = new TenantRegistry({ log });

  registry.on('tenant-expired', (t) => {
    warn(`租户 ${t.id} 登录失效，已停止。重新添加: ${CLI} login`);
  });

  await registry.loadAll(tenants);

  for (const s of registry.list()) {
    log(`  ${s.state === 'running' ? '✅' : '❌'} ${s.id}  owner=${s.ownerId ?? '-'}  cwd=${s.cwd}`);
  }

  const running = registry.list().filter((s) => s.state === 'running').length;
  const total = cfg.tenants.length;
  if (total === 0) {
    log(`\n👂 服务已就绪，正在等待第一个 bot 扫码接入。Ctrl+C 退出。`);
  } else if (running === 0) {
    // 有配置但都没起来：保留进程，等修复配置后热加载，而不是直接死掉
    warn(`⚠️ ${total} 个租户都没能启动，服务继续运行等待配置修复`);
  } else {
    log(`\n🚀 ${running}/${total} 个租户运行中。Ctrl+C 退出。`);
  }

  // 容器/K8s 探针：BRIDGE_HEALTH_PORT 设置后暴露 /healthz 与 /readyz。
  // 不设置时完全不监听端口（裸机部署保持原样）。
  let healthServer = null;
  const healthPort = Number(process.env.BRIDGE_HEALTH_PORT ?? 0);
  if (Number.isFinite(healthPort) && healthPort > 0) {
    const http = await import('node:http');
    const host = process.env.BRIDGE_HEALTH_HOST ?? '127.0.0.1';
    healthServer = http.createServer((req, res) => {
      if (req.url !== '/healthz' && req.url !== '/readyz') {
        res.writeHead(404);
        res.end('not found\n');
        return;
      }
      const list = registry.list();
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        ok: true,
        running: list.filter((t) => t.state === 'running').length,
        tenants: list.map((t) => ({ id: t.id, state: t.state })),
      }) + '\n');
    });
    healthServer.on('error', (err) => warn(`健康检查端口 ${healthPort} 失败: ${err.message}`));
    healthServer.listen(healthPort, host, () => log(`健康检查: http://${host}:${healthPort}/healthz`));
  }

  // 运行期重载：配置变化（增删租户、改 persona/model/cwd/apikey）自动同步。
  // 比对整份合并视图，而不仅是 id —— 否则改了 persona 不会生效。
  // apiKey 只参与比对哈希，绝不把明文放进任何日志或比较结果。
  const defKey = (list) =>
    JSON.stringify(
      [...list]
        .sort((a, b) => String(a.id).localeCompare(String(b.id)))
        .map((d) => [
          d.id, d.cwd, d.model, d.provider, d.persona ?? '', apiKeyFingerprint(d.apiKey),
        ]),
    );
  let lastSeen = defKey(tenants);
  const reloadTimer = setInterval(async () => {
    try {
      const fresh = await store.resolveAll();
      const key = defKey(fresh.tenants);
      if (key === lastSeen) return;
      lastSeen = key;

      const freshIds = fresh.tenants.map((t) => t.id);

      for (const f of fresh.failures) {
        if (registry.get(f.id)) warn(`租户 ${f.id} 无法载入（${f.error}），将停止`);
      }

      // 新增
      for (const tenant of fresh.tenants) {
        if (!registry.get(tenant.id)) {
          log(`检测到新租户 ${tenant.id}，启动中…`);
          await registry.add(tenant).catch((e) => warn(`启动 ${tenant.id} 失败: ${e.message}`));
        }
      }
      // 配置变更 → 重启该租户
      for (const tenant of fresh.tenants) {
        const existing = registry.get(tenant.id);
        if (existing && defKey([existing.tenant]) !== defKey([tenant])) {
          log(`租户 ${tenant.id} 配置已变更，重启中…`);
          await registry.remove(tenant.id).catch(() => {});
          await registry.add(tenant).catch((e) => warn(`重启 ${tenant.id} 失败: ${e.message}`));
        }
      }
      // 删除
      for (const existing of registry.list()) {
        if (!freshIds.includes(existing.id)) {
          log(`检测到租户 ${existing.id} 被移除，停止中…`);
          await registry.remove(existing.id).catch(() => {});
        }
      }
    } catch (err) {
      warn(`重载配置失败: ${err.message}`);
    }
  }, 3000);
  // 注意：**不要 unref**。这个定时器是服务的心跳 ——
  // 没有任何租户时，若把它 unref，事件循环为空，进程会立刻退出，
  // 于是"空跑等登录"根本等不到第一个人。

  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    clearInterval(reloadTimer);
    try { healthServer?.close(); } catch { /* 未成功 listen 时 close 会抛 */ }
    log('正在关闭所有租户…');
    await registry.stopAll();
    setTimeout(() => process.exit(0), 1000);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
