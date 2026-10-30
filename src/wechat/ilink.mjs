/**
 * 腾讯 iLink Bot 通道客户端。
 *
 * 协议参考腾讯官方开源仓库 Tencent/openclaw-weixin（MIT），
 * 本项目按其 JSON-over-HTTP 约定复现了收发消息所需的最小集合：
 *
 *   POST {baseUrl}/ilink/bot/getupdates   长轮询收消息
 *   POST {baseUrl}/ilink/bot/sendmessage  发消息
 *   POST {baseUrl}/ilink/bot/getconfig    取 typing_ticket
 *   POST {baseUrl}/ilink/bot/sendtyping   正在输入
 *   GET  {baseUrl}/ilink/bot/get_bot_qrcode?bot_type=  取登录二维码
 *   GET  {baseUrl}/ilink/bot/get_qrcode_status?qrcode= 轮询扫码结果
 *
 * 注意：这不是逆向个人微信协议，走的是腾讯官方 bot 接口。
 */

import { randomBytes } from 'node:crypto';

export const DEFAULT_BASE_URL = 'https://ilinkai.weixin.qq.com';
const DEFAULT_LONG_POLL_TIMEOUT_MS = 35_000;
const DEFAULT_API_TIMEOUT_MS = 15_000;
const CHANNEL_VERSION = '0.1.0';
const BOT_AGENT = 'dsh-wechat-link';

/** 消息类型 */
export const MessageType = { NONE: 0, USER: 1, BOT: 2 };
/** 消息内容项类型 */
export const MessageItemType = { NONE: 0, TEXT: 1, IMAGE: 2, VOICE: 3, FILE: 4, VIDEO: 5 };

/**
 * sendmessage 业务错误。带上 ret/errmsg，便于上层区分
 * "context_token 失效"（可排队重试）和普通参数错误。
 */
export class IlinkSendError extends Error {
  constructor(message, { ret, errmsg } = {}) {
    super(message);
    this.name = 'IlinkSendError';
    this.ret = ret;
    this.errmsg = errmsg;
  }
}

/**
 * 是否是 per-user context_token 失效。
 *
 * iLink 的 sendmessage 在 token 过期/缺失时返回 ret=-1；errmsg 在不同版本里
 * 可能是 "invalid context token" / "session expired" 等。这里只做保守判断，
 * 命中后由 Tenant 把消息放进待发队列，用户下次发消息时补发。
 */
export function isTokenExpiredError(err) {
  if (!err) return false;
  if (err.ret === -1) return true;
  const text = `${err.errmsg ?? ''} ${err.message ?? ''}`;
  return /context[_\s-]?token|token[^\n]{0,30}(expir|invalid|失效|过期)|会话[^\n]{0,20}(失效|过期)/i.test(text);
}

function baseInfo() {
  return { channel_version: CHANNEL_VERSION, bot_agent: BOT_AGENT };
}

/** X-WECHAT-UIN: 随机 uint32 → 十进制字符串 → base64 */
function randomWechatUin() {
  const uint32 = randomBytes(4).readUInt32BE(0);
  return Buffer.from(String(uint32), 'utf8').toString('base64');
}

function headers(token) {
  const h = {
    'Content-Type': 'application/json',
    AuthorizationType: 'ilink_bot_token',
    'X-WECHAT-UIN': randomWechatUin(),
  };
  if (token) h.Authorization = `Bearer ${token}`;
  return h;
}

function normalizeBase(url) {
  return url.endsWith('/') ? url : `${url}/`;
}

export class IlinkClient {
  /**
   * @param {object} opts
   * @param {string} opts.token     - 扫码得到的 bot_token
   * @param {string} [opts.baseUrl] - 扫码返回的 baseurl，默认官方地址
   * @param {(m: string) => void} [opts.log]
   */
  constructor(opts) {
    this.token = opts.token;
    this.baseUrl = normalizeBase(opts.baseUrl || DEFAULT_BASE_URL);
    this.log = opts.log ?? ((m) => console.error(`[ilink] ${m}`));
    /** 服务端返回的长轮询上下文 */
    this.syncBuf = '';
    this.stopped = false;
  }

  async #post(endpoint, body, timeoutMs = DEFAULT_API_TIMEOUT_MS) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const res = await fetch(this.baseUrl + endpoint, {
        method: 'POST',
        headers: headers(this.token),
        body: JSON.stringify(body),
        signal: ctl.signal,
      });
      const text = await res.text();
      if (!res.ok) throw new Error(`${endpoint} HTTP ${res.status}: ${text.slice(0, 200)}`);
      return JSON.parse(text);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * 长轮询拉取新消息。
   * @returns {Promise<{msgs: any[], ret: number, errcode?: number, errmsg?: string}>}
   */
  async getUpdates(timeoutMs = DEFAULT_LONG_POLL_TIMEOUT_MS) {
    const resp = await this.#post(
      'ilink/bot/getupdates',
      { get_updates_buf: this.syncBuf ?? '', base_info: baseInfo() },
      timeoutMs,
    );
    if (resp.get_updates_buf) this.syncBuf = resp.get_updates_buf;
    return resp;
  }

  /** 发送一条消息并检查 ret。 */
  async #sendMessage(msg, endpoint = 'ilink/bot/sendmessage') {
    // 防御：session-store 里是 {token, updatedAt}，调用方必须取 .token。
    // 传对象会让服务端返回 ret=-1 invalid request，而且很难从日志看出原因。
    if (msg.context_token !== undefined && typeof msg.context_token !== 'string') {
      throw new Error('context_token 必须是字符串（不能传 {token, updatedAt} 对象）');
    }
    const resp = await this.#post(endpoint, { msg, base_info: baseInfo() });
    if (resp.ret && resp.ret !== 0) {
      throw new IlinkSendError(
        `sendmessage ret=${resp.ret} errmsg=${resp.errmsg ?? '(none)'}`,
        { ret: resp.ret, errmsg: resp.errmsg },
      );
    }
    return resp;
  }

  /**
   * 发送文本消息。
   * @param {object} opts
   * @param {string} opts.toUserId      - 目标用户 id
   * @param {string} opts.text
   * @param {string} [opts.contextToken] - 回复时必须带，取自收到的消息
   */
  async sendText({ toUserId, text, contextToken }) {
    const msg = {
      from_user_id: '',
      to_user_id: toUserId,
      client_id: `dsh-${randomBytes(6).toString('hex')}`,
      message_type: MessageType.BOT,
      message_state: 2, // FINISH
      create_time_ms: Date.now(),
      item_list: [{ type: MessageItemType.TEXT, text_item: { text } }],
    };
    if (contextToken) msg.context_token = contextToken;
    return this.#sendMessage(msg);
  }

  /**
   * 申请微信 CDN 上传地址。
   * @param {object} opts
   * @param {string} opts.filekey      - 随机 16 字节 hex（32 字符）
   * @param {number} opts.mediaType    - 1=IMAGE 2=VIDEO 3=FILE
   * @param {string} opts.toUserId
   * @param {number} opts.rawsize      - 明文字节数
   * @param {string} opts.rawfilemd5   - 明文 MD5 hex
   * @param {number} opts.filesize     - AES-ECB 密文字节数
   * @param {string} opts.aeskey       - AES-128 key hex（32 字符）
   */
  async getUploadUrl({ filekey, mediaType = 1, toUserId, rawsize, rawfilemd5, filesize, aeskey }) {
    const resp = await this.#post('ilink/bot/getuploadurl', {
      filekey,
      media_type: mediaType,
      to_user_id: toUserId,
      rawsize,
      rawfilemd5,
      filesize,
      no_need_thumb: true,
      aeskey,
      base_info: baseInfo(),
    }, 30_000);
    if (resp.ret && resp.ret !== 0) {
      throw new Error(`getuploadurl ret=${resp.ret} errmsg=${resp.errmsg ?? '(none)'}`);
    }
    return resp;
  }

  /**
   * 发送一张已经上传到 CDN 的图片。
   * @param {object} opts
   * @param {string} opts.toUserId
   * @param {string} [opts.contextToken]
   * @param {string} opts.encryptQueryParam - CDN 响应头 x-encrypted-param
   * @param {string} opts.aesKeyHex         - AES-128 key hex（32 字符）
   * @param {number} opts.ciphertextSize    - 加密后的字节数（mid_size）
   */
  async sendImageItem({ toUserId, contextToken, encryptQueryParam, aesKeyHex, ciphertextSize }) {
    const msg = {
      from_user_id: '',
      to_user_id: toUserId,
      client_id: `dsh-${randomBytes(6).toString('hex')}`,
      message_type: MessageType.BOT,
      message_state: 2, // FINISH
      create_time_ms: Date.now(),
      item_list: [{
        type: MessageItemType.IMAGE,
        image_item: {
          media: {
            encrypt_query_param: encryptQueryParam,
            // 协议要求：32 个 ASCII hex 字符的 bytes，再 Base64
            aes_key: Buffer.from(aesKeyHex, 'ascii').toString('base64'),
            encrypt_type: 1,
          },
          mid_size: ciphertextSize,
        },
      }],
    };
    if (contextToken) msg.context_token = contextToken;
    return this.#sendMessage(msg);
  }

  /**
   * 发送一个已经上传到 CDN 的普通文件。
   * @param {object} opts
   * @param {string} opts.toUserId
   * @param {string} [opts.contextToken]
   * @param {string} opts.encryptQueryParam - CDN 响应头 x-encrypted-param
   * @param {string} opts.aesKeyHex         - AES-128 key hex（32 字符）
   * @param {string} opts.fileName          - 展示给用户的文件名
   * @param {number} opts.plaintextSize     - 原文件字节数（协议字段 len 是字符串）
   */
  async sendFileItem({ toUserId, contextToken, encryptQueryParam, aesKeyHex, fileName, plaintextSize }) {
    const msg = {
      from_user_id: '',
      to_user_id: toUserId,
      client_id: `dsh-${randomBytes(6).toString('hex')}`,
      message_type: MessageType.BOT,
      message_state: 2, // FINISH
      create_time_ms: Date.now(),
      item_list: [{
        type: MessageItemType.FILE,
        file_item: {
          media: {
            encrypt_query_param: encryptQueryParam,
            aes_key: Buffer.from(aesKeyHex, 'ascii').toString('base64'),
            encrypt_type: 1,
          },
          file_name: fileName,
          len: String(plaintextSize),
        },
      }],
    };
    if (contextToken) msg.context_token = contextToken;
    return this.#sendMessage(msg);
  }

  /** 取 typing_ticket（用于"正在输入"状态）。失败不致命。 */
  async getConfig(ilinkUserId) {
    try {
      const resp = await this.#post('ilink/bot/getconfig', {
        ilink_user_id: ilinkUserId,
        base_info: baseInfo(),
      });
      return resp.typing_ticket ?? null;
    } catch (err) {
      this.log(`getconfig 失败（忽略）: ${err.message}`);
      return null;
    }
  }

  /** 发送"正在输入"。status: 1=输入中, 2=取消。失败不致命。 */
  async sendTyping(ilinkUserId, typingTicket) {
    if (!typingTicket) return;
    try {
      await this.#post('ilink/bot/sendtyping', {
        ilink_user_id: ilinkUserId,
        typing_ticket: typingTicket,
        status: 1,
        base_info: baseInfo(),
      });
    } catch {
      /* 忽略：typing 只是体验增强 */
    }
  }

  /** 通知服务端本客户端下线。 */
  async notifyStop() {
    try {
      await this.#post('ilink/bot/msg/notifystop', { base_info: baseInfo() }, 5000);
    } catch {
      /* 忽略 */
    }
  }
}

/**
 * 读取单个 MessageItem 的文本，并按需收集可下载的图片/文件原始项。
 * @param {object} item
 * @param {{images?: object[], files?: object[]}} [collect]
 * @returns {{text: string, kind: string}}
 */
function readMessageItem(item, collect = {}) {
  if (!item || typeof item !== 'object') return { text: '', kind: 'unknown' };

  switch (item.type) {
    case MessageItemType.TEXT:
      return { text: item.text_item?.text ?? '', kind: 'text' };
    case MessageItemType.VOICE:
      // 优先用服务端识别结果；没有就只给占位
      return {
        text: item.voice_item?.text || '[语音消息]',
        kind: 'voice',
      };
    case MessageItemType.IMAGE:
      // 收集原图信息；能否解密成功由调用方决定，失败再退化为占位文本
      if (collect.images && item.image_item) collect.images.push(item.image_item);
      return { text: '[图片]', kind: 'image' };
    case MessageItemType.FILE:
      if (collect.files && item.file_item) collect.files.push(item.file_item);
      return { text: `[文件 ${item.file_item?.file_name ?? ''}]`, kind: 'file' };
    case MessageItemType.VIDEO:
      return { text: '[视频]', kind: 'video' };
    default:
      return { text: '', kind: 'unknown' };
  }
}

/**
 * 提取被引用（引用回复）的消息上下文。
 *
 * 官方协议：`MessageItem.ref_msg = { title?, message_item? }`，
 * message_item 是完整的被引用内容（文本/图片/文件等）。
 * 这里同时兼容 msg.ref_msg（少数客户端会放在顶层）。
 *
 * @param {object} msg
 * @returns {{text: string, images: object[], files: object[]}|null}
 */
export function extractQuotedContext(msg) {
  const candidates = [];
  for (const item of msg?.item_list ?? []) {
    if (item?.ref_msg) candidates.push(item.ref_msg);
  }
  if (msg?.ref_msg) candidates.push(msg.ref_msg);

  const ref = candidates.find(Boolean);
  if (!ref || typeof ref !== 'object') return null;

  const images = [];
  const files = [];
  const parts = [];

  if (ref.message_item) {
    const r = readMessageItem(ref.message_item, { images, files });
    if (r.text) parts.push(r.text);
  }
  // 没有完整内容时退化为服务端摘要
  if (parts.length === 0 && ref.title) parts.push(String(ref.title));
  if (parts.length === 0 && images.length === 0 && files.length === 0) {
    parts.push('[一条无法读取的引用消息]');
  }

  return { text: parts.join('\n').trim(), images, files };
}

/**
 * 把引用上下文格式化成注入给模型的前缀。
 * @param {{text?: string}|null} quoted
 * @returns {string}
 */
export function formatQuotedContext(quoted) {
  if (!quoted?.text) return '';
  return `用户引用了下面这条消息作为上下文：\n「${quoted.text}」`;
}

/**
 * 从一条 WeixinMessage 里提取纯文本，以及被引用的上下文。
 * @param {object} msg
 * @returns {{text: string, kind: string, images: object[], files: object[],
 *            quoted: {text: string, images: object[], files: object[]}|null}}
 */
export function extractInboundText(msg) {
  const items = msg.item_list ?? [];
  const parts = [];
  /** 原始 image_item，供上层下载解密后作为图片块送入模型 */
  const images = [];
  /** 原始 file_item，供上层下载后落盘交给 agent */
  const files = [];
  let kind = 'unknown';

  for (const item of items) {
    const r = readMessageItem(item, { images, files });
    if (r.text) parts.push(r.text);
    if (r.kind !== 'unknown') kind = r.kind;
  }

  return {
    text: parts.join('\n').trim(),
    kind,
    images,
    files,
    quoted: extractQuotedContext(msg),
  };
}

/**
 * 完整扫码登录流程：取二维码 → 打印 → 轮询直到确认。
 * @param {object} [opts]
 * @param {(url: string) => void} [opts.onQr] - 拿到二维码链接时回调（自行渲染）
 * @param {(m: string) => void} [opts.log]
 * @returns {Promise<{token: string, baseUrl: string}>}
 */
export async function qrLogin(opts = {}) {
  const log = opts.log ?? ((m) => console.error(`[login] ${m}`));
  const baseUrl = DEFAULT_BASE_URL;

  const qrRes = await fetch(`${baseUrl}/ilink/bot/get_bot_qrcode?bot_type=3`, {
    headers: { 'X-WECHAT-UIN': randomWechatUin() },
  }).then((r) => r.json());

  const qrcode = qrRes.qrcode;
  const qrcodeUrl = qrRes.qrcode_img_content;
  if (!qrcode) throw new Error('未拿到二维码');

  if (opts.onQr) opts.onQr(qrcodeUrl);
  else log(`请用微信扫码登录：\n${qrcodeUrl}`);

  let currentBase = baseUrl;
  for (;;) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 40_000);
    let resp;
    try {
      resp = await fetch(
        `${currentBase}/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`,
        { headers: { 'X-WECHAT-UIN': randomWechatUin() }, signal: ctl.signal },
      ).then((r) => r.json());
    } catch {
      continue; // 超时属于正常，继续轮询
    } finally {
      clearTimeout(timer);
    }

    switch (resp.status) {
      case 'wait':
        continue;
      case 'scaned_but_redirect':
        if (resp.redirect_host) currentBase = `https://${resp.redirect_host}`;
        log('已扫码，等待确认…');
        continue;
      case 'confirmed':
        if (!resp.bot_token) throw new Error('登录确认但未返回 token');
        return {
          token: resp.bot_token,
          baseUrl: resp.baseurl
            ? resp.baseurl
            : resp.redirect_host
              ? `https://${resp.redirect_host}`
              : currentBase,
          /** bot 自身 id（形如 xxx@im.bot），用于诊断 */
          botId: resp.ilink_bot_id ?? null,
          /** 扫码者的个人微信 id（形如 xxx@im.wechat），即 bot 所有者 */
          ownerId: resp.ilink_user_id ?? null,
        };
      case 'expired':
        throw new Error('二维码已过期，请重试');
      default:
        log(`未知状态: ${JSON.stringify(resp).slice(0, 200)}`);
        continue;
    }
  }
}
