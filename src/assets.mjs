/**
 * 单文件（Node SEA）下的资源定位。
 *
 * 普通源码运行时，资源在仓库里（examples/persona.md、src/*.py），直接用文件路径。
 * 打成单文件后，这些资源被嵌入 SEA blob，必须通过 sea.getAsset() 取出，
 * 解压到缓存目录后才能交给 readFile / 写入租户工作区。
 *
 * 资源名必须与 build/sea-config.json 的 assets key 完全一致。
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 当前是否运行在 Node SEA 单文件里。
 * 非 SEA（源码运行）或 Node 版本没有 node:sea 时返回 false。
 */
export async function isSeaRuntime() {
  try {
    const sea = await import('node:sea');
    return typeof sea.isSea === 'function' && sea.isSea();
  } catch {
    return false;
  }
}

/** 源码运行时的资源路径（SEA 下不会走到这里）。 */
function sourcePath(name) {
  return fileURLToPath(new URL(`../${name}`, import.meta.url));
}

async function writeIfNeeded(path, bytes) {
  try {
    const current = await readFile(path);
    if (current.equals(bytes)) return path;
  } catch {
    // 不存在：继续写
  }
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, bytes, { mode: 0o644 });
  return path;
}

/**
 * 返回资源的可用绝对路径。
 * SEA 下会把嵌入资源解压到缓存目录（只写一次）。
 *
 * @param {string} name - 例如 'examples/persona.md'、'src/tasks/taskctl.py'
 * @returns {Promise<string>}
 */
export async function assetFilePath(name) {
  if (!(await isSeaRuntime())) return sourcePath(name);

  const sea = await import('node:sea');
  if (typeof sea.getAsset !== 'function') {
    throw new Error(`当前 Node 不支持 sea.getAsset，无法读取资源 ${name}`);
  }
  const bytes = Buffer.from(sea.getAsset(name));

  const base = process.env.XDG_CACHE_HOME || join(homedir(), '.cache');
  const cachePath = join(base, 'dsh-wechat-link', 'assets', name);
  try {
    return await writeIfNeeded(cachePath, bytes);
  } catch {
    // HOME/缓存只读时退回 /tmp，保证单文件仍能启动
    return writeIfNeeded(join(tmpdir(), 'dsh-wechat-link-assets', name), bytes);
  }
}
