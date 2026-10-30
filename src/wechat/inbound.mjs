/**
 * 入站流水线：访问控制 → 解析 → 同用户队列（500ms 合并）→ 回合执行/命令。
 *
 * 入口只有一个：push(msg)。Tenant 的长轮询把每条 WeixinMessage 交进来，
 * 解析、合并、ack 与命令都在本模块完成。
 *
 * 行为约束：
 *   - allowUsers 为空时只允许 owner；未授权只记日志，绝不进队列
 *   - 同用户 FIFO；同一时刻只跑一个回合；500ms 静默合并（最长压 3s）
 *   - 内置命令单独成批，保持命令前后的消息顺序
 *   - 每条上行消息刷新 context_token 缓存（可选调试落盘）
 *   - 慢请求先回一条「正在处理」；typing 失败不影响主流程
 *   - 图片/文件下载后与文字一起进 prompt
 *   - 消息里的链接先抓正文，再作为上下文注入
 *   - /new /status /tasks /usage /help 等内置命令直接发确认，不经过模型；
 *     token 失效时走 reply.queueTextBody 进待发队列
 *
 * 只通过注入对象工作：conv.ask/reset、reply.send/flush/queueTextBody、
 * ilink（typing 与命令确认）、media（入站媒体）。
 */

import { extractInboundText, formatQuotedContext, isTokenExpiredError } from './ilink.mjs';
import { UserMessageQueue, DEFAULT_MERGE_WINDOW_MS } from './message-queue.mjs';
import { parseBuiltinCommand, renderCommand } from './commands.mjs';

export class InboundPipeline {
  /**
   * @param {object} opts
   * @param {object} opts.tenant            - 租户视图（id / ownerId / allowUsers / ackDelayMs）
   * @param {object} opts.ilink             - iLink 客户端（typing 与命令确认）
   * @param {object} opts.conv              - ConversationManager（ask / reset）
   * @param {object} opts.reply             - ReplySender（send / flush / queueTextBody）
   * @param {object} opts.media             - MediaIngest（loadImages / loadFiles）
   * @param {{get(peerId:string):string|undefined,set(peerId:string,token:string):void,
   *          flush(force?:boolean):Promise<unknown>}} opts.tokens - context_token 存储
   * @param {object|null} [opts.links]      - LinkIngest（enrich）
   * @param {object|null} [opts.commands]   - 内置命令依赖：usage / getStatus / listTasks
   * @param {(msg: string) => void} [opts.log]
   */
  constructor({
    tenant, ilink, conv, reply, media, tokens,
    links = null, commands = null, log = () => {},
  }) {
    this.tenant = tenant;
    this.ilink = ilink;
    this.conv = conv;
    this.reply = reply;
    this.media = media;
    this.tokens = tokens;
    this.links = links;
    this.commands = commands;
    this.log = log;
    /** 每个用户的 typing_ticket 缓存（取不到就每次重试） */
    this.typingTickets = new Map();

    /**
     * 同用户消息队列：串行执行 + 500ms 合并。
     */
    this.queue = new UserMessageQueue({
      windowMs: DEFAULT_MERGE_WINDOW_MS,
      handle: (peerId, batch) => this.#handleBatch(peerId, batch),
      log: (m) => this.log(`[queue] ${m}`),
    });
  }

  /**
   * 同步入队：一条原始 WeixinMessage。
   * 访问控制与解析在入队前完成，保证未授权消息不占队列。
   */
  push(msg) {
    this.#handleMessage(msg).catch((e) => this.log(`处理消息失败: ${e.message}`));
  }

  /** 停止接收并清掉所有待合并定时器（已在跑的回合不会被打断）。 */
  stop() {
    this.queue.stop();
  }

  /** 诊断用：队列里还有多少用户/待处理消息。 */
  stats() {
    return this.queue.stats();
  }

  /**
   * 重启后换用新的 iLink / 会话 / 发送器。
   * 队列本身保留，避免 dsh 重启期间已到达的消息被丢掉。
   */
  rebind({ ilink = this.ilink, conv = this.conv, reply = this.reply } = {}) {
    this.ilink = ilink;
    this.conv = conv;
    this.reply = reply;
  }

  #isAllowed(userId) {
    const owner = this.tenant.ownerId?.trim();
    const allow = (this.tenant.allowUsers ?? []).filter((u) => typeof u === 'string' && u.trim());
    if (allow.length === 0) return owner ? userId === owner : false;
    return allow.includes(userId);
  }

  async #handleMessage(msg) {
    const from = msg.from_user_id;
    if (!from) return;
    if (msg.message_type === 2) return; // bot 自己发的

    if (!this.#isAllowed(from)) {
      this.log(`拒绝未授权用户: ${from}`);
      return;
    }

    const {
      text,
      kind,
      images: rawImages,
      files: rawFiles,
      quoted,
    } = extractInboundText(msg);

    // 引用消息：被引用的文本放在当前消息之前，媒体与当前媒体一起送进模型
    const quotedNote = formatQuotedContext(quoted);
    const promptBody = quotedNote ? `${quotedNote}\n\n${text}` : text;
    const allImages = [...(quoted?.images ?? []), ...(rawImages ?? [])];
    const allFiles = [...(quoted?.files ?? []), ...(rawFiles ?? [])];
    if (!promptBody && allImages.length === 0 && allFiles.length === 0) return;

    // 缓存 context_token：每条回复都必须带上它才能送达。
    // 在入队前完成，保证后到的消息也能被定时任务复用。
    // 只在内存里，不落盘 —— 它等价于一次有效会话的凭据。
    const contextToken = msg.context_token ?? this.tokens.get(from);
    if (msg.context_token) {
      this.tokens.set(from, msg.context_token);
      // 显式开启调试时才落盘（默认关闭）。不 await，避免打乱入队顺序。
      if (process.env.BRIDGE_DUMP_CONTEXT_TOKEN === '1') {
        import('node:fs/promises')
          .then(({ writeFile: wf }) => wf(`/tmp/.dsh-wechat-ctx-${this.tenant.id}`, msg.context_token, { mode: 0o600 }))
          .catch(() => {});
      }
    }

    // 内置命令不经过模型。标记为不可合并，队列会让它单独成批，
    // 从而保持「命令前/命令后」的消息顺序。
    // 未知的 /xxx 不拦截，照常交给模型。
    const builtin = parseBuiltinCommand(text);
    this.queue.push(from, {
      kind: builtin ? 'command' : kind,
      command: builtin?.name ?? null,
      text: promptBody,
      images: allImages,
      files: allFiles,
      contextToken,
      mergeable: !builtin,
    });
  }

  /**
   * 队列回调：同一用户的回合在这里串行执行（不会并发跑两个回合）。
   * batch 可能是多条消息合并后的结果。
   */
  async #handleBatch(from, batch) {
    // 用户刚发来新消息 → context_token 已刷新，先把之前积压的消息补发掉
    await this.reply.flush(from);

    if (batch.kind === 'command') {
      await this.#handleCommand(from, batch);
      return;
    }

    const { text, images: rawImages, files: rawFiles, contextToken } = batch;
    try {
      const merged = batch.messageCount > 1 ? ` ×${batch.messageCount}` : '';
      this.log(`📨 [${from.slice(0, 12)}…] (${batch.kind}${merged}) ${text.slice(0, 50)}`);

      let ticket = this.typingTickets.get(from);
      if (ticket === undefined) {
        ticket = await this.ilink.getConfig(from);
        this.typingTickets.set(from, ticket);
      }
      this.ilink.sendTyping(from, ticket).catch(() => {});

      // 慢请求兜底：超过阈值先回一条"处理中"，避免用户以为 bot 挂了。
      // 复杂问题的推理可能耗时数分钟，静默等待体验很差。
      const ACK_DELAY_MS = this.tenant.ackDelayMs ?? 15_000;
      let acked = false;
      const ackTimer = setTimeout(() => {
        acked = true;
        this.reply.send(from, '⏳ 正在处理，这个问题需要点时间，请稍候…', contextToken).catch(() => {});
      }, ACK_DELAY_MS);

      // 下载并解密图片（大图/不支持格式会被压缩或转码）
      // 文件下载、链接抓取与图片下载并行，避免串行等待放大延迟
      const [imageBlocks, fileNote, linkNote] = await Promise.all([
        this.media.loadImages(from, rawImages),
        this.media.loadFiles(rawFiles),
        this.links
          ? this.links.enrich(text, { peerId: from }).catch((err) => {
            this.log(`链接抓取失败（忽略）: ${err.message}`);
            return '';
          })
          : Promise.resolve(''),
      ]);
      const originals = imageBlocks.map((b) => b.originalPath).filter(Boolean);
      const imageNote = originals.length
        ? `用户发来的图片原图已保留在工作区（模型看到的是压缩/转码后的版本）：\n${originals.join('\n')}`
        : '';
      const promptText = [text, linkNote, imageNote, fileNote].filter(Boolean).join('\n\n');

      let reply;
      try {
        reply = await this.conv.ask(from, promptText, imageBlocks);
      } finally {
        clearTimeout(ackTimer);
      }

      if (acked) this.log('（已提前发送"处理中"提示）');
      await this.reply.send(from, reply || '（DSH 没有返回内容）', contextToken);
      this.log(`📤 [${from.slice(0, 12)}…] ${(reply || '').slice(0, 50)}`);
    } catch (err) {
      this.log(`处理失败: ${err.message}`);
      await this.reply.send(from, `⚠️ 处理失败：${err.message}`, contextToken).catch(() => {});
    }
  }

  /** 内置命令：不经过模型，直接由桥接处理。 */
  async #handleCommand(from, batch) {
    const name = batch.command ?? parseBuiltinCommand(batch.text)?.name;
    if (!name) return;

    if (name === 'new') {
      this.conv.reset(from);
      // 链接缓存按会话隔离；换会话后重新抓取，避免拿旧会话的路径当作已读
      this.links?.reset?.(from);
      await this.tokens.flush(true).catch(() => {});
      this.log(`🔄 [${from.slice(0, 12)}…] 已重置会话`);
      await this.#sendCommandReply(from, '🔄 已开启新会话，之前的上下文不再参与。', batch.contextToken);
      return;
    }

    let text = '';
    try {
      text = renderCommand(name, {
        status: this.commands?.getStatus?.(),
        tasks: this.commands?.listTasks?.() ?? [],
        usage: this.commands?.usage?.summary?.(),
      });
    } catch (err) {
      text = `⚠️ 命令 /${name} 执行失败：${err.message}`;
    }
    if (!text) return;

    this.log(`⌘ [${from.slice(0, 12)}…] /${name}`);
    await this.#sendCommandReply(from, text, batch.contextToken);
  }

  /** 命令回复：token 失效时进待发队列，其它错误只记日志。 */
  async #sendCommandReply(from, text, contextToken) {
    try {
      await this.ilink.sendText({ toUserId: from, text, contextToken });
    } catch (err) {
      if (isTokenExpiredError(err)) {
        this.reply.queueTextBody(from, text);
        this.log(`⌘ 命令回复因 context_token 失效进入待发队列`);
      } else {
        this.log(`⌘ 命令回复发送失败: ${err.message}`);
      }
    }
  }
}
