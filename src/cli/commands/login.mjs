/**
 * `login`：扫码添加一个租户（独立 bot），并继承预设 API key。
 */

import { mkdir } from 'node:fs/promises';

import { qrLogin } from '../../wechat/ilink.mjs';
import {
  applyPersonaTemplate, buildTenantDef, maskKey, resolveDefaultApiKey, tenantIdFrom, tenantWorkspace,
} from '../../config.mjs';
import { CLI, CONFIG_PATH, store, warn } from '../context.mjs';

export async function cmdLogin(argv) {
  const cwdIdx = argv.indexOf('--cwd');
  const explicitCwd = cwdIdx >= 0 ? argv[cwdIdx + 1] : null;

  console.log('开始扫码添加一个新的微信 bot…\n');
  const res = await qrLogin({
    onQr: (url) => {
      console.log('请用微信扫描下方链接（在浏览器打开后扫码）：\n');
      console.log(url);
      console.log('\n等待扫码…');
    },
    log: warn,
  });

  const id = tenantIdFrom(res.botId ?? res.token);
  const cfg = await store.read();
  const secrets = await store.secrets.read();

  const isNew = !cfg.tenants.some((t) => t.id === id);
  if (!isNew) {
    console.log(`\nℹ️ 该 bot 已存在（${id}），更新了凭证。`);
  }

  // 构造租户定义；自动继承预设 API key（之后可用 apikey <id> --set 覆盖）
  // 默认工作目录由 id 派生；只有显式 --cwd 且不等于派生值时才写 cwdOverride
  const { config: entry, secret } = buildTenantDef(res, {
    cwdOverride: explicitCwd ?? undefined,
    defaultApiKey: resolveDefaultApiKey(secrets),
  });

  const cwd = tenantWorkspace(id, entry);
  await mkdir(cwd, { recursive: true }).catch(() => {});

  // 先写凭据再写配置：配置里出现租户时，它的 token 一定已经落盘
  const merged = { ...(secrets.tenants[id] ?? {}), ...secret };
  await store.secrets.write({ ...secrets, tenants: { ...secrets.tenants, [id]: merged } });

  const others = cfg.tenants.filter((t) => t.id !== id);
  await store.write({ ...cfg, tenants: [...others, entry] });

  // 新租户首次创建时套用仓库里的默认人设模板；已有 persona.md 的租户不动
  let templatePath = null;
  if (isNew) {
    try {
      templatePath = await applyPersonaTemplate(store, id);
    } catch (err) {
      warn(`应用 persona 模板失败: ${err.message}`);
    }
  }
  const personaText = await store.readPersona(id).catch(() => '');

  console.log(`\n✅ 已添加租户 ${id}`);
  console.log(`   bot    : ${res.botId ?? '(未知)'}`);
  console.log(`   所有者 : ${res.ownerId ?? '(未知)'}`);
  console.log(`   工作目录: ${cwd}`);
  console.log(`   API key : ${merged.apiKey ? '已继承预设 key ' + maskKey(merged.apiKey) : '未配置（使用宿主机凭据）'}`);
  console.log(`   persona : ${personaText.trim()
    ? `已设置（${personaText.trim().length} 字${templatePath ? '，来自模板' : ''}）`
    : '未设置（使用 dsh 默认）'}`);
  console.log(`\n配置: ${CONFIG_PATH}`);
  console.log(`凭据: ${store.secretsPath}`);
  console.log('\n如果桥接服务正在运行，它会自动检测到新租户并启动（无需重启）。');
  console.log(`否则运行: ${CLI}`);
}
