/**
 * 让 agent 能自己创建定时任务。
 *
 * 为什么不用共享文件：tasks.json 在沙箱外（agent 改不到），这是有意的——
 * 调度配置不该被模型随意改坏。所以走「提议 / 提交」两段式：
 *
 *   agent 把请求写成 JSON 放进 <工作区>/_tasks/pending/
 *     ↓ 桥接监听目录（通常 1 秒内），校验 schema
 *   合法 → 写入权威的 <租户根>/tasks.json，请求文件删除
 *   非法 → 移到 <工作区>/_tasks/rejected/ 并留原因
 *
 * 另外桥接会把当前任务清单快照到 <工作区>/_tasks/current.json，
 * 让 agent 能"看见"自己创建了哪些任务。
 */

import { mkdir, readFile, readdir, writeFile, rename, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { computeNextRun, describeSchedule, formatNextRun } from './tasks.mjs';
import { assetFilePath } from '../assets.mjs';

/** 注入到 system prompt 末尾的能力说明（personaSuffix） */
export const TASK_CAPABILITY_PROMPT = `## 定时任务

你可以为用户创建定时任务。用户在微信里用自然语言提需求（例如「明天 12:30 提醒我开会」「每天早 9 点问我一道题」），你就把它写成 JSON 文件放进 \`_tasks/pending/\` 目录（一个任务一个文件，文件名用任务 id 或时间戳，避免重复，以 .json 结尾）。

任务文件格式：

{
  "action": "add",
  "title": "简短标题",
  "schedule": { "kind": "once", "at": "2026-10-29 12:30" },
  "prompt": "到点时要执行的指令"
}

schedule 支持四种：
- {"kind":"once","at":"2026-10-29 12:30"}              一次性，本地时间
- {"kind":"daily","time":"09:00"}                       每天固定时刻
- {"kind":"weekly","days":[1,3,5],"time":"09:00"}       每周指定星期（1=周一 … 7=周日）
- {"kind":"every","minutes":60}                         每隔 N 分钟

用户说「每周五」「每周一三五」「工作日」「周末」时用 weekly。
days 可以写数组 [5]，也可以写字符串 "周一,周五" 或 "工作日"。
注意用当前时间推算：先看今天星期几，再决定 nextRunAt 是哪天。

prompt 字段写的是**给未来自己的指令**，不是最终发给用户的文字。到点时这条指令会注入你的上下文，由你（带着当时的上下文）生成实际回复。所以要写清要做什么，例如「从 _quiz/题库.md 抽一道没考过的题发给用户，这次不要给答案」。

暂停任务：写 {"action":"disable","id":"task-xxxxxxxx"} 到 pending 目录。
恢复任务：写 {"action":"enable","id":"task-xxxxxxxx"} 到 pending 目录。
删除任务：写 {"action":"rm","id":"task-xxxxxxxx"} 到 pending 目录。
修改时间：写 {"action":"update","id":"task-xxxxxxxx","schedule":{"kind":"daily","time":"08:00"}}。
稍后提醒：写 {"action":"snooze","id":"task-xxxxxxxx","minutes":10}。

所有操作（disable / enable / rm / update / snooze）也可以用标题代替 id：
{"action":"rm","title":"每日一题"}。标题匹配到多个任务时桥接会拒绝并列出候选，
这时先用 _tasks/current.json 里的 id 再发一次。
用户说「10 分钟后再提醒」时用 snooze；如果只有一条任务，可以省略 id/title。

查看已有任务：读 _tasks/current.json（含 id / title / schedule / nextRunAt / lastResult，任务变化时桥接会刷新）。

**必须等桥接处理完再回复**：写完请求文件后，立刻运行

python3 _tools/taskctl.py wait <文件名> [更多文件名...]

它会阻塞到桥接处理完（通常 1 秒内），并把最终结果打印出来（例如「✅ 已取消定时任务「每日一题」」）。
然后你把打印出的结果用一句简短的话转述给用户：只回一行，不要寒暄、不要追加建议或提醒。
不要自己猜结果，也不要解释「提交请求 / 桥接确认」这些内部流程。

如果脚本输出以「⚠️」开头，就如实转述失败原因，不要改口说成功。
如果脚本提示「等待任务结果超时」，告诉用户「任务请求处理超时，请稍后再试」，
不要声称已完成。

用户说「取消所有/全部」时：先读 _tasks/current.json，为每个任务各写一条 rm 请求，
然后运行一次 python3 _tools/taskctl.py wait <所有文件名>，最后只回一句
「已取消全部 N 个定时任务」；如果输出里有失败项，按失败原因如实说明。`;

/**
 * 把 taskctl.py 写到工作区 `_tools/`。agent 用 bash 调它来同步等待任务结果。
 * 内容和仓库模板不一致时覆盖（agent 改坏会在下次启动恢复）。
 * @param {string} workspace
 * @returns {Promise<string>} 写入路径
 */
export async function ensureTaskCtl(workspace) {
  const dir = join(workspace, '_tools');
  await mkdir(dir, { recursive: true });
  const dest = join(dir, 'taskctl.py');
  const template = await readFile(await assetFilePath('src/tasks/taskctl.py'), 'utf8');
  const current = await readFile(dest, 'utf8').catch(() => null);
  if (current !== template) {
    await writeFile(dest, template, { mode: 0o644 });
  }
  return dest;
}

/**
 * 处理 pending 目录里的任务请求。
 *
 * @param {object} opts
 * @param {string} opts.workspace   - 租户工作区
 * @param {import('./tasks.mjs').TaskStore} opts.store
 * @param {(m: string) => void} opts.log
 * @param {(result: object) => void} [opts.onResult] - 每条请求的处理结果
 *        （成功: {ok:true, action, task, file}；失败: {ok:false, reason, file}）
 * @returns {Promise<number>} 处理的请求数
 */
export async function processPendingTaskRequests({ workspace, store, log, onResult }) {
  const pendingDir = join(workspace, '_tasks', 'pending');
  if (!existsSync(pendingDir)) return 0;

  const entries = await readdir(pendingDir).catch(() => []);
  const files = entries.filter((f) => f.endsWith('.json'));
  if (files.length === 0) return 0;

  let handled = 0;
  /** @type {object[]} */
  const results = [];

  for (const name of files) {
    const src = join(pendingDir, name);
    let raw;
    try {
      raw = JSON.parse(await readFile(src, 'utf8'));
    } catch (err) {
      const reason = `JSON 解析失败: ${err.message}`;
      await reject(workspace, src, name, reason);
      log(`[task] 拒绝 ${name}: ${reason}`);
      results.push({ ok: false, file: name, reason });
      handled++;
      continue;
    }

    try {
      const info = applyRequest(store, raw, log);
      await rm(src, { force: true });
      results.push({ ok: true, file: name, ...info });
      handled++;
    } catch (err) {
      const action = typeof raw?.action === 'string' ? raw.action : undefined;
      await reject(workspace, src, name, err.message);
      log(`[task] 拒绝 ${name}: ${err.message}`);
      results.push({ ok: false, file: name, action, reason: err.message });
      handled++;
    }
  }

  let flushError = null;
  if (handled > 0) {
    try {
      await store.flush();
    } catch (err) {
      flushError = err;
    }
  }

  // 落盘成功后才写结果；agent 的 taskctl.py 会轮询这些文件
  for (const r of results) {
    const final = flushError && r.ok
      ? { ...r, ok: false, reason: `保存失败: ${flushError.message}` }
      : r;
    await writeTaskResult(workspace, final).catch((e) => log(`[task] 写结果失败 ${r.file}: ${e.message}`));
    onResult?.(final);
  }
  return handled;
}

/**
 * 把单条处理结果原子写入 `_tasks/results/<请求文件名>`，供 agent 同步读取。
 * 用 tmp + rename，避免 agent 读到半截 JSON。
 */
async function writeTaskResult(workspace, result) {
  const dir = join(workspace, '_tasks', 'results');
  await mkdir(dir, { recursive: true }).catch(() => {});

  const rawName = String(result.file ?? `result-${randomUUID()}.json`).replace(/[\\/]/g, '_');
  const name = rawName.endsWith('.json') ? rawName : `${rawName}.json`;
  const dest = join(dir, name);
  const payload = {
    ok: Boolean(result.ok),
    file: result.file,
    action: result.action,
    reason: result.reason,
    text: formatTaskResultNotice(result),
    task: result.task ? {
      id: result.task.id,
      title: result.task.title,
      schedule: result.task.schedule,
      nextRunAt: result.task.nextRunAt,
    } : undefined,
    at: new Date().toISOString(),
  };

  const tmp = `${dest}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(payload, null, 2), { mode: 0o644 });
  await rename(tmp, dest);
}

/** 把一条请求应用到 TaskStore（校验后） */
function applyRequest(store, req, log) {
  if (!req || typeof req !== 'object') throw new Error('请求必须是 JSON 对象');

  const action = req.action ?? 'add';

  if (action === 'add') {
    if (!req.schedule || typeof req.schedule !== 'object') {
      throw new Error('缺少 schedule');
    }
    const prompt = String(req.prompt ?? '').trim();
    if (!prompt) throw new Error('缺少 prompt');
    if (prompt.length > 8000) throw new Error('prompt 过长（上限 8000 字）');

    const next = computeNextRun(req.schedule, Date.now());
    if (!next) throw new Error(`schedule 无法解析: ${JSON.stringify(req.schedule)}`);
    if (next < Date.now() - 60_000) throw new Error('触发时间已经过去');

    const task = store.add({
      schedule: req.schedule,
      prompt,
      title: req.title ? String(req.title).slice(0, 60) : undefined,
    });
    log(`[task] agent 创建任务 ${task.id}「${task.title}」${describeSchedule(task.schedule)}，首次 ${formatNextRun(task.nextRunAt)}`);
    return { action: 'add', task };
  }

  if (action === 'rm' || action === 'remove') {
    const task = resolveTarget(store, req, action);
    store.remove(task.id);
    log(`[task] agent 删除了任务 ${task.id}「${task.title}」`);
    return { action: 'rm', task };
  }

  if (action === 'disable' || action === 'enable') {
    const task = resolveTarget(store, req, action);
    store.setEnabled(task.id, action === 'enable');
    log(`[task] agent ${action === 'enable' ? '启用' : '停用'}了任务 ${task.id}「${task.title}」`);
    return { action, task: store.get(task.id) };
  }

  if (action === 'update' || action === 'reschedule' || action === 'set') {
    const task = resolveTarget(store, req, action);
    const schedule = scheduleFromRequest(req);
    if (!schedule) {
      throw new Error('update 需要 schedule（或 at / daily / every 简写）');
    }
    const next = computeNextRun(schedule, Date.now());
    if (!next) throw new Error(`schedule 无法解析: ${JSON.stringify(schedule)}`);
    if (next < Date.now() - 60_000) throw new Error('触发时间已经过去');
    if (!store.setSchedule(task.id, schedule)) throw new Error('修改计划失败');
    const updated = store.get(task.id);
    log(`[task] agent 修改了任务 ${task.id}「${updated.title}」为 ${describeSchedule(updated.schedule)}，下次 ${formatNextRun(updated.nextRunAt)}`);
    return { action: 'update', task: updated };
  }

  if (action === 'snooze' || action === 'delay' || action === 'later') {
    const task = resolveTarget(store, req, 'snooze');
    const minutes = Number(req.minutes ?? req.delayMinutes ?? 10);
    if (!Number.isFinite(minutes) || minutes <= 0 || minutes > 7 * 24 * 60) {
      throw new Error('minutes 必须是 1–10080 之间的数字');
    }
    if (!store.snooze(task.id, minutes)) throw new Error('推迟任务失败');
    const updated = store.get(task.id);
    log(`[task] agent 把任务 ${task.id}「${updated.title}」推迟了 ${minutes} 分钟，下次 ${formatNextRun(updated.nextRunAt)}`);
    return { action: 'snooze', task: updated, minutes };
  }

  throw new Error(`未知 action: ${action}`);
}

/**
 * 解析任务目标：id 优先，其次标题。
 * snooze 是唯一允许省略目标的动作（只有一条任务时默认推迟它）。
 */
function resolveTarget(store, req, action) {
  const selector = String(req.id ?? req.taskId ?? req.title ?? req.query ?? '').trim();
  if (!selector) {
    const all = store.list();
    if (action === 'snooze' && all.length === 1) return all[0];
    throw new Error(`${action} 需要 id 或 title`);
  }

  const task = store.resolve(selector);
  if (!task) throw new Error(`没有找到任务 ${selector}`);
  return task;
}

/** 兼容 schedule 对象与 agent 常用的 at/daily/every 简写。 */
function scheduleFromRequest(req) {
  if (req.schedule && typeof req.schedule === 'object') return req.schedule;
  if (req.at) return { kind: 'once', at: req.at };
  if (req.daily) return { kind: 'daily', time: req.daily };
  if (req.weekly) {
    return typeof req.weekly === 'object'
      ? { kind: 'weekly', ...req.weekly }
      : null;
  }
  if (req.every !== undefined) return { kind: 'every', minutes: Number(req.every) };
  if (req.kind) {
    return {
      kind: req.kind,
      at: req.at,
      time: req.time,
      days: req.days,
      minutes: req.minutes,
    };
  }
  return null;
}

/** 把无法处理的请求移到 rejected/，并留下原因 */
async function reject(workspace, src, name, reason) {
  const dir = join(workspace, '_tasks', 'rejected');
  await mkdir(dir, { recursive: true }).catch(() => {});
  const dest = join(dir, `${Date.now()}-${name}`);
  try {
    const content = await readFile(src, 'utf8').catch(() => '');
    await writeFile(`${dest}.reason.txt`, `拒绝原因: ${reason}\n原始内容:\n${content}`, { mode: 0o644 });
    await rm(src, { force: true });
  } catch {
    /* 尽力而为 */
  }
}

/**
 * 把当前任务清单快照到工作区，供 agent 查看。
 * @param {string} workspace
 * @param {import('./tasks.mjs').TaskStore} store
 */
export async function writeTaskSnapshot(workspace, store) {
  const dir = join(workspace, '_tasks');
  await mkdir(dir, { recursive: true }).catch(() => {});
  const tasks = store.list().map((t) => ({
    id: t.id,
    title: t.title,
    enabled: t.enabled,
    schedule: t.schedule,
    nextRunAt: t.nextRunAt ? formatNextRun(t.nextRunAt) : null,
    lastRunAt: t.lastRunAt,
    lastResult: t.lastResult,
    prompt: t.prompt,
  }));
  await writeFile(
    join(dir, 'current.json'),
    JSON.stringify({ updatedAt: new Date().toISOString(), tasks }, null, 2),
    { mode: 0o644 },
  ).catch(() => {});
}

/**
 * 把一条处理结果格式化成发给用户的微信确认消息。
 *
 * agent 的回复早于桥接处理，它说的结果可能还没真正落盘；这条消息才是最终结论。
 * @param {object} result - processPendingTaskRequests 的 onResult 结果
 * @returns {string}
 */
export function formatTaskResultNotice(result) {
  const task = result?.task;
  const title = task?.title ? `「${task.title}」` : '';

  if (!result?.ok) {
    return `⚠️ 定时任务请求未生效：${String(result?.reason ?? '未知原因').slice(0, 300)}`;
  }

  switch (result.action) {
    case 'add': {
      // once 的 describeSchedule 已包含时间，不再重复"下次"
      const next = task?.schedule?.kind === 'once' ? '' : `，下次 ${formatNextRun(task?.nextRunAt)}`;
      return `✅ 定时任务已生效：${title}${describeSchedule(task?.schedule)}${next}`;
    }
    case 'rm':
      return `✅ 已取消定时任务${title}`;
    case 'disable':
      return `✅ 已暂停定时任务${title}`;
    case 'enable':
      return `✅ 已恢复定时任务${title}，下次 ${formatNextRun(task?.nextRunAt)}`;
    case 'update': {
      const next = task?.schedule?.kind === 'once' ? '' : `，下次 ${formatNextRun(task?.nextRunAt)}`;
      return `✅ 已修改定时任务${title}：${describeSchedule(task?.schedule)}${next}`;
    }
    case 'snooze':
      return `✅ 已推迟定时任务${title}，下次 ${formatNextRun(task?.nextRunAt)}`;
    default:
      return `✅ 定时任务请求已生效${title}`;
  }
}
