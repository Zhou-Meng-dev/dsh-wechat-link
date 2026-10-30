/**
 * 沙箱参数顺序回归：bwrap 按顺序应用挂载，后写的覆盖先写的。
 *
 * 真实事故：`--bind cwd` 在前、`--tmpfs /tmp` 在后，当 BRIDGE_HOME 位于
 * /tmp 下时，工作目录先被 bind 进沙箱、又被 tmpfs 盖掉，dsh 启动报
 * `bwrap: Can't chdir to /tmp/...: No such file or directory`。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildSandboxArgv } from '../src/sandbox/sandbox.mjs';

function baseOpts() {
  return {
    cwd: '/tmp/ws',
    dshHome: '/tmp/dh',
    homeDir: '/home/test',
    voltaRoot: '/opt/volta',
    nodeBin: '/opt/node',
    dshJs: '/opt/dsh/bin.js',
    dshArgs: ['--profile', 'sdk'],
  };
}

/** 找到 `--flag value` 的起始下标 */
function flagIndex(argv, flag, value) {
  for (let i = 0; i < argv.length - 1; i += 1) {
    if (argv[i] === flag && argv[i + 1] === value) return i;
  }
  return -1;
}

/** 找到 `--bind src dst` 的起始下标 */
function bindIndex(argv, src, dst) {
  for (let i = 0; i < argv.length - 2; i += 1) {
    if (argv[i] === '--bind' && argv[i + 1] === src && argv[i + 2] === dst) return i;
  }
  return -1;
}

test('/tmp 的 tmpfs 必须早于 cwd 的 bind（否则工作目录会被盖掉）', () => {
  const argv = buildSandboxArgv(baseOpts());
  const tmpfsTmp = flagIndex(argv, '--tmpfs', '/tmp');
  const bindCwd = bindIndex(argv, '/tmp/ws', '/tmp/ws');

  assert.ok(tmpfsTmp >= 0, '应包含 --tmpfs /tmp');
  assert.ok(bindCwd >= 0, '应 bind 工作目录');
  assert.ok(tmpfsTmp < bindCwd, `--tmpfs /tmp (${tmpfsTmp}) 必须在 bind cwd (${bindCwd}) 之前`);
});

test('/tmp 的 tmpfs 必须早于 dsh-home 的 bind', () => {
  const argv = buildSandboxArgv(baseOpts());
  const tmpfsTmp = flagIndex(argv, '--tmpfs', '/tmp');
  const bindHome = bindIndex(argv, '/tmp/dh', '/home/test/.dsh');

  assert.ok(bindHome >= 0, '应 bind dsh-home');
  assert.ok(tmpfsTmp < bindHome, 'dsh-home 的 bind 不能被 /tmp tmpfs 覆盖');
});

test('先遮住家目录，再 bind dsh-home 与工作目录', () => {
  const argv = buildSandboxArgv(baseOpts());
  const tmpfsHome = flagIndex(argv, '--tmpfs', '/home/test');
  const bindHome = bindIndex(argv, '/tmp/dh', '/home/test/.dsh');

  assert.ok(tmpfsHome >= 0 && bindHome >= 0);
  assert.ok(tmpfsHome < bindHome, '家目录 tmpfs 必须先于 dsh-home bind');
});
