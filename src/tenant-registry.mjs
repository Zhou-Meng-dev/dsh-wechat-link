/**
 * 多租户运行时：持有所有 Tenant，负责热添加/移除。
 *
 * 注意：这里**不负责写配置**。配置的增删改只发生在 CLI（login / rm），
 * 服务侧每 3 秒重读配置并同步内存 —— 避免把含秘密的合并视图写回配置文件。
 */

import { EventEmitter } from 'node:events';

import { tenantIdFrom } from './config.mjs';
import { Tenant } from './tenant.mjs';

export class TenantRegistry extends EventEmitter {
  /**
   * @param {object} opts
   * @param {(msg: string) => void} opts.log
   */
  constructor(opts) {
    super();
    this.log = opts.log;
    /** @type {Map<string, Tenant>} */
    this.tenants = new Map();
  }

  /** 从合并视图批量启动（并行，互不阻塞） */
  async loadAll(tenants) {
    const results = await Promise.allSettled(tenants.map((t) => this.add(t)));
    const failed = results.filter((r) => r.status === 'rejected');
    if (failed.length) {
      this.log(`⚠️ ${failed.length} 个租户启动失败`);
    }
    return this.list();
  }

  /**
   * 添加并启动一个租户。幂等：同 id 已存在则返回已有的。
   * @param {object} tenant - resolveTenant() 的合并视图
   */
  async add(tenant) {
    const id = tenant.id ?? tenantIdFrom(tenant.botId ?? tenant.token);
    const existing = this.tenants.get(id);
    if (existing) return existing;

    const t = new Tenant({ ...tenant, id }, { log: this.log });
    this.tenants.set(id, t);

    t.on('expired', () => this.emit('tenant-expired', t));

    await t.start();

    this.emit('tenant-added', t);
    return t;
  }

  /** 停止并从内存移除（不负责改配置） */
  async remove(id) {
    const t = this.tenants.get(id);
    if (!t) return false;
    await t.stop();
    this.tenants.delete(id);
    this.emit('tenant-removed', t);
    return true;
  }

  get(id) {
    return this.tenants.get(id);
  }

  list() {
    return [...this.tenants.values()].map((t) => t.status());
  }

  async stopAll() {
    await Promise.all([...this.tenants.values()].map((t) => t.stop()));
  }
}
