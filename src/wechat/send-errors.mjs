/**
 * 出站错误分类：把任意发送错误归一成三类，作为重试/入队/DLQ 的唯一判据。
 *
 *   'token'     - context_token 失效：消息保留在 outbox，等用户下次入站，不消耗尝试次数
 *   'retryable' - 网络/超时/5xx/429：退避重试，达到上限进 DLQ
 *   'permanent' - 4xx 参数错误、文件不存在、未知错误：直接进 DLQ，避免无限重试
 *
 * 判断顺序固定：token → HTTP 状态码 → 错误码 → 文案兜底 → permanent。
 * 未知错误按 permanent 处理是刻意的：宁可放弃一条并告警，也不要无限重试。
 */

import { isTokenExpiredError } from './ilink.mjs';

/** 可重试的网络/运行时错误码 */
export const RETRYABLE_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ECONNABORTED',
  'ETIMEDOUT',
  'EPIPE',
  'EAI_AGAIN',
  'ENOTFOUND',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_SOCKET',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'ABORT_ERR',
]);

/** 可重试的 HTTP 状态码（5xx 另按区间判断） */
export const RETRYABLE_HTTP_STATUS = new Set([408, 425, 429]);

/**
 * 分类一个发送错误。
 * @param {unknown} err
 * @param {number} [depth] - 展开 cause 链的深度保护
 * @returns {'token'|'retryable'|'permanent'}
 */
export function classifySendError(err, depth = 0) {
  if (!err) return 'permanent';

  // 1. context_token 失效：唯一的「不消耗尝试次数」分支
  if (isTokenExpiredError(err)) return 'token';

  // 2. HTTP 状态码（IlinkHttpError.status）
  const status = Number(err.status);
  if (Number.isFinite(status) && status > 0) {
    if (status >= 500) return 'retryable';
    if (RETRYABLE_HTTP_STATUS.has(status)) return 'retryable';
    if (status >= 400) return 'permanent';
  }

  // 3. 错误码（fetch / undici / Node 网络栈）
  const code = String(err.code ?? '').toUpperCase();
  if (code && RETRYABLE_CODES.has(code)) return 'retryable';
  if (err.name === 'AbortError') return 'retryable';
  if (/abort/i.test(code)) return 'retryable';

  // 4. 文案兜底：有些错误只带 message，没有 code/status
  const text = `${err.errmsg ?? ''} ${err.message ?? ''}`.toLowerCase();
  // 4.1 被包装过的错误可能把状态码写进文案（如 "CDN 上传失败 HTTP 503"）
  const statusFromText = text.match(/http\s+(\d{3})/);
  if (statusFromText) {
    const s = Number(statusFromText[1]);
    if (s >= 500 || RETRYABLE_HTTP_STATUS.has(s)) return 'retryable';
    if (s >= 400) return 'permanent';
  }
  if (/timeout|timed out|socket hang up|network|other side closed|connection reset|fetch failed/.test(text)) {
    return 'retryable';
  }

  // 5. 有些代码用 { cause } 包装底层网络错误，继续向下分类
  if (err.cause && depth < 3) {
    const inner = classifySendError(err.cause, depth + 1);
    if (inner !== 'permanent') return inner;
  }

  // 6. 未知错误：永久失败，带原文进 DLQ
  return 'permanent';
}

/** 是否值得重试 */
export function isRetryable(err) {
  return classifySendError(err) === 'retryable';
}

/** 是否应该直接放弃 */
export function isPermanent(err) {
  return classifySendError(err) === 'permanent';
}
