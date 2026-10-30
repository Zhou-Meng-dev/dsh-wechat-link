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
import { ReplySender } from './wechat/reply.mjs';
import { MediaIngest } from './wechat/ingest.mjs';
import { InboundPipeline } from './wechat/inbound.mjs';
import { LinkIngest } from './wechat/links.mjs';
import { AgentSession } from './agent/session.mjs';
import { TaskRuntime } from './tasks/runtime.mjs';
import { UsageStore } from './ops/usage.mjs';

const STARTUP_RETRY_MS = 3_000;
const MAX_STARTUP_RETRIES = 5;

export class Tenant extends EventEmitter {
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
      },
    });
    // 超过预算时给 owner 发一条提醒（每周期一次；发送失败只记日志）
    this.usage.on('alert', (info) => this.#onBudgetAlert(info));

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
      this.#scheduleRestart();
    });

    /** 入站/发送/任务共用的 token 视图：由 AgentSession 统一维护内存 + 落盘 */
    this.tokens = {
      get: (peerId) => this.session.getToken(peerId),
      set: (peerId, token) => this.session.setToken(peerId, token),
      flush: (force) => this.session.flushTokens(force),
    };
    /** @type {OutboxStore|null} token 失效时的待发队列（租户根/outbox.json） */
    this.outbox = null;
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

      // token 失效时的待发队列：重启后仍保留，用户下次发消息自动补发
      const tenantRoot = this.tenant.root;
      this.outbox = new OutboxStore(`${tenantRoot}/outbox.json`);
      await this.outbox.load();
      const pendingOut = this.outbox.stats();
      if (pendingOut.items > 0) {
        this.#log(`恢复了 ${pendingOut.items} 条待发送消息（${pendingOut.peers} 个用户），等用户下次发消息后补发`);
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

      // 5. 入站流水线：访问控制/解析/队列/命令
      if (!this.inbound) {
        this.inbound = this.createInboundPipeline();
      } else {
        // 重启会换新 ilink/session/reply；队列必须保留，避免丢已到达的消息
        this.inbound.rebind({ ilink: this.ilink, conv: this.session, reply: this.reply });
      }

      this.state = 'running';
      this.startAttempts = 0;
      this.restartExhausted = false;
      if (this.restartTimer) { clearTimeout(this.restartTimer); this.restartTimer = null; }
      this.#log(`✅ 已启动 (cwd=${cwd})`);
      this.emit('running');

      this.#pollLoop();
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

  async #pollLoop() {
    let backoff = 1000;
    while (!this.stopped && this.state === 'running') {
      let resp;
      try {
        resp = await this.ilink.getUpdates();
      } catch (err) {
        // 长轮询超时属正常
        backoff = Math.min(backoff * 2, 15_000);
        await new Promise((r) => setTimeout(r, Math.min(backoff, 15_000)));
        continue;
      }
      backoff = 1000;

      // 会话失效
      if (resp.errcode === -14) {
        this.#log('❌ 登录已失效（errcode -14），本租户停止。请重新扫码添加。');
        this.state = 'stopped';
        this.emit('expired');
        return;
      }

      for (const msg of resp.msgs ?? []) {
        this.inbound.push(msg);
      }
    }
  }

  // ---------------------------------------------------------------- 定时任务

  /** 立即执行指定任务（手动触发/测试用）。任务不存在时返回 false。 */
  async runTaskNow(taskId) {
    if (!this.taskRuntime) return false;
    return this.taskRuntime.runNow(taskId);
  }

  async stop() {
    if (this.stopped) return;
    this.stopped = true;
    this.state = 'stopped';
    this.#log('正在停止…');
    // 停止队列（清掉待合并定时器）与任务调度器，并刷盘任务/历史
    this.inbound?.stop();
    await this.taskRuntime?.stop().catch(() => {});
    await this.outbox?.flush().catch(() => {});
    await this.usage.flush().catch(() => {});
    // 先把会话映射刷盘，避免重启丢上下文；再通知服务端、关闭 dsh
    await this.session.flushTokens(true).catch(() => {});
    await this.ilink?.notifyStop().catch(() => {});
    await this.session.stop().catch(() => {});
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
      outbox: this.outbox ? this.outbox.stats() : null,
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
