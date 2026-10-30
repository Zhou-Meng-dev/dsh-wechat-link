#!/usr/bin/env node
/**
 * 会话映射持久化单元测试。
 */
import assert from 'node:assert';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionStore } from '../src/agent/session-store.mjs';

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

const dir = await mkdtemp(join(tmpdir(), 'dsh-store-test-'));
const path = join(dir, 'bridge-state.json');

await check('新文件 load 后为空', async () => {
  const s = new SessionStore(path);
  await s.load();
  assert.strictEqual(s.peers().length, 0);
  assert.strictEqual(s.get('alice'), undefined);
});

await check('set/get 生效', async () => {
  const s = new SessionStore(path);
  await s.load();
  s.set('alice', 'wx-alice-1');
  assert.strictEqual(s.get('alice'), 'wx-alice-1');
  assert.strictEqual(s.has('alice'), true);
  assert.strictEqual(s.has('bob'), false);
});

await check('flush 后能读回（跨实例）', async () => {
  const s = new SessionStore(path);
  await s.load();
  s.set('alice', 'wx-alice-1');
  s.set('bob', 'wx-bob-1');
  const wrote = await s.flush();
  assert.strictEqual(wrote, true);

  const s2 = new SessionStore(path);
  await s2.load();
  assert.strictEqual(s2.get('alice'), 'wx-alice-1');
  assert.strictEqual(s2.get('bob'), 'wx-bob-1');
});

await check('无变更时 flush 不写盘', async () => {
  const s = new SessionStore(path);
  await s.load();
  assert.strictEqual(await s.flush(), false);
});

await check('delete 移除映射', async () => {
  const s = new SessionStore(path);
  await s.load();
  s.delete('bob');
  await s.flush();
  const s2 = new SessionStore(path);
  await s2.load();
  assert.strictEqual(s2.get('bob'), undefined);
  assert.strictEqual(s2.get('alice'), 'wx-alice-1');
});

await check('文件损坏时降级为空而非崩溃', async () => {
  const bad = join(dir, 'bad.json');
  await writeFile(bad, '{ 这不是 JSON');
  const s = new SessionStore(bad);
  await s.load();
  assert.strictEqual(s.peers().length, 0);
});

await check('文件权限是 0600', async () => {
  const s = new SessionStore(path);
  await s.load();
  s.set('carol', 'wx-carol-1');
  await s.flush();
  const { stat } = await import('node:fs/promises');
  const mode = (await stat(path)).mode & 0o777;
  assert.strictEqual(mode, 0o600, `实际权限 ${mode.toString(8)}`);
});

await check('reset 后新 sessionId 与旧的同 peer 不同', async () => {
  const s = new SessionStore(path);
  await s.load();
  s.set('dave', 'wx-dave-old');
  await s.flush();
  const s2 = new SessionStore(path);
  await s2.load();
  assert.strictEqual(s2.get('dave'), 'wx-dave-old');
  s2.set('dave', 'wx-dave-new');
  await s2.flush();
  const s3 = new SessionStore(path);
  await s3.load();
  assert.strictEqual(s3.get('dave'), 'wx-dave-new');
});

await rm(dir, { recursive: true, force: true });

console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
