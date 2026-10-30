#!/usr/bin/env node
/**
 * 超长回复转文件：阈值判断、落盘、摘要、目录清理。
 * 最后用 outbound-media 的路径校验确认生成的文件能被正常发送。
 */
import assert from 'node:assert';
import { mkdtemp, mkdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  analyzeOversize,
  buildOverflowNote,
  makeOverflowFileName,
  summarizeForChat,
  writeOverflowFile,
  DEFAULT_OVERFLOW_CHARS,
  OUTBOX_DIR,
} from '../src/wechat/overflow.mjs';
import { prepareMediaForUpload } from '../src/wechat/outbound-media.mjs';

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

await check('默认阈值为 4000 字', () => {
  assert.strictEqual(DEFAULT_OVERFLOW_CHARS, 4000);
});

await check('短回复不转文件', () => {
  const r = analyzeOversize('你好，这是一条普通回复。');
  assert.strictEqual(r.overflow, false);
  assert.strictEqual(r.reason, null);
});

await check('超过字符阈值 → reason=length', () => {
  const r = analyzeOversize('字'.repeat(4001));
  assert.strictEqual(r.overflow, true);
  assert.strictEqual(r.reason, 'length');
  assert.strictEqual(r.chars, 4001);
});

await check('大代码块触发 → reason=code', () => {
  const code = '说明\n```js\n' + 'const x = 1;\n'.repeat(200) + '```';
  const r = analyzeOversize(code);
  assert.strictEqual(r.overflow, true);
  assert.strictEqual(r.reason, 'code');
  assert.strictEqual(r.block.kind, 'code');
});

await check('大表格触发 → reason=table', () => {
  const rows = Array.from({ length: 200 }, (_, i) => `| 行${i} | 值${i} |`);
  const table = ['| 名称 | 值 |', '| --- | --- |', ...rows].join('\n');
  const r = analyzeOversize(table);
  assert.strictEqual(r.overflow, true);
  assert.strictEqual(r.reason, 'table');
});

await check('阈值可覆盖', () => {
  assert.strictEqual(analyzeOversize('12345678901', { maxChars: 10 }).overflow, true);
  assert.strictEqual(analyzeOversize('12345', { maxChars: 100 }).overflow, false);
});

await check('文件名格式固定且不含路径分隔符', () => {
  const name = makeOverflowFileName(new Date(2026, 9, 29, 1, 2, 3));
  assert.match(name, /^reply-20261029-010203-[0-9a-f]{4}\.md$/);
});

const root = await mkdtemp(join(tmpdir(), 'overflow-'));
const ws = join(root, 'workspace');
await mkdir(ws, { recursive: true });

await check('写到工作区 _outbox/ 下，内容完整（补一个换行）', async () => {
  const text = '# 标题\n\n' + '正文'.repeat(2500);
  const file = await writeOverflowFile(ws, text, { fileName: 'reply-20261029-010203-abcd.md' });
  assert.strictEqual(file.relPath, `${OUTBOX_DIR}/reply-20261029-010203-abcd.md`);
  assert.strictEqual(file.name, 'reply-20261029-010203-abcd.md');
  assert.strictEqual(file.absPath, join(ws, OUTBOX_DIR, file.name));
  const saved = await readFile(file.absPath, 'utf8');
  assert.strictEqual(saved, `${text}\n`);
  assert.strictEqual(file.bytes, Buffer.byteLength(saved));
});

await check('生成的文件能通过出站媒体的路径校验并读回', async () => {
  const file = await writeOverflowFile(ws, '长内容', { fileName: 'reply-20261029-010204-beef.md' });
  const prepared = await prepareMediaForUpload(file.relPath, ws, 'file');
  assert.strictEqual(prepared.kind, 'file');
  assert.strictEqual(prepared.name, file.name);
  assert.strictEqual(prepared.buffer.toString('utf8'), '长内容\n');
});

await check('清理 _outbox 里过期的 reply-*.md，但不动其它文件', async () => {
  const dir = join(ws, OUTBOX_DIR);
  const old = join(dir, 'reply-old.md');
  const keep = join(dir, 'notes.txt');
  await writeFile(old, 'old');
  await writeFile(keep, 'keep');

  const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
  await utimes(old, eightDaysAgo, eightDaysAgo);

  await writeOverflowFile(ws, '新内容', { fileName: 'reply-20261029-010205-cafe.md' });

  await assert.rejects(() => stat(old), /ENOENT/);
  assert.ok((await stat(keep)).isFile(), '不应删除非 reply-*.md 文件');
});

await check('摘要取第一句，过长时截断并加省略号', () => {
  assert.strictEqual(summarizeForChat('第一句。第二句。'), '第一句。第二句。');
  assert.strictEqual(
    summarizeForChat('第一句话。第二句话。' + '填充'.repeat(100), 30),
    '第一句话。',
  );
  const long = '这是一段很长的开头，'.repeat(20);
  const s = summarizeForChat(long, 40);
  assert.ok(s.length <= 40, `摘要长度 ${s.length}`);
  assert.ok(s.endsWith('…'));
});

await check('摘要压平换行和多余空格', () => {
  assert.strictEqual(summarizeForChat('第一行\n\n  第二行'), '第一行 第二行');
});

await check('文件说明包含文件名、字符数与摘要', async () => {
  const note = buildOverflowNote({
    fileName: 'reply-20261029-010203-abcd.md',
    chars: 5234,
    plainText: '报告分为三部分。第一部分是数据。',
  });
  assert.match(note, /约 5234 字/);
  assert.match(note, /reply-20261029-010203-abcd\.md/);
  assert.match(note, /摘要：报告分为三部分。/);
});

await check('没有可摘录内容时只给文件说明', () => {
  const note = buildOverflowNote({ fileName: 'a.md', chars: 10, plainText: '   ' });
  assert.strictEqual(note, '内容较长（约 10 字），已整理成文件发送：a.md');
});

await rm(root, { recursive: true, force: true });

console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
