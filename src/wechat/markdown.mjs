/**
 * Markdown → 微信纯文本。
 *
 * 微信聊天不渲染 Markdown：标题会显示成 `## 标题`，加粗会显示成 `**字**`。
 * persona 里已经要求模型直接说话，但模型偶尔仍会输出 Markdown——这里做兜底转换，
 * 保证用户至少能读到干净的文字。
 *
 * 处理范围：
 *   - 标题（# ~ ######）：去掉标记，一二级用【】突出
 *   - 加粗 / 斜体 / 删除线 / 行内代码：去掉标记，保留文字
 *   - 链接 / 图片：转成「文字 (URL)」/「[图片] URL」
 *   - 表格：去掉分隔行，按 `列1 | 列2` 逐行展开
 *   - 代码围栏：去掉 ``` 行，保留代码内容原样（**不再解析**代码里的 Markdown）
 *   - 引用、列表、分割线、HTML 标签：做最小清理
 *
 * 刻意不做：
 *   - 不扫描/上传 Markdown 图片或链接（安全边界见 outbound-media.mjs）
 *   - 不改变 `[[image: ...]]` / `[[file: ...]]` 媒体指令（它们在调用本模块前已被提取）
 */

/** 单个代码块/表格超过多少字符算「大块」，应转为文件发送 */
export const DEFAULT_LARGE_BLOCK_CHARS = 1_500;

/** 独占一行的围栏：``` 或 ~~~（允许缩进与语言标记） */
const FENCE_RE = /^\s*(`{3,}|~{3,})(.*)$/;

/**
 * 把 Markdown 转成适合微信显示的纯文本。
 *
 * @param {string} input
 * @returns {string}
 */
export function markdownToPlainText(input) {
  const src = String(input ?? '');
  if (!src) return '';

  const lines = src.replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  /** @type {{char: string, len: number}|null} */
  let fence = null;
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    const fenceMatch = FENCE_RE.exec(line);

    // 代码块内：原样保留内容，只丢掉围栏标记本身
    if (fence) {
      if (fenceMatch && fenceMatch[1][0] === fence.char
        && fenceMatch[1].length >= fence.len && !fenceMatch[2].trim()) {
        fence = null;
        i++;
        continue;
      }
      out.push(line);
      i++;
      continue;
    }

    if (fenceMatch) {
      fence = { char: fenceMatch[1][0], len: fenceMatch[1].length };
      i++;
      continue;
    }

    // 表格：当前行是表头、下一行是分隔行
    if (looksLikeTableHeader(line) && isTableSeparator(lines[i + 1])) {
      out.push(formatTableRow(line));
      i += 2; // 跳过表头与分隔行（表头已输出）
      while (i < lines.length && looksLikeTableRow(lines[i])) {
        out.push(formatTableRow(lines[i]));
        i++;
      }
      continue;
    }

    // ATX 标题
    let m = /^\s{0,3}(#{1,6})\s+(.*?)(?:\s+#+)?\s*$/.exec(line);
    if (m) {
      const title = inline(m[2]);
      out.push(m[1].length <= 2 ? `【${title}】` : title);
      i++;
      continue;
    }

    // 分割线（--- / *** / ___）
    if (/^\s{0,3}(?:(?:\*\s*){3,}|(?:-\s*){3,}|(?:_\s*){3,})$/.test(line)) {
      out.push('');
      i++;
      continue;
    }

    // 引用（可嵌套）
    m = /^\s{0,3}(?:>\s?)+(.*)$/.exec(line);
    if (m) {
      out.push(inline(m[1]));
      i++;
      continue;
    }

    // 无序列表：保留缩进，换成 •（微信里比 - 更像列表）
    m = /^(\s*)[-*+]\s+(.*)$/.exec(line);
    if (m) {
      out.push(`${m[1]}• ${inline(m[2])}`);
      i++;
      continue;
    }

    // 有序列表：原样保留序号
    m = /^(\s*)(\d+)[.)]\s+(.*)$/.exec(line);
    if (m) {
      out.push(`${m[1]}${m[2]}. ${inline(m[3])}`);
      i++;
      continue;
    }

    out.push(inline(line));
    i++;
  }

  return out.join('\n').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * 找出回复里最大的代码块或表格，用于判断是否应该转成文件。
 *
 * @param {string} text
 * @param {object} [opts]
 * @param {number} [opts.codeChars]  - 代码块内容超过多少字符算大块
 * @param {number} [opts.tableChars] - 表格总字符数超过多少算大块
 * @returns {{kind: 'code'|'table', chars: number, lines: number}|null}
 */
export function findOversizeBlock(text, opts = {}) {
  const codeLimit = opts.codeChars ?? DEFAULT_LARGE_BLOCK_CHARS;
  const tableLimit = opts.tableChars ?? DEFAULT_LARGE_BLOCK_CHARS;
  const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n');

  /** @type {{kind: 'code'|'table', chars: number, lines: number}|null} */
  let best = null;
  const consider = (block) => {
    if (!best || block.chars > best.chars) best = block;
  };

  /** @type {{char: string, len: number}|null} */
  let fence = null;
  let codeChars = 0;
  let codeLines = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = FENCE_RE.exec(line);

    if (fence) {
      const closing = m && m[1][0] === fence.char
        && m[1].length >= fence.len && !m[2].trim();
      if (closing) {
        if (codeChars > codeLimit) consider({ kind: 'code', chars: codeChars, lines: codeLines });
        fence = null;
        codeChars = 0;
        codeLines = 0;
      } else {
        codeChars += line.length + 1;
        codeLines++;
      }
      continue;
    }

    if (m) {
      fence = { char: m[1][0], len: m[1].length };
      codeChars = 0;
      codeLines = 0;
      continue;
    }

    if (looksLikeTableHeader(line) && isTableSeparator(lines[i + 1])) {
      let chars = line.length + 1;
      let rows = 1;
      let j = i + 2;
      while (j < lines.length && looksLikeTableRow(lines[j])) {
        chars += lines[j].length + 1;
        rows++;
        j++;
      }
      if (chars > tableLimit) consider({ kind: 'table', chars, lines: rows });
      i = j - 1;
    }
  }

  // 未闭合的代码块：按到文件末尾算，避免漏判
  if (fence && codeChars > codeLimit) {
    consider({ kind: 'code', chars: codeChars, lines: codeLines });
  }

  return best;
}

// ---------------------------------------------------------------- internals

function looksLikeTableHeader(line) {
  return typeof line === 'string'
    && line.trim() !== ''
    && line.includes('|')
    && !FENCE_RE.test(line);
}

function looksLikeTableRow(line) {
  return typeof line === 'string' && line.trim() !== '' && line.includes('|');
}

function isTableSeparator(line) {
  if (typeof line !== 'string' || !line.includes('|')) return false;
  const cells = splitTableRow(line);
  return cells.length >= 1 && cells.every((c) => /^:?-{1,}:?$/.test(c));
}

function splitTableRow(line) {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|')) s = s.slice(0, -1);
  return s.split('|').map((c) => c.trim());
}

function formatTableRow(line) {
  return splitTableRow(line).map((c) => inline(c)).join(' | ');
}

/** 处理行内 Markdown：强调、链接、图片、行内代码、HTML。 */
function inline(text) {
  let s = String(text ?? '');
  if (!s) return '';

  s = s.replace(/<br\s*\/?>/gi, '\n');

  // 行内代码先抽成占位符，避免代码里的 * _ [ ] 被后续规则误伤
  const codes = [];
  s = s.replace(/`([^`\n]+)`/g, (_, code) => {
    codes.push(code);
    return `\u0000${codes.length - 1}\u0000`;
  });

  // 反斜杠转义也先藏起来，否则 \*星号\* 会先被斜体规则吃掉
  const escapes = [];
  s = s.replace(/\\([\\`*_{}[\]()#+\-.!|>~])/g, (_, ch) => {
    escapes.push(ch);
    return `\u0001${escapes.length - 1}\u0001`;
  });

  // 图片：![alt](url) → [图片] alt URL
  s = s.replace(
    /!\[([^\]]*)\]\(\s*([^)\s]+)(?:\s+["'][^"']*["'])?\s*\)/g,
    (_, alt, url) => (alt.trim() ? `[图片：${alt.trim()}] ${url}` : `[图片] ${url}`),
  );

  // 链接：[文字](url) → 文字 (url)；文字等于 URL 时只保留一份
  s = s.replace(
    /\[([^\]]+)\]\(\s*([^)\s]+)(?:\s+["'][^"']*["'])?\s*\)/g,
    (_, label, url) => {
      const t = label.trim();
      return !t || t === url ? url : `${t} (${url})`;
    },
  );

  // 删除线与强调
  s = s.replace(/~~([^~\n]+)~~/g, '$1');
  s = s.replace(/\*\*\*([^*\n]+)\*\*\*/g, '$1');
  s = s.replace(/___([^_\n]+)___/g, '$1');
  s = s.replace(/\*\*([^*\n]+)\*\*/g, '$1');
  s = s.replace(/__([^_\n]+)__/g, '$1');
  s = s.replace(/(^|[^\w*])\*([^*\s][^*\n]*?)\*(?![\w*])/g, '$1$2');
  s = s.replace(/(^|[^\w])_([^_\s][^_\n]*?)_(?!\w)/g, '$1$2');

  // HTML 标签（保留 <br> 已换成换行）
  s = s.replace(/<\/?[a-zA-Z][^>]*>/g, '');

  // 还原行内代码与转义字符
  s = s.replace(/\u0000(\d+)\u0000/g, (_, idx) => codes[Number(idx)] ?? '');
  s = s.replace(/\u0001(\d+)\u0001/g, (_, idx) => escapes[Number(idx)] ?? '');

  return s;
}
