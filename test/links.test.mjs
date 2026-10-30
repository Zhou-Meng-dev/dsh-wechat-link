#!/usr/bin/env node
/**
 * INGEST-001：链接提取、SSRF 防护、抓取限制、HTML 正文提取、落盘与注入文案。
 * 全部使用注入的 lookup/request，不访问真实网络。
 */
import assert from 'node:assert';
import { Readable } from 'node:stream';
import { gzipSync } from 'node:zlib';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  LinkIngest,
  assertSafeUrl,
  decodeContentEncoding,
  extractUrls,
  fetchLink,
  formatLinkContext,
  htmlToText,
  isPrivateIp,
  makePinnedLookup,
  readBodyLimited,
} from '../src/wechat/links.mjs';

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

const publicLookup = async () => [{ address: '93.184.216.34', family: 4 }];
const privateLookup = async () => [{ address: '10.0.0.5', family: 4 }];

function makeResponse({ status = 200, headers = {}, body = '', truncated = false } = {}) {
  return { statusCode: status, headers, body: Buffer.from(body), truncated };
}

// ---------------------------------------------------------------- 纯函数

await check('extractUrls：去重、去句末标点、限制数量', () => {
  const urls = extractUrls(
    '看这个 https://example.com/a?x=1。还有 http://example.org/b, 以及 https://example.com/a?x=1',
    3,
  );
  assert.deepStrictEqual(urls, ['https://example.com/a?x=1', 'http://example.org/b']);

  const many = extractUrls('https://a.com/1 https://b.com/2 https://c.com/3', 2);
  assert.strictEqual(many.length, 2);

  assert.deepStrictEqual(extractUrls('没有链接，ftp://x.com 不算'), []);
});

await check('isPrivateIp：覆盖回环/私网/link-local/IPv6', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1',
    '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1', '::1', '::', 'fe80::1',
    'fd00::1', 'fc00::1', '::ffff:127.0.0.1', '2001:db8::1', 'not-an-ip']) {
    assert.strictEqual(isPrivateIp(ip), true, `${ip} 应判定为内网`);
  }
  for (const ip of ['93.184.216.34', '1.1.1.1', '2606:4700:4700::1111']) {
    assert.strictEqual(isPrivateIp(ip), false, `${ip} 应判定为公网`);
  }
});

await check('assertSafeUrl：拒绝内网/本地/非 http/特殊端口', async () => {
  const bad = [
    'http://127.0.0.1/',
    'http://10.1.2.3/',
    'http://172.20.0.1/',
    'http://192.168.1.1/',
    'http://169.254.169.254/latest/meta-data',
    'http://[::1]/',
    'http://[fd12::1]/',
    'http://localhost/',
    'http://intranet/',
    'ftp://example.com/file',
    'http://user:pass@example.com/',
    'http://example.com:8080/',
  ];
  for (const url of bad) {
    await assert.rejects(assertSafeUrl(url, { lookup: publicLookup }), undefined, `${url} 应被拒绝`);
  }

  await assert.rejects(
    assertSafeUrl('https://example.com/', { lookup: privateLookup }),
    /内网\/本地地址/,
  );
});

await check('assertSafeUrl：公网域名通过并返回解析地址', async () => {
  const { url, addresses } = await assertSafeUrl('https://example.com/a', { lookup: publicLookup });
  assert.strictEqual(url.hostname, 'example.com');
  assert.strictEqual(addresses[0].address, '93.184.216.34');
});

await check('assertSafeUrl：公网 IPv6 字面量可以通过', async () => {
  const lookupV6 = async () => [{ address: '2606:4700:4700::1111', family: 6 }];
  const { addresses } = await assertSafeUrl('https://[2606:4700:4700::1111]/', { lookup: lookupV6 });
  assert.strictEqual(addresses[0].family, 6);
});

await check('htmlToText：标题/描述/正文，去掉脚本导航页脚，解码实体', () => {
  const html = [
    '<html><head><title>测试 &amp; 标题</title>',
    '<meta name="description" content="页面描述"></head><body>',
    '<nav>导航链接</nav>',
    '<article><h1>大标题</h1><p>第一段。</p><script>alert(1)</script>',
    '<p>第二段 &lt;tag&gt; &nbsp;结束</p></article>',
    '<footer>页脚</footer></body></html>',
  ].join('');
  const out = htmlToText(html);
  assert.strictEqual(out.title, '测试 & 标题');
  assert.strictEqual(out.description, '页面描述');
  assert.match(out.text, /第一段/);
  assert.match(out.text, /第二段 <tag> 结束/);
  assert.doesNotMatch(out.text, /导航链接|页脚|alert\(1\)/);
});

await check('htmlToText：没有 article/main 时也不把 head 标题混进正文', () => {
  const out = htmlToText('<html><head><title>标题</title></head><body><p>正文</p></body></html>');
  assert.strictEqual(out.title, '标题');
  assert.strictEqual(out.text, '正文');
});

await check('htmlToText：超长正文截断并标记 truncated', () => {
  const out = htmlToText(`<p>${'a'.repeat(50)}</p>`, { maxChars: 10 });
  assert.strictEqual(out.text.length, 10);
  assert.strictEqual(out.truncated, true);
});

await check('readBodyLimited：超过上限截断，未超过完整返回', async () => {
  const small = await readBodyLimited(Readable.from([Buffer.from('hello world')]), 20);
  assert.strictEqual(small.body.toString(), 'hello world');
  assert.strictEqual(small.truncated, false);

  const cut = await readBodyLimited(Readable.from([Buffer.from('hello '), Buffer.from('world')]), 8);
  assert.strictEqual(cut.body.toString(), 'hello wo');
  assert.strictEqual(cut.truncated, true);
});

await check('makePinnedLookup：兼容 autoSelectFamily 的 all:true 调用', async () => {
  const pinned = makePinnedLookup('93.184.216.34', 4);

  const single = await new Promise((resolve, reject) => {
    pinned('example.com', { family: 4 }, (err, address, family) => {
      if (err) reject(err);
      else resolve({ address, family });
    });
  });
  assert.deepStrictEqual(single, { address: '93.184.216.34', family: 4 });

  const all = await new Promise((resolve, reject) => {
    pinned('example.com', { all: true }, (err, addresses) => {
      if (err) reject(err);
      else resolve(addresses);
    });
  });
  assert.deepStrictEqual(all, [{ address: '93.184.216.34', family: 4 }]);
});

// ---------------------------------------------------------------- 抓取

await check('fetchLink：200 页面提取正文并保留最终 URL', async () => {
  const html = '<html><head><title>标题</title></head><body><article><p>正文内容</p></article></body></html>';
  const req = async () => makeResponse({ headers: { 'content-type': 'text/html; charset=utf-8' }, body: html });
  const out = await fetchLink('https://example.com/page', { lookup: publicLookup, request: req });
  assert.strictEqual(out.title, '标题');
  assert.match(out.text, /正文内容/);
  assert.strictEqual(out.contentType, 'text/html');
  assert.strictEqual(out.finalUrl, 'https://example.com/page');
});

await check('fetchLink：重定向到内网被拦截，且不会发起第二次请求', async () => {
  const requested = [];
  const req = async ({ url }) => {
    requested.push(String(url));
    return makeResponse({ status: 302, headers: { location: 'http://127.0.0.1/secret' } });
  };
  await assert.rejects(
    fetchLink('https://example.com/start', { lookup: publicLookup, request: req }),
    /内网\/本地地址/,
  );
  assert.strictEqual(requested.length, 1);
});

await check('fetchLink：重定向次数超限报错', async () => {
  let n = 0;
  const req = async () => {
    n++;
    return makeResponse({ status: 302, headers: { location: `https://example.com/r${n}` } });
  };
  await assert.rejects(
    fetchLink('https://example.com/start', { lookup: publicLookup, request: req, maxRedirects: 2 }),
    /重定向次数过多/,
  );
  assert.strictEqual(n, 3, '首次 + 2 次重定向');
});

await check('fetchLink：拒绝非文本内容类型与错误状态码', async () => {
  const binary = async () => makeResponse({ headers: { 'content-type': 'application/octet-stream' }, body: 'x' });
  await assert.rejects(
    fetchLink('https://example.com/a.zip', { lookup: publicLookup, request: binary }),
    /不支持的内容类型/,
  );

  const notFound = async () => makeResponse({ status: 404, headers: { 'content-type': 'text/html' } });
  await assert.rejects(
    fetchLink('https://example.com/missing', { lookup: publicLookup, request: notFound }),
    /HTTP 404/,
  );

  const gzipped = async () => makeResponse({
    headers: { 'content-type': 'text/html', 'content-encoding': 'gzip' },
    body: '<p>x</p>',
  });
  await assert.rejects(
    fetchLink('https://example.com/gzip', { lookup: publicLookup, request: gzipped }),
    /内容解压失败/,
  );
});

await check('decodeContentEncoding：gzip 正常解压，未知编码报错', () => {
  const zipped = gzipSync(Buffer.from('<p>压缩正文</p>'));
  assert.strictEqual(decodeContentEncoding(zipped, 'gzip', 1024).toString(), '<p>压缩正文</p>');
  assert.strictEqual(decodeContentEncoding(zipped, 'identity', 1024), zipped);
  assert.throws(() => decodeContentEncoding(zipped, 'zstd', 1024), /不支持的内容编码/);
  assert.throws(() => decodeContentEncoding(Buffer.from('not-gzip'), 'gzip', 1024), /内容解压失败/);
});

await check('fetchLink：gzip 响应可解码为正文', async () => {
  const zipped = gzipSync(Buffer.from('<html><head><title>压缩页</title></head><body><p>压缩正文</p></body></html>'));
  const req = async () => makeResponse({
    headers: { 'content-type': 'text/html; charset=utf-8', 'content-encoding': 'gzip' },
    body: zipped,
  });
  const out = await fetchLink('https://example.com/gzip-ok', { lookup: publicLookup, request: req });
  assert.strictEqual(out.title, '压缩页');
  assert.strictEqual(out.text, '压缩正文');
});

await check('fetchLink：text/plain 原样返回', async () => {
  const req = async () => makeResponse({ headers: { 'content-type': 'text/plain; charset=utf-8' }, body: 'hello\nworld' });
  const out = await fetchLink('https://example.com/a.txt', { lookup: publicLookup, request: req });
  assert.strictEqual(out.title, '');
  assert.strictEqual(out.text, 'hello\nworld');
});

// ---------------------------------------------------------------- 编排/落盘

const ws = join(await mkdtemp(join(tmpdir(), 'links-')), 'ws');

await check('LinkIngest：抓取成功时落盘全文，注入截取正文与路径', async () => {
  const longText = `开头 ${'内容'.repeat(3000)}`; // 远超 4000 字
  const fakeFetch = async () => ({
    url: 'https://example.com/a',
    finalUrl: 'https://example.com/a',
    title: '示例标题',
    text: longText,
    truncated: false,
  });
  const ingest = new LinkIngest({
    cwd: ws,
    fetchLink: fakeFetch,
    now: () => new Date(2026, 9, 30, 12, 0, 0),
  });
  const note = await ingest.enrich('帮我看看 https://example.com/a 讲了什么');

  assert.match(note, /不可信资料/);
  assert.match(note, /示例标题/);
  assert.match(note, /正文已保存到工作区：_inbox\/links\/link-/);
  assert.match(note, /正文（截取开头）/);

  const files = await readdir(join(ws, '_inbox', 'links'));
  assert.strictEqual(files.length, 1);
  const saved = await readFile(join(ws, '_inbox', 'links', files[0]), 'utf8');
  assert.match(saved, /# 示例标题/);
  assert.match(saved, /https:\/\/example\.com\/a/);
  assert.ok(saved.length > 4000);
});

await check('LinkIngest：抓取失败只记录，不抛出', async () => {
  const ingest = new LinkIngest({
    cwd: ws,
    fetchLink: async () => { throw new Error('拒绝访问内网/本地地址：x'); },
  });
  const note = await ingest.enrich('https://example.com/blocked');
  assert.match(note, /抓取失败/);
  assert.match(note, /拒绝访问内网/);
});

await check('LinkIngest：没有链接返回空串，不调用抓取', async () => {
  let called = 0;
  const ingest = new LinkIngest({ cwd: ws, fetchLink: async () => { called++; } });
  assert.strictEqual(await ingest.enrich('今天天气不错'), '');
  assert.strictEqual(called, 0);
});

await check('formatLinkContext：空输入返回空串，失败项也列出', () => {
  assert.strictEqual(formatLinkContext([]), '');
  const text = formatLinkContext([{ ok: false, url: 'https://x.com', error: '超时' }]);
  assert.match(text, /https:\/\/x\.com/);
  assert.match(text, /超时/);
});

await check('formatLinkContext：cached 项只给路径，不重复正文', () => {
  const text = formatLinkContext([{
    ok: true,
    url: 'https://x.com/a',
    title: '标题',
    chars: 1234,
    savedPath: '_inbox/links/a.txt',
    excerpt: '不应出现的正文',
    excerptTruncated: true,
    cached: true,
  }]);
  assert.match(text, /已在本会话抓取过/);
  assert.match(text, /_inbox\/links\/a\.txt/);
  assert.match(text, /共 1234 字/);
  assert.ok(!text.includes('不应出现的正文'));
  assert.ok(!text.includes('正文（截取开头）'));
});

await check('LinkIngest：单链接摘录默认不超过 1500 字符', async () => {
  const root = await mkdtemp(join(tmpdir(), 'links-cap-'));
  const capWs = join(root, 'ws');
  const longText = `开头 ${'内容'.repeat(2000)}`;
  const ingest = new LinkIngest({
    cwd: capWs,
    fetchLink: async () => ({
      url: 'https://example.com/long',
      finalUrl: 'https://example.com/long',
      title: '长文',
      text: longText,
      truncated: false,
    }),
  });
  const note = await ingest.enrich('https://example.com/long');
  assert.ok(note.length < 2500, `说明应只含短摘录，实际 ${note.length} 字符`);
  assert.match(note, /正文（截取开头）/);

  const files = await readdir(join(capWs, '_inbox', 'links'));
  const saved = await readFile(join(capWs, '_inbox', 'links', files[0]), 'utf8');
  assert.ok(saved.length > 1500, '完整正文仍应落盘');
  await rm(root, { recursive: true, force: true });
});

await check('LinkIngest：同一 peer 重复链接不重新抓取，只给路径', async () => {
  const root = await mkdtemp(join(tmpdir(), 'links-cache-'));
  const cacheWs = join(root, 'ws');
  let calls = 0;
  const ingest = new LinkIngest({
    cwd: cacheWs,
    fetchLink: async () => {
      calls++;
      return {
        url: 'https://example.com/a',
        finalUrl: 'https://example.com/a',
        title: '示例',
        text: '正文'.repeat(100),
        truncated: false,
      };
    },
  });

  const first = await ingest.enrich('看看 https://example.com/a', { peerId: 'u1' });
  const second = await ingest.enrich('再看 https://example.com/a', { peerId: 'u1' });
  assert.strictEqual(calls, 1, '同一 peer 同一 URL 不应重复抓取');
  assert.match(first, /正文：/);
  assert.match(second, /已在本会话抓取过/);
  assert.match(second, /_inbox\/links\/link-/);
  assert.ok(!second.includes('正文：'), '第二次不应重复注入正文');
  assert.ok(second.length < first.length);

  await ingest.enrich('https://example.com/a', { peerId: 'u2' });
  assert.strictEqual(calls, 2, '不同 peer 不共享缓存');

  ingest.reset('u1');
  await ingest.enrich('https://example.com/a', { peerId: 'u1' });
  assert.strictEqual(calls, 3, '/new 后应重新抓取');

  await ingest.enrich('https://example.com/a', { peerId: 'u2' });
  assert.strictEqual(calls, 3, 'reset(peer) 不应清掉其它 peer 的缓存');

  ingest.reset();
  await ingest.enrich('https://example.com/a', { peerId: 'u2' });
  assert.strictEqual(calls, 4, 'reset() 应清空全部缓存');
  await rm(root, { recursive: true, force: true });
});

await rm(join(ws, '..'), { recursive: true, force: true });

console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
