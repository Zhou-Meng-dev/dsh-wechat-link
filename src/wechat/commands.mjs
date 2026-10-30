/**
 * 内置命令：/help /status /tasks /usage /new，不经过模型，省 token 也更快。
 *
 * 设计约束：
 *   - 解析与渲染都是纯函数，InboundPipeline 只负责取数据与发送
 *   - 命令单独成批、不可合并，保持命令前/后的消息顺序
 *   - 未知的 `/xxx` 仍然当成普通消息交给模型，不拦截
 *   - `/new` 的会话重置仍由 InboundPipeline 处理（要碰会话与落盘）
 */

import { describeSchedule, formatNextRun } from '../tasks/tasks.mjs';
import { dayKey, formatTokens, formatUsageSummary, monthKey } from '../ops/usage.mjs';

/** 命令别名 → 规范名。中文别名让用户不用切输入法。 */
const ALIASES = new Map([
  ['/new', 'new'],
  ['/reset', 'new'],
  ['/重置', 'new'],
  ['/清空', 'new'],
  ['/help', 'help'],
  ['/?', 'help'],
  ['/帮助', 'help'],
  ['/status', 'status'],
  ['/状态', 'status'],
  ['/tasks', 'tasks'],
  ['/task', 'tasks'],
  ['/任务', 'tasks'],
  ['/usage', 'usage'],
  ['/用量', 'usage'],
  ['/统计', 'usage'],
]);

/** 所有能识别的命令规范名（供测试/文档核对）。 */
export const BUILTIN_COMMAND_NAMES = [...new Set(ALIASES.values())];

/**
 * 从一条用户消息里解析内置命令。
 * 只认消息开头的第一个 token；`/help me` 也算 /help。
 *
 * @param {string} text
 * @returns {{name: string, token: string}|null}
 */
export function parseBuiltinCommand(text) {
  const raw = String(text ?? '').trim();
  if (!raw.startsWith('/')) return null;
  const token = raw.split(/\s+/)[0].toLowerCase();
  const name = ALIASES.get(token);
  return name ? { name, token } : null;
}

/** 是否是桥接内置命令（按它决定不可合并、绕过模型）。 */
export function isBuiltinCommand(text) {
  return Boolean(parseBuiltinCommand(text));
}

export function formatHelp() {
  return [
    '🧰 内置命令（直接由桥接处理，不消耗模型额度）',
    '/new     开新会话，丢弃当前上下文（也可用 /重置、/清空）',
    '/status  运行状态、队列、会话与今日用量',
    '/tasks   定时任务列表（含下次触发时间）',
    '/usage   今日/本月 token 用量与预算',
    '/help    本帮助',
    '',
    '其它内容会正常交给 agent 处理。',
  ].join('\n');
}

const STATE_LABELS = {
  idle: '未启动',
  starting: '启动中',
  running: '运行中',
  stopped: '已停止',
  failed: '异常',
};

/**
 * 渲染 /status。入参就是 Tenant.status() 的返回，缺字段时优雅降级。
 * @param {object} status
 */
export function formatStatus(status = {}) {
  const lines = ['📊 运行状态'];

  const id = status.id ?? '(未知)';
  const label = status.label && status.label !== id ? `${status.label}（${id}）` : id;
  lines.push(`租户: ${label}`);
  lines.push(`状态: ${STATE_LABELS[status.state] ?? status.state ?? '未知'}`);
  if (status.ownerId) lines.push(`所有者: ${status.ownerId}`);
  if (status.cwd) lines.push(`工作区: ${status.cwd}`);

  if (status.sessions) {
    lines.push(`会话: ${status.sessions.peers ?? 0} 个用户 / ${status.sessions.busy ?? 0} 个忙碌`);
  }
  if (status.queue) {
    lines.push(`队列: ${status.queue.peers ?? 0} 个用户 / ${status.queue.pending ?? 0} 条待处理`);
  }
  if (status.outbox) {
    lines.push(`待发: ${status.outbox.items ?? 0} 条（token 失效时暂存）`);
  }
  if (status.tasks) {
    lines.push(`定时任务: ${status.tasks.total ?? 0} 个（启用 ${status.tasks.enabled ?? 0} 个）`);
  }
  if (status.usage?.day) {
    const d = status.usage.day;
    const m = status.usage.month;
    const today = `${d.turns ?? 0} 回合 / ${formatTokens(d.totalTokens)} tokens`;
    const month = m ? `；本月 ${m.turns ?? 0} 回合 / ${formatTokens(m.totalTokens)} tokens` : '';
    lines.push(`用量: 今日 ${today}${month}`);
  }
  return lines.join('\n');
}

/** 任务标题里不要出现换行/超长，避免刷屏。 */
function cleanTitle(text, maxLen = 40) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim() || '(无标题)';
  return flat.length <= maxLen ? flat : `${flat.slice(0, maxLen - 1)}…`;
}

/**
 * 渲染 /tasks。
 * @param {object[]} tasks - TaskStore.list() 的返回
 * @param {object} [opts]
 * @param {number} [opts.maxItems]
 */
export function formatTasks(tasks, opts = {}) {
  const list = Array.isArray(tasks) ? tasks : [];
  if (list.length === 0) {
    return [
      '🗓 还没有定时任务。',
      '可以用 CLI 添加，例如：',
      '  task <租户 id> add --daily "09:00" --prompt "今天的计划"',
    ].join('\n');
  }

  const maxItems = opts.maxItems ?? 10;
  const enabled = list.filter((t) => t.enabled).length;
  const lines = [`🗓 定时任务（共 ${list.length} 个，启用 ${enabled} 个）`];

  for (const task of list.slice(0, maxItems)) {
    const mark = task.enabled ? '✅' : '⏸';
    const schedule = describeSchedule(task.schedule);
    const next = task.enabled && task.nextRunAt ? `；下次 ${formatNextRun(task.nextRunAt)}` : '';
    lines.push(`${mark} 「${cleanTitle(task.title)}」 ${schedule}${next}`);
  }
  if (list.length > maxItems) {
    lines.push(`…… 还有 ${list.length - maxItems} 个任务，用 CLI 的 task list 查看全部。`);
  }
  return lines.join('\n');
}

/** 渲染 /usage（没有数据时也必须能看懂）。 */
export function formatUsage(usage) {
  return formatUsageSummary(usage, { title: '用量统计' });
}

/**
 * 渲染一个命令的回复文本。未知命令返回空串（调用方忽略）。
 *
 * @param {string} name - parseBuiltinCommand().name
 * @param {object} [ctx]
 * @param {object} [ctx.status] - Tenant.status()
 * @param {object[]} [ctx.tasks]
 * @param {object} [ctx.usage]  - UsageStore.summary()
 */
export function renderCommand(name, ctx = {}) {
  switch (name) {
    case 'help':
      return formatHelp();
    case 'status':
      return formatStatus(ctx.status);
    case 'tasks':
      return formatTasks(ctx.tasks);
    case 'usage':
      return formatUsage(ctx.usage ?? {
        day: { key: dayKey(), turns: 0, failedTurns: 0, totalTokens: 0 },
        month: { key: monthKey(), turns: 0, failedTurns: 0, totalTokens: 0 },
        budget: {},
      });
    default:
      return '';
  }
}
