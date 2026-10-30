#!/usr/bin/env node
/**
 * 启动依赖检查：必需项失败应阻止启动，可选项缺失只警告。
 */
import assert from 'node:assert';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { runPreflight, formatPreflight } from '../src/ops/preflight.mjs';

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

const root = await mkdtemp(join(tmpdir(), 'preflight-'));
const credentialsFile = join(root, 'dsh-home', '.credentials.yaml');
await mkdir(dirname(credentialsFile), { recursive: true });
await writeFile(credentialsFile, 'api_key: sk-test\n');
const paths = {
  configDir: join(root, 'config', 'link-home'),
  sandboxRoot: join(root, 'link-home', 'tenants'),
  workspacesRoot: join(root, 'link-home', 'workspace'),
  credentialsFile,
  secretsFile: join(root, 'link-home', 'secrets.json'),
};

function fakeExec(overrides = {}) {
  return (cmd, args) => {
    const key = `${cmd} ${args.join(' ')}`;
    if (overrides[key]) return overrides[key];
    if (cmd === 'dsh' && args[0] === '--version') {
      return { ok: true, stdout: '0.2.1-rc.4', stderr: '' };
    }
    if (cmd === 'python3' && args[0] === '--version') {
      return { ok: true, stdout: 'Python 3.11.2', stderr: '' };
    }
    if (cmd === 'python3' && args[0] === '-c' && String(args[1]).includes('matplotlib')) {
      return { ok: true, stdout: '3.6.3', stderr: '' };
    }
    if (cmd === 'python3' && args[0] === '-c') {
      return { ok: true, stdout: '9.4.0', stderr: '' };
    }
    if (cmd === 'pdftotext') {
      return { ok: true, stdout: '', stderr: 'pdftotext version 22.12.0' };
    }
    if (cmd === 'pdftoppm') {
      return { ok: true, stdout: '', stderr: 'pdftoppm version 22.12.0' };
    }
    if (cmd === 'tesseract') {
      return { ok: true, stdout: 'tesseract 5.3.0', stderr: '' };
    }
    if (cmd === 'dot') {
      return { ok: true, stdout: '', stderr: 'dot - graphviz version 7.0.0' };
    }
    if (cmd === 'qrencode') {
      return { ok: true, stdout: 'qrencode version 4.1.1', stderr: '' };
    }
    if (cmd === 'bwrap') {
      return { ok: true, stdout: 'bubblewrap 0.8.0', stderr: '' };
    }
    return { ok: false, stdout: '', stderr: 'not found' };
  };
}

const baseOpts = () => ({ env: { DSH_SANDBOX: '0' }, exec: fakeExec(), paths, nodeVersion: '24.0.0' });

await check('全部依赖齐全 → 通过', async () => {
  const r = await runPreflight(baseOpts());
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.failures.length, 0);
  assert.strictEqual(r.warnings.length, 0);
});

await check('未显式关闭时默认要求 bwrap（默认沙箱）', async () => {
  const r = await runPreflight({
    ...baseOpts(),
    env: {},
    exec: fakeExec({ 'bwrap --version': { ok: false, stdout: '', stderr: 'ENOENT' } }),
  });
  assert.strictEqual(r.ok, false);
  assert.ok(r.failures.some((c) => c.name === 'bubblewrap'));
});

await check('DSH_SANDBOX=0 时不再要求 bwrap', async () => {
  const r = await runPreflight({ ...baseOpts(), env: { DSH_SANDBOX: '0' } });
  assert.strictEqual(r.ok, true);
  assert.ok(r.checks.some((c) => c.name === 'bubblewrap' && c.status === 'ok'));
});

await check('沙箱工具链解析失败 → 失败', async () => {
  const r = await runPreflight({
    ...baseOpts(),
    env: { DSH_SANDBOX: '1' },
    sandboxError: new Error('找不到 dsh 的 bin.js'),
  });
  assert.strictEqual(r.ok, false);
  assert.ok(r.failures.some((c) => c.name === '沙箱工具链'));
});

await check('缺 dsh → 失败（必需）', async () => {
  const r = await runPreflight({
    ...baseOpts(),
    exec: fakeExec({ 'dsh --version': { ok: false, stdout: '', stderr: 'ENOENT' } }),
  });
  assert.strictEqual(r.ok, false);
  assert.ok(r.failures.some((c) => c.name === 'DSH'));
});

await check('DSH_JS_PATH 存在时走 node bin.js', async () => {
  let called = null;
  const r = await runPreflight({
    ...baseOpts(),
    env: { DSH_SANDBOX: '0', DSH_JS_PATH: '/opt/dsh/bin.js' },
    exec: (cmd, args) => {
      if (args[0] === '/opt/dsh/bin.js') called = { cmd, args };
      if (cmd === 'dsh' || args[0] === '/opt/dsh/bin.js') {
        return { ok: true, stdout: '0.2.1-rc.4', stderr: '' };
      }
      return fakeExec()(cmd, args);
    },
  });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(called.args[0], '/opt/dsh/bin.js');
});

await check('SEA 单文件忽略 DSH_JS_PATH，改用 PATH 里的 dsh', async () => {
  const cmds = [];
  const r = await runPreflight({
    ...baseOpts(),
    isSea: true,
    env: { DSH_SANDBOX: '0', DSH_JS_PATH: '/opt/dsh/bin.js' },
    exec: (cmd, args) => {
      cmds.push(cmd);
      if (cmd === 'dsh') return { ok: true, stdout: '0.2.1-rc.4', stderr: '' };
      return fakeExec()(cmd, args);
    },
  });
  assert.strictEqual(r.ok, true);
  assert.ok(cmds.includes('dsh'));
  assert.ok(!cmds.includes(process.execPath), 'SEA 下不应拿自己当 node 执行 dsh/bin.js');
});

await check('dsh 版本过低 → 失败（sdk profile 需要 >= 0.2.0）', async () => {
  const r = await runPreflight({
    ...baseOpts(),
    exec: fakeExec({ 'dsh --version': { ok: true, stdout: '0.1.9', stderr: '' } }),
  });
  assert.strictEqual(r.ok, false);
  assert.ok(r.failures.some((c) => c.name === 'DSH 版本'));
});

await check('dsh 版本无法解析 → 警告但不阻止启动', async () => {
  const r = await runPreflight({
    ...baseOpts(),
    exec: fakeExec({ 'dsh --version': { ok: true, stdout: 'dev-build', stderr: '' } }),
  });
  assert.strictEqual(r.ok, true);
  assert.ok(r.warnings.some((c) => c.name === 'DSH 版本'));
});

await check('缺宿主凭据且无预设 key → 警告但不阻止启动', async () => {
  const r = await runPreflight({
    ...baseOpts(),
    paths: {
      ...paths,
      credentialsFile: join(root, 'missing', '.credentials.yaml'),
      secretsFile: join(root, 'missing', 'secrets.json'),
    },
  });
  assert.strictEqual(r.ok, true);
  assert.ok(r.warnings.some((c) => c.name === 'DSH 凭据'));
});

await check('BRIDGE_DEFAULT_API_KEY 视为凭据已配置', async () => {
  const r = await runPreflight({
    ...baseOpts(),
    env: { DSH_SANDBOX: '0', BRIDGE_DEFAULT_API_KEY: 'sk-test' },
    paths: {
      ...paths,
      credentialsFile: join(root, 'missing', '.credentials.yaml'),
      secretsFile: join(root, 'missing', 'secrets.json'),
    },
  });
  assert.ok(!r.warnings.some((c) => c.name === 'DSH 凭据'));
});

await check('secrets.json 的 defaultApiKey 视为凭据已配置', async () => {
  const secrets = join(root, 'with-key', 'secrets.json');
  await mkdir(dirname(secrets), { recursive: true });
  await writeFile(secrets, JSON.stringify({ version: 1, defaultApiKey: 'sk-test', tenants: {} }));
  const r = await runPreflight({
    ...baseOpts(),
    paths: {
      ...paths,
      credentialsFile: join(root, 'missing', '.credentials.yaml'),
      secretsFile: secrets,
    },
  });
  assert.ok(!r.warnings.some((c) => c.name === 'DSH 凭据'));
});


await check('Node 版本过低 → 失败', async () => {
  const r = await runPreflight({ ...baseOpts(), nodeVersion: '20.11.0' });
  assert.strictEqual(r.ok, false);
  assert.ok(r.failures.some((c) => c.name === 'Node.js'));
});

await check('缺 Python → 警告但不阻止启动', async () => {
  const r = await runPreflight({
    ...baseOpts(),
    exec: fakeExec({ 'python3 --version': { ok: false, stdout: '', stderr: 'ENOENT' } }),
  });
  assert.strictEqual(r.ok, true);
  assert.ok(r.warnings.some((c) => c.name === 'Python 3'));
  assert.ok(r.warnings.some((c) => c.name === 'Pillow'));
});

await check('缺 Pillow → 警告但不阻止启动', async () => {
  const r = await runPreflight({
    ...baseOpts(),
    exec: fakeExec({
      'python3 -c import PIL; print(PIL.__version__)': { ok: false, stdout: '', stderr: 'No module named PIL' },
    }),
  });
  assert.strictEqual(r.ok, true);
  assert.ok(r.warnings.some((c) => c.name === 'Pillow'));
});

await check('缺 pdftotext → 警告', async () => {
  const r = await runPreflight({
    ...baseOpts(),
    exec: fakeExec({ 'pdftotext -v': { ok: false, stdout: '', stderr: 'ENOENT' } }),
  });
  assert.strictEqual(r.ok, true);
  assert.ok(r.warnings.some((c) => c.name === 'pdftotext'));
});

await check('缺 OCR / 图表工具 → 警告但不阻止启动', async () => {
  const r = await runPreflight({
    ...baseOpts(),
    exec: fakeExec({
      'pdftoppm -v': { ok: false, stdout: '', stderr: 'ENOENT' },
      'tesseract --version': { ok: false, stdout: '', stderr: 'ENOENT' },
      'python3 -c import matplotlib; print(matplotlib.__version__)': {
        ok: false, stdout: '', stderr: 'No module named matplotlib',
      },
      'dot -V': { ok: false, stdout: '', stderr: 'ENOENT' },
      'qrencode -V': { ok: false, stdout: '', stderr: 'ENOENT' },
    }),
  });
  assert.strictEqual(r.ok, true);
  for (const name of ['pdftoppm', 'tesseract', 'matplotlib', 'graphviz', 'qrencode']) {
    assert.ok(r.warnings.some((c) => c.name === name), `应警告缺少 ${name}`);
  }
});

await check('裸机沙箱模式缺 bwrap → 失败', async () => {
  const r = await runPreflight({
    ...baseOpts(),
    env: { DSH_SANDBOX: '1' },
    exec: fakeExec({ 'bwrap --version': { ok: false, stdout: '', stderr: 'ENOENT' } }),
  });
  assert.strictEqual(r.ok, false);
  assert.ok(r.failures.some((c) => c.name === 'bubblewrap'));
});

await check('容器模式不要求 bwrap', async () => {
  const r = await runPreflight({
    ...baseOpts(),
    env: { DSH_SANDBOX: '1', BRIDGE_DSH_MODE: 'container' },
    exec: fakeExec({ 'bwrap --version': { ok: false, stdout: '', stderr: 'ENOENT' } }),
  });
  assert.strictEqual(r.ok, true);
});

await check('目录不可写 → 失败', async () => {
  const file = join(root, 'not-a-dir');
  await writeFile(file, 'x');
  const r = await runPreflight({
    ...baseOpts(),
    paths: { ...paths, configDir: file },
  });
  assert.strictEqual(r.ok, false);
  assert.ok(r.failures.some((c) => c.name === '配置目录'));
});

await check('报告包含图标和结论', async () => {
  const r = await runPreflight(baseOpts());
  const text = formatPreflight(r);
  assert.match(text, /启动前依赖检查/);
  assert.match(text, /✅ DSH/);
  assert.match(text, /依赖检查通过/);

  const bad = await runPreflight({
    ...baseOpts(),
    nodeVersion: '18.0.0',
  });
  const badText = formatPreflight(bad);
  assert.match(badText, /❌ Node\.js/);
  assert.match(badText, /启动中止/);
});

await check('readOnly（--check）不创建目录', async () => {
  const roRoot = join(root, 'readonly');
  const roPaths = {
    configDir: join(roRoot, 'config'),
    sandboxRoot: join(roRoot, 'tenants'),
    workspacesRoot: join(roRoot, 'workspace'),
    credentialsFile,
    secretsFile: join(root, 'missing', 'secrets.json'),
  };
  const r = await runPreflight({ ...baseOpts(), paths: roPaths, readOnly: true });
  assert.strictEqual(r.ok, true);
  for (const dir of [roPaths.configDir, roPaths.sandboxRoot, roPaths.workspacesRoot]) {
    await assert.rejects(access(dir), `只读检查不应创建 ${dir}`);
  }
});

await rm(root, { recursive: true, force: true });

console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
