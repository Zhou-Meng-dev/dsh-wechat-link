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
import { dayKey } from '../ops/usage.mjs';
import { budgetBlocked } from '../ops/budget-guard.mjs';
import { TENANT_LIMITS_DEFAULTS } from '../config.mjs';

/**
 * 「每日回合上限」提示的节流窗口。
 * 键里已经带了本地日期，窗口取 24h，保证同一个用户当天只被打扰一次
 * （默认的 5 分钟窗口会让提示每 5 分钟重复一次）。
 */
const QUOTA_NOTICE_WINDOW_MS = 24 * 60 * 60 * 1000;

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
   * @param {{commitMany(ids: string[]): Promise<unknown>}|null} [opts.journal]
   *        入站日志。只暴露 commitMany：流水线拿不到游标，也无法推进它
   * @param {object|null} [opts.limits]     - TenantLimits（truncate / take / allowDay / recordTurn）
   * @param {object|null} [opts.semaphore]  - Semaphore（全局并发上限）
   * @param {{canSend(peerId: string, key: string, opts?: object): boolean}|null} [opts.notice]
   *        提示节流：同一 peer + key 在窗口内只发一次
   * @param {{action: 'warn'|'block', canSpend(peerId: string): object}|null} [opts.budgetGuard]
   *        预算守卫：block 且超限时拒绝新回合
   * @param {() => Date} [opts.now] - 注入时钟（每日配额提示 key 用）
   * @param {(msg: string) => void} [opts.log]
   */
  constructor({
    tenant, ilink, conv, reply, media, tokens,
    links = null, commands = null, journal = null,
    limits = null, semaphore = null, notice = null, budgetGuard = null,
    now = () => new Date(), log = () => {},
  }) {
    this.tenant = tenant;
    this.ilink = ilink;
    this.conv = conv;
    this.reply = reply;
    this.media = media;
    this.tokens = tokens;
    this.links = links;
    this.commands = commands;
    this.journal = journal;
    this.limits = limits;
    this.semaphore = semaphore;
    this.notice = notice;
    this.budgetGuard = budgetGuard;
    this.now = now;
    this.log = log;
    /** 每个用户的 typing_ticket 缓存（取不到就每次重试） */
    this.typingTickets = new Map();
    /** 限流/上限/截断计数（status 直接读这里） */
    this.counters = { rejected: 0, rateLimited: 0, budgetBlocked: 0, truncated: 0 };
    /**
     * 已在队列 / 回合中、但还没 commit 的 journalId。
     * 作用：dsh 重启后 Tenant 会用 sync.json.pending 重放，而队列本身也是保留的，
     * 不查重会把同一条消息再跑一遍。提交后从集合里移除。
     */
    this.queuedJournalIds = new Set();

    /**
     * 同用户消息队列：串行执行 + 500ms 合并。
     * handle 的第三个参数 items 保留每条的 journalId，回合结束后统一 commit。
     */
    this.queue = new UserMessageQueue({
      windowMs: DEFAULT_MERGE_WINDOW_MS,
      // 每用户待处理条数上限（租户配置，默认 20）；拒绝最新一条，不静默丢
      maxPerPeer: limits?.queueMaxPerPeer ?? tenant.queueMaxPerPeer ?? TENANT_LIMITS_DEFAULTS.queueMaxPerPeer,
      handle: (peerId, batch, items) => this.#handleBatch(peerId, batch, items),
      log: (m) => this.log(`[queue] ${m}`),
    });
  }

  /**
   * 同步入队：一条原始 WeixinMessage。
   * 访问控制与解析在入队前完成，保证未授权消息不占队列。
   *
   * @param {object} msg
   * @param {{journalId?: string}} [meta] - 入站日志条目 id（回合结束后 commit）
   */
  push(msg, meta = {}) {
    const journalId = meta?.journalId;
    if (journalId) {
      if (this.queuedJournalIds.has(journalId)) return; // 重放/重投递：已经在队列或回合中
      this.queuedJournalIds.add(journalId);
    }
    this.#handleMessage(msg, meta).catch((e) => {
      this.log(`处理消息失败: ${e.message}`);
      // 解析阶段抛错也不能把消息永久留在 pending：已给出日志，按已处理收尾
      this.#commitJournalId(journalId).catch(() => {});
    });
  }

  /** 停止接收并清掉所有待合并定时器（已在跑的回合不会被打断）。 */
  stop() {
    this.queue.stop();
  }

  /**
   * 优雅排空：不再接受新消息，立刻结算合并窗口，等在途回合完成。
   * 超时返回尚未 commit 的 journalId（保留在 sync.json.pending）。
   * @param {{timeoutMs?: number}} [opts]
   */
  drain(opts = {}) {
    return this.queue.drain(opts);
  }

  /** 尚未 commit 的入站消息 id（强制退出诊断用）。 */
  abandonedIds() {
    return this.queue.abandonedIds();
  }

  /** 诊断用：队列 + 限流/上限计数（status 依赖这些字段）。 */
  stats() {
    return {
      ...this.queue.stats(),
      rejected: this.counters.rejected,
      rateLimited: this.counters.rateLimited,
      busy: this.semaphore ? this.semaphore.stats().waiting : 0,
      budgetBlocked: this.counters.budgetBlocked,
      truncated: this.counters.truncated,
    };
  }

  /**
   * 重启后换用新的 iLink / 会话 / 发送器。
   * 队列本身保留，避免 dsh 重启期间已到达的消息被丢掉。
   *
   * journal 不在这里换：Tenant 传入的是 `{ commitMany }` 端口（闭包按调用时读
   * `tenant.journal`），新建 InboundJournal 后 commit 会自动落到新实例。
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

  async #handleMessage(msg, meta = {}) {
    const from = msg.from_user_id;
    // 在进入队列前就被丢弃的消息，也必须从 pending 里移出：
    // 它们已经得到确定处理结果（拒绝/忽略），不需要重启后重放。
    if (!from) {
      await this.#commitJournalId(meta?.journalId);
      return;
    }
    if (msg.message_type === 2) {
      await this.#commitJournalId(meta?.journalId); // bot 自己发的
      return;
    }

    if (!this.#isAllowed(from)) {
      this.log(`拒绝未授权用户: ${from}`);
      await this.#commitJournalId(meta?.journalId);
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
    if (!promptBody && allImages.length === 0 && allFiles.length === 0) {
      await this.#commitJournalId(meta?.journalId);
      return;
    }

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
    let queuedText = promptBody;

    // 检查点顺序：长度截断 → 速率 → 每日回合 → 入队上限。
    // 命令不调模型，不占速率/回合/并发名额。
    if (!builtin) {
      const truncated = this.limits?.truncate?.(promptBody);
      if (truncated?.truncated) {
        queuedText = truncated.text;
        this.counters.truncated += 1;
        this.log(`✂️ [${from.slice(0, 12)}…] 消息过长（${truncated.originalLength} 字），已截断`);
      }

      const rate = this.limits?.take?.(from);
      if (rate && rate.ok === false) {
        this.counters.rateLimited += 1;
        const seconds = Math.max(1, Math.ceil((rate.retryAfterMs ?? 1000) / 1000));
        this.#noticeOnce(from, 'rate', `⏳ 消息太频繁了，请 ${seconds} 秒后再试。`, contextToken);
        await this.#commitJournalId(meta?.journalId);
        return;
      }

      if (this.#blockedByQuota(from, contextToken)) {
        await this.#commitJournalId(meta?.journalId);
        return;
      }

      // 预算预检（block 模式）：入队前给用户即时反馈；
      // 回合开始前会再查一次，防止排队期间额度被别的回合花完。
      if (this.#blockedByBudget(from, contextToken)) {
        await this.#commitJournalId(meta?.journalId);
        return;
      }
    }

    const result = this.queue.push(from, {
      kind: builtin ? 'command' : kind,
      command: builtin?.name ?? null,
      text: queuedText,
      images: allImages,
      files: allFiles,
      contextToken,
      mergeable: !builtin,
      journalId: meta?.journalId,
    });
    if (result?.accepted === false) {
      if (result.reason === 'draining' || result.reason === 'stopped') {
        // 关闭中：不能 commit —— 消息必须留在 sync.json.pending，重启后重放
        if (meta?.journalId) this.queuedJournalIds.delete(meta.journalId);
        this.log(`队列已停止接收（${result.reason}），消息保留待重启重放`);
      } else {
        // 每用户队列满：拒绝最新一条 + 节流提示（用户能立刻感知并重发）
        this.counters.rejected += 1;
        this.#noticeOnce(
          from,
          result.reason === 'full' ? 'full' : 'rejected',
          '📥 待处理消息太多，请稍等片刻再发。',
          contextToken,
        );
        await this.#commitJournalId(meta?.journalId);
      }
    }
  }

  /**
   * 队列回调：同一用户的回合在这里串行执行（不会并发跑两个回合）。
   * batch 可能是多条消息合并后的结果。
   *
   * 无论成功、失败、被限流还是被预算拒绝，只要已经给出用户可见结果，
   * finally 就必须 commit；只有「进程被 kill」这种路径才留下 pending。
   */
  async #handleBatch(from, batch, items = []) {
    try {
      // 用户刚发来新消息 → context_token 已刷新，先把之前积压的消息补发掉
      await this.reply.flush(from);

      if (batch.kind === 'command') {
        // 命令不调模型，不占并发名额
        await this.#handleCommand(from, batch);
        return;
      }

      if (!this.semaphore) {
        await this.#runTurn(from, batch);
        return;
      }
      // 全局并发上限（每租户）：超出就排队等待，不拒绝
      const release = await this.semaphore.acquire();
      try {
        await this.#runTurn(from, batch);
      } finally {
        release?.();
      }
    } finally {
      // 回复可能刚进入待发队列：先确认落盘，再移除入站日志条目，
      // 否则进程被 kill 时会出现「日志已 commit、回复只在内存」的丢失窗口。
      try {
        await this.reply?.persist?.();
      } catch {
        /* 落盘失败时 commit 仍继续：最坏只是重启后重放一次 */
      }
      await this.#commitItems(items);
    }
  }

  /** 真正的一次模型回合（已被并发信号量保护）。 */
  async #runTurn(from, batch) {
    const { text, images: rawImages, files: rawFiles, contextToken } = batch;

    // 回合前再查一次每日配额与预算：排队期间别的回合可能刚把额度用完
    if (this.#blockedByQuota(from, contextToken)) return;
    if (this.#blockedByBudget(from, contextToken)) return;

    // 回合计数：合并后的多条消息只算一个回合
    if (this.limits?.recordTurn) {
      try {
        await this.limits.recordTurn(from);
      } catch (err) {
        this.log(`记录每日回合失败（忽略）: ${err.message}`);
      }
    }

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

  /** 提交一批队列条目的 journalId（合并成一次写盘）。 */
  async #commitItems(items) {
    const ids = (items ?? []).map((item) => item?.journalId).filter(Boolean);
    if (ids.length === 0) return;
    for (const id of ids) this.queuedJournalIds.delete(id);
    if (!this.journal?.commitMany) return;
    try {
      await this.journal.commitMany(ids);
    } catch (err) {
      // commit 失败只影响「是否重放一次」，不能反过来打断用户回复
      this.log(`入站日志 commit 失败（重启后可能重放）: ${err.message}`);
    }
  }

  /** 单条消息尚未入队就确定结果时，直接 commit。 */
  async #commitJournalId(id) {
    if (!id) return;
    await this.#commitItems([{ journalId: id }]);
  }

  /**
   * 每日回合上限：超限时计数并按「每天一次」提示。返回 true 表示已拒绝。
   * 入队前与回合前各调用一次（排队期间额度可能被别的回合用完）。
   */
  #blockedByQuota(peerId, contextToken) {
    const day = this.limits?.allowDay?.(peerId);
    if (!day || day.ok !== false) return false;
    this.counters.rejected += 1;
    this.#noticeOnce(
      peerId,
      `quota-${dayKey(this.now())}`,
      `📵 今天的回合数已达上限（${day.limit}）。明天再来，或回复 /usage 查看用量。`,
      contextToken,
      { windowMs: QUOTA_NOTICE_WINDOW_MS },
    );
    return true;
  }

  /** 预算硬拦截（block 模式）：超限时计数并提示。返回 true 表示已拒绝。 */
  #blockedByBudget(peerId, contextToken) {
    const budget = budgetBlocked(this.budgetGuard, peerId);
    if (!budget) return false;
    this.counters.budgetBlocked += 1;
    this.#noticeOnce(peerId, 'budget', this.#budgetNotice(budget), contextToken);
    return true;
  }

  /** 预算拦截文案：给出今日/本月用量与限额，并引导 /usage。 */
  #budgetNotice(check) {
    const label = check.window === 'month' ? '本月' : '今日';
    const who = check.scope === 'user' ? '你的' : '';
    const s = this.commands?.usage?.summary?.();
    const day = s?.day?.totalTokens;
    const month = s?.month?.totalTokens;
    const totals = Number.isFinite(day) || Number.isFinite(month)
      ? `；当前今日 ${day ?? 0} / 本月 ${month ?? 0} token`
      : '';
    return `💸 ${who}${label} token 用量已达 ${check.spent}（限额 ${check.limit}）${totals}，已暂停新回合。回复 /usage 查看明细。`;
  }

  /**
   * 节流提示：同一 peer + key 在窗口内只发一次。
   * 走 ReplySender（token 失效自然进 outbox），发送失败只记日志。
   *
   * @param {{windowMs?: number}} [opts] - 覆盖提示窗口（如「每日回合上限」要每天只提示一次）
   */
  #noticeOnce(peer, key, text, contextToken, opts = {}) {
    if (this.notice && typeof this.notice.canSend === 'function' && !this.notice.canSend(peer, key, opts)) {
      return;
    }
    const send = typeof this.reply?.sendText === 'function'
      ? this.reply.sendText(peer, text, contextToken)
      : this.reply?.send?.(peer, text, contextToken);
    Promise.resolve(send).catch((err) => this.log(`提示发送失败（忽略）: ${err.message}`));
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

  /** 命令回复：统一走 ReplySender（分类、重试、入队），失败只记日志。 */
  async #sendCommandReply(from, text, contextToken) {
    try {
      // reply.sendText 内部已处理 token 失效（入队）与可重试错误（退避/入队）
      if (typeof this.reply?.sendText === 'function') {
        await this.reply.sendText(from, text, contextToken);
        return;
      }
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
