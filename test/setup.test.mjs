/**
 * 首次配置向导测试：key 校验、触发条件、落盘结果。
 *
 * 用 BRIDGE_HOME 把根目录指到临时目录；input 用可读流模拟管道输入，
 * 不会碰真实配置，也不依赖 TTY。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, PassThrough } from 'node:stream';

import { ConfigStore } from '../src/config.mjs';
import { validateApiKey, shouldRunSetup, runSetup } from '../src/ops/setup.mjs';

async function freshRoot(tag) {
  const root = await mkdtemp(join(tmpdir(), `wechat-setup-${tag}-`));
  process.env.BRIDGE_HOME = root;
  return { root, store: new ConfigStore(join(root, 'config.json')) };
}

/** 跑一次向导，返回输出文本。 */
async function run(root, store, lines) {
  const input = Readable.from(lines);
  const output = new PassThrough();
  let text = '';
  output.on('data', (d) => { text += d.toString(); });
  const result = await runSetup({
    store,
    input,
    output,
    tty: false,
    warn: (m) => { text += `${m}\n`; },
  });
  return { ...result, text };
}

test('validateApiKey 接受 sk- 开头且足够长的 key', () => {
  assert.equal(validateApiKey('sk-abcdefghi12345678'), true);
  assert.equal(validateApiKey('  sk-abcdefghi12345678  '), true);
  assert.equal(validateApiKey('sk-short'), false);
  assert.equal(validateApiKey('ak-abcdefghi12345678'), false);
  assert.equal(validateApiKey(''), false);
});

test('shouldRunSetup 只在“首次 + 交互终端 + 无 key”时触发', () => {
  const base = { markerExists: false, tenantCount: 0, hasApiKey: false, isTTY: true };
  assert.equal(shouldRunSetup(base), true);
  assert.equal(shouldRunSetup({ ...base, skip: true }), false);
  assert.equal(shouldRunSetup({ ...base, isTTY: false }), false);
  assert.equal(shouldRunSetup({ ...base, markerExists: true }), false);
  assert.equal(shouldRunSetup({ ...base, hasApiKey: true }), false);
  assert.equal(shouldRunSetup({ ...base, tenantCount: 1 }), false);
});

test('填了 key：写入 secrets.json，并留下 setup.json', async () => {
  const { root, store } = await freshRoot('key');
  const { ran, apiKeySet, text } = await run(root, store, ['sk-test123456789\n']);

  assert.equal(ran, true);
  assert.equal(apiKeySet, true);
  assert.match(text, /已写入 secrets\.json/);

  const secrets = JSON.parse(await readFile(join(root, 'secrets.json'), 'utf8'));
  assert.equal(secrets.defaultApiKey, 'sk-test123456789');

  const marker = JSON.parse(await readFile(join(root, 'setup.json'), 'utf8'));
  assert.equal(marker.version, 1);
  assert.equal(marker.apiKeySet, true);
});

test('直接回车：跳过并写标记，不创建 secrets.json', async () => {
  const { root, store } = await freshRoot('skip');
  const { ran, apiKeySet, text } = await run(root, store, ['\n']);

  assert.equal(ran, true);
  assert.equal(apiKeySet, false);
  assert.match(text, /未设置 API key/);
  assert.equal(existsSync(join(root, 'secrets.json')), false);
  assert.equal(existsSync(join(root, 'setup.json')), true);
});

test('格式错误会重问，第二次填对后生效', async () => {
  const { root, store } = await freshRoot('retry');
  const { apiKeySet, text } = await run(root, store, ['not-a-key\nsk-good123456789\n']);

  assert.equal(apiKeySet, true);
  assert.match(text, /应以 sk- 开头/);
  const secrets = JSON.parse(await readFile(join(root, 'secrets.json'), 'utf8'));
  assert.equal(secrets.defaultApiKey, 'sk-good123456789');
});

test('重跑时回车保留现有 key', async () => {
  const { root, store } = await freshRoot('keep');
  await store.secrets.write({ defaultApiKey: 'sk-existing123456' });
  const { apiKeySet, text } = await run(root, store, ['\n']);

  assert.equal(apiKeySet, true);
  assert.match(text, /保留现有 API key/);
  const secrets = JSON.parse(await readFile(join(root, 'secrets.json'), 'utf8'));
  assert.equal(secrets.defaultApiKey, 'sk-existing123456');
});

test('已有 setup.json 时非强制调用不再询问', async () => {
  const { root, store } = await freshRoot('marker');
  await run(root, store, ['\n']);
  const again = await runSetup({
    store,
    input: Readable.from([]),
    output: new PassThrough(),
    tty: false,
  });
  assert.deepEqual(again, { ran: false, apiKeySet: false });
  // 根目录里的标记仍然存在
  assert.equal(existsSync(join(root, 'setup.json')), true);
  await mkdir(join(root, 'workspace'), { recursive: true }); // 目录布局与真实环境一致
});
