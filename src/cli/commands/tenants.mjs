/**
 * 租户管理：`list` / `rm`。
 */

import { maskKey, tenantWorkspace } from '../../config.mjs';
import { CLI, store } from '../context.mjs';

export async function cmdList() {
  const { config: cfg, secrets, tenants, failures } = await store.resolveAll();
  if (cfg.tenants.length === 0) {
    console.log(`还没有任何租户。运行: ${CLI} login`);
    return;
  }
  console.log(`共 ${cfg.tenants.length} 个租户:`);
  if (secrets.defaultApiKey) {
    console.log(`（预设 API key: ${maskKey(secrets.defaultApiKey)} —— 新增 bot 会自动继承）`);
  }
  console.log('');
  for (const t of tenants) {
    console.log(`  ${t.id}`);
    console.log(`    bot     : ${t.botId || '(未知)'}`);
    console.log(`    所有者  : ${t.ownerId ?? '(未知)'}`);
    console.log(`    工作目录: ${t.cwd}`);
    console.log(`    API key : ${t.apiKey ? maskKey(t.apiKey) : '未配置（用宿主凭据）'}`);
    console.log(`    创建于  : ${t.createdAt ?? '(未知)'}`);
    console.log('');
  }
  for (const f of failures) {
    console.log(`  ${f.id}`);
    console.log(`    ⚠️ 无法载入: ${f.error}`);
    console.log('');
  }
}

export async function cmdRemove(argv) {
  const id = argv[0];
  if (!id) {
    console.error(`用法: ${CLI} rm <id>`);
    process.exit(1);
  }
  const cfg = await store.read();
  const removed = cfg.tenants.find((t) => t.id === id);
  const next = cfg.tenants.filter((t) => t.id !== id);
  if (!removed) {
    console.error(`没有找到租户 ${id}`);
    process.exit(1);
  }
  await store.write({ ...cfg, tenants: next });

  // 同步删掉凭据；工作目录与租户根保留（可能还有会话/任务数据）
  const secrets = await store.secrets.read();
  if (secrets.tenants[id]) {
    const nextSecrets = { ...secrets, tenants: { ...secrets.tenants } };
    delete nextSecrets.tenants[id];
    await store.secrets.write(nextSecrets);
  }

  console.log(`✅ 已删除租户 ${id}（工作目录保留: ${tenantWorkspace(id, removed)}）`);
  console.log('运行中的桥接会自动停止这个租户，无需重启。');
}
