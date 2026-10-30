/**
 * 每租户能力管理：`skills` / `persona` / `plugin`。
 * 这些命令只改租户目录，运行中的服务会在 3 秒内检测到并重启该租户。
 */

import { personaPath, tenantDshHome } from '../../config.mjs';
import { requireTenant } from '../tenant-context.mjs';
import { CLI, store } from '../context.mjs';

export async function cmdSkills(argv) {
  const [id, action = 'list', arg] = argv;
  if (!id) {
    console.error(`用法: ${CLI} skills <id> [list|add <目录>|rm <名称>]`);
    process.exit(1);
  }
  const { tenantSkillsDir } = await import('../../agent/profile.mjs');
  const { existsSync } = await import('node:fs');
  const { cp, rm } = await import('node:fs/promises');
  const { basename } = await import('node:path');
  await requireTenant(id);

  const dir = tenantSkillsDir(id);

  if (action === 'list') {
    const { listSkills } = await import('../../agent/profile.mjs');
    const items = await listSkills(dir);
    console.log(`租户 ${id} 的技能目录: ${dir}`);
    if (items.length === 0) {
      console.log(`  (空)。添加: ${CLI} skills ${id} add <技能目录>`);
    } else {
      for (const n of items) console.log(`  - ${n}`);
    }
    return;
  }

  if (action === 'add') {
    if (!arg) { console.error('用法: skills <id> add <技能目录>'); process.exit(1); }
    if (!existsSync(arg)) { console.error(`源目录不存在: ${arg}`); process.exit(1); }
    const name = basename(arg.replace(/\/+$/, ''));
    await cp(arg, `${dir}/${name}`, { recursive: true });
    console.log(`✅ 已添加技能 ${name} → ${dir}/${name}`);
    console.log('   服务会自动重启该租户使其生效。');
    return;
  }

  if (action === 'rm') {
    if (!arg) { console.error('用法: skills <id> rm <名称>'); process.exit(1); }
    await rm(`${dir}/${arg}`, { recursive: true, force: true });
    console.log(`✅ 已删除技能 ${arg}`);
    return;
  }

  console.error(`未知操作: ${action}`);
  process.exit(1);
}

export async function cmdPersona(argv) {
  const [id, ...rest] = argv;
  if (!id) {
    console.error(`用法: ${CLI} persona <id> [--set "文本" | --file <路径> | --show | --clear]`);
    process.exit(1);
  }
  const { tenant } = await requireTenant(id);

  if (rest.length === 0 || rest[0] === '--show') {
    if (!tenant.persona.trim()) {
      console.log(`租户 ${id} 未设置自定义 persona（使用 dsh 默认）。`);
    } else {
      console.log(`租户 ${id} 的 persona（${personaPath(id)}）:\n`);
      console.log(tenant.persona);
    }
    return;
  }

  if (rest[0] === '--clear') {
    await store.writePersona(id, '');
    console.log(`✅ 已清除租户 ${id} 的 persona`);
    return;
  }

  let text;
  if (rest[0] === '--set') {
    text = rest.slice(1).join(' ');
  } else if (rest[0] === '--file') {
    const { readFile } = await import('node:fs/promises');
    text = await readFile(rest[1], 'utf8');
  } else {
    console.error('未知参数。支持 --set / --file / --show / --clear');
    process.exit(1);
  }
  if (!text || !text.trim()) { console.error('persona 不能为空'); process.exit(1); }

  const body = text.trim();
  const path = await store.writePersona(id, body);
  console.log(`✅ 已设置租户 ${id} 的 persona（${body.length} 字 → ${path}）`);
  console.log('   服务会自动重启该租户使其生效。');
}

export async function cmdPlugin(argv) {
  const [id, action = 'list', ...rest] = argv;
  if (!id) {
    console.error(`用法: ${CLI} plugin <id> [list|add <包>|rm <包>]`);
    process.exit(1);
  }
  const { listPlugins } = await import('../../agent/profile.mjs');
  await requireTenant(id);

  const dshHome = tenantDshHome(id);
  const profileDir = `${dshHome}/profiles/sdk`;

  if (action === 'list') {
    const deps = await listPlugins(dshHome);
    console.log(`租户 ${id} 的插件（${profileDir}）:`);
    const keys = Object.keys(deps);
    if (keys.length === 0) console.log('  (无)');
    else for (const k of keys) console.log(`  - ${k}@${deps[k]}`);
    return;
  }

  if (action !== 'add' && action !== 'rm') {
    console.error(`未知操作: ${action}`);
    process.exit(1);
  }

  const pkg = rest[0];
  if (!pkg) { console.error(`用法: plugin <id> ${action} <包名>`); process.exit(1); }

  // 直接调 pnpm，等价于 dsh plugin --profile sdk <action> <pkg>
  const { spawnSync } = await import('node:child_process');
  const args = action === 'add' ? ['add', pkg] : ['remove', pkg];
  console.log(`在 ${profileDir} 执行 pnpm ${args.join(' ')} …`);
  const r = spawnSync('pnpm', args, {
    cwd: profileDir,
    stdio: 'inherit',
    env: { ...process.env, DSH_HOME: dshHome },
  });
  if (r.status !== 0) {
    console.error(`❌ pnpm 失败（exit=${r.status}）。是否已安装 pnpm？`);
    process.exit(1);
  }
  console.log(`✅ 插件${action === 'add' ? '安装' : '移除'}完成。服务会自动重启该租户。`);
}
