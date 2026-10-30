/**
 * 首次启动配置向导。
 *
 * 触发条件（全部满足才问，避免打扰已有部署）：
 *   - 明显是首次：还没有任何租户、setup.json 不存在、也没有可用的预设 key
 *   - stdin 是 TTY（systemd / Docker / 管道环境自动跳过，保持无人值守）
 *   - 未设置 BRIDGE_SKIP_SETUP=1
 *
 * 只问一样东西：DeepSeek API key。
 *   - 填了 → 写入 secrets.json 的 defaultApiKey，之后新增的 bot 自动继承
 *   - 回车 → 跳过，回退宿主 ~/.dsh/.credentials.yaml
 *
 * 无论填不填都写 setup.json，避免下次启动重复询问。
 * 想重新配置：`dsh-wechat-link setup`（显式命令不受 TTY 与标记限制）。
 */

import { existsSync } from 'node:fs';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { bridgeHome, setupMarkerPath } from '../config.mjs';

export const SETUP_VERSION = 1;

/** DeepSeek API key 的宽松校验（与 CLI apikey 命令保持一致）。 */
export function validateApiKey(key) {
  return /^sk-[A-Za-z0-9_-]{8,}$/.test(String(key ?? '').trim());
}

/**
 * 是否应该自动进入首次配置向导。
 *
 * @param {object} opts
 * @param {boolean} opts.markerExists - setup.json 是否已存在
 * @param {number}  opts.tenantCount  - 已配置租户数
 * @param {boolean} opts.hasApiKey    - 已有可用预设 key（文件或环境变量）
 * @param {boolean} opts.isTTY        - stdin 是否交互终端
 * @param {boolean} [opts.skip]       - BRIDGE_SKIP_SETUP=1
 * @returns {boolean}
 */
export function shouldRunSetup({ markerExists, tenantCount, hasApiKey, isTTY, skip = false }) {
  if (skip) return false;
  if (!isTTY) return false;
  if (markerExists) return false;
  if (hasApiKey) return false;          // 用户已经显式配过 key，不必再问
  if (Number(tenantCount) > 0) return false; // 已有 bot，说明早跑起来了
  return true;
}

/**
 * TTY 下读取不回显的一行（API key 不该出现在终端回滚里）。
 * 只做最小行编辑：退格、回车、Ctrl+C/Ctrl+D。
 *
 * @param {string} prompt
 * @param {object} [opts]
 * @param {NodeJS.ReadStream} [opts.input]
 * @param {NodeJS.WriteStream} [opts.output]
 * @returns {Promise<string>}
 */
export function readSecretLine(prompt, opts = {}) {
  const input = opts.input ?? process.stdin;
  const output = opts.output ?? process.stdout;

  return new Promise((resolve, reject) => {
    output.write(prompt);
    const wasRaw = Boolean(input.isRaw);
    if (input.isTTY) input.setRawMode(true);
    input.resume?.();
    input.setEncoding?.('utf8');

    let value = '';
    let settled = false;

    const finish = (err) => {
      if (settled) return;
      settled = true;
      input.removeListener('data', onData);
      if (input.isTTY) input.setRawMode(wasRaw);
      input.pause?.();
      output.write('\n');
      if (err) reject(err);
      else resolve(value.trim());
    };

    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') { finish(null); return; }
        if (ch === '\u0003' || ch === '\u0004') { finish(new Error('已取消')); return; }
        if (ch === '\u007f' || ch === '\b') {
          if (value) {
            value = value.slice(0, -1);
            output.write('\b \b');
          }
          continue;
        }
        // 忽略其余控制字符；API key 是 ASCII
        if (ch >= ' ') {
          value += ch;
          output.write('*');
        }
      }
    };

    input.on('data', onData);
  });
}

/**
 * 按行读取一个可读流（管道场景）。
 *
 * 与 readline 不同：已经收到但还没被 ask 消费的行会留在队列里，
 * 即使流已经 EOF 也能继续返回缓冲行；队列空且已 EOF 时返回空串（= 跳过）。
 */
function createLineReader(input) {
  const lines = [];
  const waiters = [];
  let buffer = '';
  let ended = false;

  const flush = () => {
    while (waiters.length > 0 && lines.length > 0) waiters.shift()(lines.shift());
    if (ended) while (waiters.length > 0) waiters.shift()('');
  };

  const onData = (chunk) => {
    buffer += chunk;
    let i;
    while ((i = buffer.indexOf('\n')) >= 0) {
      lines.push(buffer.slice(0, i).replace(/\r$/, ''));
      buffer = buffer.slice(i + 1);
    }
    flush();
  };
  const onEnd = () => {
    if (buffer) { lines.push(buffer.replace(/\r$/, '')); buffer = ''; }
    ended = true;
    flush();
  };

  input.setEncoding?.('utf8');
  input.on('data', onData);
  input.on('end', onEnd);
  input.resume?.();

  return {
    next() {
      if (lines.length > 0) return Promise.resolve(lines.shift());
      if (ended) return Promise.resolve('');
      return new Promise((resolve) => waiters.push(resolve));
    },
    close() {
      input.removeListener('data', onData);
      input.removeListener('end', onEnd);
      input.pause?.();
      lines.length = 0;
      waiters.length = 0;
    },
  };
}

/**
 * 运行向导。
 *
 * @param {object} opts
 * @param {import('../config.mjs').ConfigStore} opts.store
 * @param {boolean} [opts.force]   - 重新配置（忽略 setup.json）
 * @param {NodeJS.ReadStream} [opts.input]
 * @param {NodeJS.WriteStream} [opts.output]
 * @param {boolean} [opts.tty]     - 默认按 input.isTTY
 * @param {(m: string) => void} [opts.log]
 * @param {(m: string) => void} [opts.warn]
 * @returns {Promise<{ran: boolean, apiKeySet: boolean}>}
 */
export async function runSetup({
  store,
  force = false,
  input = process.stdin,
  output = process.stdout,
  tty = Boolean(input.isTTY),
  log = () => {},
  warn = () => {},
} = {}) {
  const marker = setupMarkerPath();
  if (!force && existsSync(marker)) return { ran: false, apiKeySet: false };

  const secrets = await store.secrets.read();
  const currentKey = String(secrets.defaultApiKey ?? '').trim();

  output.write(`\n🔧 配置向导（配置目录: ${bridgeHome()}）\n`);
  output.write('   DeepSeek API key（sk-...）\n');
  output.write(currentKey
    ? '   直接回车保留现有 key；输入新 key 覆盖\n'
    : '   直接回车跳过，改用宿主 ~/.dsh/.credentials.yaml\n');

  // 非 TTY 用自建的行队列，而不是 readline：
  // 管道可能一次性吐完多行并立即 EOF，readline 会在第一问后就 close，
  // 第二次提问直接抛 ERR_USE_AFTER_CLOSE。
  const reader = tty ? null : createLineReader(input);
  const ask = () => (tty
    ? readSecretLine('   key: ', { input, output })
    : reader.next().then((s) => s.trim()));

  let key = '';
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      const answer = await ask();
      if (!answer) break; // 回车 = 跳过 / 保留
      if (validateApiKey(answer)) { key = answer; break; }
      warn('格式不像 DeepSeek API key（应以 sk- 开头），请重试；回车可跳过');
    }
  } finally {
    reader?.close();
  }

  if (key) {
    secrets.defaultApiKey = key;
    await store.secrets.write(secrets);
    output.write('   ✅ 已写入 secrets.json（之后新增的 bot 会自动继承）\n');
  } else if (currentKey) {
    output.write('   ℹ️ 保留现有 API key\n');
  } else {
    output.write('   ℹ️ 未设置 API key，将使用宿主凭据'
      + '（之后可用 `setup` 或 `apikey --default` 设置）\n');
  }

  const effective = Boolean(key || currentKey);
  await writeSetupMarker({ apiKeySet: effective });
  log(`首次配置完成（API key: ${effective ? '已设置' : '未设置，用宿主凭据'}）`);
  return { ran: true, apiKeySet: effective };
}

async function writeSetupMarker({ apiKeySet }) {
  const path = setupMarkerPath();
  await mkdir(dirname(path), { recursive: true, mode: 0o700 }).catch(() => {});
  const tmp = `${path}.tmp-${process.pid}`;
  const body = `${JSON.stringify({
    version: SETUP_VERSION,
    completedAt: new Date().toISOString(),
    apiKeySet: Boolean(apiKeySet),
  }, null, 2)}\n`;
  await writeFile(tmp, body, { mode: 0o600 });
  await rename(tmp, path);
}
