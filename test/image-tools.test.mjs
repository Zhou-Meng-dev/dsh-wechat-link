#!/usr/bin/env node
/**
 * 入站图片归一化：格式判断、压缩/转码决策、原图留存。
 *
 * 真实转换依赖 python3-pil 或 imagemagick；没有工具时验证降级路径，
 * 有工具时额外跑一次 1x1 BMP → png/jpeg 的实转。
 */
import assert from 'node:assert';
import { mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  MODEL_IMAGE_MIMES,
  DEFAULT_IMAGE_TARGET_BYTES,
  DEFAULT_IMAGE_MAX_BYTES,
  DEFAULT_IMAGE_MAX_DIMENSION,
  normalizeImage,
  convertImage,
  saveOriginalImage,
} from '../src/wechat/image-tools.mjs';
import { detectImageMime } from '../src/wechat/media.mjs';

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

// 1x1 透明 PNG
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
const BMP = Buffer.from('BM' + '\0'.repeat(60));
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, ...Array(20).fill(0)]);

await check('默认阈值合理', () => {
  assert.ok(MODEL_IMAGE_MIMES.has('image/png'));
  assert.ok(MODEL_IMAGE_MIMES.has('image/jpeg'));
  assert.strictEqual(DEFAULT_IMAGE_TARGET_BYTES, 4 * 1024 * 1024);
  assert.strictEqual(DEFAULT_IMAGE_MAX_BYTES, 20 * 1024 * 1024);
  assert.strictEqual(DEFAULT_IMAGE_MAX_DIMENSION, 2048);
});

await check('小尺寸且格式受支持：原样返回，不调用转换器', async () => {
  let called = 0;
  const r = await normalizeImage(PNG, {
    mimeType: 'image/png',
    convertImage: async () => { called++; throw new Error('不应调用'); },
  });
  assert.strictEqual(r.converted, false);
  assert.strictEqual(r.mimeType, 'image/png');
  assert.strictEqual(r.reason, null);
  assert.strictEqual(called, 0);
  assert.ok(r.buffer.equals(PNG));
});

await check('受支持格式但超过目标大小：触发压缩', async () => {
  const big = Buffer.concat([PNG, Buffer.alloc(500)]);
  const r = await normalizeImage(big, {
    mimeType: 'image/png',
    targetBytes: 100,
    convertImage: async () => ({ buffer: JPEG, mimeType: 'image/jpeg', tool: 'fake' }),
  });
  assert.strictEqual(r.converted, true);
  assert.strictEqual(r.reason, 'too-large');
  assert.strictEqual(r.mimeType, 'image/jpeg');
  assert.strictEqual(r.tool, 'fake');
  assert.ok(r.buffer.equals(JPEG));
});

await check('不支持的格式：触发转码', async () => {
  const r = await normalizeImage(BMP, {
    mimeType: 'image/bmp',
    convertImage: async () => ({ buffer: PNG, mimeType: 'image/png', tool: 'fake' }),
  });
  assert.strictEqual(r.converted, true);
  assert.strictEqual(r.reason, 'unsupported-format');
  assert.strictEqual(r.originalMimeType, 'image/bmp');
  assert.strictEqual(r.mimeType, 'image/png');
});

await check('受支持格式压缩失败：退回原图而不是丢图', async () => {
  const big = Buffer.concat([PNG, Buffer.alloc(200)]);
  const r = await normalizeImage(big, {
    mimeType: 'image/png',
    targetBytes: 100,
    convertImage: async () => { throw new Error('没有工具'); },
  });
  assert.strictEqual(r.converted, false);
  assert.strictEqual(r.mimeType, 'image/png');
  assert.match(r.reason, /转换失败/);
  assert.ok(r.buffer.equals(big));
});

await check('不支持的格式转换失败：抛错（调用方跳过该图）', async () => {
  await assert.rejects(
    () => normalizeImage(BMP, {
      mimeType: 'image/bmp',
      convertImage: async () => { throw new Error('没有工具'); },
    }),
    /不受支持.*转换失败/,
  );
});

await check('转换结果不是模型支持格式：抛错', async () => {
  await assert.rejects(
    () => normalizeImage(BMP, {
      mimeType: 'image/bmp',
      convertImage: async () => ({ buffer: BMP, mimeType: 'image/bmp', tool: 'fake' }),
    }),
    /转换结果格式不受支持/,
  );
});

await check('转换后仍超过硬上限：抛错', async () => {
  const big = Buffer.concat([PNG, Buffer.alloc(200)]);
  await assert.rejects(
    () => normalizeImage(big, {
      mimeType: 'image/png',
      targetBytes: 100,
      maxBytes: 50,
      convertImage: async () => ({ buffer: PNG, mimeType: 'image/png', tool: 'fake' }),
    }),
    /仍超过/,
  );
});

await check('空输入/无法识别格式抛错', async () => {
  await assert.rejects(() => normalizeImage(Buffer.alloc(0)), /内容为空/);
  await assert.rejects(() => normalizeImage(Buffer.from('hello world!!!!')), /无法识别/);
});

const root = await mkdtemp(join(tmpdir(), 'image-tools-'));
const originals = join(root, 'originals');

await check('原图落盘：扩展名、内容与名称可追溯', async () => {
  const saved = await saveOriginalImage(originals, PNG, {
    mimeType: 'image/png',
    now: new Date(2026, 9, 29, 1, 2, 3),
  });
  assert.match(saved.name, /^img-20261029-010203-[0-9a-f]{8}\.png$/);
  assert.strictEqual(saved.bytes, PNG.length);
  assert.ok((await readFile(saved.path)).equals(PNG));
});

await check('原图目录清理过期文件，不碰其它文件', async () => {
  const old = join(originals, 'img-old.png');
  const keep = join(originals, 'keep.txt');
  await writeFile(old, 'old');
  await writeFile(keep, 'keep');
  const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
  await utimes(old, eightDaysAgo, eightDaysAgo);

  await saveOriginalImage(originals, JPEG, { mimeType: 'image/jpeg' });
  await assert.rejects(() => stat(old), /ENOENT/);
  assert.ok((await stat(keep)).isFile());
});

await check('没有转换工具时 convertImage 给出可操作错误', async () => {
  // 宿主有工具时会成功，这条只在无工具环境断言错误文案
  try {
    const r = await convertImage(BMP, { targetBytes: 1000, maxDimension: 100 });
    assert.ok(r.mimeType === 'image/png' || r.mimeType === 'image/jpeg');
  } catch (err) {
    assert.match(err.message, /python3-pil|imagemagick|图片转换/);
  }
});

await check('有 Pillow/ImageMagick 时真实转换 1x1 BMP', async () => {
  // 构造一个合法的 1x1 24-bit BMP
  const bmp = Buffer.alloc(58);
  bmp.write('BM', 0, 'ascii');
  bmp.writeUInt32LE(58, 2);
  bmp.writeUInt32LE(54, 10);
  bmp.writeUInt32LE(40, 14);
  bmp.writeInt32LE(1, 18);
  bmp.writeInt32LE(1, 22);
  bmp.writeUInt16LE(1, 26);
  bmp.writeUInt16LE(24, 28);
  bmp.writeUInt32LE(4, 34);
  // 像素：蓝绿红 + padding
  bmp[54] = 0x00; bmp[55] = 0x00; bmp[56] = 0xff;
  assert.strictEqual(detectImageMime(bmp), 'image/bmp');

  let result;
  try {
    result = await convertImage(bmp, { targetBytes: 200_000, maxDimension: 100 });
  } catch (err) {
    console.log(`   (跳过真实转换：${err.message.slice(0, 80)})`);
    return;
  }
  assert.ok(result.mimeType === 'image/png' || result.mimeType === 'image/jpeg');
  assert.ok(result.buffer.length > 0);
  assert.notStrictEqual(result.buffer.toString('hex'), bmp.toString('hex'));
});

const names = await readdir(originals).catch(() => []);
assert.ok(names.length >= 2);
await rm(root, { recursive: true, force: true });

console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
