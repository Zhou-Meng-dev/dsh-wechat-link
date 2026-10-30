/**
 * 命令间共享的租户查询：按 id 取合并视图，找不到或缺凭据就报错退出。
 */

import { resolveTenant } from '../config.mjs';
import { store } from './context.mjs';

/** 找到租户的合并视图，找不到（或缺凭据）就报错退出 */
export async function requireTenant(id) {
  const cfg = await store.read();
  const entry = cfg.tenants.find((x) => x.id === id);
  if (!entry) {
    console.error(`没有找到租户 ${id}。用 list 查看可用租户。`);
    process.exit(1);
  }
  const secrets = await store.secrets.read();
  try {
    const personaText = await store.readPersona(id);
    const tenant = resolveTenant({
      configEntry: entry,
      secretEntry: secrets.tenants[id],
      personaText,
      id,
    });
    return { cfg, secrets, entry, tenant };
  } catch (err) {
    console.error(`租户 ${id} 无法载入: ${err.message}`);
    process.exit(1);
  }
}
