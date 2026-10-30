/**
 * 配置热重载的比对键。
 *
 * 服务每 3 秒重读一次配置，只有键发生变化才重启对应租户。
 * 这里刻意把「整份运行时视图」都纳入比对，而不是手写字段清单：
 * 以后新增配置字段时不需要再改这里，也就不会出现
 * 「改了 allowUsers / 预算，服务却没重启」这类静默漂移。
 *
 * 安全约定：
 *   - token / apiKey 只以 sha256 前缀参与比较，键里绝不出现明文；
 *   - 键只用于内存比较，不写日志、不落盘。
 *
 * 顺序约定：allowUsers 顺序无语义，排序后再比较，避免无意义重启。
 */

import { apiKeyFingerprint } from '../config.mjs';

/** 需要脱敏的字段 */
const SECRET_FIELDS = new Set(['token', 'apiKey']);

/** 顺序无语义的数组字段 */
const UNORDERED_ARRAYS = new Set(['allowUsers']);

/**
 * 把租户视图归一化成可比较的纯对象。
 * @param {object} tenant - resolveTenant() 的合并视图
 * @returns {object}
 */
export function tenantConfigView(tenant) {
  const src = tenant && typeof tenant === 'object' ? tenant : {};
  const view = {};

  for (const key of Object.keys(src).sort()) {
    const value = src[key];
    if (value === undefined) continue;

    if (SECRET_FIELDS.has(key)) {
      view[key] = apiKeyFingerprint(value);
    } else if (UNORDERED_ARRAYS.has(key) && Array.isArray(value)) {
      view[key] = [...value].sort();
    } else {
      view[key] = value;
    }
  }

  return view;
}

/** 单个租户的比对键 */
export function tenantConfigKey(tenant) {
  return JSON.stringify(tenantConfigView(tenant));
}

/**
 * 一组租户的比对键。按 id 排序，配置里租户顺序变化不算变更。
 * @param {object[]} [tenants]
 */
export function tenantListKey(tenants) {
  const list = Array.isArray(tenants) ? tenants : [];
  return JSON.stringify(
    list
      .map(tenantConfigView)
      .sort((a, b) => String(a.id ?? '').localeCompare(String(b.id ?? ''))),
  );
}
