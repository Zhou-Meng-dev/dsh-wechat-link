#!/usr/bin/env node
/**
 * 把桥接打包成 Linux 单文件 ELF（Node SEA）。
 *
 * 产物：build/dsh-wechat-link
 * 依赖：构建机需要 Node >= 24、npm install（esbuild/postject）
 *
 * 注意：单文件只包含桥接代码 + 模板资源；运行时仍需要：
 *   - dsh（PATH 里）
 *   - python3（任务/文件功能；可选）
 *   - Pillow（大图/HEIC；可选）
 * 启动时 `dsh-wechat-link doctor` 会检查。
 */
import { execFileSync } from 'node:child_process';
import {
  chmodSync, copyFileSync, existsSync, mkdirSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BUILD = join(ROOT, 'build');
const BUNDLE = join(BUILD, 'bridge.cjs');
const BLOB = join(BUILD, 'bridge.blob');
const CONFIG = join(BUILD, 'sea-config.json');
const OUT = join(BUILD, 'dsh-wechat-link');

if (process.platform !== 'linux') {
  console.warn('⚠️ 当前脚本按 Linux ELF 打包；其他平台需要调整 postject 参数。');
}
if (!existsSync(join(ROOT, 'node_modules', 'esbuild'))) {
  console.error('缺少构建依赖，请先执行：npm install');
  process.exit(1);
}

rmSync(BUILD, { recursive: true, force: true });
mkdirSync(BUILD, { recursive: true });

console.log('1/4 esbuild 打包 JS …');
await build({
  entryPoints: [join(ROOT, 'src', 'main.mjs')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  outfile: BUNDLE,
  sourcemap: false,
  logLevel: 'info',
  // import.meta.url 只在源码模式下用于定位资源；SEA 下走 getAsset，不会用到
  logOverride: { 'empty-import-meta': 'silent' },
});

console.log('2/4 生成 SEA blob …');
writeFileSync(CONFIG, JSON.stringify({
  main: BUNDLE,
  output: BLOB,
  disableExperimentalSEAWarning: true,
  assets: {
    'examples/persona.md': join(ROOT, 'examples', 'persona.md'),
    'src/tasks/taskctl.py': join(ROOT, 'src', 'tasks', 'taskctl.py'),
    'src/agent/doc-probe.py': join(ROOT, 'src', 'agent', 'doc-probe.py'),
  },
}, null, 2));
execFileSync(process.execPath, ['--experimental-sea-config', CONFIG], {
  cwd: ROOT,
  stdio: 'inherit',
});

console.log('3/4 复制 Node 并注入 blob …');
copyFileSync(process.execPath, OUT);
chmodSync(OUT, 0o755);

const postject = join(ROOT, 'node_modules', '.bin', 'postject');
if (!existsSync(postject)) {
  console.error('找不到 node_modules/.bin/postject，请先执行 npm install');
  process.exit(1);
}
execFileSync(postject, [
  OUT,
  'NODE_SEA_BLOB',
  BLOB,
  '--sentinel-fuse',
  'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
], { cwd: ROOT, stdio: 'inherit' });
chmodSync(OUT, 0o755);

console.log('4/4 完成');
const size = statSync(OUT).size;
console.log(`产物: ${OUT} (${(size / 1024 / 1024).toFixed(1)} MB)`);
console.log('运行: ./build/dsh-wechat-link doctor');
