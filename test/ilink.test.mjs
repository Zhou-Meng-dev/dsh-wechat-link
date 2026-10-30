#!/usr/bin/env node
/**
 * iLink 客户端：sendmessage 业务错误分类（context_token 失效）。
 */
import assert from 'node:assert';
import { createServer } from 'node:http';

import {
  IlinkClient,
  IlinkSendError,
  isTokenExpiredError,
  extractInboundText,
  extractQuotedContext,
  formatQuotedContext,
  MessageItemType,
} from '../src/wechat/ilink.mjs';

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

await check('isTokenExpiredError：ret=-1 视为 token 失效', () => {
  assert.strictEqual(isTokenExpiredError(new IlinkSendError('x', { ret: -1 })), true);
  assert.strictEqual(isTokenExpiredError({ ret: -1 }), true);
});

await check('isTokenExpiredError：errmsg 命中 token 关键词', () => {
  assert.strictEqual(isTokenExpiredError(new Error('invalid context token')), true);
  assert.strictEqual(isTokenExpiredError(new Error('context_token expired')), true);
  assert.strictEqual(isTokenExpiredError(new Error('会话已过期')), true);
});

await check('isTokenExpiredError：普通错误不误判', () => {
  assert.strictEqual(isTokenExpiredError(new Error('HTTP 500')), false);
  assert.strictEqual(isTokenExpiredError(new IlinkSendError('bad request', { ret: -2 })), false);
  assert.strictEqual(isTokenExpiredError(null), false);
});


// ---------------------------------------------------------------- 引用消息

await check('引用文本：正文与被引用内容分开提取', () => {
  const msg = {
    item_list: [{
      type: MessageItemType.TEXT,
      text_item: { text: '现在的问题是？' },
      ref_msg: {
        title: '摘要',
        message_item: { type: MessageItemType.TEXT, text_item: { text: '被引用的原文' } },
      },
    }],
  };
  const r = extractInboundText(msg);
  assert.strictEqual(r.text, '现在的问题是？');
  assert.strictEqual(r.quoted.text, '被引用的原文');
  assert.strictEqual(formatQuotedContext(r.quoted), '用户引用了下面这条消息作为上下文：\n「被引用的原文」');
});

await check('引用图片：收集 image_item 作为上下文媒体', () => {
  const imageItem = { media: { encrypt_query_param: 'q' }, aeskey: 'a'.repeat(32) };
  const msg = {
    item_list: [{
      type: MessageItemType.TEXT,
      text_item: { text: '这张图是什么？' },
      ref_msg: {
        message_item: { type: MessageItemType.IMAGE, image_item: imageItem },
      },
    }],
  };
  const r = extractInboundText(msg);
  assert.strictEqual(r.quoted.text, '[图片]');
  assert.strictEqual(r.quoted.images.length, 1);
  assert.strictEqual(r.quoted.images[0], imageItem);
  assert.strictEqual(r.images.length, 0, '引用图片不应混进当前消息的图片列表');
});

await check('引用文件：收集 file_item 并把文件名写进上下文', () => {
  const fileItem = { media: { encrypt_query_param: 'q' }, file_name: '报告.pdf' };
  const msg = {
    item_list: [{
      type: MessageItemType.TEXT,
      text_item: { text: '总结一下这个文件' },
      ref_msg: { message_item: { type: MessageItemType.FILE, file_item: fileItem } },
    }],
  };
  const r = extractInboundText(msg);
  assert.strictEqual(r.quoted.text, '[文件 报告.pdf]');
  assert.strictEqual(r.quoted.files.length, 1);
});

await check('引用语音：优先使用转写文本', () => {
  const msg = {
    item_list: [{
      type: MessageItemType.TEXT,
      text_item: { text: '刚才说了什么' },
      ref_msg: { message_item: { type: MessageItemType.VOICE, voice_item: { text: '帮我定个闹钟' } } },
    }],
  };
  assert.strictEqual(extractQuotedContext(msg).text, '帮我定个闹钟');
});

await check('只有 title 时退化为摘要', () => {
  const msg = {
    item_list: [{
      type: MessageItemType.TEXT,
      text_item: { text: '继续' },
      ref_msg: { title: '之前的消息摘要' },
    }],
  };
  assert.strictEqual(extractQuotedContext(msg).text, '之前的消息摘要');
});

await check('兼容顶层 ref_msg，且没有引用时返回 null', () => {
  const top = {
    ref_msg: { message_item: { type: MessageItemType.TEXT, text_item: { text: '顶层引用' } } },
    item_list: [{ type: MessageItemType.TEXT, text_item: { text: 'x' } }],
  };
  assert.strictEqual(extractQuotedContext(top).text, '顶层引用');
  assert.strictEqual(extractQuotedContext({ item_list: [{ type: MessageItemType.TEXT, text_item: { text: 'x' } }] }), null);
  assert.strictEqual(formatQuotedContext(null), '');
});

await check('普通消息的文本/图片/文件提取不受影响', () => {
  const msg = {
    item_list: [
      { type: MessageItemType.TEXT, text_item: { text: '正文' } },
      { type: MessageItemType.IMAGE, image_item: { media: {} } },
      { type: MessageItemType.FILE, file_item: { file_name: 'a.txt' } },
    ],
  };
  const r = extractInboundText(msg);
  assert.strictEqual(r.text, '正文\n[图片]\n[文件 a.txt]');
  assert.strictEqual(r.kind, 'file');
  assert.strictEqual(r.images.length, 1);
  assert.strictEqual(r.files.length, 1);
  assert.strictEqual(r.quoted, null);
});

let sendResp = { ret: -1, errmsg: 'invalid context token' };
let lastBody = null;
const server = createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  lastBody = Buffer.concat(chunks).toString('utf8');
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(sendResp));
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;

await check('sendmessage ret=-1 抛出 IlinkSendError 且可识别为 token 失效', async () => {
  const ilink = new IlinkClient({ token: 't', baseUrl: `http://127.0.0.1:${port}/` });
  await assert.rejects(
    () => ilink.sendText({ toUserId: 'u', text: 'hi', contextToken: 'old' }),
    (err) => {
      assert.ok(err instanceof IlinkSendError);
      assert.strictEqual(err.ret, -1);
      assert.match(err.errmsg, /invalid context token/);
      assert.strictEqual(isTokenExpiredError(err), true);
      return true;
    },
  );
  assert.match(lastBody, /"context_token":"old"/);
});

await check('ret=0 时正常返回', async () => {
  sendResp = { ret: 0 };
  const ilink = new IlinkClient({ token: 't', baseUrl: `http://127.0.0.1:${port}/` });
  const r = await ilink.sendText({ toUserId: 'u', text: 'hi', contextToken: 'new' });
  assert.strictEqual(r.ret, 0);
});

server.close();

console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
