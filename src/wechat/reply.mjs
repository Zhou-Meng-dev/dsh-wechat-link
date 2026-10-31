/**
 * 出站回复：媒体指令、Markdown 清理、超长转文件、分段、失败重试与待发队列。
 *
 * 一块行为，三个入口：
 *   - send()     把一条 agent 回复完整送到用户（必要时入队/DLQ）
 *   - sendText() 发送一段纯文本（内置命令回复复用同一套重试语义）
 *   - flush()    用最新 context_token 补发积压（严格按 seq 从队首开始）
 *
 * 行为约束：
 *   - `[[image:]]` / `[[file:]]` 先发、最多 5 个，失败在文字前加警告
 *   - 超长/大代码块/大表格转成 `.md` 文件走 FILE 通道，聊天里只留摘要
 *   - 微信不渲染 Markdown，正文发送前统一转纯文本
 *   - 按租户 maxChars 分段（默认 1800 字），段间间隔 400ms
 *   - 错误分类（send-errors）：
 *       token      → 入队，不消耗尝试次数
 *       retryable  → 原地 500ms 重试一次，仍失败入队并退避
 *       permanent  → 进 DLQ + 告警（不无限重试）
 *   - 队首未到 nextAttemptAt 时绝不跳过去发后面的（保序）
 *
 * 本模块不读 Tenant 的私有字段：工作目录、分段上限、token 查询、时钟都由构造参数注入。
 */

import { labelChunks, splitMessage, DEFAULT_MAX_CHARS } from './split.mjs';
import {
  extractMediaDirectives,
  MAX_MEDIA_PER_REPLY,
  sendPreparedMedia,
  uploadMedia,
} from './outbound-media.mjs';
import { markdownToPlainText } from './markdown.mjs';
import { analyzeOversize, buildOverflowNote, writeOverflowFile } from './overflow.mjs';
import { previewOf } from './outbox.mjs';
import { newClientId } from './ids.mjs';
import { classifySendError } from './send-errors.mjs';
import { DEFAULT_MAX_ATTEMPTS, nextAttemptDelay } from './retry-policy.mjs';

/** 可重试错误的首次原地重试延迟 */
export const RETRY_INLINE_DELAY_MS = 500;
/** 单次 flush 最多补发多少条，避免长队列把入站处理拖住 */
export const MAX_FLUSH_ITEMS = 10;

const sleepDefault = (ms) => new Promise((r) => setTimeout(r, ms));

export class ReplySender {
  /**
   * @param {object} opts
   * @param {string} opts.cwd                 - 租户工作区（媒体与 _outbox 都相对它）
   * @param {number} [opts.maxChars]          - 单条消息分段上限
   * @param {import('./ilink.mjs').IlinkClient} opts.ilink
   * @param {import('./outbox.mjs').OutboxStore|null} [opts.outbox] - 未初始化时只记日志
   * @param {import('./dlq.mjs').DlqStore|null} [opts.dlq]          - 放弃的消息写这里
   * @param {(info: object) => void} [opts.onDlq]                   - DLQ 告警回调（异步，不等待）
   * @param {(msg: string) => void} [opts.log]
   * @param {(peerId: string) => string|undefined} [opts.getContextToken] - flush 时取最新 token
   * @param {() => number} [opts.now]         - 注入时钟（测试退避）
   * @param {(ms: number) => Promise<void>} [opts.sleep] - 注入等待（测试）
   * @param {() => number} [opts.random]      - 退避抖动随机源
   */
  constructor({
    cwd,
    maxChars = DEFAULT_MAX_CHARS,
    ilink,
    outbox = null,
    dlq = null,
    onDlq = null,
    log = () => {},
    getContextToken = () => undefined,
    now = () => Date.now(),
    sleep = sleepDefault,
    random = Math.random,
    maxFlushItems = MAX_FLUSH_ITEMS,
  }) {
    this.cwd = cwd;
    this.maxChars = maxChars ?? DEFAULT_MAX_CHARS;
    this.ilink = ilink;
    this.outbox = outbox;
    this.dlq = dlq;
    this.onDlq = onDlq;
    this.log = log;
    this.getContextToken = getContextToken;
    this.now = now;
    this.sleep = sleep;
    this.random = random;
    this.maxFlushItems = maxFlushItems;
  }

  /**
   * 发送回复：先按 [[image: ...]] / [[file: ...]] 指令发媒体，再把文字超长分段发送。
   * 媒体失败会在文字前加警告，避免 agent 说"已发送"而用户什么都没收到。
   *
   * @returns {Promise<{sent: number, queued: number}>}
   *          queued > 0 表示有内容因可恢复错误进入了待发队列。
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
    /** 一旦有媒体进了待发队列，后续媒体也必须入队，否则补发顺序会乱 */
    let queueRest = false;

    for (let i = 0; i < mediaToSend.length; i++) {
      const { kind, path: filePath } = mediaToSend[i];
      const label = kind === 'image' ? '图片' : '文件';

      if (queueRest) {
        await this.#queueMediaFile(toUserId, kind, filePath, notes);
        queuedMedia++;
        continue;
      }

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
        const kindOfError = classifySendError(err);
        notes.push(`${label}「${filePath}」发送失败：${err.message}`);
        this.log(`${kind === 'image' ? '🖼' : '📎'} ${label}上传失败 ${filePath}: ${err.message}`);
        if (kindOfError === 'permanent') {
          this.#recordDlq(toUserId, { type: 'media-file', kind, filePath }, err.message, 0);
          continue;
        }
        // 可重试：存 media-file，补发时重新上传（会再过一次 workspace 白名单）
        this.#queueOutbound(
          toUserId,
          { type: 'media-file', kind, filePath },
          `上传失败：${err.message}`,
          { attempts: 1, nextAt: this.#nextAt(1) },
        );
        queuedMedia++;
        queueRest = true;
        continue;
      }

      try {
        const status = await this.#sendOrQueueMedia(toUserId, prepared, contextToken);
        if (status === 'sent') {
          sentMedia++;
          this.log(`${kind === 'image' ? '🖼' : '📎'} 已发送${label} ${prepared.name} (${Math.round(prepared.bytes / 1024)}KB)`);
          continue;
        }
        if (status === 'dropped') continue;

        // 已入队：后续媒体也按顺序入队，再排队文字
        queuedMedia++;
        queueRest = true;
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
            // status === 'dropped'：文件已进 DLQ，回退为分段发送正文
            if (status && status !== 'dropped') {
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

  /**
   * 发送纯文本（内置命令回复 / 提示复用）。
   * 与 send() 使用同一套分类、原地重试与入队逻辑，但不再解析媒体指令与 Markdown。
   *
   * @returns {Promise<{sent: number, queued: number}>}
   */
  sendText(peerId, text, contextToken) {
    return this.#sendTextChunks(peerId, text, contextToken);
  }

  /**
   * 用最新的 context_token 补发某个用户的积压消息。
   * 严格从队首开始：未到 nextAttemptAt 就停，不跳过它去发后面的。
   */
  async flush(peerId) {
    if (!this.outbox) return;
    const queued = this.outbox.list(peerId);
    if (queued.length === 0) return;

    const contextToken = this.getContextToken(peerId);
    if (!contextToken) {
      // 没有 token 不消耗尝试次数：等用户下次入站
      this.log(`📮 [${peerId.slice(0, 12)}…] 还有 ${queued.length} 条待发消息，但缺少 context_token`);
      return;
    }

    let sent = 0;
    for (let i = 0; i < this.maxFlushItems; i++) {
      const item = this.outbox.dueHead(peerId, this.now());
      if (!item) break; // 队列空 / 队首未到重试时间

      try {
        await this.#sendOutboxItem(peerId, item, contextToken);
        this.outbox.remove(peerId, item.seq);
        sent++;
        this.log(`📮 补发成功（${sent}/${queued.length}）`);
      } catch (err) {
        const kind = classifySendError(err);
        const summary = errorSummary(err);

        if (kind === 'token') {
          this.log(`📮 补发暂停：context_token 仍未生效（已补发 ${sent}/${queued.length}），剩余消息继续保留`);
          break;
        }

        const attempts = (item.attempts ?? 0) + 1;
        if (kind === 'permanent') {
          // 先把这一次失败计入 attempts，DLQ 摘要才是真实的尝试次数
          this.outbox.markAttempt(peerId, item.seq, { error: summary, nextAt: this.now() });
          this.outbox.moveToDlq(peerId, item.seq, summary);
          this.#notifyDlq(peerId, item, summary, attempts);
          this.log(`📮 永久错误，已放弃（${item.type}）: ${summary}`);
          continue; // 队首已移除，继续下一条，剩余顺序不变
        }

        if (attempts >= DEFAULT_MAX_ATTEMPTS) {
          this.outbox.markAttempt(peerId, item.seq, { error: summary, nextAt: this.now() });
          this.outbox.moveToDlq(peerId, item.seq, summary);
          this.#notifyDlq(peerId, item, summary, attempts);
          this.log(`📮 已尝试 ${attempts} 次，进入 DLQ: ${summary}`);
          continue;
        }

        const delay = nextAttemptDelay(attempts, { random: this.random });
        this.outbox.markAttempt(peerId, item.seq, { error: summary, nextAt: this.now() + delay });
        this.log(`📮 第 ${attempts} 次失败，${Math.round(delay / 1000)}s 后重试: ${summary}`);
        break; // 队首失败：本轮停止，保证后续消息不会插队
      }
    }

    if (sent > 0) this.log(`📮 已补发 ${sent} 条积压消息`);
    await this.outbox.flush().catch(() => {});
    await this.dlq?.flush().catch(() => {});
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
   * 发送一个已上传的媒体。
   * @returns {Promise<'sent'|'queued'|'dropped'>}
   */
  async #sendOrQueueMedia(toUserId, prepared, contextToken) {
    // 一次逻辑发送只生成一个幂等键：原地重试与入队补发都复用它
    const clientId = newClientId();
    const attempt = () => sendPreparedMedia({
      ilink: this.ilink,
      toUserId,
      contextToken,
      prepared,
      clientId,
    });

    try {
      await attempt();
      return 'sent';
    } catch (err) {
      const kind = classifySendError(err);

      if (kind === 'token') {
        this.#queueOutbound(toUserId, { type: 'media', media: prepared }, 'context_token 失效', { quiet: true, clientId });
        this.log(`📮 媒体 ${prepared.name} 因 context_token 失效进入待发队列`);
        return 'queued';
      }

      if (kind === 'permanent') {
        this.#recordDlq(toUserId, { type: 'media', media: prepared }, err.message, 0);
        return 'dropped';
      }

      // 可重试：原地 500ms 再试一次
      this.log(`📮 媒体 ${prepared.name} 发送失败（可重试），${RETRY_INLINE_DELAY_MS}ms 后原地重试一次: ${err.message}`);
      await this.sleep(RETRY_INLINE_DELAY_MS);
      try {
        await attempt();
        return 'sent';
      } catch (err2) {
        const kind2 = classifySendError(err2);
        if (kind2 === 'token') {
          this.#queueOutbound(toUserId, { type: 'media', media: prepared }, 'context_token 失效', { quiet: true, clientId });
          this.log(`📮 媒体 ${prepared.name} 因 context_token 失效进入待发队列`);
          return 'queued';
        }
        if (kind2 === 'permanent') {
          this.#recordDlq(toUserId, { type: 'media', media: prepared }, err2.message, 1);
          return 'dropped';
        }
        this.#queueOutbound(
          toUserId,
          { type: 'media', media: prepared },
          `可重试错误：${err2.message}`,
          { attempts: 1, nextAt: this.#nextAt(1), clientId },
        );
        this.log(`📮 媒体 ${prepared.name} 进入待发队列，稍后重试`);
        return 'queued';
      }
    }
  }

  /**
   * 把后续媒体按顺序处理：上传成功就存已上传参数，失败就存 media-file 等补发时重传。
   * 这样既不会因为一次 token 失效丢掉后续媒体，也不会打乱顺序。
   */
  async #queueMediaFile(toUserId, kind, filePath, notes) {
    const label = kind === 'image' ? '图片' : '文件';
    try {
      const prepared = await uploadMedia({
        ilink: this.ilink,
        workspace: this.cwd,
        kind,
        filePath,
        toUserId,
      });
      this.#queueOutbound(toUserId, { type: 'media', media: prepared }, 'context_token 失效', { quiet: true });
    } catch (err) {
      notes.push(`${label}「${filePath}」发送失败：${err.message}`);
      this.log(`${kind === 'image' ? '🖼' : '📎'} ${label}上传失败 ${filePath}: ${err.message}`);
      if (classifySendError(err) === 'permanent') {
        this.#recordDlq(toUserId, { type: 'media-file', kind, filePath }, err.message, 0);
        return;
      }
      this.#queueOutbound(
        toUserId,
        { type: 'media-file', kind, filePath },
        `上传失败：${err.message}`,
        { attempts: 1, nextAt: this.#nextAt(1) },
      );
    }
  }

  /**
   * 把纯文本按租户上限分段发送；单段失败按分类处理，不中断后续（永久错误除外）。
   */
  async #sendTextChunks(toUserId, body, contextToken) {
    const chunks = labelChunks(splitMessage(body, this.maxChars));
    if (chunks.length === 0) return { sent: 0, queued: 0 };

    let sent = 0;
    for (let i = 0; i < chunks.length; i++) {
      // 每段是独立消息，各自一个幂等键；失败入队时复用同一段的键
      const clientId = newClientId();
      const outcome = await this.#deliverTextChunk(toUserId, chunks[i], contextToken, clientId);

      if (outcome === 'sent') {
        sent++;
        if (chunks.length > 1) {
          this.log(`  段 ${i + 1}/${chunks.length} 已发送 (${chunks[i].length} 字)`);
        }
      } else if (outcome === 'token') {
        const rest = chunks.slice(i);
        this.log(`  段 ${i + 1}/${chunks.length} 因 context_token 失效转入待发队列（剩余 ${rest.length} 段）`);
        return { sent, queued: this.#queueTextChunks(toUserId, rest, { clientId }) };
      } else if (outcome === 'queued') {
        const rest = chunks.slice(i);
        this.log(`  段 ${i + 1}/${chunks.length} 因可重试错误转入待发队列（剩余 ${rest.length} 段）`);
        return {
          sent,
          queued: this.#queueTextChunks(toUserId, rest, {
            reason: '可重试错误',
            attempts: 1,
            nextAt: this.#nextAt(1),
            clientId,
          }),
        };
      }
      // outcome === 'dropped'：已进 DLQ，继续发后面的段

      if (i < chunks.length - 1) await this.sleep(400);
    }

    if (chunks.length > 1) this.log(`  全部 ${chunks.length} 段处理完毕（成功 ${sent} 段）`);
    return { sent, queued: 0 };
  }

  /**
   * 发送单段文字，返回处理结果。
   * @returns {Promise<'sent'|'token'|'queued'|'dropped'>}
   */
  async #deliverTextChunk(peerId, text, contextToken, clientId) {
    try {
      await this.ilink.sendText({ toUserId: peerId, text, contextToken, clientId });
      return 'sent';
    } catch (err) {
      const kind = classifySendError(err);
      if (kind === 'token') return 'token';

      if (kind === 'permanent') {
        this.#recordDlq(peerId, { type: 'text', text }, err.message, 0);
        return 'dropped';
      }

      this.log(`文字发送失败（可重试），${RETRY_INLINE_DELAY_MS}ms 后原地重试一次: ${err.message}`);
      await this.sleep(RETRY_INLINE_DELAY_MS);
      try {
        await this.ilink.sendText({ toUserId: peerId, text, contextToken, clientId });
        return 'sent';
      } catch (err2) {
        const kind2 = classifySendError(err2);
        if (kind2 === 'token') return 'token';
        if (kind2 === 'permanent') {
          this.#recordDlq(peerId, { type: 'text', text }, err2.message, 1);
          return 'dropped';
        }
        return 'queued';
      }
    }
  }

  #queueTextChunks(toUserId, chunks, { reason = 'context_token 失效', attempts = 0, nextAt = 0, clientId = null } = {}) {
    let first = true;
    for (const text of chunks) {
      this.#queueOutbound(
        toUserId,
        { type: 'text', text },
        reason,
        { quiet: true, attempts, nextAt, clientId: first ? clientId : null },
      );
      first = false;
    }
    if (chunks.length > 0) {
      this.log(`📮 ${chunks.length} 段文字进入待发队列（${reason}），用户下次发消息后补发`);
    }
    return chunks.length;
  }

  /** 发送一条 outbox 条目（补发路径）。media-file 会重新上传并再次经过 workspace 校验。 */
  async #sendOutboxItem(peerId, item, contextToken) {
    const clientId = item.clientId;
    if (item.type === 'text') {
      return this.ilink.sendText({ toUserId: peerId, text: item.text, contextToken, clientId });
    }
    if (item.type === 'media') {
      return sendPreparedMedia({
        ilink: this.ilink,
        toUserId: peerId,
        contextToken,
        prepared: item.media,
        clientId,
      });
    }
    if (item.type === 'media-file') {
      const prepared = await uploadMedia({
        ilink: this.ilink,
        workspace: this.cwd,
        kind: item.kind,
        filePath: item.filePath,
        toUserId: peerId,
      });
      return sendPreparedMedia({
        ilink: this.ilink,
        toUserId: peerId,
        contextToken,
        prepared,
        clientId,
      });
    }
    throw new Error(`未知待发消息类型 ${item.type}`);
  }

  #queueOutbound(toUserId, item, reason, opts = {}) {
    if (!this.outbox) {
      this.log(`📮 待发队列未初始化，无法暂存消息（${reason}）`);
      return;
    }
    const dropped = this.outbox.add(toUserId, item, {
      attempts: opts.attempts,
      nextAttemptAt: opts.nextAt,
      clientId: opts.clientId ?? undefined,
    });
    if (dropped > 0) {
      this.log(`📮 待发队列超过上限，丢弃 ${dropped} 条最旧消息`);
    }
    this.outbox.flush().catch((e) => this.log(`📮 待发队列落盘失败: ${e.message}`));
    if (!opts.quiet) {
      this.log(`📮 [${toUserId.slice(0, 12)}…] 消息进入待发队列（${reason}），用户下次发消息后补发`);
    }
  }

  /** 不在 outbox 里的消息（上传/发送当场就永久失败）直接写 DLQ。 */
  #recordDlq(peerId, item, reason, attempts) {
    const summary = String(reason ?? '').slice(0, 200);
    try {
      this.dlq?.add({ peerId, type: item.type, reason: summary, attempts, preview: previewOf(item) });
      this.dlq?.flush().catch(() => {});
    } catch (err) {
      this.log(`📮 写 DLQ 失败（忽略）: ${err.message}`);
    }
    this.#notifyDlq(peerId, item, summary, attempts);
  }

  #notifyDlq(peerId, item, reason, attempts) {
    this.log(`📮 消息进入 DLQ（${item.type}，尝试 ${attempts} 次）: ${String(reason).slice(0, 120)}`);
    try {
      // 告警自身失败只记日志，绝不再入队（防止循环）
      const r = this.onDlq?.({ peerId, item, reason, attempts });
      if (r && typeof r.catch === 'function') r.catch((e) => this.log(`DLQ 告警失败（忽略）: ${e.message}`));
    } catch (err) {
      this.log(`DLQ 告警回调失败（忽略）: ${err.message}`);
    }
  }

  #nextAt(attempts) {
    return this.now() + nextAttemptDelay(attempts, { random: this.random });
  }
}

function errorSummary(err) {
  const msg = err?.message ?? String(err ?? '未知错误');
  return msg.slice(0, 200);
}
