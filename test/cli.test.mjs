/**
 * CLI 入口测试：spawn `node src/main.mjs ...`，验证 -h / --help / version
 * 与"未知命令不再启动服务"。
 *
 * 单文件 SEA 用的是同一份 argv 解析逻辑，因此这里不构建 118MB 的二进制；
 * SEA 形态的冒烟测试在打包后手动执行 `./build/dsh-wechat-link -h`。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { VERSION } from '../src/version.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ENTRY = join(ROOT, 'src', 'main.mjs');

/** 运行 CLI，失败退出不抛异常，统一返回 { code, stdout, stderr }。 */
function runCli(...args) {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [ENTRY, ...args],
      { cwd: ROOT, timeout: 10_000 },
      (err, stdout, stderr) => {
        const code = err ? (typeof err.code === 'number' ? err.code : 1) : 0;
        resolve({ code, stdout, stderr });
      },
    );
  });
}

test('-h 打印桥接帮助，且带源码运行形态的命令名', async () => {
  const { code, stdout } = await runCli('-h');
  assert.equal(code, 0);
  assert.match(stdout, /DSH × 微信桥接/);
  assert.match(stdout, /node src\/main\.mjs login/);
  assert.match(stdout, /usage <id>/);
  assert.match(stdout, /\/status/);
  assert.match(stdout, /version\s+打印版本/);
});

test('--help 与 -h 输出一致', async () => {
  const [a, b] = await Promise.all([runCli('-h'), runCli('--help')]);
  assert.equal(a.code, 0);
  assert.equal(b.code, 0);
  assert.equal(a.stdout, b.stdout);
});

test('version 的四种写法都输出版本号', async () => {
  for (const flag of ['version', '--version', '-V', '-v']) {
    const { code, stdout } = await runCli(flag);
    assert.equal(code, 0, `${flag} 退出码应为 0`);
    assert.match(stdout, new RegExp(`dsh-wechat-link ${VERSION.replace(/\./g, '\\.')}`));
    assert.match(stdout, /node v\d+\./);
  }
});

test('未知子命令报错退出，不启动常驻服务', async () => {
  const { code, stdout, stderr } = await runCli('nope');
  assert.equal(code, 1);
  assert.equal(stdout, '');
  assert.match(stderr, /未知命令: 「nope」/);
  assert.match(stderr, /-h/);
});

test('未知选项报错退出，不启动常驻服务', async () => {
  const { code, stderr } = await runCli('--nope');
  assert.equal(code, 1);
  assert.match(stderr, /未知命令: --nope/);
});

test('src/version.mjs 与 package.json 版本一致', async () => {
  const pkg = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'));
  assert.equal(VERSION, pkg.version);
});
