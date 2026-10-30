#!/usr/bin/env node
/**
 * 出站媒体：指令解析、工作区路径校验、CDN 加密上传、IMAGE / FILE 消息构造。
 *
 * 用本地 HTTP 服务模拟 iLink 的 getuploadurl / CDN upload / sendmessage，
 * 不需要真实 token，也不发真实微信消息。
 */
import assert from 'node:assert';
import { createServer } from 'node:http';
import { createDecipheriv } from 'node:crypto';
import { mkdtemp, writeFile, symlink, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { IlinkClient } from '../src/wechat/ilink.mjs';
import {
  extractMediaDirectives,
  prepareMediaForUpload,
  prepareImageForUpload,
  sendMedia,
  sendImageFile,
  uploadMedia,
  sendPreparedMedia,
  MAX_OUTBOUND_IMAGE_BYTES,
  MAX_OUTBOUND_FILE_BYTES,
} from '../src/wechat/outbound-media.mjs';

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

const root = await mkdtemp(join(tmpdir(), 'outbound-media-'));
const ws = join(root, 'ws');
await mkdir(ws, { recursive: true });
await writeFile(join(ws, 'chart.png'), PNG);
await writeFile(join(root, 'outside.png'), PNG);
await writeFile(join(ws, 'notes.txt'), 'not an image');
await symlink(join(root, 'outside.png'), join(ws, 'link.png'));

// ---------------------------------------------------------------- 指令解析

await check('解析独占一行的图片指令，并从正文中移除', () => {
  const { text, media } = extractMediaDirectives(
    '图在下面：\n[[image: chart.png]]\n这是说明。',
  );
  assert.deepStrictEqual(media, [{ kind: 'image', path: 'chart.png' }]);
  assert.strictEqual(text, '图在下面：\n这是说明。');
});

await check('支持多张、引号、文件与无空格写法，并保留顺序', () => {
  const { text, media } = extractMediaDirectives(
    '[[image: "a b.png"]]\n正文\n[[image:chart.png]]\n[[file: report.csv]]',
  );
  assert.deepStrictEqual(media, [
    { kind: 'image', path: 'a b.png' },
    { kind: 'image', path: 'chart.png' },
    { kind: 'file', path: 'report.csv' },
  ]);
  assert.strictEqual(text, '正文');
});

await check('代码块里的指令不解析', () => {
  const src = '示例：\n```\n[[image: chart.png]]\n[[file: notes.txt]]\n```\n结束';
  const { text, media } = extractMediaDirectives(src);
  assert.deepStrictEqual(media, []);
  assert.strictEqual(text, src);
});

await check('普通 Markdown 图片/链接不会误发', () => {
  const src = '![图](chart.png) 和 [报告](report.pdf)';
  const { text, media } = extractMediaDirectives(src);
  assert.deepStrictEqual(media, []);
  assert.strictEqual(text, src);
});

// ---------------------------------------------------------------- 路径校验

await check('拒绝工作区外的相对路径（目录穿越）', async () => {
  await assert.rejects(
    () => prepareMediaForUpload('../outside.png', ws, 'image'),
    /工作区/,
  );
  await assert.rejects(
    () => prepareMediaForUpload('../outside.png', ws, 'file'),
    /工作区/,
  );
});

await check('拒绝指向工作区外的符号链接', async () => {
  await assert.rejects(
    () => prepareImageForUpload('link.png', ws),
    /工作区/,
  );
});

await check('图片指令拒绝非图片文件', async () => {
  await assert.rejects(
    () => prepareMediaForUpload('notes.txt', ws, 'image'),
    /不支持/,
  );
});

await check('文件指令接受任意类型文件', async () => {
  const f = await prepareMediaForUpload('notes.txt', ws, 'file');
  assert.strictEqual(f.kind, 'file');
  assert.strictEqual(f.name, 'notes.txt');
  assert.strictEqual(f.mimeType, null);
  assert.strictEqual(f.bytes, Buffer.byteLength('not an image'));
});

await check('合法图片返回 MIME 与字节', async () => {
  const img = await prepareImageForUpload('chart.png', ws);
  assert.strictEqual(img.mimeType, 'image/png');
  assert.ok(img.buffer.equals(PNG));
  assert.strictEqual(img.name, 'chart.png');
  assert.ok(MAX_OUTBOUND_IMAGE_BYTES >= 20 * 1024 * 1024);
  assert.ok(MAX_OUTBOUND_FILE_BYTES >= 100 * 1024 * 1024);
});

// ---------------------------------------------------------------- 完整发送

let getUploadReq = null;
let uploadedCipher = null;
let uploadKey = null;
let sentMessage = null;
let uploadMode = 'full';
let lastCdnUrl = null;

const server = createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = Buffer.concat(chunks);

  if (req.url === '/ilink/bot/getuploadurl') {
    getUploadReq = JSON.parse(body.toString('utf8'));
    uploadKey = Buffer.from(getUploadReq.aeskey, 'hex');
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(uploadMode === 'param'
      ? { upload_param: 'upload-param-1' }
      : { upload_full_url: `http://127.0.0.1:${server.address().port}/cdn/upload` }));
    return;
  }
  if (req.url === '/cdn/upload' || req.url.startsWith('/c2c/upload?')) {
    lastCdnUrl = req.url;
    uploadedCipher = body;
    res.writeHead(200, { 'x-encrypted-param': 'enc-param-test' });
    res.end();
    return;
  }
  if (req.url === '/ilink/bot/sendmessage') {
    sentMessage = JSON.parse(body.toString('utf8'));
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ret: 0 }));
    return;
  }
  res.writeHead(404);
  res.end();
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;

await check('上传前请求 getuploadurl（明文大小 / MD5 / 密文大小 / AES key）', async () => {
  const ilink = new IlinkClient({ token: 'test-token', baseUrl: `http://127.0.0.1:${port}/` });
  const result = await sendImageFile({
    ilink,
    workspace: ws,
    filePath: 'chart.png',
    toUserId: 'user-1',
    contextToken: 'ctx-1',
  });

  assert.strictEqual(result.name, 'chart.png');
  assert.strictEqual(getUploadReq.media_type, 1);
  assert.strictEqual(getUploadReq.to_user_id, 'user-1');
  assert.strictEqual(getUploadReq.rawsize, PNG.length);
  assert.match(getUploadReq.rawfilemd5, /^[0-9a-f]{32}$/);
  assert.strictEqual(getUploadReq.filesize, Math.ceil((PNG.length + 1) / 16) * 16);
  assert.strictEqual(getUploadReq.no_need_thumb, true);
  assert.match(getUploadReq.aeskey, /^[0-9a-f]{32}$/);
});

await check('上传体是 AES-128-ECB 密文，可用同一 key 解回原图', () => {
  assert.ok(uploadedCipher?.length);
  const d = createDecipheriv('aes-128-ecb', uploadKey, null);
  const plain = Buffer.concat([d.update(uploadedCipher), d.final()]);
  assert.ok(plain.equals(PNG));
});

await check('sendmessage 携带 IMAGE item 与 CDN 参数', () => {
  const msg = sentMessage.msg;
  assert.strictEqual(msg.to_user_id, 'user-1');
  assert.strictEqual(msg.context_token, 'ctx-1');
  assert.strictEqual(msg.message_type, 2);
  assert.strictEqual(msg.item_list.length, 1);

  const item = msg.item_list[0];
  assert.strictEqual(item.type, 2);
  assert.strictEqual(item.image_item.media.encrypt_query_param, 'enc-param-test');
  assert.strictEqual(item.image_item.media.encrypt_type, 1);
  assert.strictEqual(
    Buffer.from(item.image_item.media.aes_key, 'base64').toString('ascii'),
    getUploadReq.aeskey,
  );
  assert.strictEqual(item.image_item.mid_size, getUploadReq.filesize);
});

await check('发送文件：media_type=3，FILE item 带 file_name 与 len', async () => {
  uploadMode = 'full';
  getUploadReq = null;
  sentMessage = null;
  uploadedCipher = null;
  lastCdnUrl = null;

  const ilink = new IlinkClient({ token: 'test-token', baseUrl: `http://127.0.0.1:${port}/` });
  const result = await sendMedia({
    ilink,
    workspace: ws,
    kind: 'file',
    filePath: 'notes.txt',
    toUserId: 'user-3',
    contextToken: 'ctx-3',
  });

  assert.strictEqual(result.kind, 'file');
  assert.strictEqual(result.name, 'notes.txt');
  assert.strictEqual(getUploadReq.media_type, 3);
  assert.strictEqual(getUploadReq.rawsize, 12);

  const item = sentMessage.msg.item_list[0];
  assert.strictEqual(item.type, 4);
  assert.strictEqual(item.file_item.file_name, 'notes.txt');
  assert.strictEqual(item.file_item.len, '12');
  assert.strictEqual(item.file_item.media.encrypt_query_param, 'enc-param-test');
  assert.strictEqual(item.file_item.media.encrypt_type, 1);
  assert.strictEqual(item.file_item.mid_size, undefined);

  const d = createDecipheriv('aes-128-ecb', uploadKey, null);
  const plain = Buffer.concat([d.update(uploadedCipher), d.final()]);
  assert.ok(plain.equals(Buffer.from('not an image')));
});

await check('服务端只返回 upload_param 时按 cdnBaseUrl 拼接上传地址', async () => {
  uploadMode = 'param';
  lastCdnUrl = null;
  const ilink = new IlinkClient({ token: 'test-token', baseUrl: `http://127.0.0.1:${port}/` });
  await sendImageFile({
    ilink,
    workspace: ws,
    filePath: 'chart.png',
    toUserId: 'user-2',
    contextToken: 'ctx-2',
    cdnBaseUrl: `http://127.0.0.1:${port}/c2c`,
  });

  assert.ok(lastCdnUrl?.startsWith('/c2c/upload?'), `unexpected URL: ${lastCdnUrl}`);
  assert.match(lastCdnUrl, /encrypted_query_param=upload-param-1/);
  assert.match(lastCdnUrl, /filekey=[0-9a-f]{32}/);
  assert.strictEqual(sentMessage.msg.to_user_id, 'user-2');
  assert.strictEqual(sentMessage.msg.item_list[0].type, 2);
});


await check('uploadMedia / sendPreparedMedia 分离，待发队列可复用已上传媒体', async () => {
  uploadMode = 'full';
  getUploadReq = null;
  sentMessage = null;
  uploadedCipher = null;

  const ilink = new IlinkClient({ token: 'test-token', baseUrl: `http://127.0.0.1:${port}/` });
  const prepared = await uploadMedia({
    ilink,
    workspace: ws,
    kind: 'image',
    filePath: 'chart.png',
    toUserId: 'user-retry',
  });
  assert.strictEqual(prepared.kind, 'image');
  assert.match(prepared.params.encryptQueryParam, /^enc-param/);
  assert.match(prepared.params.aesKeyHex, /^[0-9a-f]{32}$/);
  assert.strictEqual(sentMessage, null, '上传阶段不应发送消息');

  await sendPreparedMedia({
    ilink,
    toUserId: 'user-retry',
    contextToken: 'ctx-new',
    prepared,
  });
  assert.strictEqual(sentMessage.msg.context_token, 'ctx-new');
  assert.strictEqual(sentMessage.msg.item_list[0].type, 2);
  assert.strictEqual(
    sentMessage.msg.item_list[0].image_item.media.encrypt_query_param,
    prepared.params.encryptQueryParam,
  );
});

await check('context_token 必须是字符串，防止把 {token, updatedAt} 对象传下去', async () => {
  const ilink = new IlinkClient({ token: 't', baseUrl: `http://127.0.0.1:${port}/` });
  await assert.rejects(
    () => ilink.sendText({ toUserId: 'u', text: 'x', contextToken: { token: 't' } }),
    /context_token 必须是字符串/,
  );
});

await check('上传或发送失败会抛出可读错误', async () => {
  const bad = new IlinkClient({ token: 't', baseUrl: 'http://127.0.0.1:1/' });
  await assert.rejects(
    () => sendImageFile({
      ilink: bad,
      workspace: ws,
      filePath: 'chart.png',
      toUserId: 'u',
      contextToken: 'c',
    }),
    /getuploadurl|fetch|ECONNREFUSED|HTTP/i,
  );
});

server.close();
await rm(root, { recursive: true, force: true });

console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
