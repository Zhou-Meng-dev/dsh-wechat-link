#!/usr/bin/env node
/**
 * 语法门禁：对仓库内所有 .mjs 跑 `node --check`。
 *
 * 为什么不用 ESLint：本项目零运行时依赖，刻意不引入一套需要联网安装、
 * 还要维护配置的 lint 工具链。语法错误是最低成本的防线，先把它锁死；
 * 风格与设计约束写在 CONTRIBUTING.md / GOVERNANCE.md 里，由 review 把关。
 *
 * 用法：npm run lint
 */

import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DIRS = ['src', 'bin', 'test', 'scripts'];

/** 递归收集目录下的 .mjs（跳过 node_modules / build） */
function collect(dir, out) {
  let entries;
  try {
    entries = readdirSync(join(ROOT, dir), { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === 'build') continue;
    const rel = join(dir, entry.name);
    if (entry.isDirectory()) collect(rel, out);
    else if (entry.isFile() && entry.name.endsWith('.mjs')) out.push(rel);
  }
}

const files = [];
for (const dir of DIRS) collect(dir, files);
files.sort();

let failed = 0;
for (const file of files) {
  const res = spawnSync(process.execPath, ['--check', file], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  if (res.status !== 0) {
    failed += 1;
    process.stderr.write(`❌ ${file}\n${res.stderr ?? res.error?.message ?? ''}\n`);
  }
}

if (failed > 0) {
  console.error(`\n❌ ${failed}/${files.length} 个文件语法检查失败`);
  process.exit(1);
}

console.log(`✅ 语法检查通过：${files.length} 个 .mjs 文件`);
