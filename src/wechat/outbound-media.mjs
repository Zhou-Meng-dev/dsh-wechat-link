/**
 * 出站媒体：把工作区里的图片/文件上传微信 CDN，再作为 IMAGE / FILE 消息发回用户。
 *
 * 协议参考腾讯官方开源仓库 Tencent/openclaw-weixin（MIT，v2.4.6）：
 *   1. POST ilink/bot/getuploadurl   申请 CDN 上传地址（明文大小/MD5/密文大小/AES key）
 *   2. POST {CDN}/upload             上传 AES-128-ECB 密文，响应头 x-encrypted-param
 *   3. POST ilink/bot/sendmessage    item_list 里放 IMAGE item（media + mid_size）
 *                                    或 FILE item（media + file_name + len）
 *
 * 安全边界：
 *   - 只有**独占一行**的 [[image: 路径]] / [[file: 路径]] 指令会被识别，
 *     正文里的 Markdown 图片/链接不处理
 *   - 路径必须解析到租户工作区内（realpath，挡 ../ 与符号链接逃逸）
 *   - 图片仅 png/jpeg/webp/gif、单张 ≤20MB；文件任意类型、单个 ≤100MB；
 *     一次回复最多 5 个媒体
 *
 * 媒体先发，文字后发；这样 agent 可以放心说「图/文件已经发给你了」。
 */

import { createHash, randomBytes } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import { basename, isAbsolute, resolve, sep } from 'node:path';

import {
  CDN_BASE_URL,
  aesEcbPaddedSize,
  encryptAesEcb,
  sanitizeFileName,
  sniffImageMime,
} from './media.mjs';

/** 单张出站图片上限（与 DSH 入站限制保持一致） */
export const MAX_OUTBOUND_IMAGE_BYTES = 20 * 1024 * 1024;
/** 单个出站文件上限（与微信文件常见限制一致） */
export const MAX_OUTBOUND_FILE_BYTES = 100 * 1024 * 1024;
/** 一条回复最多发几个媒体（图片 + 文件合计），防止一次上传拖垮服务 */
export const MAX_MEDIA_PER_REPLY = 5;

/** 独占一行的指令：[[image: 相对路径]] / [[file: 相对路径]] */
const MEDIA_DIRECTIVE_RE = /^\s*\[\[(image|file):\s*(.+?)\s*\]\]\s*$/i;

/** 注入到 system prompt 的能力说明（personaSuffix） */
export const MEDIA_CAPABILITY_PROMPT = `## 发送图片和文件

你可以主动把工作区里的图片或文件发给微信用户。做法：先把文件写到你的工作区（cwd）里，然后在回复中**单独一行**写一条指令：

图片：
[[image: relative/path.png]]

文件：
[[file: relative/path.pdf]]

规则：
- 图片只支持 png / jpeg / webp / gif，单张不超过 20MB。
- 文件支持任意类型（pdf / zip / xlsx / txt 等），单个不超过 100MB。
- 视频会作为普通文件发送，不是微信视频气泡。
- 一次回复最多 5 个媒体（图片 + 文件合计）。
- 路径是相对工作区的；不要写绝对路径，也不要用 Markdown（![](...) / [](...)）代替指令。
- 桥接会**先上传并发送媒体，再发送你的其余文字**，所以可以告诉用户「已经发给你了」。
- 媒体必须位于工作区内；工作区外的路径会被拒绝。发送失败时桥接会在文字前加一条警告。
- 用户发来的图片/文件在工作区的 \`_inbox/\` 下，如果需要回发，直接引用它。

## 在工作区生成图片（图表 / 二维码 / 流程图）

需要生成图片时，先把图片写到工作区，再用 \`[[image: relative/path.png]]\` 发送：

- 图表：\`python3\` + matplotlib（用 \`Agg\` 后端、\`plt.savefig\` 落盘）。
  中文标签先设置字体，例如 \`plt.rcParams['font.sans-serif'] = ['Noto Sans CJK SC', 'DejaVu Sans']\`。
- 二维码：\`qrencode -o qr.png "要编码的内容"\`。
- 流程图/关系图：\`dot -Tpng diagram.dot -o diagram.png\`（Graphviz）。
- 生成后先确认文件存在、格式是 png/jpeg，再写发送指令；不要用 Markdown 图片语法。
- 工具缺失时（\`matplotlib\` / \`dot\` / \`qrencode\` 找不到）直接告诉用户需要安装什么，
  不要反复重试。`;

/**
 * 从一段回复里提取媒体指令，并返回去掉指令后的正文。
 *
 * 只认独占一行的指令；代码块里的示例不解析；普通 Markdown 不解析。
 * 图片/文件的先后顺序保留，方便按 agent 的意图发送。
 *
 * @param {string} text
 * @returns {{text: string, media: {kind: 'image'|'file', path: string}[]}}
 */
export function extractMediaDirectives(text) {
  const src = String(text ?? '');
  if (!src) return { text: '', media: [] };

  const media = [];
  const seen = new Set();
  const kept = [];
  let inFence = false;

  for (const line of src.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      kept.push(line);
      continue;
    }
    if (!inFence) {
      const m = MEDIA_DIRECTIVE_RE.exec(line);
      if (m) {
        const kind = m[1].toLowerCase();
        const raw = m[2].trim().replace(/^[`"']+|[`"']+$/g, '').trim();
        const key = `${kind}:${raw}`;
        if (raw && !seen.has(key)) {
          seen.add(key);
          media.push({ kind, path: raw });
        }
        continue;
      }
    }
    kept.push(line);
  }

  const clean = kept.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  return { text: clean, media };
}

/**
 * 读取并校验一个待发送媒体。
 *
 * @param {string} filePath - 相对工作区或绝对路径（必须落在工作区内）
 * @param {string} workspace - 租户工作区
 * @param {'image'|'file'} kind
 * @returns {Promise<{buffer: Buffer, mimeType: string|null, name: string, bytes: number, kind: string}>}
 */
export async function prepareMediaForUpload(filePath, workspace, kind = 'image') {
  if (kind !== 'image' && kind !== 'file') throw new Error(`未知媒体类型: ${kind}`);
  const label = kind === 'image' ? '图片' : '文件';
  const limit = kind === 'image' ? MAX_OUTBOUND_IMAGE_BYTES : MAX_OUTBOUND_FILE_BYTES;

  const raw = String(filePath ?? '').trim().replace(/^[`"']+|[`"']+$/g, '').trim();
  if (!raw) throw new Error(`${label}路径为空`);
  if (raw.includes('\0')) throw new Error(`${label}路径非法`);

  const workspaceReal = await realpath(workspace).catch(() => {
    throw new Error(`工作区不存在: ${workspace}`);
  });
  const target = isAbsolute(raw) ? raw : resolve(workspaceReal, raw);
  const real = await realpath(target).catch(() => {
    throw new Error(`${label}不存在: ${raw}`);
  });

  if (real !== workspaceReal && !real.startsWith(workspaceReal + sep)) {
    throw new Error(`${label}必须位于工作区内: ${raw}`);
  }

  const st = await stat(real);
  if (!st.isFile()) throw new Error(`不是普通文件: ${raw}`);
  if (st.size <= 0) throw new Error(`${label}是空文件: ${raw}`);
  if (st.size > limit) {
    throw new Error(`${label}超过 ${Math.round(limit / 1024 / 1024)}MB: ${raw}`);
  }

  const buffer = await readFile(real);
  if (buffer.length > limit) {
    throw new Error(`${label}超过 ${Math.round(limit / 1024 / 1024)}MB: ${raw}`);
  }

  let mimeType = null;
  if (kind === 'image') {
    mimeType = sniffImageMime(buffer);
    if (!mimeType) {
      throw new Error(`不支持的图片格式（仅 png/jpeg/webp/gif）: ${raw}`);
    }
  }

  return {
    buffer,
    mimeType,
    name: sanitizeFileName(basename(real), kind),
    bytes: buffer.length,
    kind,
  };
}

/** 只准备图片的简写。 */
export function prepareImageForUpload(filePath, workspace) {
  return prepareMediaForUpload(filePath, workspace, 'image');
}

/**
 * 上传密文到微信 CDN，返回 x-encrypted-param。
 * 4xx 直接失败；5xx / 网络错误重试 3 次。
 */
async function uploadCiphertext(url, ciphertext, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const retries = opts.retries ?? 3;
  let lastError;

  for (let attempt = 1; attempt <= retries; attempt++) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: ciphertext,
        signal: ctl.signal,
      });
      if (res.status >= 400 && res.status < 500) {
        const detail = res.headers.get('x-error-message')
          ?? await res.text().catch(() => '');
        const err = new Error(`CDN 拒绝上传 HTTP ${res.status}${detail ? `: ${detail}` : ''}`);
        err.fatal = true;
        throw err;
      }
      if (res.status !== 200) {
        throw new Error(`CDN 上传失败 HTTP ${res.status}`);
      }
      const downloadParam = res.headers.get('x-encrypted-param');
      if (!downloadParam) throw new Error('CDN 响应缺少 x-encrypted-param');
      return downloadParam;
    } catch (err) {
      lastError = err;
      if (err.fatal) throw err;
      if (attempt < retries) {
        await new Promise((r) => setTimeout(r, 300 * attempt));
      }
    } finally {
      clearTimeout(timer);
    }
  }

  throw lastError instanceof Error ? lastError : new Error('CDN 上传失败');
}

/**
 * 读取、校验并上传一个媒体到微信 CDN。
 *
 * 返回的 `params` 是后续 sendmessage 所需的全部信息；把它存进待发队列后，
 * token 恢复时无需重新上传即可补发。
 *
 * @param {object} opts
 * @param {import('./ilink.mjs').IlinkClient} opts.ilink
 * @param {string} opts.workspace
 * @param {string} opts.filePath
 * @param {'image'|'file'} [opts.kind]
 * @param {string} opts.toUserId
 * @param {string} [opts.cdnBaseUrl]
 * @returns {Promise<{kind: string, name: string, bytes: number, mimeType: string|null,
 *                    params: {encryptQueryParam: string, aesKeyHex: string,
 *                             ciphertextSize: number, fileName?: string, plaintextSize?: number}}>}
 */
export async function uploadMedia({
  ilink,
  workspace,
  filePath,
  kind = 'image',
  toUserId,
  cdnBaseUrl = CDN_BASE_URL,
}) {
  const media = await prepareMediaForUpload(filePath, workspace, kind);

  const filekey = randomBytes(16).toString('hex');
  const aeskey = randomBytes(16);
  const rawsize = media.buffer.length;
  const rawfilemd5 = createHash('md5').update(media.buffer).digest('hex');
  const filesize = aesEcbPaddedSize(rawsize);

  let uploadResp;
  try {
    uploadResp = await ilink.getUploadUrl({
      filekey,
      mediaType: kind === 'image' ? 1 : 3,
      toUserId,
      rawsize,
      rawfilemd5,
      filesize,
      aeskey: aeskey.toString('hex'),
    });
  } catch (err) {
    throw new Error(`获取上传地址失败: ${err.message}`);
  }

  const fullUrl = uploadResp?.upload_full_url?.trim?.();
  const uploadParam = uploadResp?.upload_param;
  let uploadUrl;
  if (fullUrl) {
    uploadUrl = fullUrl;
  } else if (uploadParam) {
    uploadUrl = `${cdnBaseUrl}/upload?encrypted_query_param=${encodeURIComponent(uploadParam)}&filekey=${encodeURIComponent(filekey)}`;
  } else {
    throw new Error('getuploadurl 未返回上传地址');
  }

  const ciphertext = encryptAesEcb(media.buffer, aeskey);
  const downloadParam = await uploadCiphertext(uploadUrl, ciphertext);

  return {
    kind,
    name: media.name,
    bytes: media.bytes,
    mimeType: media.mimeType,
    params: {
      encryptQueryParam: downloadParam,
      aesKeyHex: aeskey.toString('hex'),
      ciphertextSize: filesize,
      ...(kind === 'file' ? { fileName: media.name, plaintextSize: rawsize } : {}),
    },
  };
}

/**
 * 发送一个已经上传到 CDN 的媒体（不重新上传）。
 * 待发队列补发时也走这里。
 *
 * @param {object} opts
 * @param {import('./ilink.mjs').IlinkClient} opts.ilink
 * @param {string} opts.toUserId
 * @param {string} [opts.contextToken]
 * @param {{kind: string, params: object}} opts.prepared
 */
export async function sendPreparedMedia({ ilink, toUserId, contextToken, prepared }) {
  const p = prepared?.params;
  if (!p?.encryptQueryParam || !p?.aesKeyHex) {
    throw new Error('媒体参数不完整，无法发送');
  }

  if (prepared.kind === 'image') {
    return ilink.sendImageItem({
      toUserId,
      contextToken,
      encryptQueryParam: p.encryptQueryParam,
      aesKeyHex: p.aesKeyHex,
      ciphertextSize: p.ciphertextSize,
    });
  }
  if (prepared.kind === 'file') {
    return ilink.sendFileItem({
      toUserId,
      contextToken,
      encryptQueryParam: p.encryptQueryParam,
      aesKeyHex: p.aesKeyHex,
      fileName: p.fileName,
      plaintextSize: p.plaintextSize,
    });
  }
  throw new Error(`未知媒体类型: ${prepared.kind}`);
}

/**
 * 把一个媒体上传并作为 IMAGE / FILE 消息发给用户。
 *
 * @param {object} opts
 * @param {import('./ilink.mjs').IlinkClient} opts.ilink
 * @param {string} opts.workspace   - 租户工作区
 * @param {string} opts.filePath    - 路径（相对工作区）
 * @param {'image'|'file'} [opts.kind]
 * @param {string} opts.toUserId
 * @param {string} [opts.contextToken]
 * @param {string} [opts.cdnBaseUrl]
 * @returns {Promise<{kind: string, name: string, bytes: number, mimeType: string|null}>}
 */
export async function sendMedia(opts) {
  const prepared = await uploadMedia(opts);
  await sendPreparedMedia({
    ilink: opts.ilink,
    toUserId: opts.toUserId,
    contextToken: opts.contextToken,
    prepared,
  });
  return {
    kind: prepared.kind,
    name: prepared.name,
    bytes: prepared.bytes,
    mimeType: prepared.mimeType,
  };
}

/** 只发送图片的简写。 */
export function sendImageFile(opts) {
  return sendMedia({ ...opts, kind: 'image' });
}
