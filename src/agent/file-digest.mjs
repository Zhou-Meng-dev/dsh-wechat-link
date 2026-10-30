/**
 * 微信文件 → 工作区的「探测 + 按需读取」策略。
 *
 * 文件内容从不进上下文，只给路径。真正容易污染上下文的是 agent 直接 read
 * 整个 PDF/XLSX（二进制读不了，或把整张表 dump 出来），所以：
 *   - 启动时把 doc_probe.py 写入 <workspace>/_tools/（零依赖，纯标准库）
 *   - 收到文件时只注入路径 + 类型 + 大小 + 明确的分步读取策略
 *
 * 扩展名/体积的展示逻辑抽成纯函数，便于测试。
 */

import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { assetFilePath } from '../assets.mjs';
import { extname, join } from 'node:path';

/** 脚本在工作区里的相对路径（agent 的 cwd 就是工作区） */
export const PROBE_REL = '_tools/doc_probe.py';

/**
 * 把 doc_probe.py 写入租户工作区。内容没变就不重写（避免刷 mtime）。
 * @param {string} workspace
 * @returns {Promise<string>} 脚本绝对路径
 */
export async function ensureDocProbe(workspace) {
  const dir = join(workspace, '_tools');
  const dest = join(dir, 'doc_probe.py');
  const body = await readFile(await assetFilePath('src/agent/doc-probe.py'), 'utf8');

  try {
    if ((await readFile(dest, 'utf8')) === body) return dest;
  } catch {
    // 不存在或读不了：继续写
  }

  await mkdir(dir, { recursive: true });
  await writeFile(dest, body, { mode: 0o644 });
  await chmod(dest, 0o644);
  return dest;
}

const KINDS = {
  '.pdf': 'PDF',
  '.xlsx': 'Excel',
  '.xls': 'Excel（旧格式）',
  '.csv': 'CSV',
  '.tsv': 'TSV',
  '.docx': 'Word',
  '.doc': 'Word（旧格式）',
  '.pptx': 'PPT',
  '.txt': '文本',
  '.md': 'Markdown',
  '.json': 'JSON',
  '.log': '日志',
  '.zip': '压缩包',
};

/** 给人看的文件类型（只按扩展名，探测细节交给脚本） */
export function fileKind(name) {
  return KINDS[extname(String(name ?? '')).toLowerCase()] ?? '文件';
}

/** 人类可读体积 */
export function formatBytes(n) {
  if (!Number.isFinite(n) || n < 0) return '?';
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / 1024 / 1024).toFixed(1)}MB`;
}

/**
 * 生成注入给 agent 的文件说明。
 *
 * @param {{ok:boolean,path?:string,name?:string,bytes?:number}[]} files
 * @param {{probe?:string}} [opts]
 * @returns {string} 没有文件时返回 ''
 */
export function formatFileNote(files, opts = {}) {
  if (!Array.isArray(files) || files.length === 0) return '';
  const probe = opts.probe ?? PROBE_REL;

  const items = files.map((f) => (f.ok
    ? `- ${f.path}（${f.name}，${fileKind(f.name)}，${formatBytes(f.bytes)}）`
    : `- ${f.name ?? '(未命名)'}（下载失败，无法读取）`));

  return [
    '用户发来了文件，已保存到你的工作目录：',
    ...items,
    '',
    '**不要把整份文件读进上下文。** 先探测结构，再按需读取：',
    `  python3 ${probe} <文件>           # 类型 / 页数 / 工作表 / 表头 / 前几行`,
    `  python3 ${probe} --help          # 其它选项（按页/按表/按行、落盘、OCR 参数）`,
    '只把必要的片段读入上下文；路径含空格时加引号。',
    '扫描件会自动尝试 OCR；缺 pdftotext / pdftoppm / tesseract 时如实告诉用户，不要反复重试。',
  ].join('\n');
}
