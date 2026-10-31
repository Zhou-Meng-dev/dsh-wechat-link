/**
 * 预算硬拦截的唯一判定点。
 *
 * `warn` 模式永远放行（超限由 UsageStore 发一次提醒）；`block` 模式在
 * `canSpend` 返回拒绝时把检查结果交给调用方，由入站流水线与定时任务各自
 * 拼提示文案。两处不再各自判断 `action === 'block'`，避免语义漂移。
 */

/**
 * @param {{action?: string, canSpend?: (peerId: string) => object}|null|undefined} guard
 * @param {string} peerId
 * @returns {object|null} 被拦截时返回 canSpend 的检查结果；放行返回 null
 */
export function budgetBlocked(guard, peerId) {
  if (!guard || guard.action !== 'block') return null;
  const result = guard.canSpend?.(peerId);
  return result && result.ok === false ? result : null;
}
