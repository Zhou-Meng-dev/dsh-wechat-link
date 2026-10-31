/**
 * 原子写文件工具：临时文件 + rename，失败清理。
 *
 * 为什么单独抽出来：
 *   sync.json / dlq.json / limits.json 都要求「要么是旧的完整内容，
 *   要么是新的完整内容」，写一半崩溃不能留下半个 JSON。config / outbox / usage
 *   里已经各有一份私有实现，这里不回头重构它们（避免扩大改动范围），
 *   只给新模块提供一个统一入口。
 *
 * 约定：
 *   - 文件权限默认 0600（配置/凭据/队列都含用户数据）
 *   - 目录默认 0700（只对本次新建的目录生效，不改已存在的父目录）
 *   - 写失败时尽力删除临时文件，然后抛出原始错误（失败要显式）
 */

import { chmod, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { dirname } from 'node:path';

let tmpSeq = 0;

/**
 * 原子写文本。
 *
 * @param {string} path - 目标文件绝对路径
 * @param {string} text
 * @param {object} [opts]
 * @param {number} [opts.mode=0o600]    - 目标文件权限
 * @param {number} [opts.dirMode=0o700] - 新建目录权限
 * @returns {Promise<void>}
 */
export async function atomicWriteText(path, text, { mode = 0o600, dirMode = 0o700 } = {}) {
  await mkdir(dirname(path), { recursive: true, mode: dirMode });
  const tmp = `${path}.tmp-${process.pid}-${tmpSeq++}-${randomBytes(3).toString('hex')}`;
  try {
    await writeFile(tmp, text, { mode });
    // 部分平台/文件系统会忽略 writeFile 的 mode，再显式 chmod 一次。
    // 只有 Windows 的「不支持/无权限」可忽略；其它失败必须显式报错（0600 是安全要求）。
    try {
      await chmod(tmp, mode);
    } catch (err) {
      if (process.platform !== 'win32' || (err?.code !== 'ENOSYS' && err?.code !== 'EPERM')) throw err;
    }
    await rename(tmp, path);
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

/**
 * 原子写 JSON（人类可读的 2 空格缩进 + 末尾换行）。
 * @param {string} path
 * @param {unknown} value
 * @param {object} [opts] - 同 atomicWriteText
 */
export function atomicWriteJson(path, value, opts = {}) {
  return atomicWriteText(path, `${JSON.stringify(value, null, 2)}\n`, opts);
}
