#!/usr/bin/env node
/**
 * 原子写工具：内容、权限、目录、写失败不破坏原文件。
 */
import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { atomicWriteJson, atomicWriteText } from '../src/ops/atomic-file.mjs';

import { createChecker } from './helpers/check.mjs';

const { check, done } = createChecker();

const root = await mkdtemp(join(tmpdir(), 'atomic-file-'));
const mode = async (p) => (await stat(p)).mode & 0o777;

await check('atomicWriteJson 写入可解析内容，权限 0600', async () => {
  const p = join(root, 'a.json');
  await atomicWriteJson(p, { hello: '世界', n: 1 });
  const raw = JSON.parse(await readFile(p, 'utf8'));
  assert.deepStrictEqual(raw, { hello: '世界', n: 1 });
  assert.strictEqual(await mode(p), 0o600);
});

await check('atomicWriteText 原样写入文本', async () => {
  const p = join(root, 'a.txt');
  await atomicWriteText(p, 'line1\nline2');
  assert.strictEqual(await readFile(p, 'utf8'), 'line1\nline2');
});

await check('新建目录权限 0700', async () => {
  const dir = join(root, 'nested', 'deep');
  const p = join(dir, 'x.json');
  await atomicWriteJson(p, { ok: true });
  assert.strictEqual(await mode(dir), 0o700);
});

await check('覆盖写更新内容且不残留临时文件', async () => {
  const dir = join(root, 'overwrite');
  const p = join(dir, 'x.json');
  await atomicWriteJson(p, { v: 1 });
  await atomicWriteJson(p, { v: 2 });
  assert.deepStrictEqual(JSON.parse(await readFile(p, 'utf8')), { v: 2 });
  const leftovers = (await readdir(dir)).filter((n) => n.includes('.tmp-'));
  assert.deepStrictEqual(leftovers, []);
  assert.strictEqual(await mode(p), 0o600);
});

await check('写失败时抛出原始错误且原文件不变', async () => {
  if (typeof process.getuid === 'function' && process.getuid() === 0) {
    console.log('   （root 用户跳过只读目录用例）');
    return;
  }
  const dir = join(root, 'readonly');
  const p = join(dir, 'x.json');
  await atomicWriteJson(p, { keep: true });
  await chmod(dir, 0o500);
  try {
    await assert.rejects(() => atomicWriteJson(p, { keep: false }), /EACCES|EPERM|permission/i);
  } finally {
    await chmod(dir, 0o700);
  }
  assert.deepStrictEqual(JSON.parse(await readFile(p, 'utf8')), { keep: true });
  // 失败时不能留下临时文件
  const leftovers = (await readdir(dir)).filter((n) => n.includes('.tmp-'));
  assert.deepStrictEqual(leftovers, []);
});

await check('目标路径的父级是文件时显式失败', async () => {
  const file = join(root, 'not-a-dir');
  await writeFile(file, 'x');
  await assert.rejects(() => atomicWriteJson(join(file, 'y.json'), { a: 1 }));
});

await rm(root, { recursive: true, force: true });

done();
