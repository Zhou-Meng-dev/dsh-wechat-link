#!/usr/bin/env node
/**
 * MediaIngest 单元测试：本地 HTTP 模拟微信 CDN，不访问真实网络。
 *
 * 覆盖：
 *   - 无媒体：返回空数组 / 空串，不产生日志
 *   - 下载失败：跳过该条并降级，不抛异常
 *   - 原图保存：_inbox/originals/ 下留有完整原图，模型块为 base64
 *   - 文件说明格式：落盘到 _inbox + 路径/类型/大小 + 探测策略
 */
import assert from 'node:assert';
import { createCipheriv } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MediaIngest } from '../src/wechat/ingest.mjs';

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

// ---------------------------------------------------------------- 本地 CDN

const KEY = Buffer.from('0123456789abcdef0123456789abcdef', 'hex');
function encrypt(buf) {
  const c = createCipheriv('aes-128-ecb', KEY, null);
  return Buffer.concat([c.update(buf), c.final()]);
}

// 1x1 PNG
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
const PNG_CIPHERTEXT = encrypt(PNG);
const TEXT = Buffer.from('第一行\n第二行\n', 'utf8');
const TEXT_CIPHERTEXT = encrypt(TEXT);

const server = createServer((req, res) => {
  if (req.url === '/img') {
    res.writeHead(200, { 'content-length': String(PNG_CIPHERTEXT.length) });
    res.end(PNG_CIPHERTEXT);
    return;
  }
  if (req.url === '/file') {
    res.writeHead(200, { 'content-length': String(TEXT_CIPHERTEXT.length) });
    res.end(TEXT_CIPHERTEXT);
    return;
  }
  res.writeHead(404);
  res.end();
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;

const root = await mkdtemp(join(tmpdir(), 'media-ingest-'));
const cwd = join(root, 'workspace');
await mkdir(cwd, { recursive: true });

function makeIngest() {
  const logs = [];
  const ingest = new MediaIngest({ cwd, log: (m) => logs.push(m) });
  return { ingest, logs };
}

const imageItem = {
  media: { full_url: `http://127.0.0.1:${port}/img` },
  aeskey: KEY.toString('hex'),
};

const fileItem = {
  file_name: '报告.txt',
  media: {
    full_url: `http://127.0.0.1:${port}/file`,
    // 线上形态：base64(32 字符 hex)
    aes_key: Buffer.from(KEY.toString('hex')).toString('base64'),
  },
};

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// ---------------------------------------------------------------- 无媒体

await check('无媒体：返回空结果且不产生日志', async () => {
  const { ingest, logs } = makeIngest();

  assert.deepStrictEqual(await ingest.loadImages('user-1', []), []);
  assert.deepStrictEqual(await ingest.loadImages('user-1', undefined), []);
  assert.strictEqual(await ingest.loadFiles([]), '');
  assert.strictEqual(await ingest.loadFiles(undefined), '');

  assert.deepStrictEqual(logs, []);
});

// ---------------------------------------------------------------- 下载失败

await check('图片下载失败：跳过该张并记录日志，不抛异常', async () => {
  const { ingest, logs } = makeIngest();

  const blocks = await ingest.loadImages('user-1', [{}]);
  assert.deepStrictEqual(blocks, []);
  assert.ok(logs.some((m) => m.includes('图片下载/解密失败，已退化为占位文本')));
});

await check('文件下载失败：说明里标记「下载失败」并记录日志', async () => {
  const { ingest, logs } = makeIngest();

  const note = await ingest.loadFiles([{ file_name: '丢失.pdf' }]);
  assert.match(note, /- 丢失\.pdf（下载失败，无法读取）/);
  assert.ok(logs.some((m) => m.includes('文件下载失败: 丢失.pdf')));
});

// ---------------------------------------------------------------- 原图保存

await check('图片：保留原图 + 返回 base64 图片块', async () => {
  const { ingest, logs } = makeIngest();

  const blocks = await ingest.loadImages('user-1', [imageItem]);
  assert.strictEqual(blocks.length, 1);

  const block = blocks[0];
  assert.strictEqual(block.mimeType, 'image/png');
  assert.strictEqual(block.bytes, PNG.length);
  assert.ok(Buffer.from(block.data, 'base64').equals(PNG));
  assert.ok(block.originalPath, '缺少 originalPath');
  assert.ok(block.originalPath.startsWith(join(cwd, '_inbox', 'originals')));
  assert.ok((await readFile(block.originalPath)).equals(PNG), '原图内容不完整');
  assert.ok(logs.some((m) => m.includes('原图已保留')));
});

// ---------------------------------------------------------------- 文件说明

await check('文件：落盘到 _inbox，说明包含路径/类型/大小与探测策略', async () => {
  const { ingest, logs } = makeIngest();

  const note = await ingest.loadFiles([fileItem]);
  const savedPath = join(cwd, '_inbox', '报告.txt');

  assert.strictEqual(await readFile(savedPath, 'utf8'), TEXT.toString('utf8'));
  assert.match(note, /用户发来了文件，已保存到你的工作目录：/);
  assert.match(
    note,
    new RegExp(`- ${escapeRe(savedPath)}（报告\\.txt，文本，20B）`),
  );
  assert.match(note, /_tools\/doc_probe\.py/);
  assert.ok(logs.some((m) => m.includes('文件已保存')));
});

server.close();
await rm(root, { recursive: true, force: true });

console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
