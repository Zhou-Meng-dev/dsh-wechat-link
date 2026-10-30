#!/usr/bin/env node
/**
 * 每租户 API key / 掩码 / 指纹 / 配置写入规则的单元测试。
 *
 * 掩码与指纹的实现位于 src/config.mjs，这里直接 import，
 * 避免测试与实现分叉。
 */
import assert from 'node:assert';
import { buildSandboxArgv } from '../src/sandbox/sandbox.mjs';
import {
  buildTenantDef, normalizeConfig, maskKey, apiKeyFingerprint,
  resolveDefaultApiKey, botIdFromToken, tenantIdFrom, tenantWorkspace,
  DEFAULT_PROVIDER, DEFAULT_MODEL, DEFAULT_BASE_URL,
} from '../src/config.mjs';

let pass = 0;
let fail = 0;
function check(desc, fn) {
  try {
    fn();
    console.log(`✅ ${desc}`);
    pass++;
  } catch (err) {
    console.log(`❌ ${desc}\n   ${err.message}`);
    fail++;
  }
}

// ---------------------------------------------------------------- 掩码

check('掩码不泄露中间部分', () => {
  const k = 'sk-abcdefghijklmnopqrstuvwxyz';
  const m = maskKey(k);
  assert.strictEqual(m, 'sk-****wxyz');
  assert.ok(!m.includes('abcdefghij'));
});

check('短 key 全部掩码', () => {
  assert.strictEqual(maskKey('sk-short'), '****');
});

check('空 key 显示未设置', () => {
  assert.strictEqual(maskKey(''), '(未设置)');
  assert.strictEqual(maskKey(undefined), '(未设置)');
});

// ---------------------------------------------------------------- 指纹

check('不同 key 指纹不同', () => {
  assert.notStrictEqual(apiKeyFingerprint('sk-aaaa'), apiKeyFingerprint('sk-bbbb'));
});

check('相同 key 指纹相同', () => {
  assert.strictEqual(apiKeyFingerprint('sk-same'), apiKeyFingerprint('sk-same'));
});

check('空 key 指纹为空（用于判定"未配置"）', () => {
  assert.strictEqual(apiKeyFingerprint(''), '');
  assert.strictEqual(apiKeyFingerprint(undefined), '');
});

check('指纹长度固定 12，不泄露明文', () => {
  const f = apiKeyFingerprint('sk-verylongsecretkeyvalue123456');
  assert.strictEqual(f.length, 12);
  assert.ok(!f.includes('secret'));
});

// ---------------------------------------------------------------- 沙箱 envVars 注入

check('envVars 生成 --setenv 参数', () => {
  const argv = buildSandboxArgv({
    cwd: '/tmp/ws',
    dshHome: '/tmp/dh',
    homeDir: '/home/test',
    voltaRoot: '/opt/volta',
    nodeBin: '/opt/node',
    dshJs: '/opt/dsh/bin.js',
    dshArgs: ['--profile', 'sdk'],
    envVars: { DEEPSEEK_API_KEY: 'sk-test-123' },
  });
  const i = argv.indexOf('DEEPSEEK_API_KEY');
  assert.ok(i > 0, '应包含 DEEPSEEK_API_KEY');
  assert.strictEqual(argv[i - 1], '--setenv');
  assert.strictEqual(argv[i + 1], 'sk-test-123');
});

check('无 envVars 时不含 --setenv 的 key 注入', () => {
  const argv = buildSandboxArgv({
    cwd: '/tmp/ws',
    dshHome: '/tmp/dh',
    homeDir: '/home/test',
    voltaRoot: '/opt/volta',
    nodeBin: '/opt/node',
    dshJs: '/opt/dsh/bin.js',
    dshArgs: ['--profile', 'sdk'],
  });
  assert.strictEqual(argv.includes('DEEPSEEK_API_KEY'), false);
});

check('envVars 在命令之前注入（bwrap 参数顺序正确）', () => {
  const argv = buildSandboxArgv({
    cwd: '/tmp/ws',
    dshHome: '/tmp/dh',
    homeDir: '/home/test',
    voltaRoot: '/opt/volta',
    nodeBin: '/tmp/node',
    dshJs: '/tmp/dsh.js',
    dshArgs: [],
    envVars: { DEEPSEEK_API_KEY: 'k' },
  });
  const envIdx = argv.indexOf('DEEPSEEK_API_KEY');
  const cmdIdx = argv.indexOf('/tmp/node');
  assert.ok(envIdx < cmdIdx, 'env 必须在最终命令之前');
});

// ---------------------------------------------------------------- 派生

check('botIdFromToken 只取第一个冒号前的部分', () => {
  assert.strictEqual(botIdFromToken('ef0cfbe30d30@im.bot:0600abcdef'), 'ef0cfbe30d30@im.bot');
  assert.strictEqual(botIdFromToken('ef0cfbe30d30@im.bot'), 'ef0cfbe30d30@im.bot');
  assert.strictEqual(botIdFromToken(undefined), '');
});

check('tenantIdFrom 与 botId 一致', () => {
  assert.strictEqual(tenantIdFrom('ef0cfbe30d30@im.bot'), 't-ef0cfbe30d30');
  assert.strictEqual(tenantIdFrom('ef0cfbe30d30@im.bot:0600xyz'), 't-ef0cfbe30d30');
});

// ---------------------------------------------------------------- 预设 key 继承

const fakeLogin = {
  token: 'abcd1234@im.bot:secret',
  baseUrl: DEFAULT_BASE_URL,
  botId: 'abcd1234@im.bot',
  ownerId: 'u123@im.wechat',
};

check('有预设 key → 新租户 secret 自动继承', () => {
  const { config, secret } = buildTenantDef(fakeLogin, { defaultApiKey: 'sk-preset123456789' });
  assert.strictEqual(secret.apiKey, 'sk-preset123456789');
  assert.strictEqual(secret.token, fakeLogin.token);
  assert.strictEqual(config.id, 't-abcd1234');
  assert.strictEqual(config.ownerId, 'u123@im.wechat');
});

check('无预设 key → 新租户 secret 不带 apiKey（回退宿主凭据）', () => {
  const { secret } = buildTenantDef(fakeLogin, {});
  assert.strictEqual(secret.apiKey, undefined);
  assert.strictEqual('apiKey' in secret, false);
});

check('预设 key 首尾空白被裁掉', () => {
  const { secret } = buildTenantDef(fakeLogin, { defaultApiKey: '  sk-x123456789  ' });
  assert.strictEqual(secret.apiKey, 'sk-x123456789');
});

check('空白预设 key 视为未设置', () => {
  const { secret } = buildTenantDef(fakeLogin, { defaultApiKey: '   ' });
  assert.strictEqual('apiKey' in secret, false);
});

check('配置里不含 token / apiKey / persona', () => {
  const { config } = buildTenantDef(fakeLogin, { defaultApiKey: 'sk-x123456789' });
  assert.deepStrictEqual(Object.keys(config).sort(), ['createdAt', 'id', 'ownerId']);
});

check('默认 provider / model / baseUrl 不写进配置', () => {
  const { config } = buildTenantDef(fakeLogin, {
    provider: DEFAULT_PROVIDER,
    model: DEFAULT_MODEL,
  });
  assert.strictEqual('provider' in config, false);
  assert.strictEqual('model' in config, false);
  assert.strictEqual('baseUrl' in config, false);
});

check('非默认 provider / model / baseUrl 才写', () => {
  const { config } = buildTenantDef(
    { ...fakeLogin, baseUrl: 'https://other.example.com/' },
    { provider: 'custom-provider', model: 'custom-model' },
  );
  assert.strictEqual(config.provider, 'custom-provider');
  assert.strictEqual(config.model, 'custom-model');
  assert.strictEqual(config.baseUrl, 'https://other.example.com/');
});

check('login --cwd 等于派生值时不写 cwdOverride，不同才写', () => {
  const derived = tenantWorkspace('t-abcd1234');
  const same = buildTenantDef(fakeLogin, { cwdOverride: derived }).config;
  assert.strictEqual('cwdOverride' in same, false);
  const custom = buildTenantDef(fakeLogin, { cwdOverride: '/custom/workspace' }).config;
  assert.strictEqual(custom.cwdOverride, '/custom/workspace');
});

// ---------------------------------------------------------------- normalizeConfig

check('normalizeConfig 保留未知顶层字段（写回不丢）', () => {
  const c = normalizeConfig({ foo: 'bar', future: { a: 1 }, tenants: [] });
  assert.strictEqual(c.foo, 'bar');
  assert.deepStrictEqual(c.future, { a: 1 });
  assert.strictEqual(c.version, 2);
});

check('normalizeConfig 不再保留 defaultApiKey（属于 secrets）', () => {
  const c = normalizeConfig({ version: 2, defaultApiKey: 'sk-d', tenants: [{ id: 't-x' }] });
  assert.strictEqual('defaultApiKey' in c, false);
  assert.strictEqual(c.tenants.length, 1);
});

check('normalizeConfig 剥掉租户级 token / apiKey / persona', () => {
  const c = normalizeConfig({
    version: 2,
    tenants: [{ id: 't-abcd', token: 'abcd@im.bot:x', apiKey: 'sk-x', persona: 'hi' }],
  });
  assert.deepStrictEqual(c.tenants[0], { id: 't-abcd' });
});

check('normalizeConfig 丢弃等于默认值的 provider / model / baseUrl', () => {
  const c = normalizeConfig({
    tenants: [{
      id: 't-x', provider: DEFAULT_PROVIDER, model: DEFAULT_MODEL, baseUrl: DEFAULT_BASE_URL,
    }],
  });
  assert.deepStrictEqual(c.tenants[0], { id: 't-x' });
});

check('normalizeConfig 保留非默认 model', () => {
  const c = normalizeConfig({ tenants: [{ id: 't-x', model: 'deepseek-v4-pro' }] });
  assert.strictEqual(c.tenants[0].model, 'deepseek-v4-pro');
});

check('normalizeConfig 保留预留项（dshHome / allowUsers / maxChars / ackDelayMs）', () => {
  const c = normalizeConfig({
    tenants: [{
      id: 't-x',
      dshHome: '/custom/dsh',
      allowUsers: ['u1', '', 'u2'],
      maxChars: 900,
      ackDelayMs: 5000,
    }],
  });
  assert.strictEqual(c.tenants[0].dshHome, '/custom/dsh');
  assert.deepStrictEqual(c.tenants[0].allowUsers, ['u1', 'u2']);
  assert.strictEqual(c.tenants[0].maxChars, 900);
  assert.strictEqual(c.tenants[0].ackDelayMs, 5000);
});

// ---------------------------------------------------------------- 预设 key 来源

check('resolveDefaultApiKey 优先 secrets 文件，环境变量兜底', () => {
  const prev = process.env.BRIDGE_DEFAULT_API_KEY;
  try {
    process.env.BRIDGE_DEFAULT_API_KEY = 'sk-from-env';
    assert.strictEqual(resolveDefaultApiKey({ defaultApiKey: 'sk-from-file' }), 'sk-from-file');
    assert.strictEqual(resolveDefaultApiKey({}), 'sk-from-env');
    delete process.env.BRIDGE_DEFAULT_API_KEY;
    assert.strictEqual(resolveDefaultApiKey({}), '');
  } finally {
    if (prev === undefined) delete process.env.BRIDGE_DEFAULT_API_KEY;
    else process.env.BRIDGE_DEFAULT_API_KEY = prev;
  }
});

console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
