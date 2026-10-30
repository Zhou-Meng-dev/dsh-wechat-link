#!/usr/bin/env node
/**
 * 配置层测试：v2 结构、秘密分离、派生值、缺失降级。
 *
 * 每个用例用独立的临时目录，并在进程内改掉 HOME / 根目录环境变量，
 * 不碰真实配置文件。
 */
import assert from 'node:assert';
import { mkdtemp, mkdir, writeFile, readFile, readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  ConfigStore, SecretsStore, normalizeConfig, resolveTenant, resolveDefaultApiKey,
  tenantWorkspace, tenantRoot, tenantDshHome, botIdFromToken, personaPath,
  configDir, defaultConfigPath, defaultSecretsPath, sandboxRoot, workspacesRoot, setupMarkerPath,
  loadPersonaTemplate, applyPersonaTemplate,
  DEFAULT_BASE_URL, DEFAULT_MODEL, DEFAULT_PROVIDER,
} from '../src/config.mjs';

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

// ---- 沙箱化：所有路径落在临时目录里 ----
const root = await mkdtemp(join(tmpdir(), 'dsh-wechat-link-config-'));
const sandbox = join(root, 'agent');
const workspaces = join(sandbox, 'workspace');
process.env.HOME = root;
process.env.WECHAT_SANDBOX_ROOT = sandbox;
process.env.WECHAT_WORKSPACES = workspaces;
delete process.env.BRIDGE_SECRETS;
delete process.env.BRIDGE_DEFAULT_API_KEY;
delete process.env.BRIDGE_PERSONA_TEMPLATE;

let seq = 0;

/** 建一个独立用例目录 + 可选配置 */
async function freshCase(config) {
  const caseDir = join(root, `case-${++seq}`);
  await mkdir(caseDir, { recursive: true });
  const cfgPath = join(caseDir, 'config.json');
  if (config !== undefined) {
    await writeFile(cfgPath, JSON.stringify(config, null, 2), { mode: 0o600 });
  }
  const store = new ConfigStore(cfgPath);
  return { caseDir, cfgPath, store };
}

const mode = async (p) => (await stat(p)).mode & 0o777;

/** 造一条 v2 租户 + 对应凭据 */
async function withTenant(store, cfgPath, entry = {}) {
  seq += 1;
  const id = entry.id ?? `t-case${seq}`;
  const token = `${id.slice(2)}@im.bot:0600secret${seq}`;
  const tenant = { id, ownerId: `u${seq}@im.wechat`, createdAt: '2026-10-27T00:00:00.000Z', ...entry };
  await store.write({ version: 2, tenants: [tenant] });
  await store.secrets.write({ tenants: { [id]: { token } } });
  return { id, token, tenant };
}

// ---------------------------------------------------------------- 空配置

await check('空租户：read 返回 v2 空配置且不创建文件', async () => {
  const { cfgPath, store } = await freshCase();
  const cfg = await store.read();
  assert.strictEqual(cfg.version, 2);
  assert.deepStrictEqual(cfg.tenants, []);
  assert.strictEqual(existsSync(cfgPath), false);
});

await check('写空配置会删除文件（不留空壳）', async () => {
  const { cfgPath, store } = await freshCase();
  await store.write({ tenants: [{ id: 't-x', ownerId: 'u' }] });
  assert.strictEqual(existsSync(cfgPath), true);
  await store.write({ tenants: [] });
  assert.strictEqual(existsSync(cfgPath), false);
});

await check('空租户但带未知顶层字段时保留文件', async () => {
  const { cfgPath, store } = await freshCase();
  await store.write({ tenants: [], futureFlag: true });
  assert.strictEqual(existsSync(cfgPath), true);
  const back = await store.read();
  assert.strictEqual(back.futureFlag, true);
});

// ---------------------------------------------------------------- 只支持 v2

await check('非 v2 文件直接报错，不静默改写', async () => {
  const v1 = { tenants: [{ id: 't-old', token: 'old@im.bot:1', persona: 'x' }] };
  const { cfgPath, store } = await freshCase(v1);
  const before = await readFile(cfgPath, 'utf8');
  await assert.rejects(() => store.read(), /配置版本不兼容/);
  assert.strictEqual(await readFile(cfgPath, 'utf8'), before);
  assert.strictEqual(existsSync(store.secretsPath), false);
});

await check('损坏的 JSON 报错且带文件路径', async () => {
  const { cfgPath, store } = await freshCase();
  await writeFile(cfgPath, '{not json', { mode: 0o600 });
  await assert.rejects(() => store.read(), /不是合法 JSON/);
});

// ---------------------------------------------------------------- 归一化

await check('写盘时剥掉顶层与租户级秘密字段', async () => {
  const { cfgPath, store } = await freshCase();
  await store.write({
    version: 2,
    defaultApiKey: 'sk-default123456',
    token: 'top@im.bot:1',
    tenants: [{ id: 't-x', token: 'a@im.bot:1', apiKey: 'sk-x123456789', persona: 'hi' }],
  });
  const text = await readFile(cfgPath, 'utf8');
  for (const needle of ['token', 'apiKey', 'defaultApiKey', 'persona', 'sk-']) {
    assert.ok(!text.includes(needle), `配置不应包含 ${needle}：\n${text}`);
  }
  const cfg = JSON.parse(text);
  assert.deepStrictEqual(cfg.tenants, [{ id: 't-x' }]);
});

await check('默认 provider / model / baseUrl 不落盘，非默认才留', async () => {
  const { store } = await freshCase();
  await store.write({
    version: 2,
    tenants: [
      { id: 't-a', provider: DEFAULT_PROVIDER, model: DEFAULT_MODEL, baseUrl: DEFAULT_BASE_URL },
      { id: 't-b', provider: 'p2', model: 'm2', baseUrl: 'https://other.example.com' },
    ],
  });
  const cfg = await store.read();
  assert.deepStrictEqual(cfg.tenants[0], { id: 't-a' });
  assert.strictEqual(cfg.tenants[1].provider, 'p2');
  assert.strictEqual(cfg.tenants[1].model, 'm2');
  assert.strictEqual(cfg.tenants[1].baseUrl, 'https://other.example.com');
});

await check('保留未知顶层字段与预留租户字段', async () => {
  const c = normalizeConfig({
    version: 2,
    futureFlag: { a: 1 },
    tenants: [{
      id: 't-x',
      dshHome: '/custom/dsh',
      allowUsers: ['u1', '', 'u2'],
      maxChars: 900,
      ackDelayMs: 5000,
    }],
  });
  assert.deepStrictEqual(c.futureFlag, { a: 1 });
  assert.strictEqual(c.tenants[0].dshHome, '/custom/dsh');
  assert.deepStrictEqual(c.tenants[0].allowUsers, ['u1', 'u2']);
  assert.strictEqual(c.tenants[0].maxChars, 900);
  assert.strictEqual(c.tenants[0].ackDelayMs, 5000);
});

// ---------------------------------------------------------------- 派生

await check('cwd / root / dshHome / botId 均由 id 与 token 派生', async () => {
  const { cfgPath, store } = await freshCase();
  const { id, token } = await withTenant(store, cfgPath);
  const { tenants } = await store.resolveAll();
  const t = tenants[0];
  assert.strictEqual(t.id, id);
  assert.strictEqual(t.botId, botIdFromToken(token));
  assert.strictEqual(t.cwd, join(workspaces, id));
  assert.strictEqual(t.root, tenantRoot(id));
  assert.strictEqual(t.dshHome, tenantDshHome(id));
  assert.strictEqual(t.provider, DEFAULT_PROVIDER);
  assert.strictEqual(t.model, DEFAULT_MODEL);
  assert.strictEqual(t.baseUrl, DEFAULT_BASE_URL);
});

await check('cwdOverride 优先生效', async () => {
  const { cfgPath, store } = await freshCase();
  const { id } = await withTenant(store, cfgPath, { cwdOverride: '/custom/workspace' });
  const cfg = await store.read();
  assert.strictEqual(cfg.tenants[0].cwdOverride, '/custom/workspace');
  assert.strictEqual(tenantWorkspace(id, cfg.tenants[0]), '/custom/workspace');
  const { tenants } = await store.resolveAll();
  assert.strictEqual(tenants[0].cwd, '/custom/workspace');
});

// ---------------------------------------------------------------- 权限与秘密分离

await check('配置文件 / 凭据文件权限 0600，且 persona 原文独立成文件', async () => {
  const { caseDir, cfgPath, store } = await freshCase();
  const { id } = await withTenant(store, cfgPath);
  const personaFile = personaPath(id);
  await mkdir(join(sandbox, id), { recursive: true });
  await store.writePersona(id, '你是「小鹿」。\n第二段。');
  await writeFile(store.secretsPath, JSON.stringify(await store.secrets.read(), null, 2), { mode: 0o600 });

  assert.strictEqual(await mode(cfgPath), 0o600);
  assert.strictEqual(await mode(store.secretsPath), 0o600);
  assert.strictEqual(await mode(personaFile), 0o600);
  assert.strictEqual(await readFile(personaFile, 'utf8'), '你是「小鹿」。\n第二段。');

  const cfgText = await readFile(cfgPath, 'utf8');
  assert.ok(!cfgText.includes('sk-'));
  assert.ok(!cfgText.includes('im.bot:'));
  assert.deepStrictEqual((await readdir(caseDir)).filter((f) => f.includes('.tmp-')), []);
});

await check('persona --clear 删除文件', async () => {
  const { cfgPath, store } = await freshCase();
  const { id } = await withTenant(store, cfgPath);
  await store.writePersona(id, '人设');
  assert.strictEqual(existsSync(personaPath(id)), true);
  await store.writePersona(id, '');
  assert.strictEqual(existsSync(personaPath(id)), false);
});

// ---------------------------------------------------------------- 人设模板

await check('loadPersonaTemplate 读到仓库自带模板', async () => {
  const tpl = await loadPersonaTemplate();
  assert.ok(tpl.path.endsWith('examples/persona.md'), tpl.path);
  assert.ok(tpl.text.length > 100, `模板只有 ${tpl.text.length} 字`);
});

await check('新租户套用模板（0600），已有 persona 不覆盖', async () => {
  const { store } = await freshCase();
  const tpl = await loadPersonaTemplate();
  const path = await applyPersonaTemplate(store, 't-tpl');
  assert.strictEqual(path, personaPath('t-tpl'));
  assert.strictEqual(await mode(path), 0o600);
  assert.strictEqual((await store.readPersona('t-tpl')).trim(), tpl.text);

  await store.writePersona('t-keep', '自定义的人设');
  const kept = await applyPersonaTemplate(store, 't-keep');
  assert.strictEqual(kept, null);
  assert.strictEqual((await store.readPersona('t-keep')).trim(), '自定义的人设');
});

await check('模板文件缺失时静默跳过', async () => {
  const prev = process.env.BRIDGE_PERSONA_TEMPLATE;
  try {
    process.env.BRIDGE_PERSONA_TEMPLATE = join(root, 'no-such-template.md');
    const { store } = await freshCase();
    assert.strictEqual(await applyPersonaTemplate(store, 't-none'), null);
    assert.strictEqual(await store.readPersona('t-none'), '');
  } finally {
    if (prev === undefined) delete process.env.BRIDGE_PERSONA_TEMPLATE;
    else process.env.BRIDGE_PERSONA_TEMPLATE = prev;
  }
});

// ---------------------------------------------------------------- 缺失凭据

await check('secrets 缺失：resolveAll 放进 failures，不拖垮其它租户', async () => {
  const { cfgPath, store } = await freshCase({ version: 2, tenants: [{ id: 't-gone' }] });
  const r = await store.resolveAll();
  assert.strictEqual(r.tenants.length, 0);
  assert.strictEqual(r.failures.length, 1);
  assert.match(r.failures[0].error, /缺少 token/);
});

await check('resolveTenant 缺 token 显式报错', async () => {
  assert.throws(
    () => resolveTenant({ configEntry: { id: 't-x' }, secretEntry: {}, personaText: '' }),
    /缺少 token/,
  );
});

await check('resolveTenant 默认值补全', async () => {
  const t = resolveTenant({
    configEntry: { id: 't-x', ownerId: 'u' },
    secretEntry: { token: 'x@im.bot:0600' },
    personaText: '',
    id: 't-x',
  });
  assert.strictEqual(t.provider, DEFAULT_PROVIDER);
  assert.strictEqual(t.model, DEFAULT_MODEL);
  assert.strictEqual(t.baseUrl, DEFAULT_BASE_URL);
  assert.strictEqual(t.persona, '');
  assert.strictEqual(t.apiKey, undefined);
  assert.strictEqual(t.botId, 'x@im.bot');
});

// ---------------------------------------------------------------- secrets 存储

await check('SecretsStore 全空时删除文件', async () => {
  const dir = join(root, `secrets-${++seq}`);
  await mkdir(dir, { recursive: true });
  const s = new SecretsStore(join(dir, 'secrets.json'));
  await s.write({ tenants: { 't-x': { token: 'a@im.bot:1' } } });
  assert.strictEqual(existsSync(s.path), true);
  assert.strictEqual(await mode(s.path), 0o600);
  await s.write({ tenants: {} });
  assert.strictEqual(existsSync(s.path), false);
});

await check('resolveDefaultApiKey 优先 secrets 文件，环境变量兜底', async () => {
  const prev = process.env.BRIDGE_DEFAULT_API_KEY;
  try {
    process.env.BRIDGE_DEFAULT_API_KEY = 'sk-from-env';
    assert.strictEqual(resolveDefaultApiKey({ defaultApiKey: 'sk-from-file' }), 'sk-from-file');
    assert.strictEqual(resolveDefaultApiKey({}), 'sk-from-env');
  } finally {
    if (prev === undefined) delete process.env.BRIDGE_DEFAULT_API_KEY;
    else process.env.BRIDGE_DEFAULT_API_KEY = prev;
  }
});

await check('read 是纯读：连续两次 read 不改文件', async () => {
  const { cfgPath, store } = await freshCase();
  await withTenant(store, cfgPath);
  const before = await readFile(cfgPath, 'utf8');
  await store.read();
  await store.read();
  assert.strictEqual(await readFile(cfgPath, 'utf8'), before);
});

await check('默认根目录是 ~/.dsh-wechat-link，可用 BRIDGE_HOME 覆盖', async () => {
  const prev = process.env.BRIDGE_HOME;
  try {
    delete process.env.BRIDGE_HOME;
    assert.strictEqual(configDir(), join(root, '.dsh-wechat-link'));
    assert.strictEqual(defaultConfigPath(), join(root, '.dsh-wechat-link', 'config.json'));
    assert.strictEqual(defaultSecretsPath(), join(root, '.dsh-wechat-link', 'secrets.json'));
    assert.strictEqual(setupMarkerPath(), join(root, '.dsh-wechat-link', 'setup.json'));

    process.env.BRIDGE_HOME = join(root, 'custom-home');
    assert.strictEqual(configDir(), join(root, 'custom-home'));
    assert.strictEqual(defaultConfigPath(), join(root, 'custom-home', 'config.json'));
  } finally {
    if (prev === undefined) delete process.env.BRIDGE_HOME;
    else process.env.BRIDGE_HOME = prev;
  }
});

await check('租户数据与工作区默认落在 BRIDGE_HOME 下', async () => {
  const prev = {
    sandbox: process.env.WECHAT_SANDBOX_ROOT,
    ws: process.env.WECHAT_WORKSPACES,
    home: process.env.BRIDGE_HOME,
  };
  try {
    delete process.env.WECHAT_SANDBOX_ROOT;
    delete process.env.WECHAT_WORKSPACES;
    delete process.env.BRIDGE_HOME;
    assert.strictEqual(sandboxRoot(), join(root, '.dsh-wechat-link', 'tenants'));
    assert.strictEqual(workspacesRoot(), join(root, '.dsh-wechat-link', 'workspace'));
  } finally {
    if (prev.sandbox === undefined) delete process.env.WECHAT_SANDBOX_ROOT;
    else process.env.WECHAT_SANDBOX_ROOT = prev.sandbox;
    if (prev.ws === undefined) delete process.env.WECHAT_WORKSPACES;
    else process.env.WECHAT_WORKSPACES = prev.ws;
    if (prev.home === undefined) delete process.env.BRIDGE_HOME;
    else process.env.BRIDGE_HOME = prev.home;
  }
});

await check('新建配置目录权限为 0700', async () => {
  const dir = join(root, 'mode-case', 'link-home');
  const store = new ConfigStore(join(dir, 'config.json'));
  await store.write({ tenants: [{ id: 't-x' }] });
  assert.strictEqual(await mode(dir), 0o700);
  assert.strictEqual(await mode(join(dir, 'config.json')), 0o600);
});

await check('secrets 默认跟随配置文件所在目录', async () => {
  const dir = join(root, `sibling-${++seq}`);
  await mkdir(dir, { recursive: true });
  const store = new ConfigStore(join(dir, 'config.json'));
  assert.strictEqual(store.secretsPath, join(dir, 'secrets.json'));
});

console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
