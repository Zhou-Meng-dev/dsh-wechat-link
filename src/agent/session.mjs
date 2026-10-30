/**
 * Agent 会话：DSH 子进程 + 沙箱 + persona + 会话映射 + context_token。
 *
 * 一块行为，一个对象：
 *   - start()/stop()  拉起 / 关闭本租户的 dsh，加载 bridge-state.json
 *   - ask()/reset()   一次对话回合 / 丢弃上下文
 *   - getToken()/setToken()/flushTokens()  定时推送与入站共用的 token 视图
 *
 * 沙箱策略：
 *   - DSH_SANDBOX=1 → dsh 跑在 bwrap 里，租户独立 DSH_HOME
 *   - BRIDGE_DSH_MODE=container → 不套 bwrap，但仍用租户独立 dsh-home
 *   - 裸机 → 保留宿主 DSH_HOME 语义
 *   - persona.patch.yml 挂进沙箱（或容器/裸机直接用绝对路径）
 *   - SANDBOX_NODE / SANDBOX_DSH_JS / VOLTA_ROOT / SANDBOX_HOME 原样透传
 *
 * 事件：把底层 dsh 的 `exit` / `stderr` 转发给 Tenant；
 * Tenant 只订阅本对象，不直接订阅 client，保证单一来源。
 */

import { EventEmitter } from 'node:events';
import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';

import { isSeaRuntime } from '../assets.mjs';
import { MEDIA_CAPABILITY_PROMPT } from '../wechat/outbound-media.mjs';
import { ConversationManager } from './conversation.mjs';
import { DshClient } from './sdk-client.mjs';
import { SessionStore } from './session-store.mjs';

/** 要遮蔽的宿主家目录（沙箱里会被 tmpfs 覆盖，只剩租户可见部分） */
const HOME_DIR = homedir();

export class AgentSession extends EventEmitter {
  #client = null;
  #sessionStore = null;
  #conv = null;
  #stopAutoFlush = null;
  /** 每个用户最近一次的 context_token（发送必需，多段发送要靠它） */
  #contextTokens = new Map();

  /**
   * @param {object} opts
   * @param {object} opts.tenant - 租户视图（cwd / root / dshHome / provider / model / persona / apiKey）
   * @param {(msg: string) => void} [opts.log]
   * @param {{record: (info: object) => void}} [opts.usage] - 回合用量统计（可选）
   */
  constructor({ tenant, log = () => {}, usage = null }) {
    super();
    this.tenant = tenant;
    this.log = log;
    this.usage = usage;
  }

  /** 只读：供需要直接观察子进程的调用方使用（Tenant 走事件，不直接订阅） */
  get client() {
    return this.#client;
  }

  /** 拉起 dsh 并加载会话映射；可重复调用（重启时复用本对象）。 */
  async start() {
    const cwd = this.tenant.cwd;

    // 沙箱模式：dsh 跑在 bwrap 里，agent 看不到宿主其它文件。
    // 每个租户用自己独立的 DSH_HOME（只含凭据），互不可见。
    const sandboxEnabled = process.env.DSH_SANDBOX === '1';
    // 容器模式：容器本身就是隔离边界，不再套 bwrap，但仍用租户独立 dsh-home
    const containerMode = process.env.BRIDGE_DSH_MODE === 'container';
    // SEA 单文件的 process.execPath 是桥接自己，不能拿来执行 dsh 的 bin.js
    const seaRuntime = await isSeaRuntime();
    const perTenantHome = sandboxEnabled || containerMode;
    // 沙箱/容器模式用租户独立 dsh-home；裸机非沙箱模式保留宿主 DSH_HOME 语义
    const tenantDshHome = perTenantHome ? this.tenant.dshHome : process.env.DSH_HOME;

    // API key 策略（关键：让 bot 与宿主机用不同的 key）
    //   本租户配了 apiKey → 通过环境变量注入，**不复制**宿主机凭据文件
    //   本租户没配     → 回退：复制宿主机凭据
    const tenantApiKey = (this.tenant.apiKey ?? '').trim();
    const extraEnv = {};
    if (tenantApiKey) extraEnv.DEEPSEEK_API_KEY = tenantApiKey;

    if (perTenantHome) {
      const { ensureTenantLayout } = await import('./profile.mjs');
      await ensureTenantLayout({
        id: this.tenant.id,
        // 有独立 key 时不复制宿主凭据，避免宿主 key 进入租户目录
        credSource: tenantApiKey ? undefined : process.env.CRED_SOURCE,
      });
      // 有独立 key 时，删掉可能残留的宿主凭据副本
      if (tenantApiKey) {
        const { rm } = await import('node:fs/promises');
        await rm(`${tenantDshHome}/.credentials.yaml`, { force: true }).catch(() => {});
      }
    }
    if (tenantApiKey) {
      this.log('使用租户独立 API key（环境变量注入，不读宿主凭据）');
    } else if (perTenantHome) {
      this.log('未配置独立 API key（依赖 CRED_SOURCE 复制的凭据）');
    } else {
      this.log('使用宿主机默认凭据（未配置独立 API key）');
    }

    // persona：写成本租户的 patch 叠加文件，并用 --patch 传给 dsh
    const persona = (this.tenant.persona ?? '').trim();
    let extraDshArgs;
    let extraRoBinds;
    // 系统提示词由两部分组成：
    //   personaPrefix  ← 用户设置的角色/语气
    //   personaSuffix  ← 桥接注入的能力说明（定时任务等），用户不该手改
    const { TASK_CAPABILITY_PROMPT } = await import('../tasks/task-inbox.mjs');
    const capabilityPrompt = `${TASK_CAPABILITY_PROMPT}\n\n${MEDIA_CAPABILITY_PROMPT}`;
    {
      const { writePersonaPatch } = await import('./profile.mjs');
      // 用租户根目录，不直接依赖 WECHAT_SANDBOX_ROOT：
      // 非沙箱模式下那个环境变量可能不存在，会导致 join 抛错。
      const patchPath = `${this.tenant.root}/persona.patch.yml`;
      await mkdir(this.tenant.root, { recursive: true }).catch(() => {});
      await writePersonaPatch(patchPath, persona, capabilityPrompt);
      // 沙箱里用挂载后的路径；容器/裸机直接用宿主机绝对路径
      const sandboxPatch = '/opt/tenant/persona.patch.yml';
      const patchArg = sandboxEnabled ? sandboxPatch : patchPath;
      extraDshArgs = ['--patch', patchArg];
      extraRoBinds = sandboxEnabled ? [{ src: patchPath, dst: sandboxPatch }] : undefined;
      if (persona) this.log(`已加载自定义 persona（${persona.length} 字）+ 定时任务/媒体能力说明`);
      else this.log('已加载定时任务/媒体能力说明');
    }

    this.#client = new DshClient({
      cwd,
      dshHome: tenantDshHome,
      provider: this.tenant.provider,
      model: this.tenant.model,
      extraEnv,
      extraDshArgs,
      sandboxOpts: sandboxEnabled
        ? {
            cwd,
            dshHome: tenantDshHome,
            homeDir: process.env.SANDBOX_HOME ?? HOME_DIR,
            voltaRoot: process.env.VOLTA_ROOT,
            nodeBin: process.env.SANDBOX_NODE,
            dshJs: process.env.SANDBOX_DSH_JS,
            extraRoBinds,
          }
        : undefined,
      dshCmd: !sandboxEnabled && process.env.DSH_JS_PATH && !seaRuntime
        ? [process.execPath, process.env.DSH_JS_PATH]
        : undefined,
    });
    // 只转发，不在本模块决定重启策略：那是 Tenant 的状态机
    this.#client.on('stderr', (line) => this.emit('stderr', line));
    this.#client.on('exit', (info) => this.emit('exit', info));

    await this.#client.start();

    // 会话映射持久化：重启后 resume 恢复上下文
    this.#stopAutoFlush?.();
    const tenantRoot = this.tenant.root;
    this.#sessionStore = new SessionStore(`${tenantRoot}/bridge-state.json`);
    await this.#sessionStore.load();
    this.#stopAutoFlush = this.#sessionStore.startAutoFlush(5000);

    // 恢复已持久化的 context_token（定时推送要用）
    for (const peerId of this.#sessionStore.tokenPeers()) {
      const tk = this.#sessionStore.getToken(peerId);
      if (tk) this.#contextTokens.set(peerId, tk);
    }
    if (this.#contextTokens.size > 0) {
      this.log(`恢复了 ${this.#contextTokens.size} 个用户的 context_token（可用于主动推送）`);
    }

    this.#conv = new ConversationManager(this.#client, {
      log: (m) => this.log(`[conv] ${m}`),
      store: this.#sessionStore,
      // 回合结束后记一次用量；统计失败不能影响对话
      onTurn: (info) => this.usage?.record({ ...info, model: this.tenant.model }),
    });
  }

  /** 刷盘会话映射并关闭 dsh 子进程。 */
  async stop() {
    this.#stopAutoFlush?.();
    this.#stopAutoFlush = null;
    await this.#sessionStore?.flush(true).catch(() => {});
    await this.#client?.shutdown().catch(() => {});
    setTimeout(() => this.#client?.kill(), 800);
  }

  /** 把一条用户消息送入会话，返回助手回复。 */
  ask(peerId, text, images) {
    if (!this.#conv) throw new Error('agent 会话尚未启动');
    return this.#conv.ask(peerId, text, images);
  }

  /** 丢弃某个用户的上下文。 */
  reset(peerId) {
    this.#conv?.reset(peerId);
  }

  /** 会话诊断：peers / sessions / busy；未启动时返回 null。 */
  stats() {
    return this.#conv ? this.#conv.stats() : null;
  }

  /** 最新 context_token：内存优先，其次落盘值。 */
  getToken(peerId) {
    return this.#contextTokens.get(peerId) ?? this.#sessionStore?.getToken(peerId);
  }

  /** 记录最新 context_token（内存 + 落盘）。 */
  setToken(peerId, token) {
    if (!token) return;
    this.#contextTokens.set(peerId, token);
    this.#sessionStore?.setToken(peerId, token);
  }

  /** 刷盘会话映射（token 与 session 映射在同一文件）。 */
  async flushTokens(force = false) {
    return this.#sessionStore?.flush(force);
  }
}
