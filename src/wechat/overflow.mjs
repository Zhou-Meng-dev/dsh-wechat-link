/**
 * 超长回复转文件。
 *
 * 微信里几十条 1800 字的分段会刷屏，而且代码/表格被拦腰切开很难读。
 * 超过阈值时把完整内容写成工作区 `_outbox/` 下的 .md 文件，用现有的
 * FILE 上传链路发出去，聊天里只留一句摘要。
 *
 * 阈值（可按需调整）：
 *   - 全文超过 4000 字
 *   - 单个代码块或表格超过 1500 字
 *
 * 文件保留 7 天 / 最多 50 个，自动清理，避免工作区无限膨胀。
 */

import { randomBytes } from 'node:crypto';
import { mkdir, readdir, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { DEFAULT_LARGE_BLOCK_CHARS, findOversizeBlock } from './markdown.mjs';

/** 全文超过多少字符转为文件 */
export const DEFAULT_OVERFLOW_CHARS = 4_000;
/** 生成文件所在目录（相对租户工作区） */
export const OUTBOX_DIR = '_outbox';

const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_OUTBOX_FILES = 50;

/**
 * 判断一条回复是否需要转文件。
 *
 * @param {string} text - 已去掉媒体指令后的正文（保留原始 Markdown）
 * @param {object} [opts]
 * @param {number} [opts.maxChars]      - 全文阈值
 * @param {number} [opts.maxBlockChars] - 代码块/表格阈值
 * @returns {{overflow: boolean, reason: 'length'|'code'|'table'|null,
 *            chars: number, block: {kind: string, chars: number, lines: number}|null}}
 */
export function analyzeOversize(text, opts = {}) {
  const src = String(text ?? '');
  const maxChars = opts.maxChars ?? DEFAULT_OVERFLOW_CHARS;
  const maxBlockChars = opts.maxBlockChars ?? DEFAULT_LARGE_BLOCK_CHARS;

  if (src.length > maxChars) {
    return { overflow: true, reason: 'length', chars: src.length, block: null };
  }

  const block = findOversizeBlock(src, { codeChars: maxBlockChars, tableChars: maxBlockChars });
  if (block) {
    return { overflow: true, reason: block.kind, chars: block.chars, block };
  }

  return { overflow: false, reason: null, chars: src.length, block: null };
}

/**
 * 把完整内容写到 `<workspace>/_outbox/reply-*.md`。
 *
 * @param {string} workspace - 租户工作区
 * @param {string} text
 * @param {object} [opts]
 * @param {string} [opts.fileName] - 指定文件名（测试用）
 * @param {Date} [opts.now]
 * @returns {Promise<{relPath: string, name: string, absPath: string, bytes: number}>}
 */
export async function writeOverflowFile(workspace, text, opts = {}) {
  if (!workspace) throw new Error('缺少工作区路径');
  const name = opts.fileName ?? makeOverflowFileName(opts.now ?? new Date());
  const dir = join(workspace, OUTBOX_DIR);
  await mkdir(dir, { recursive: true });

  const body = String(text ?? '');
  const content = body.endsWith('\n') ? body : `${body}\n`;
  const absPath = join(dir, name);
  await writeFile(absPath, content, 'utf8');

  // 清理失败不影响发送
  await pruneOutbox(dir).catch(() => {});

  return {
    relPath: `${OUTBOX_DIR}/${name}`,
    name,
    absPath,
    bytes: Buffer.byteLength(content),
  };
}

/**
 * 生成安全的文件名：reply-YYYYMMDD-HHMMSS-xxxx.md（本地时间 + 随机后缀防撞）。
 * @param {Date} [date]
 */
export function makeOverflowFileName(date = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  const stamp = [
    date.getFullYear(),
    p(date.getMonth() + 1),
    p(date.getDate()),
    '-',
    p(date.getHours()),
    p(date.getMinutes()),
    p(date.getSeconds()),
  ].join('');
  return `reply-${stamp}-${randomBytes(2).toString('hex')}.md`;
}

/**
 * 为聊天窗口生成一句摘要（纯文本，不超长）。
 *
 * @param {string} plainText - 已转成纯文本的正文
 * @param {number} [maxLen]
 * @returns {string}
 */
export function summarizeForChat(plainText, maxLen = 120) {
  const flat = String(plainText ?? '').replace(/\s+/g, ' ').trim();
  if (!flat) return '';
  if (flat.length <= maxLen) return flat;

  // 只取第一句，避免把正文开头整段贴回聊天窗口
  const end = flat.search(/[。！？.!?]/);
  if (end >= 0) {
    const sentence = flat.slice(0, end + 1);
    return sentence.length <= maxLen ? sentence : `${sentence.slice(0, maxLen - 1)}…`;
  }

  return `${flat.slice(0, maxLen - 1).replace(/[，,、；;\s]+$/, '')}…`;
}

/**
 * 组装发送给用户的文件说明 + 摘要。
 *
 * @param {object} opts
 * @param {string} opts.fileName
 * @param {number} opts.chars     - 原文字符数
 * @param {string} opts.plainText - 已转成纯文本的正文
 * @returns {string}
 */
export function buildOverflowNote({ fileName, chars, plainText }) {
  const head = `内容较长（约 ${chars} 字），已整理成文件发送：${fileName}`;
  const excerpt = summarizeForChat(plainText);
  return excerpt ? `${head}\n摘要：${excerpt}` : head;
}

// ---------------------------------------------------------------- internals

/** 只清理本模块生成的文件，不碰工作区里的其它文件。 */
async function pruneOutbox(dir, opts = {}) {
  const maxAgeMs = opts.maxAgeMs ?? RETENTION_MS;
  const maxFiles = opts.maxFiles ?? MAX_OUTBOX_FILES;
  const names = (await readdir(dir).catch(() => []))
    .filter((n) => /^reply-.*\.md$/.test(n));

  const now = Date.now();
  const kept = [];
  for (const name of names) {
    const full = join(dir, name);
    const st = await stat(full).catch(() => null);
    if (!st?.isFile()) continue;
    if (now - st.mtimeMs > maxAgeMs) {
      await unlink(full).catch(() => {});
      continue;
    }
    kept.push({ name, mtimeMs: st.mtimeMs });
  }

  kept.sort((a, b) => b.mtimeMs - a.mtimeMs);
  for (const item of kept.slice(maxFiles)) {
    await unlink(join(dir, item.name)).catch(() => {});
  }
}
