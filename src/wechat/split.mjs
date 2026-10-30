/**
 * 微信长回复分段。
 *
 * 背景：iLink sendmessage 对单条文本有长度上限，超过会返回 ret=-2
 * （`prepare failed`）。实测约 5400 字符（中文）附近开始失败，且不同内容
 * 类型（含大量换行/特殊字符）边界不稳定，因此取保守值。
 *
 * 分段策略（按优先级尝试切点，避免把句子/代码块拦腰截断）：
 *   1. 空行（段落边界）
 *   2. 单个换行
 *   3. Markdown 代码围栏 ``` 的边界
 *   4. 中英文句末标点（。！？；.!?;）
 *   5. 空格
 *   6. 实在没有，硬切
 *
 * 每段带 " (i/n)" 后缀时不会超限：切点计算时已为后缀预留空间。
 */

/** 单条消息的安全长度上限（留余量，实测 5400 附近开始失败）。 */
export const DEFAULT_MAX_CHARS = 1800;

/** 后缀形如 " (12/34)"，最长按 99/99 估算 */
const SUFFIX_RESERVE = 8;

const HARD_BOUNDARIES = [
  { name: 'paragraph', re: /\n\s*\n/g },
  { name: 'newline', re: /\n/g },
  { name: 'sentence', re: /[。！？；!?;]/g },
  { name: 'space', re: /\s/g },
];

/**
 * 把长文本切成若干段。
 * @param {string} text
 * @param {number} [maxChars] 每段最大字符数（含序号后缀预留）
 * @returns {string[]} 至少一段（除空输入返回空数组）
 */
export function splitMessage(text, maxChars = DEFAULT_MAX_CHARS) {
  if (typeof text !== 'string' || text.length === 0) return [];
  const limit = Math.max(64, Math.floor(maxChars) - SUFFIX_RESERVE);
  if (text.length <= limit) return [text];

  const chunks = [];
  let rest = text;

  while (rest.length > limit) {
    // 只在 [limit*0.5, limit] 窗口内找切点，避免切出太碎的小段
    const windowStart = Math.floor(limit * 0.5);
    let cut = -1;

    for (const { re } of HARD_BOUNDARIES) {
      re.lastIndex = 0;
      let m;
      let best = -1;
      // 找出窗口内最后一个切点
      while ((m = re.exec(rest)) !== null) {
        const end = m.index + m[0].length;
        if (end > limit) break;
        if (end >= windowStart) best = end;
      }
      if (best > 0) {
        cut = best;
        break;
      }
    }

    if (cut <= 0) cut = limit; // 硬切

    const piece = rest.slice(0, cut);
    if (piece.trim()) chunks.push(piece.trimEnd());
    rest = rest.slice(cut).replace(/^\s+/, '');
  }

  if (rest.trim()) chunks.push(rest.trimEnd());
  return chunks;
}

/**
 * 给分段加上 (i/n) 标记。只有一段时不加。
 * @param {string[]} chunks
 * @returns {string[]}
 */
export function labelChunks(chunks) {
  if (chunks.length <= 1) return chunks;
  const total = chunks.length;
  return chunks.map((c, i) => `${c}\n\n(${i + 1}/${total})`);
}
