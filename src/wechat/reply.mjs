/**
 * 出站回复：媒体指令、Markdown 清理、超长转文件、分段、待发队列。
 *
 * 一块行为，一个小接口：
 *   - send()  把一条 agent 回复完整送到用户（必要时入队）
 *   - flush() 用户下次发消息时，用最新 context_token 补发积压
 *
 * 行为约束：
 *   - `[[image:]]` / `[[file:]]` 先发、最多 5 个，失败在文字前加警告
 *   - 超长/大代码块/大表格转成 `.md` 文件走 FILE 通道，聊天里只留摘要
 *   - 微信不渲染 Markdown，正文发送前统一转纯文本
 *   - 按租户 maxChars 分段（默认 1800 字），段间间隔 400ms
 *   - token 失效进 outbox；非 token 错误只影响当前这条，不阻塞后续
 *   - 没有 context_token 时不发送，积压保留到用户下次说话
 *
 * 本模块不读 Tenant 的私有字段：工作目录、分段上限、token 查询都由构造参数注入。
 */

import { isTokenExpiredError } from './ilink.mjs';
import { labelChunks, splitMessage, DEFAULT_MAX_CHARS } from './split.mjs';
import {
  extractMediaDirectives,
  MAX_MEDIA_PER_REPLY,
  sendPreparedMedia,
  uploadMedia,
} from './outbound-media.mjs';
import { markdownToPlainText } from './markdown.mjs';
import { analyzeOversize, buildOverflowNote, writeOverflowFile } from './overflow.mjs';

export class ReplySender {
  /**
   * @param {object} opts
   * @param {string} opts.cwd                 - 租户工作区（媒体与 _outbox 都相对它）
   * @param {number} [opts.maxChars]          - 单条消息分段上限
   * @param {import('./ilink.mjs').IlinkClient} opts.ilink
   * @param {import('./outbox.mjs').OutboxStore|null} [opts.outbox] - 未初始化时只记日志
   * @param {(msg: string) => void} [opts.log]
   * @param {(peerId: string) => string|undefined} [opts.getContextToken] - flush 时取最新 token
   */
  constructor({ cwd, maxChars = DEFAULT_MAX_CHARS, ilink, outbox = null, log = () => {}, getContextToken = () => undefined }) {
    this.cwd = cwd;
    this.maxChars = maxChars ?? DEFAULT_MAX_CHARS;
    this.ilink = ilink;
    this.outbox = outbox;
    this.log = log;
    this.getContextToken = getContextToken;
  }

  /**
   * 发送回复：先按 [[image: ...]] / [[file: ...]] 指令发媒体，再把文字超长分段发送。
   * 媒体失败会在文字前加警告，避免 agent 说"已发送"而用户什么都没收到。
   *
   * @returns {Promise<{sent: number, queued: number}>}
   *          queued > 0 表示有内容因 context_token 失效进入了待发队列。
   */
  async send(toUserId, text, contextToken) {
    const { text: rawBody, media } = extractMediaDirectives(text);
    const notes = [];
    let sentMedia = 0;
    let queuedMedia = 0;

    if (media.length > MAX_MEDIA_PER_REPLY) {
      notes.push(`一次最多发送 ${MAX_MEDIA_PER_REPLY} 个媒体（图片+文件），其余 ${media.length - MAX_MEDIA_PER_REPLY} 个已忽略`);
    }

    const mediaToSend = media.slice(0, MAX_MEDIA_PER_REPLY);
    for (let i = 0; i < mediaToSend.length; i++) {
      const { kind, path: filePath } = mediaToSend[i];
      const label = kind === 'image' ? '图片' : '文件';

      let prepared;
      try {
        prepared = await uploadMedia({
          ilink: this.ilink,
          workspace: this.cwd,
          kind,
          filePath,
          toUserId,
        });
      } catch (err) {
        notes.push(`${label}「${filePath}」发送失败：${err.message}`);
        this.log(`${kind === 'image' ? '🖼' : '📎'} ${label}上传失败 ${filePath}: ${err.message}`);
        continue;
      }

      try {
        const status = await this.#sendOrQueueMedia(toUserId, prepared, contextToken);
        if (status === 'sent') {
          sentMedia++;
          this.log(`${kind === 'image' ? '🖼' : '📎'} 已发送${label} ${prepared.name} (${Math.round(prepared.bytes / 1024)}KB)`);
          continue;
        }

        // token 失效：当前媒体已入队，后续媒体也按顺序上传并入队，再排队文字。
        queuedMedia++;
        for (const rest of mediaToSend.slice(i + 1)) {
          const restLabel = rest.kind === 'image' ? '图片' : '文件';
          try {
            const p = await uploadMedia({
              ilink: this.ilink,
              workspace: this.cwd,
              kind: rest.kind,
              filePath: rest.path,
              toUserId,
            });
            this.#queueOutbound(toUserId, { type: 'media', media: p }, 'context_token 失效', { quiet: true });
            queuedMedia++;
          } catch (err) {
            notes.push(`${restLabel}「${rest.path}」发送失败：${err.message}`);
            this.log(`${rest.kind === 'image' ? '🖼' : '📎'} ${restLabel}上传失败 ${rest.path}: ${err.message}`);
          }
        }
        break;
      } catch (err) {
        notes.push(`${label}「${filePath}」发送失败：${err.message}`);
        this.log(`${kind === 'image' ? '🖼' : '📎'} ${label}发送失败 ${filePath}: ${err.message}`);
      }
    }

    const warning = notes.length ? notes.map((n) => `⚠️ ${n}`).join('\n') : '';

    // 超长 / 大代码块 / 大表格：写成 .md 文件走 FILE 通道，聊天里只留摘要。
    // 转文件失败不能丢内容，回退到普通分段发送。
    let noteBody = null;
    let overflowQueued = 0;
    if (rawBody.trim()) {
      const oversize = analyzeOversize(rawBody);
      if (oversize.overflow) {
        let file = null;
        try {
          file = await writeOverflowFile(this.cwd, rawBody);
        } catch (err) {
          this.log(`📎 长回复转文件失败，回退为分段发送: ${err.message}`);
        }

        if (file) {
          let prepared = null;
          try {
            prepared = await uploadMedia({
              ilink: this.ilink,
              workspace: this.cwd,
              kind: 'file',
              filePath: file.relPath,
              toUserId,
            });
          } catch (err) {
            this.log(`📎 长回复文件上传失败，回退为分段发送: ${err.message}`);
          }

          if (prepared) {
            let status = null;
            try {
              status = await this.#sendOrQueueMedia(toUserId, prepared, contextToken);
            } catch (err) {
              this.log(`📎 长回复文件发送失败，回退为分段发送: ${err.message}`);
            }
            if (status === 'sent') {
              sentMedia++;
              this.log(
                `📎 回复较长（${oversize.reason}，${rawBody.length} 字），已转为文件 ${file.relPath} (${Math.round(file.bytes / 1024)}KB)`,
              );
            } else if (status === 'queued') {
              overflowQueued++;
              this.log(`📎 长回复文件已进入待发队列 ${file.relPath}`);
            }
            if (status) {
              noteBody = buildOverflowNote({
                fileName: file.name,
                chars: rawBody.length,
                plainText: markdownToPlainText(rawBody),
              });
            }
          }
        }
      }
    }

    // 微信不渲染 Markdown：发送前统一转成纯文本
    let body = noteBody
      ? [warning, noteBody].filter(Boolean).join('\n\n')
      : [warning, markdownToPlainText(rawBody)].filter(Boolean).join('\n\n');

    if (!body) {
      // 只有媒体、没有文字：媒体发出去就够了
      if (sentMedia > 0 || queuedMedia > 0 || overflowQueued > 0) {
        return { sent: sentMedia, queued: queuedMedia + overflowQueued };
      }
      body = '（DSH 没有返回内容）';
    }

    // 已经有媒体进待发队列时，文字也排队，保证补发顺序
    if (queuedMedia + overflowQueued > 0) {
      const n = this.queueTextBody(toUserId, body);
      return { sent: sentMedia, queued: queuedMedia + overflowQueued + n };
    }

    const textResult = await this.#sendTextChunks(toUserId, body, contextToken);
    return { sent: sentMedia + textResult.sent, queued: textResult.queued };
  }

  /** 用最新的 context_token 补发某个用户的积压消息；遇到 token 仍失效就保留剩余。 */
  async flush(peerId) {
    if (!this.outbox) return;
    const items = this.outbox.list(peerId);
    if (items.length === 0) return;

    const contextToken = this.getContextToken(peerId);
    if (!contextToken) {
      this.log(`📮 [${peerId.slice(0, 12)}…] 还有 ${items.length} 条待发消息，但缺少 context_token`);
      return;
    }

    this.log(`📮 [${peerId.slice(0, 12)}…] 尝试补发 ${items.length} 条积压消息`);
    let sent = 0;
    for (const item of items) {
      try {
        if (item.type === 'text') {
          await this.ilink.sendText({ toUserId: peerId, text: item.text, contextToken });
        } else if (item.type === 'media') {
          await sendPreparedMedia({
            ilink: this.ilink,
            toUserId: peerId,
            contextToken,
            prepared: item.media,
          });
        } else {
          throw new Error(`未知待发消息类型 ${item.type}`);
        }
        this.outbox.shift(peerId, 1);
        sent++;
        this.log(`📮 补发成功（${sent}/${items.length}）`);
      } catch (err) {
        if (isTokenExpiredError(err)) {
          this.log(`📮 补发暂停：context_token 仍未生效（已补发 ${sent}/${items.length}），剩余消息继续保留`);
          break;
        }
        // 非 token 错误：这条再试也不会成功，丢弃以免堵住队列
        this.outbox.shift(peerId, 1);
        this.log(`📮 丢弃无法补发的消息（${err.message}）`);
      }
    }
    if (sent > 0) this.log(`📮 已补发 ${sent} 条积压消息`);
    await this.outbox.flush().catch(() => {});
  }

  /**
   * 按分段规则把一段文字放进待发队列，返回条数。
   * 供内置命令（/new 确认）在 token 失效时使用，不尝试重新发送。
   */
  queueTextBody(toUserId, body) {
    const chunks = labelChunks(splitMessage(body, this.maxChars));
    return this.#queueTextChunks(toUserId, chunks);
  }

  /**
   * 发送一个已上传的媒体；token 失效时入队并返回 'queued'。
   * 其它错误抛给调用方（媒体文件坏了、CDN 拒绝等）。
   */
  async #sendOrQueueMedia(toUserId, prepared, contextToken) {
    try {
      await sendPreparedMedia({ ilink: this.ilink, toUserId, contextToken, prepared });
      return 'sent';
    } catch (err) {
      if (isTokenExpiredError(err)) {
        this.#queueOutbound(toUserId, { type: 'media', media: prepared }, 'context_token 失效', { quiet: true });
        this.log(`📮 媒体 ${prepared.name} 因 context_token 失效进入待发队列`);
        return 'queued';
      }
      throw err;
    }
  }

  /** 把纯文本按租户上限分段发送；单段失败只记日志，不中断后续。 */
  async #sendTextChunks(toUserId, body, contextToken) {
    const chunks = labelChunks(splitMessage(body, this.maxChars));

    if (chunks.length === 0) return { sent: 0, queued: 0 };
    if (chunks.length === 1) {
      try {
        await this.ilink.sendText({ toUserId, text: chunks[0], contextToken });
        return { sent: 1, queued: 0 };
      } catch (err) {
        if (isTokenExpiredError(err)) {
          return { sent: 0, queued: this.#queueTextChunks(toUserId, chunks) };
        }
        throw err;
      }
    }

    this.log(`回复较长（${body.length} 字），分 ${chunks.length} 段发送`);
    let sent = 0;
    for (let i = 0; i < chunks.length; i++) {
      try {
        const r = await this.ilink.sendText({ toUserId, text: chunks[i], contextToken });
        sent++;
        this.log(`  段 ${i + 1}/${chunks.length} 已发送 (${chunks[i].length} 字, msg=${r?.message_id ?? '-'})`);
      } catch (err) {
        if (isTokenExpiredError(err)) {
          const rest = chunks.slice(i);
          this.log(`  段 ${i + 1}/${chunks.length} 因 context_token 失效转入待发队列（剩余 ${rest.length} 段）`);
          return { sent, queued: this.#queueTextChunks(toUserId, rest) };
        }
        // 单段失败不中断后续，但要留下痕迹
        this.log(`  段 ${i + 1}/${chunks.length} 发送失败: ${err.message}`);
      }
      if (i < chunks.length - 1) await new Promise((r) => setTimeout(r, 400));
    }
    this.log(`  全部 ${chunks.length} 段发送完毕`);
    return { sent, queued: 0 };
  }

  #queueTextChunks(toUserId, chunks) {
    for (const text of chunks) {
      this.#queueOutbound(toUserId, { type: 'text', text }, 'context_token 失效', { quiet: true });
    }
    if (chunks.length > 0) {
      this.log(`📮 ${chunks.length} 段文字进入待发队列，用户下次发消息后补发`);
    }
    return chunks.length;
  }

  #queueOutbound(toUserId, item, reason, opts = {}) {
    if (!this.outbox) {
      this.log(`📮 待发队列未初始化，无法暂存消息（${reason}）`);
      return;
    }
    const dropped = this.outbox.add(toUserId, item);
    if (dropped > 0) {
      this.log(`📮 待发队列超过上限，丢弃 ${dropped} 条最旧消息`);
    }
    this.outbox.flush().catch((e) => this.log(`📮 待发队列落盘失败: ${e.message}`));
    if (!opts.quiet) {
      this.log(`📮 [${toUserId.slice(0, 12)}…] 消息进入待发队列（${reason}），用户下次发消息后补发`);
    }
  }
}
