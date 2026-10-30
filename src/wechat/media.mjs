/**
 * 微信（iLink）图片下载/解密与上传/加密。
 *
 * 协议参考腾讯官方开源仓库 Tencent/openclaw-weixin（MIT）：
 *   - 图片以 CDNMedia 引用形式下发，带 encrypt_query_param 或 full_url
 *   - 内容用 AES-128-ECB + PKCS7 加密
 *   - 密钥两种编码：
 *       image_item.aeskey  → 16 字节的 hex 字符串
 *       media.aes_key      → base64(16 原始字节) 或 base64(32 字符 hex)
 *
 * 解密后的字节直接可作为 SDK 的 SdkEncodedImageBlock.data（base64）。
 * 出站上传复用同一套 AES helpers（见 encryptAesEcb / aesEcbPaddedSize）。
 */

import { createCipheriv, createDecipheriv, createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';

export const CDN_BASE_URL = 'https://novac2c.cdn.weixin.qq.com/c2c';

/** 单张图片下载上限。允许先下载大图，再由 image-tools 压缩到模型可用大小。 */
const MAX_DOWNLOAD_BYTES = 60 * 1024 * 1024;
/** 下载超时 */
const DOWNLOAD_TIMEOUT_MS = 20_000;

/**
 * 解析 AES 密钥。
 * @param {string} raw - hex 字符串，或 base64
 * @returns {Buffer|null} 16 字节密钥
 */
export function parseAesKey(raw) {
  if (!raw || typeof raw !== 'string') return null;

  // 情形 1：32 字符 hex（image_item.aeskey 的常见形态）
  if (/^[0-9a-fA-F]{32}$/.test(raw)) {
    return Buffer.from(raw, 'hex');
  }

  // 情形 2：base64 编码的原始 16 字节
  const b64 = Buffer.from(raw, 'base64');
  if (b64.length === 16) return b64;

  // 情形 3：base64 解出 32 字符 hex
  if (b64.length === 32 && /^[0-9a-fA-F]{32}$/.test(b64.toString('ascii'))) {
    return Buffer.from(b64.toString('ascii'), 'hex');
  }

  return null;
}

/**
 * 构造下载 URL。
 * @param {{encrypt_query_param?: string, full_url?: string}} media
 * @param {string} [cdnBaseUrl]
 */
export function buildDownloadUrl(media, cdnBaseUrl = CDN_BASE_URL) {
  if (media?.full_url) return media.full_url;
  if (media?.encrypt_query_param) {
    return `${cdnBaseUrl}/download?encrypted_query_param=${encodeURIComponent(media.encrypt_query_param)}`;
  }
  return null;
}

/** AES-128-ECB 解密（PKCS7） */
export function decryptAesEcb(ciphertext, key) {
  const d = createDecipheriv('aes-128-ecb', key, null);
  return Buffer.concat([d.update(ciphertext), d.final()]);
}

/** AES-128-ECB 加密（PKCS7），用于上传到微信 CDN。 */
export function encryptAesEcb(plaintext, key) {
  const c = createCipheriv('aes-128-ecb', key, null);
  return Buffer.concat([c.update(plaintext), c.final()]);
}

/** AES-128-ECB + PKCS7 后的密文长度（16 字节对齐，且至少补 1 字节）。 */
export function aesEcbPaddedSize(plaintextSize) {
  return Math.ceil((plaintextSize + 1) / 16) * 16;
}

/**
 * 从图片字节嗅探 MIME。DSH 只接受 png/jpeg/webp/gif。
 * @param {Buffer} buf
 * @returns {'image/png'|'image/jpeg'|'image/webp'|'image/gif'|null}
 */
export function sniffImageMime(buf) {
  if (!buf || buf.length < 12) return null;
  // JPEG: FF D8 FF
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47 &&
    buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a
  ) {
    return 'image/png';
  }
  // GIF: "GIF8"
  if (buf.subarray(0, 4).toString('ascii') === 'GIF8') return 'image/gif';
  // WEBP: "RIFF"...."WEBP"
  if (
    buf.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buf.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return 'image/webp';
  }
  return null;
}

/**
 * 更宽的图片格式嗅探：除了模型直接支持的 png/jpeg/webp/gif，
 * 还识别 bmp/tiff/heic/avif，交给 image-tools 转成模型可用格式。
 *
 * @param {Buffer} buf
 * @returns {string|null}
 */
export function detectImageMime(buf) {
  const supported = sniffImageMime(buf);
  if (supported) return supported;
  if (!buf || buf.length < 2) return null;

  // BMP: "BM"
  if (buf[0] === 0x42 && buf[1] === 0x4d) return 'image/bmp';

  // TIFF: "II*\0" (little-endian) 或 "MM\0*" (big-endian)
  if (buf.length >= 4) {
    const sig = buf.subarray(0, 4);
    if ((sig[0] === 0x49 && sig[1] === 0x49 && sig[2] === 0x2a && sig[3] === 0x00)
      || (sig[0] === 0x4d && sig[1] === 0x4d && sig[2] === 0x00 && sig[3] === 0x2a)) {
      return 'image/tiff';
    }
  }

  // HEIC / AVIF: box header "....ftyp<brand>"
  if (buf.length >= 12 && buf.subarray(4, 8).toString('ascii') === 'ftyp') {
    const brand = buf.subarray(8, 12).toString('ascii').toLowerCase();
    if (brand.startsWith('heic') || brand.startsWith('heix') || brand.startsWith('mif1') || brand.startsWith('msf1')) {
      return 'image/heic';
    }
    if (brand.startsWith('avif')) return 'image/avif';
  }

  return null;
}

/**
 * 下载并解密一张图片。
 *
 * @param {object} imageItem - WeixinMessage.item_list 里的 image_item
 * @param {object} [opts]
 * @param {string} [opts.cdnBaseUrl]
 * @param {number} [opts.timeoutMs]
 * @returns {Promise<{data: string, mimeType: string, bytes: number} | null>}
 *          失败返回 null（调用方退化为占位文本）
 */
export async function downloadImage(imageItem, opts = {}) {
  const media = imageItem?.media ?? imageItem?.thumb_media;
  if (!media) return null;

  const url = buildDownloadUrl(media, opts.cdnBaseUrl);
  if (!url) return null;

  // 密钥来源：image_item.aeskey（hex）优先，其次 media.aes_key（base64）
  const key = parseAesKey(imageItem?.aeskey) ?? parseAesKey(media.aes_key);
  if (!key) return null;

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), opts.timeoutMs ?? DOWNLOAD_TIMEOUT_MS);
  let ciphertext;
  try {
    const res = await fetch(url, { signal: ctl.signal });
    if (!res.ok) return null;
    const len = Number(res.headers.get('content-length') ?? 0);
    if (len > MAX_DOWNLOAD_BYTES) return null;
    ciphertext = Buffer.from(await res.arrayBuffer());
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
  if (!ciphertext?.length || ciphertext.length > MAX_DOWNLOAD_BYTES) return null;

  let plain;
  try {
    plain = decryptAesEcb(ciphertext, key);
  } catch {
    // 少数情况下内容是明文（未加密），直接尝试当作图片
    plain = ciphertext;
  }

  const mimeType = detectImageMime(plain);
  if (!mimeType) return null;

  return {
    data: plain.toString('base64'),
    mimeType,
    bytes: plain.length,
    /** 原始字节，供 image-tools 压缩/转格式和保留原图 */
    buffer: plain,
  };
}

// ---------------------------------------------------------------- 文件

/** 单文件上限（微信文件一般远小于此） */
const MAX_FILE_BYTES = 100 * 1024 * 1024;

/**
 * 清洗文件名：去掉路径分隔符与控制字符，避免目录穿越。
 * @param {string} raw
 * @param {string} [fallback]
 */
export function sanitizeFileName(raw, fallback = 'file') {
  const base = basename(String(raw ?? '').replace(/\\/g, '/'));
  const cleaned = base
    .replace(/[\u0000-\u001f<>:"/\\|?*]/g, '_')
    .replace(/^\.+/, '')  // 剥掉前导点：避免 '..' 与隐藏文件
    .trim();
  if (!cleaned) return fallback;
  return cleaned.length > 180 ? cleaned.slice(0, 180) : cleaned;
}

/**
 * 下载并解密一个文件，保存到指定目录。
 *
 * 与图片不同：**不把内容送进模型上下文**，而是落盘后把路径告诉 agent，
 * 由 agent 用自己的文件工具去读。这样大文件也不会撑爆上下文。
 *
 * @param {object} fileItem - WeixinMessage.item_list 里的 file_item
 * @param {object} opts
 * @param {string} opts.destDir  - 保存目录（一般是租户工作区）
 * @param {string} [opts.cdnBaseUrl]
 * @param {number} [opts.timeoutMs]
 * @returns {Promise<{path:string, name:string, bytes:number, sha256:string} | null>}
 */
export async function downloadFile(fileItem, opts) {
  const media = fileItem?.media;
  if (!media || !opts?.destDir) return null;

  const url = buildDownloadUrl(media, opts.cdnBaseUrl);
  if (!url) return null;

  // 文件密钥通常是 base64(32字符hex)，parseAesKey 三种形态都兼容
  const key = parseAesKey(media.aes_key);
  if (!key) return null;

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), opts.timeoutMs ?? 60_000);
  let ciphertext;
  try {
    const res = await fetch(url, { signal: ctl.signal });
    if (!res.ok) return null;
    const len = Number(res.headers.get('content-length') ?? 0);
    if (len > MAX_FILE_BYTES) return null;
    ciphertext = Buffer.from(await res.arrayBuffer());
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
  if (!ciphertext?.length || ciphertext.length > MAX_FILE_BYTES) return null;

  let plain;
  try {
    plain = decryptAesEcb(ciphertext, key);
  } catch {
    plain = ciphertext; // 少数情况下未加密
  }

  const name = sanitizeFileName(fileItem.file_name, `file-${Date.now()}`);
  const destDir = opts.destDir;
  await mkdir(destDir, { recursive: true });
  const dest = join(destDir, name);
  await writeFile(dest, plain);

  return {
    path: dest,
    name,
    bytes: plain.length,
    sha256: createHash('sha256').update(plain).digest('hex').slice(0, 16),
  };
}
