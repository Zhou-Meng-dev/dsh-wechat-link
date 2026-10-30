/**
 * `apikey`：预设 key（新 bot 继承）与单租户独立 key 的查看/设置/清除。
 */

import { maskKey, resolveDefaultApiKey } from '../../config.mjs';
import { validateApiKey } from '../../ops/setup.mjs';
import { requireTenant } from '../tenant-context.mjs';
import { CLI, store } from '../context.mjs';

export async function cmdApikey(argv) {
  const [id, action = '--show', ...rest] = argv;
  if (!id) {
    console.error(`用法:
  ${CLI} apikey --default [--show | --set <key> | --clear]   预设 key（新 bot 自动继承）
  ${CLI} apikey <id> [--show | --set <key> | --clear]        覆盖单个 bot 的 key`);
    process.exit(1);
  }

  // ---- 预设 key（全局默认）----
  if (id === '--default' || id === 'default') {
    const secrets = await store.secrets.read();
    if (action === '--show' || action === undefined) {
      const effective = resolveDefaultApiKey(secrets);
      const fromEnv = !secrets.defaultApiKey && Boolean(process.env.BRIDGE_DEFAULT_API_KEY);
      console.log(`预设 API key: ${maskKey(effective)}`);
      if (secrets.defaultApiKey) {
        console.log(`  → 来源: ${store.secretsPath} (defaultApiKey)`);
        console.log('  → 新增 bot 时会自动继承此 key');
      } else if (fromEnv) {
        console.log('  → 来源: 环境变量 BRIDGE_DEFAULT_API_KEY');
        console.log('  → 新增 bot 时会自动继承此 key');
      } else {
        console.log('  → 未设置，新增 bot 将回退使用宿主机凭据');
      }
      return;
    }
    if (action === '--clear') {
      delete secrets.defaultApiKey;
      await store.secrets.write(secrets);
      console.log('✅ 已清除预设 key（已存在的 bot 不受影响）');
      return;
    }
    let k;
    if (action === '--set') k = rest.join(' ').trim();
    else if (action === '--file') {
      const { readFile } = await import('node:fs/promises');
      k = (await readFile(rest[1], 'utf8')).trim();
    } else {
      console.error('未知参数。支持 --show / --set / --file / --clear');
      process.exit(1);
    }
    if (!k) { console.error('key 不能为空'); process.exit(1); }
    if (!validateApiKey(k)) {
      console.error('看起来不像有效的 DeepSeek API key（应以 sk- 开头）');
      process.exit(1);
    }
    secrets.defaultApiKey = k;
    await store.secrets.write(secrets);
    console.log(`✅ 已设置预设 API key: ${maskKey(k)} → ${store.secretsPath}`);
    console.log('   之后新增的 bot 会自动使用它。已存在的 bot 不受影响。');
    return;
  }

  const { tenant, secrets } = await requireTenant(id);

  if (action === '--show') {
    console.log(`租户 ${id} 的 API key: ${maskKey(tenant.apiKey)}`);
    console.log(tenant.apiKey
      ? '  → 使用租户独立 key（通过环境变量注入，宿主凭据不进入沙箱）'
      : '  → 未配置，回退使用宿主机默认凭据');
    return;
  }

  if (action === '--clear') {
    const nextSecrets = { ...secrets, tenants: { ...secrets.tenants } };
    if (nextSecrets.tenants[id]) {
      nextSecrets.tenants[id] = { ...nextSecrets.tenants[id] };
      delete nextSecrets.tenants[id].apiKey;
      if (!nextSecrets.tenants[id].token) delete nextSecrets.tenants[id];
    }
    await store.secrets.write(nextSecrets);
    console.log(`✅ 已清除租户 ${id} 的独立 key，将回退使用宿主机凭据`);
    return;
  }

  let key;
  if (action === '--set') {
    key = rest.join(' ').trim();
  } else if (action === '--file') {
    const { readFile } = await import('node:fs/promises');
    key = (await readFile(rest[1], 'utf8')).trim();
  } else {
    console.error('未知参数。支持 --show / --set / --file / --clear');
    process.exit(1);
  }
  if (!key) { console.error('key 不能为空'); process.exit(1); }
  if (!validateApiKey(key)) {
    console.error('看起来不像有效的 DeepSeek API key（应以 sk- 开头）');
    process.exit(1);
  }

  await store.secrets.write({
    ...secrets,
    tenants: {
      ...secrets.tenants,
      [id]: { ...(secrets.tenants[id] ?? { token: tenant.token }), apiKey: key },
    },
  });
  console.log(`✅ 已为租户 ${id} 设置独立 API key: ${maskKey(key)}`);
  console.log('   服务会在 3 秒内重启该租户。');
  console.log('   注意：该租户的 dsh-home 里不再保留宿主凭据文件。');
}
