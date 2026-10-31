/**
 * 租户管理器：每个租户 = 一份独立的 (ILink 长轮询 + DSH 子进程 + 会话表)。
 *
 * 关键隔离点：
 *   - 每个租户有自己的 bot_token → 收的是自己的消息
 *   - 每个租户有自己的 dsh 子进程 → agent 状态、模型凭据互不影响
 *   - 每个租户有自己的 cwd → 文件操作互不可见
 *   - 每个租户有自己的 ConversationManager → session 映射不串
 *
 * 任何租户的崩溃、重启、退出都不影响其他租户。
 */

import { EventEmitter } from 'node:events';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import { IlinkClient } from './wechat/ilink.mjs';
import { tenantLabel } from './config.mjs';
import { DEFAULT_MAX_CHARS } from './wechat/split.mjs';
import { OutboxStore } from './wechat/outbox.mjs';
import { DlqStore } from './wechat/dlq.mjs';
import { NoticeThrottle } from './wechat/notice-throttle.mjs';
import { ReplySender } from './wechat/reply.mjs';
import { MediaIngest } from './wechat/ingest.mjs';
import { InboundPipeline } from './wechat/inbound.mjs';
import { InboundJournal } from './wechat/inbound-journal.mjs';
import { createInboundPoller } from './wechat/inbound-poller.mjs';
import { TenantLimits } from './wechat/limits.mjs';
import { Semaphore } from './wechat/semaphore.mjs';
import { LinkIngest } from './wechat/links.mjs';
import { AgentSession } from './agent/session.mjs';
import { TaskRuntime } from './tasks/runtime.mjs';
import { UsageStore } from './ops/usage.mjs';

const STARTUP_RETRY_MS = 3_000;
const MAX_STARTUP_RETRIES = 5;
/** 用量定时落盘：进程被硬杀时最多丢这个窗口的计数 */
const USAGE_FLUSH_INTERVAL_MS = 30_000;


export class Tenant extends EventEmitter {
  /** 节流窗口内已放弃、还没汇总进告警的 DLQ 条数 */
  #dlqPending = 0;

  /**
   * @param {object} tenant - resolveTenant() 合并后的运行时视图
   *   （config + secrets + persona 文件，已含派生值）
   * @param {object} opts
   * @param {(msg: string) => void} opts.log
   */
  constructor(tenant, opts) {
    super();
    this.tenant = tenant;
    this.log = opts.log;
    this.state = 'idle'; // idle | starting | running | stopped | failed
    this.startAttempts = 0;
    this.ilink = null;
    this.stopped = false;

    /** @type {UsageStore} 按天累计的 turn / token / 模型，预算告警也在这里 */
    this.usage = new UsageStore({
      path: join(this.tenant.root, 'usage.json'),
      budget: {
        day: this.tenant.budgetTokensPerDay,
        month: this.tenant.budgetTokensPerMonth,
        // 每用户配额；未设置 = 不限
        userDay: this.tenant.perUserBudgetTokensPerDay,
        userMonth: this.tenant.perUserBudgetTokensPerMonth,
      },
    });
    // 超过预算时给 owner 发一条提醒（每周期一次；发送失败只记日志）
    this.usage.on('alert', (info) => this.#onBudgetAlert(info));

    /**
     * 预算守卫：warn = 只提醒；block = 拒绝新回合。
     * 入站与定时任务共用同一份只读检查。
     */
    this.budgetGuard = {
      action: this.tenant.budgetAction ?? 'warn',
      canSpend: (peerId) => this.usage.canSpend({ peerId }),
    };

    /** @type {AgentSession} agent 会话：dsh/沙箱/persona/会话映射/token */
    this.session = new AgentSession({
      tenant: this.tenant,
      log: (m) => this.#log(m),
      usage: this.usage,
    });
    // 只从 session 转发 dsh 事件，Tenant 与 client 不形成第二个来源
    this.session.on('stderr', (line) => {
      if (/error|fail/i.test(line)) this.#log(`[dsh] ${line.slice(0, 180)}`);
    });
    this.session.on('exit', ({ code, signal }) => {
      if (this.stopped) return;
      this.#log(`❌ dsh 子进程退出 (code=${code}, signal=${signal})，尝试重启`);
      this.state = 'failed';
      // 先把用量落盘；start() 会重新跑一遍，不能让内存计数被磁盘旧值覆盖
      this.usage.flush().catch(() => {});
      this.#scheduleRestart();
    });

    /** 入站/发送/任务共用的 token 视图：由 AgentSession 统一维护内存 + 落盘 */
    this.tokens = {
      get: (peerId) => this.session.getToken(peerId),
      set: (peerId, token) => this.session.setToken(peerId, token),
      flush: (force) => this.session.flushTokens(force),
    };
    /** @type {OutboxStore|null} token 失效/可重试错误时的待发队列（租户根/outbox.json） */
    this.outbox = null;
    /** @type {DlqStore|null} 超过尝试次数或被判定永久失败的消息（租户根/dlq.json） */
    this.dlq = null;
    /** @type {InboundJournal|null} 入站游标 + 待处理消息 + 去重环（租户根/sync.json） */
    this.journal = null;
    /** @type {TenantLimits|null} 每用户速率 / 每日回合 / 消息截断（租户根/limits.json） */
    this.limits = null;
    /** @type {Semaphore|null} 全局并发回合上限（每租户） */
    this.semaphore = null;
    /** 出站重试定时器（30s，unref） */
    this.retryTimer = null;
    /** 用量定时落盘（30s，unref） */
    this.usageTimer = null;
    /** 提示节流：DLQ 告警、限流提示、预算提示共用 */
    this.noticeThrottle = new NoticeThrottle();
    /** @type {ReplySender|null} 出站发送（媒体/分段/待发队列），start() 或测试装配点创建 */
    this.reply = null;
    /** @type {InboundPipeline|null} 入站：访问控制/解析/合并/命令，start() 或测试装配点创建 */
    this.inbound = null;
    /** @type {TaskRuntime|null} 任务调度/收件箱/执行/历史，start() 或测试装配点创建 */
    this.taskRuntime = null;

    /** @type {MediaIngest} 入站图片/文件的下载、落盘与归一化 */
    this.media = new MediaIngest({
      cwd: this.tenant.cwd,
      log: (m) => this.#log(m),
    });

    /** @type {LinkIngest} 用户发链接时的抓取/落盘（含 SSRF 防护） */
    this.links = new LinkIngest({
      cwd: this.tenant.cwd,
      log: (m) => this.#log(m),
    });
  }

  get id() {
    return this.tenant.id;
  }
  get label() {
    return tenantLabel(this.tenant);
  }
  #log(m) {
    this.log(`[${this.label}] ${m}`);
  }

  /**
   * 装配出站发送器。start() 用它对接真实 iLink/outbox；
   * 测试可以先设置 this.ilink / this.outbox 再调用，无需拉起真实连接。
   */
  createReplySender() {
    return new ReplySender({
      cwd: this.tenant.cwd,
      maxChars: this.tenant.maxChars ?? DEFAULT_MAX_CHARS,
      ilink: this.ilink,
      outbox: this.outbox,
      dlq: this.dlq,
      onDlq: (info) => this.#onDlq(info),
      log: (m) => this.#log(m),
      getContextToken: (peerId) => this.session.getToken(peerId),
    });
  }

  /**
   * 装配任务运行时。start() 在会话与发送器就绪后调用；
   * 测试可以先设置 this.session / this.reply 再调用并 start()，无需拉起 dsh。
   */
  createTaskRuntime() {
    return new TaskRuntime({
      tenant: this.tenant,
      ask: (peerId, prompt) => this.session.ask(peerId, prompt),
      reply: this.reply,
      getContextToken: (peerId) => this.session.getToken(peerId),
      isActive: () => this.state === 'running',
      budgetGuard: this.budgetGuard,
      // 复用同一个提示节流器：任务预算提示按「每天一次」窗口调用 canSend
      notice: this.noticeThrottle,
      log: (m) => this.#log(m),
    });
  }

  /**
   * 装配入站流水线。start() 在会话/发送器就绪后调用；
   * 测试可以先设置 this.ilink / this.session / this.reply 再调用。
   */
  createInboundPipeline() {
    return new InboundPipeline({
      tenant: this.tenant,
      ilink: this.ilink,
      conv: this.session,
      reply: this.reply,
      media: this.media,
      tokens: this.tokens,
      links: this.links,
      // 只把 commitMany 交给流水线：它拿不到游标，也无法推进游标
      journal: this.journal
        ? { commitMany: (ids) => this.journal.commitMany(ids) }
        : null,
      limits: this.limits,
      semaphore: this.semaphore,
      notice: this.noticeThrottle,
      budgetGuard: this.budgetGuard,
      commands: {
        usage: this.usage,
        getStatus: () => this.status(),
        listTasks: () => this.taskRuntime?.tasks?.list() ?? [],
      },
      log: (m) => this.#log(m),
    });
  }

  /** 启动本租户的全部资源。失败会自我重试，不抛出给其他租户。 */
  async start() {
    if (this.stopped) return;
    if (this.state === 'running' || this.state === 'starting') return;
    this.state = 'starting';

    try {
      // 工作目录：每个租户独立子目录（由租户 id 派生）
      const cwd = this.tenant.cwd;
      await mkdir(cwd, { recursive: true }).catch(() => {});

      // 用量统计：先加载历史，保证重启后日/月汇总连续
      await this.usage.load();
      this.#startUsageTimer();
      const todayTurns = this.usage.dayBucket().turns;
      if (todayTurns > 0) this.#log(`今日已累计 ${todayTurns} 个回合的用量`);

      // 文件探测脚本：让 agent 先看结构、再按需读，避免整份 PDF/XLSX 进上下文
      {
        const { ensureDocProbe } = await import('./agent/file-digest.mjs');
        await ensureDocProbe(cwd).catch((e) => this.#log(`无法写入 _tools/doc_probe.py: ${e.message}`));
        // 任务同步等待脚本：agent 写完 pending 请求后，用它等桥接结果再回复
        const { ensureTaskCtl } = await import('./tasks/task-inbox.mjs');
        await ensureTaskCtl(cwd).catch((e) => this.#log(`无法写入 _tools/taskctl.py: ${e.message}`));
        // 窗口随机任务的进度/计分脚本：agent 用 quiz.py 读写 _quiz/state.json
        const { ensureQuizTool } = await import('./tasks/quiz.mjs');
        await ensureQuizTool(cwd).catch((e) => this.#log(`无法写入 _tools/quiz.py: ${e.message}`));
      }

      // 1. agent 会话：沙箱/凭据/persona + dsh + 会话映射
      await this.session.start();

      // 死信队列 + 待发队列：重启后仍保留，用户下次发消息自动补发
      const tenantRoot = this.tenant.root;
      this.dlq = new DlqStore(join(tenantRoot, 'dlq.json'));
      const dlqLoaded = await this.dlq.load();
      if (dlqLoaded.warning) this.#log(`⚠️ ${dlqLoaded.warning}`);
      this.outbox = new OutboxStore(join(tenantRoot, 'outbox.json'), { dlq: this.dlq });
      await this.outbox.load();
      const pendingOut = this.outbox.stats();
      if (pendingOut.items > 0) {
        this.#log(`恢复了 ${pendingOut.items} 条待发送消息（${pendingOut.peers} 个用户），等用户下次发消息后补发`);
      }
      if (pendingOut.dlq > 0) {
        this.#log(`待发队列中有 ${pendingOut.dlq} 条已放弃的消息（dlq.json），仅保留摘要`);
      }

      // 输入上限：每用户速率/每日回合（limits.json）+ 全局并发信号量。
      // 重启（dsh 退出重拉）时复用已有实例，避免清零当天计数。
      if (!this.limits) {
        this.limits = new TenantLimits({
          path: join(tenantRoot, 'limits.json'),
          queueMaxPerPeer: this.tenant.queueMaxPerPeer,
          ratePerMinute: this.tenant.perUserRatePerMinute,
          turnsPerDay: this.tenant.perUserTurnsPerDay,
          maxMessageChars: this.tenant.maxMessageChars,
        });
        await this.limits.load();
      }
      if (!this.semaphore) {
        this.semaphore = new Semaphore(this.tenant.maxConcurrentTurns);
      }

      // 2. iLink 客户端
      this.ilink = new IlinkClient({
        token: this.tenant.token,
        baseUrl: this.tenant.baseUrl,
        log: (m) => this.#log(`[ilink] ${m}`),
      });

      // 3. 出站发送：媒体指令、超长转文件、分段、待发队列
      this.reply = this.createReplySender();

      // 4. 任务运行时：watch/timer/inbox/执行/历史
      if (!this.taskRuntime) this.taskRuntime = this.createTaskRuntime();
      await this.taskRuntime.start();

      // 5. 入站日志：游标 + 待处理消息 + 去重环。
      //    必须在装配流水线之前创建（流水线只拿到 commitMany）。
      this.journal = new InboundJournal(join(tenantRoot, 'sync.json'));
      const recovered = await this.journal.load();
      if (recovered.warning) this.#log(`⚠️ ${recovered.warning}`);

      // 6. 入站流水线：访问控制/解析/队列/命令
      if (!this.inbound) {
        this.inbound = this.createInboundPipeline();
      } else {
        // 重启会换新 ilink/session/reply；队列必须保留，避免丢已到达的消息
        this.inbound.rebind({ ilink: this.ilink, conv: this.session, reply: this.reply });
      }

      // 回放必须排在「流水线装配完成」之后、「开始轮询」之前，
      // 否则会出现「先拉到新消息、后回放旧消息」的顺序错乱。
      if (recovered.recovered) {
        this.#log(`恢复 ${recovered.pending.length} 条未处理消息，重新入队`);
        for (const entry of recovered.pending) {
          this.inbound.push(entry.msg, { journalId: entry.id });
        }
      }
      // 让长轮询从持久化游标继续；没有游标时保持空串（从头开始）
      this.ilink.advanceCursor(this.journal.cursor);

      this.state = 'running';
      this.startAttempts = 0;
      this.restartExhausted = false;
      if (this.restartTimer) { clearTimeout(this.restartTimer); this.restartTimer = null; }
      this.#startRetryTimer();
      this.#log(`✅ 已启动 (cwd=${cwd})`);
      this.emit('running');

      this.#startPolling();
    } catch (err) {
      this.state = 'failed';
      this.#log(`❌ 启动失败: ${err.message}`);
      this.#scheduleRestart();
    }
  }

  #scheduleRestart() {
    if (this.stopped) return;

    // dsh 退出会同时触发 'exit' 回调和 start() 的 catch，两处都会调这里。
    // 不加锁会导致重复调度、重复日志，甚至并发起两个 dsh 进程。
    if (this.restartTimer) return;
    if (this.startAttempts >= MAX_STARTUP_RETRIES) {
      if (!this.restartExhausted) {
        this.restartExhausted = true;
        this.#log(`❌ 连续失败 ${MAX_STARTUP_RETRIES} 次，停止重试`);
      }
      return;
    }
    this.startAttempts++;
    const n = this.startAttempts;
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (this.stopped) return;
      this.#log(`重试启动 (${n}/${MAX_STARTUP_RETRIES})`);
      this.start();
    }, STARTUP_RETRY_MS);
    this.restartTimer.unref?.();
  }

  /** 起长轮询。轮询本身不变量多、与租户装配无关，拆在 inbound-poller.mjs。 */
  #startPolling() {
    this.poller = createInboundPoller({
      ilink: this.ilink,
      journal: this.journal,
      inbound: this.inbound,
      log: (m) => this.#log(m),
      isRunning: () => !this.stopped && this.state === 'running',
      onExpired: () => {
        this.state = 'stopped';
        this.emit('expired');
      },
      debugInboundIds: process.env.BRIDGE_DEBUG_INBOUND_IDS === '1',
    });
    this.poller.run();
  }

  // ---------------------------------------------------------------- 出站重试

  #startUsageTimer() {
    if (this.usageTimer) return;
    this.usageTimer = setInterval(() => {
      this.usage.flush().catch((err) => this.#log(`用量落盘失败: ${err.message}`));
    }, USAGE_FLUSH_INTERVAL_MS);
    this.usageTimer.unref?.();
  }

  #startRetryTimer() {
    if (this.retryTimer) return;
    this.retryTimer = setInterval(() => {
      this.#retryTick().catch((err) => this.#log(`出站重试失败: ${err.message}`));
    }, 30_000);
    // 不阻止进程退出：服务由长轮询/健康端口保活
    this.retryTimer.unref?.();
  }

  /** 每 30s 对「队首已到重试时间且该 peer 有 token」的队列补发一次。 */
  async #retryTick() {
    if (this.state !== 'running' || !this.outbox || !this.reply) return;
    const now = Date.now();
    for (const peerId of [...this.outbox.peers.keys()]) {
      if (this.state !== 'running') return;
      if (!this.outbox.dueHead(peerId, now)) continue;
      // 没有 context_token 时不消耗尝试次数：等用户下次入站拿到新 token
      if (!this.session?.getToken?.(peerId)) continue;
      await this.reply
        .flush(peerId)
        .catch((err) => this.#log(`补发 ${peerId.slice(0, 12)}… 失败: ${err.message}`));
    }
  }

  /**
   * 一条消息被放弃：刷 DLQ，并按节流给 owner 发一条「N 条」汇总。
   * 节流窗口内的失败会累积到下一次告警里，不逐条打扰用户。
   */
  async #onDlq({ peerId, reason, attempts }) {
    this.#log(`⚠️ [${peerId.slice(0, 12)}…] 消息进入 DLQ: ${String(reason ?? '').slice(0, 100)}`);
    await this.dlq?.flush().catch(() => {});
    this.#dlqPending += 1;

    const owner = this.tenant.ownerId;
    if (!owner) return;
    if (!this.noticeThrottle.canSend(owner, 'dlq')) return;

    const count = this.#dlqPending;
    this.#dlqPending = 0;
    const token = this.session?.getToken?.(owner);
    const retried = attempts ? `（最后一次尝试 ${attempts} 次）` : '';
    const text = `⚠️ ${count} 条消息发送失败，已放弃${retried}，详见日志。回复 /status 查看待发队列。`;
    try {
      // 直接走 ilink：告警自身失败只记日志，绝不再入队（防止循环）
      await this.ilink?.sendText?.({ toUserId: owner, text, contextToken: token });
    } catch (err) {
      this.#log(`DLQ 告警发送失败（忽略，不再入队）: ${err.message}`);
    }
  }

  // ---------------------------------------------------------------- 定时任务

  /** 立即执行指定任务（手动触发/测试用）。任务不存在时返回 false。 */
  async runTaskNow(taskId) {
    if (!this.taskRuntime) return false;
    return this.taskRuntime.runNow(taskId);
  }

  /**
   * 停止本租户。
   *
   * 顺序：
   *   1. 停止轮询 + 中断在途长轮询（游标未推进，消息会被重投）
   *   2. 排空入站队列：不再接新消息、立刻结算合并窗口、等在途回合
   *   3. 等会话里的回合结束（正常情况下第 2 步已空闲）
   *   4. 停任务调度器
   *   5. 刷盘 journal → outbox → dlq → usage → tokens
   *   6. notifyStop → 关闭 dsh
   *
   * @param {object} [opts]
   * @param {boolean} [opts.drain=true] - 热重载可传 false：不排空，消息留在 sync.json.pending
   * @param {number} [opts.timeoutMs=20000]
   */
  async stop({ drain = true, timeoutMs = 20_000 } = {}) {
    if (this.stopped) return;
    this.stopped = true;
    this.state = 'stopping';
    if (this.retryTimer) { clearInterval(this.retryTimer); this.retryTimer = null; }
    if (this.usageTimer) { clearInterval(this.usageTimer); this.usageTimer = null; }

    const deadline = Date.now() + Math.max(0, Number(timeoutMs) || 0);
    const remaining = () => Math.max(0, deadline - Date.now());
    this.#log(drain ? `正在优雅停止（最多 ${Math.max(0, Number(timeoutMs) || 0)}ms）…` : '正在停止（不排空）…');

    // 1. 停止轮询：中断在途长轮询，避免等满 35s
    try { this.ilink?.abort?.(); } catch { /* 已关闭 */ }

    // 2. 排空入站队列
    if (drain && typeof this.inbound?.drain === 'function') {
      const r = await this.inbound
        .drain({ timeoutMs: remaining() })
        .catch((err) => {
          this.#log(`排空入站队列失败: ${err.message}`);
          return { idle: false, abandoned: [] };
        });
      const abandoned = Array.isArray(r?.abandoned) ? r.abandoned : [];
      if (abandoned.length > 0) {
        const preview = abandoned.slice(0, 5).map((id) => String(id).slice(0, 12)).join(', ');
        this.#log(`⚠️ 关闭超时：${abandoned.length} 条消息未完成（${preview}），已保留在 sync.json.pending，重启后重放`);
      }
      // 3. 等会话回合（排空已覆盖；这里兜底「回合在队列摘除后仍在跑」的窗口）
      const idle = await this.session
        ?.waitIdle?.({ timeoutMs: remaining() })
        .catch(() => null);
      if (idle && idle.idle === false) {
        this.#log(`⚠️ 关闭超时：仍有 ${idle.busy ?? '?'} 个回合并未结束，回复可能进入 outbox`);
      }
      // 队列状态清掉，但未 commit 的消息仍在 sync.json.pending
      this.inbound.stop();
    } else {
      // 热重载：在途消息仍在 sync.json.pending，新 Tenant 启动后会重放
      this.inbound?.stop();
    }

    // 4. 停任务调度器（不再触发新任务；在途任务等到同一截止时间）
    await this.taskRuntime?.stop({ timeoutMs: remaining() }).catch(() => {});

    // 5. 刷盘：顺序与数据依赖一致
    await this.journal?.flush().catch(() => {});
    await this.outbox?.flush().catch(() => {});
    await this.dlq?.flush().catch(() => {});
    await this.limits?.flush().catch(() => {});
    await this.usage.flush().catch(() => {});
    await this.session.flushTokens(true).catch(() => {});

    // 6. 通知服务端、关闭 dsh
    await this.ilink?.notifyStop().catch(() => {});
    await this.session.stop().catch(() => {});

    this.state = 'stopped';
    this.#log('已停止');
    this.emit('stopped');
  }

  /**
   * 尚未 commit 的入站消息 id（强制退出前记录放弃项）。
   * @returns {string[]}
   */
  abandonedIds() {
    return this.inbound?.abandonedIds?.() ?? [];
  }

  status() {
    const tasks = this.taskRuntime?.tasks ? this.taskRuntime.tasks.list() : null;
    return {
      id: this.id,
      label: this.label,
      ownerId: this.tenant.ownerId ?? null,
      cwd: this.tenant.cwd,
      state: this.state,
      sessions: this.session ? this.session.stats() : null,
      queue: this.inbound ? this.inbound.stats() : { peers: 0, pending: 0, running: 0 },
      journal: this.journal ? this.journal.stats() : null,
      outbox: this.outbox ? this.outbox.stats() : null,
      dlq: this.dlq ? this.dlq.stats() : null,
      limits: this.limits ? this.limits.stats() : null,
      tasks: tasks
        ? { total: tasks.length, enabled: tasks.filter((t) => t.enabled).length }
        : { total: 0, enabled: 0 },
      usage: this.usage.summary(),
    };
  }

  /** 预算告警：发一条给 owner；token 失效时走待发队列。 */
  #onBudgetAlert({ scope, key, spent, limit }) {
    const label = scope === 'day' ? '今日' : '本月';
    this.#log(`💸 ${label} token 用量 ${spent} 已超过预算 ${limit}（${key}）`);

    const owner = this.tenant.ownerId;
    if (!owner || !this.reply) return;
    const text = `💸 用量提醒：${label}（${key}）token 用量已达 ${spent}，超过预算 ${limit}。回复 /usage 查看明细。`;
    const token = this.session?.getToken?.(owner);
    this.reply.send(owner, text, token).catch((e) => this.#log(`预算提醒发送失败: ${e.message}`));
  }
}
