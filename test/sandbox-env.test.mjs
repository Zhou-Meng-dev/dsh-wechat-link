/**
 * 默认沙箱配置解析：直接运行与 SEA 都应默认解析出 bwrap 工具链。
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { sandboxMode, resolveSandbox, applySandboxEnv } from '../src/sandbox/sandbox-env.mjs';

let root;
let nodeBin;
let dshJs;
let tools;
let home;

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'sandbox-env-'));
  tools = join(root, 'tools');
  home = join(root, 'home');
  nodeBin = join(tools, 'node', 'bin', 'node');
  dshJs = join(tools, 'dsh', 'lib', 'bin.js');
  await mkdir(join(tools, 'node', 'bin'), { recursive: true });
  await mkdir(join(tools, 'dsh', 'lib'), { recursive: true });
  await mkdir(join(home, '.dsh'), { recursive: true });
  await writeFile(nodeBin, '#!/bin/sh\n', { mode: 0o755 });
  await writeFile(dshJs, '// fake dsh\n');
  await writeFile(join(home, '.dsh', '.credentials.yaml'), 'api_key: sk-test\n');
});

after(async () => {
  await rm(root, { recursive: true, force: true });
});

function baseEnv(extra = {}) {
  return {
    HOME: home,
    PATH: '',
    WECHAT_NODE_BIN: nodeBin,
    WECHAT_DSH_JS: dshJs,
    WECHAT_TOOL_ROOT: tools,
    SANDBOX_HOME: home,
    ...extra,
  };
}

test('默认是 bwrap；DSH_SANDBOX=0 关闭；container 优先', () => {
  assert.equal(sandboxMode({}), 'bwrap');
  assert.equal(sandboxMode({ DSH_SANDBOX: '1' }), 'bwrap');
  assert.equal(sandboxMode({ DSH_SANDBOX: '0' }), 'off');
  assert.equal(sandboxMode({ DSH_SANDBOX: 'false' }), 'off');
  assert.equal(sandboxMode({ BRIDGE_DSH_MODE: 'container' }), 'container');
  assert.equal(sandboxMode({ BRIDGE_DSH_MODE: 'container', DSH_SANDBOX: '1' }), 'container');
});

test('显式工具链：解析出沙箱内路径', async () => {
  const sandbox = await resolveSandbox({ env: baseEnv(), isSea: true });
  const realTools = await realpath(tools);

  assert.equal(sandbox.mode, 'bwrap');
  assert.equal(sandbox.toolRoot, realTools);
  assert.equal(sandbox.sandboxNode, '/opt/volta/node/bin/node');
  assert.equal(sandbox.sandboxDshJs, '/opt/volta/dsh/lib/bin.js');
  assert.equal(sandbox.homeDir, home);
  assert.equal(sandbox.credSource, join(home, '.dsh', '.credentials.yaml'));
});

test('applySandboxEnv 写回 Tenant / preflight 读取的变量', async () => {
  const env = baseEnv();
  const sandbox = await resolveSandbox({ env, isSea: true });
  applySandboxEnv(sandbox, env);

  assert.equal(env.DSH_SANDBOX, '1');
  assert.equal(env.VOLTA_ROOT, sandbox.toolRoot);
  assert.equal(env.SANDBOX_NODE, '/opt/volta/node/bin/node');
  assert.equal(env.SANDBOX_DSH_JS, '/opt/volta/dsh/lib/bin.js');
  assert.equal(env.SANDBOX_HOME, home);
  assert.equal(env.CRED_SOURCE, join(home, '.dsh', '.credentials.yaml'));
  assert.equal(env.WECHAT_NODE_BIN, nodeBin);
  assert.equal(env.WECHAT_DSH_JS, dshJs);
});

test('DSH_SANDBOX=0 / 容器模式：不解析工具链', async () => {
  const off = await resolveSandbox({ env: { DSH_SANDBOX: '0' } });
  assert.deepEqual(off, { mode: 'off' });

  const env = { DSH_SANDBOX: '0', BRIDGE_DSH_MODE: 'container' };
  const container = await resolveSandbox({ env });
  assert.deepEqual(container, { mode: 'container' });
  applySandboxEnv(container, env);
  assert.equal(env.DSH_SANDBOX, '0');
  assert.equal(env.BRIDGE_DSH_MODE, 'container');
});

test('沿用 sandbox.sh 已算好的 SANDBOX_* 变量', async () => {
  const env = {
    SANDBOX_NODE: '/opt/volta/tools/node/bin/node',
    SANDBOX_DSH_JS: '/opt/volta/tools/dsh/lib/bin.js',
    VOLTA_ROOT: tools,
    WECHAT_NODE_BIN: nodeBin,
    WECHAT_DSH_JS: dshJs,
    SANDBOX_HOME: home,
    CRED_SOURCE: join(home, '.dsh', '.credentials.yaml'),
  };
  const sandbox = await resolveSandbox({ env, isSea: true });
  assert.equal(sandbox.reused, true);
  assert.equal(sandbox.sandboxNode, '/opt/volta/tools/node/bin/node');
  assert.equal(sandbox.sandboxDshJs, '/opt/volta/tools/dsh/lib/bin.js');
});

test('工具根是家目录祖先时拒绝（避免把 ~/.ssh 挂进沙箱）', async () => {
  await assert.rejects(
    resolveSandbox({
      env: baseEnv({ WECHAT_TOOL_ROOT: root }),
      isSea: true,
    }),
    /家目录或其祖先/,
  );
});

test('找不到 dsh bin.js 时报可操作错误', async () => {
  await assert.rejects(
    resolveSandbox({
      env: baseEnv({ WECHAT_DSH_JS: join(root, 'missing', 'bin.js') }),
      isSea: true,
    }),
    /WECHAT_DSH_JS/,
  );
});
