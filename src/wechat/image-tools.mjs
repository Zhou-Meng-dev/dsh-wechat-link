/**
 * 入站图片归一化：大图压缩、不支持的格式（bmp/tiff/heic/avif）转 png/jpeg。
 *
 * 为什么需要：
 *   - 微信会把原图直接下发，手机照片动辄 5–15MB，模型上下文和上传都很吃力
 *   - 模型只接受 png/jpeg/webp/gif；bmp/tiff/heic 会被静默丢弃
 *
 * 依赖：
 *   - 首选 Pillow（python3-pil）：缩放 + 按目标大小循环降 JPEG 质量
 *   - 没有 Pillow 时退回 ImageMagick（magick / convert）
 *   - 两者都没有：支持的格式且不超限就原样用，否则明确失败
 *
 * 原图不丢：调用方用 saveOriginalImage() 把解密后的原始字节存到
 * `<工作区>/_inbox/originals/`，保留 7 天 / 最多 100 张。
 */

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readdir, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { detectImageMime } from './media.mjs';

/** 模型（DSH）直接支持的图片 MIME */
export const MODEL_IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

/** 转换后允许发给模型的最大字节数（硬上限） */
export const DEFAULT_IMAGE_MAX_BYTES = 20 * 1024 * 1024;
/** 超过这个大小就压缩（不是硬上限） */
export const DEFAULT_IMAGE_TARGET_BYTES = 4 * 1024 * 1024;
/** 缩放后的最长边 */
export const DEFAULT_IMAGE_MAX_DIMENSION = 2048;
/** 原图保留数量 / 时长 */
export const MAX_ORIGINALS = 100;
const ORIGINAL_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_CONVERT_OUTPUT_BYTES = 30 * 1024 * 1024;

const PYTHON_CONVERT = String.raw`
import io, os, sys
from PIL import Image, ImageOps
Image.MAX_IMAGE_PIXELS = 50_000_000
data = sys.stdin.buffer.read()
target = int(os.environ.get("IMG_TARGET_BYTES", "4194304"))
maxdim = int(os.environ.get("IMG_MAX_DIM", "2048"))
try:
    im = Image.open(io.BytesIO(data))
    im = ImageOps.exif_transpose(im)
    has_alpha = im.mode in ("RGBA", "LA") or ("transparency" in im.info)
    if max(im.size) > maxdim:
        resample = getattr(Image, "Resampling", Image).LANCZOS
        im.thumbnail((maxdim, maxdim), resample)
    def jpeg(img, quality):
        buf = io.BytesIO()
        img.convert("RGB").save(buf, "JPEG", quality=quality, optimize=True, progressive=True)
        return buf.getvalue()
    if has_alpha:
        buf = io.BytesIO()
        im.save(buf, "PNG", optimize=True)
        payload = buf.getvalue()
        if len(payload) > target:
            payload = jpeg(im, 85)
    else:
        payload = jpeg(im, 85)
        for q in (85, 75, 65, 55, 45, 35):
            payload = jpeg(im, q)
            if len(payload) <= target:
                break
    sys.stdout.buffer.write(payload)
except Exception as e:
    print(str(e), file=sys.stderr)
    sys.exit(2)
`;

/**
 * 执行外部命令并收集 stdout。
 * @param {string} command
 * @param {string[]} args
 * @param {object} [opts]
 * @returns {Promise<Buffer>}
 */
function runProcess(command, args, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const maxOutputBytes = opts.maxOutputBytes ?? MAX_CONVERT_OUTPUT_BYTES;

  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(command, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, ...(opts.env ?? {}) },
      });
    } catch (err) {
      reject(err);
      return;
    }

    const chunks = [];
    let size = 0;
    let stderr = '';
    let settled = false;
    const finish = (err, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) reject(err);
      else resolve(value);
    };
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
      finish(new Error(`${command} 超时（${timeoutMs}ms）`));
    }, timeoutMs);
    timer.unref?.();

    child.on('error', (err) => finish(err));
    child.on('close', (code) => {
      finish(
        code === 0 ? null : new Error(`${command} 退出码 ${code}${stderr ? `: ${stderr.slice(0, 300)}` : ''}`),
        Buffer.concat(chunks),
      );
    });
    child.stdout.on('data', (d) => {
      size += d.length;
      if (size > maxOutputBytes) {
        try { child.kill('SIGKILL'); } catch { /* ignore */ }
        finish(new Error('图片转换输出过大'));
        return;
      }
      chunks.push(d);
    });
    child.stderr.on('data', (d) => {
      stderr += d.toString('utf8');
      if (stderr.length > 4000) stderr = stderr.slice(-4000);
    });

    if (opts.input) child.stdin.end(opts.input);
    else child.stdin.end();
  });
}

let pillowProbe = null;
/** 探测 python3 + Pillow（缓存结果）。 */
function pillowAvailable() {
  if (!pillowProbe) {
    pillowProbe = runProcess('python3', ['-c', 'import PIL'], { timeoutMs: 5_000 })
      .then(() => true)
      .catch(() => false);
  }
  return pillowProbe;
}

/**
 * 把任意图片转成模型可用格式（优先 Pillow，其次 ImageMagick）。
 *
 * @param {Buffer} buffer
 * @param {object} [opts]
 * @param {number} [opts.targetBytes]
 * @param {number} [opts.maxDimension]
 * @returns {Promise<{buffer: Buffer, mimeType: string, tool: string}>}
 */
export async function convertImage(buffer, opts = {}) {
  const targetBytes = opts.targetBytes ?? DEFAULT_IMAGE_TARGET_BYTES;
  const maxDimension = opts.maxDimension ?? DEFAULT_IMAGE_MAX_DIMENSION;
  let lastError = null;

  if (await pillowAvailable()) {
    try {
      const out = await runProcess('python3', ['-c', PYTHON_CONVERT], {
        input: buffer,
        timeoutMs: opts.timeoutMs ?? 30_000,
        env: {
          IMG_TARGET_BYTES: String(targetBytes),
          IMG_MAX_DIM: String(maxDimension),
        },
      });
      const mimeType = detectImageMime(out);
      if (!mimeType) throw new Error('Pillow 输出无法识别');
      return { buffer: out, mimeType, tool: 'pillow' };
    } catch (err) {
      lastError = err;
    }
  }

  const args = [
    '-', '-auto-orient',
    '-resize', `${maxDimension}x${maxDimension}>`,
    '-strip', '-quality', '82', 'jpg:-',
  ];
  for (const cmd of ['magick', 'convert']) {
    try {
      const out = await runProcess(cmd, args, { input: buffer, timeoutMs: opts.timeoutMs ?? 30_000 });
      const mimeType = detectImageMime(out);
      if (!mimeType) throw new Error(`${cmd} 输出无法识别`);
      return { buffer: out, mimeType, tool: cmd };
    } catch (err) {
      if (err.code !== 'ENOENT') lastError = err;
      else if (!lastError) lastError = err;
    }
  }

  throw new Error(
    `没有可用的图片转换工具（安装 python3-pil 或 imagemagick）${lastError ? `: ${lastError.message}` : ''}`,
  );
}

/**
 * 判断一张图是否需要/能够送给模型。
 *
 * @param {Buffer} buffer
 * @param {object} [opts]
 * @param {string} [opts.mimeType]
 * @param {number} [opts.maxBytes]
 * @param {number} [opts.targetBytes]
 * @param {number} [opts.maxDimension]
 * @param {(buffer: Buffer, opts: object) => Promise<{buffer: Buffer, mimeType: string, tool: string}>} [opts.convertImage]
 * @returns {Promise<{buffer: Buffer, mimeType: string, originalMimeType: string,
 *                    converted: boolean, reason: string|null, tool: string|null}>}
 */
export async function normalizeImage(buffer, opts = {}) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) throw new Error('图片内容为空');

  const sourceMime = opts.mimeType ?? detectImageMime(buffer);
  if (!sourceMime) throw new Error('无法识别的图片格式');

  const maxBytes = opts.maxBytes ?? DEFAULT_IMAGE_MAX_BYTES;
  const targetBytes = opts.targetBytes ?? DEFAULT_IMAGE_TARGET_BYTES;
  const maxDimension = opts.maxDimension ?? DEFAULT_IMAGE_MAX_DIMENSION;
  const supported = MODEL_IMAGE_MIMES.has(sourceMime);
  const tooLarge = buffer.length > targetBytes;

  if (supported && !tooLarge && buffer.length <= maxBytes) {
    return {
      buffer,
      mimeType: sourceMime,
      originalMimeType: sourceMime,
      converted: false,
      reason: null,
      tool: null,
    };
  }

  const convert = opts.convertImage ?? convertImage;
  let converted;
  try {
    converted = await convert(buffer, { targetBytes, maxDimension });
  } catch (err) {
    if (supported && buffer.length <= maxBytes) {
      // 压缩失败但原图模型能用：宁可发大图，也不要丢图
      return {
        buffer,
        mimeType: sourceMime,
        originalMimeType: sourceMime,
        converted: false,
        reason: `转换失败: ${err.message}`,
        tool: null,
      };
    }
    throw new Error(`图片格式 ${sourceMime} 不受支持，且转换失败: ${err.message}`);
  }

  const outputUnsupported = !MODEL_IMAGE_MIMES.has(converted.mimeType);
  const outputTooLarge = converted.buffer.length > maxBytes;
  if (outputUnsupported || outputTooLarge) {
    // 转换结果不能用时，如果原图本身还能发，就退回原图
    if (supported && buffer.length <= maxBytes) {
      return {
        buffer,
        mimeType: sourceMime,
        originalMimeType: sourceMime,
        converted: false,
        reason: outputUnsupported
          ? `转换结果格式不受支持: ${converted.mimeType}`
          : `转换后仍超过 ${Math.round(maxBytes / 1024 / 1024)}MB`,
        tool: null,
      };
    }
    throw new Error(outputUnsupported
      ? `转换结果格式不受支持: ${converted.mimeType}`
      : `转换后图片仍超过 ${Math.round(maxBytes / 1024 / 1024)}MB`);
  }

  return {
    buffer: converted.buffer,
    mimeType: converted.mimeType,
    originalMimeType: sourceMime,
    converted: true,
    reason: supported ? 'too-large' : 'unsupported-format',
    tool: converted.tool ?? null,
  };
}

const MIME_EXT = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/bmp': 'bmp',
  'image/tiff': 'tiff',
  'image/heic': 'heic',
  'image/avif': 'avif',
};

/**
 * 把解密后的原图存到工作区，便于事后追溯（模型看到的是压缩后的版本）。
 *
 * @param {string} dir - 例如 `<工作区>/_inbox/originals`
 * @param {Buffer} buffer
 * @param {object} [opts]
 * @param {string} [opts.mimeType]
 * @param {Date} [opts.now]
 * @returns {Promise<{path: string, name: string, bytes: number}>}
 */
export async function saveOriginalImage(dir, buffer, opts = {}) {
  await mkdir(dir, { recursive: true });
  const mimeType = opts.mimeType ?? detectImageMime(buffer);
  const ext = MIME_EXT[mimeType] ?? 'bin';
  const sha = createHash('sha256').update(buffer).digest('hex').slice(0, 8);
  const d = opts.now ?? new Date();
  const p = (n) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  const name = `img-${stamp}-${sha}.${ext}`;
  const path = join(dir, name);
  await writeFile(path, buffer, { mode: 0o644 });

  await pruneOriginals(dir).catch(() => {});
  return { path, name, bytes: buffer.length };
}

async function pruneOriginals(dir) {
  const names = (await readdir(dir).catch(() => [])).filter((n) => /^img-.*\.(png|jpg|jpeg|webp|gif|bmp|tiff|heic|avif|bin)$/.test(n));
  const now = Date.now();
  const kept = [];
  for (const name of names) {
    const full = join(dir, name);
    const st = await stat(full).catch(() => null);
    if (!st?.isFile()) continue;
    if (now - st.mtimeMs > ORIGINAL_RETENTION_MS) {
      await unlink(full).catch(() => {});
      continue;
    }
    kept.push({ full, mtimeMs: st.mtimeMs });
  }
  kept.sort((a, b) => b.mtimeMs - a.mtimeMs);
  for (const item of kept.slice(MAX_ORIGINALS)) {
    await unlink(item.full).catch(() => {});
  }
}
