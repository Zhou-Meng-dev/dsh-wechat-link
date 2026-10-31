#!/usr/bin/env node
/**
 * 出站错误分类与退避策略。
 *
 * 分类是全项目唯一判据：改错一个分支，可能导致永久错误无限重试，
 * 或者一次网络抖动就把用户消息丢进 DLQ。
 */
import assert from 'node:assert/strict';

import { IlinkHttpError, IlinkSendError } from '../src/wechat/ilink.mjs';
import {
  RETRYABLE_CODES,
  RETRYABLE_HTTP_STATUS,
  classifySendError,
  isPermanent,
  isRetryable,
} from '../src/wechat/send-errors.mjs';
import {
  DEFAULT_MAX_ATTEMPTS,
} from '../src/wechat/retry-policy.mjs';

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

const httpError = (status) => new IlinkHttpError(`HTTP ${status}`, { status, endpoint: 'x' });

await check('token 失效：IlinkSendError ret=-1 归为 token', () => {
  const err = new IlinkSendError('ret=-1', { ret: -1, errmsg: 'invalid context token' });
  assert.strictEqual(classifySendError(err), 'token');
  assert.strictEqual(isRetryable(err), false);
  assert.strictEqual(isPermanent(err), false);
});

await check('token 失效优先于 HTTP 状态码', () => {
  const err = new IlinkHttpError('context_token expired', { status: 500 });
  // errmsg 不在 message 里时仍按状态码；这里 message 命中 token 关键词
  assert.strictEqual(classifySendError(err), 'token');
});

await check('HTTP 5xx / 429 / 408 → retryable', () => {
  for (const status of [500, 502, 503, 504, 429, 408]) {
    assert.strictEqual(classifySendError(httpError(status)), 'retryable', `HTTP ${status}`);
  }
});

await check('HTTP 4xx（参数错误）→ permanent', () => {
  for (const status of [400, 401, 403, 404, 413]) {
    assert.strictEqual(classifySendError(httpError(status)), 'permanent', `HTTP ${status}`);
  }
});

await check('网络错误码 → retryable', () => {
  for (const code of ['ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'EAI_AGAIN', 'UND_ERR_SOCKET']) {
    assert.ok(RETRYABLE_CODES.has(code), `${code} 应在白名单里`);
    assert.strictEqual(classifySendError(Object.assign(new Error('net'), { code })), 'retryable');
  }
});

await check('AbortError（超时中断）→ retryable', () => {
  const err = new Error('aborted');
  err.name = 'AbortError';
  assert.strictEqual(classifySendError(err), 'retryable');
});

await check('只有文案的 timeout / socket hang up → retryable', () => {
  assert.strictEqual(classifySendError(new Error('request timeout')), 'retryable');
  assert.strictEqual(classifySendError(new Error('socket hang up')), 'retryable');
  assert.strictEqual(classifySendError(new Error('network error')), 'retryable');
});

await check('ENOENT（文件不存在）→ permanent', () => {
  assert.strictEqual(classifySendError(Object.assign(new Error('no such file'), { code: 'ENOENT' })), 'permanent');
});

await check('被包装的错误：沿 cause 链继续分类', () => {
  const inner = Object.assign(new Error('fetch failed'), { code: 'ECONNRESET' });
  const outer = new Error('获取上传地址失败: fetch failed', { cause: inner });
  assert.strictEqual(classifySendError(outer), 'retryable');
});

await check('文案里的 HTTP 状态码也参与分类', () => {
  assert.strictEqual(classifySendError(new Error('CDN 上传失败 HTTP 503')), 'retryable');
  assert.strictEqual(classifySendError(new Error('CDN 拒绝上传 HTTP 413')), 'permanent');
});

await check('cause 链过深不会无限递归', () => {
  let err = new Error('top');
  for (let i = 0; i < 10; i++) err = new Error(`layer ${i}`, { cause: err });
  assert.strictEqual(classifySendError(err), 'permanent');
});

await check('未知错误按 permanent（不无限重试）', () => {
  assert.strictEqual(classifySendError(new Error('unexpected boom')), 'permanent');
  assert.strictEqual(classifySendError(null), 'permanent');
});

await check('常量集合与分类保持一致', () => {
  for (const s of RETRYABLE_HTTP_STATUS) assert.strictEqual(classifySendError(httpError(s)), 'retryable');
  assert.strictEqual(DEFAULT_MAX_ATTEMPTS, 6);
});

console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
