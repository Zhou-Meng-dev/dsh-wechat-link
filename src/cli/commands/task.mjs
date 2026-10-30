/**
 * `task`：租户定时任务的增删改查。
 * 只读写 <租户根>/tasks.json；运行中的服务会在 1 秒内热加载。
 */

import { join } from 'node:path';

import { tenantRoot } from '../../config.mjs';
import { requireTenant } from '../tenant-context.mjs';
import { CLI } from '../context.mjs';
import { validateWindowSchedule } from '../../tasks/tasks.mjs';

/** 解析 --at / --daily / --weekly / --every / --window，供 add 与 update 共用 */
function parseTaskScheduleArgs(args) {
  let schedule = null;
  let window = null;
  let count = null;
  let spacing = null;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--at') { schedule = { kind: 'once', at: args[++i] }; }
    else if (a === '--daily') { schedule = { kind: 'daily', time: args[++i] }; }
    else if (a === '--every') { schedule = { kind: 'every', minutes: Number(args[++i]) }; }
    else if (a === '--weekly') {
      // 形式: --weekly "1,3,5 09:00" 或 --weekly "周一,周五 09:00"
      const spec = String(args[++i] ?? '');
      const m = spec.match(/^(.*?)[\s@]+(\d{2}:\d{2})$/);
      if (!m) {
        console.error('--weekly 格式: "<星期> HH:MM"，例: --weekly "1,3,5 09:00"');
        process.exit(1);
      }
      schedule = { kind: 'weekly', days: m[1].trim(), time: m[2] };
    }
    else if (a === '--window') {
      // 形式: --window "08:00-23:00" --count 10
      const spec = String(args[++i] ?? '');
      const m = spec.match(/^(\d{1,2}:\d{2})\s*[-–~]\s*(\d{1,2}:\d{2})$/);
      if (!m) {
        console.error('--window 格式: "HH:MM-HH:MM"，例: --window "08:00-23:00" --count 10');
        process.exit(1);
      }
      window = { start: m[1], end: m[2] };
    }
    else if (a === '--count') { count = Number(args[++i]); }
    else if (a === '--spacing') { spacing = args[++i]; }
  }

  if (window) {
    schedule = {
      kind: 'window',
      start: window.start,
      end: window.end,
      count: count ?? 1,
      spacing: spacing ?? 'stratified',
    };
  }
  return schedule;
}

export async function cmdTask(argv) {
  const [id, action = 'list', ...rest] = argv;
  if (!id) {
    console.error(`用法:
  ${CLI} task <id> list
  ${CLI} task <id> add --at "2026-10-28 12:30" --prompt "..." [--title ...]
  ${CLI} task <id> add --daily "09:00" --prompt "..."
  ${CLI} task <id> add --weekly "1,3,5 09:00" --prompt "..."   （周一三五）
  ${CLI} task <id> add --every 60 --prompt "..."
  ${CLI} task <id> add --window "08:00-23:00" --count 10 --prompt "..."
  ${CLI} task <id> rm <taskId|标题>
  ${CLI} task <id> enable|disable <taskId|标题>
  ${CLI} task <id> update <taskId|标题> --at "..." | --daily "..." | --weekly "..." | --every N | --window "..." --count N
  ${CLI} task <id> snooze <taskId|标题> [--minutes 10]`);
    process.exit(1);
  }
  await requireTenant(id);

  const { TaskStore, describeSchedule, formatNextRun } = await import('../../tasks/tasks.mjs');
  const path = join(tenantRoot(id), 'tasks.json');
  const taskStore = new TaskStore(path);
  await taskStore.load();

  /** id 或标题都可能；标题有歧义时打印候选并退出 */
  const resolveOrExit = (selector) => {
    try {
      const t = taskStore.resolve(selector);
      if (!t) {
        console.error(`没有找到任务 ${selector ?? '(未指定)'}`);
        process.exit(1);
      }
      return t;
    } catch (err) {
      console.error(err.message);
      process.exit(1);
    }
  };

  if (action === 'list' || action === 'ls') {
    const list = taskStore.list();
    console.log(`租户 ${id} 的任务（${path}）:`);
    if (list.length === 0) {
      console.log('  (无)');
      return;
    }
    for (const t of list) {
      const flag = t.enabled ? '启用' : '停用';
      console.log(`  ${t.id}  [${flag}]  ${t.title}`);
      console.log(`    计划: ${describeSchedule(t.schedule)}`);
      console.log(`    下次: ${t.schedule?.kind === 'once' && !t.enabled ? '(已执行)' : formatNextRun(t.nextRunAt)}`);
      if (t.lastRunAt) console.log(`    上次: ${new Date(t.lastRunAt).toLocaleString('zh-CN')} (${t.lastResult ?? '-'})`);
      console.log(`    提示词: ${t.prompt.slice(0, 60)}${t.prompt.length > 60 ? '…' : ''}`);
      console.log('');
    }
    return;
  }

  if (action === 'add') {
    const schedule = parseTaskScheduleArgs(rest);
    let prompt = null;
    let title = null;
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === '--prompt') prompt = rest[++i];
      else if (rest[i] === '--title') title = rest[++i];
    }
    if (!schedule) { console.error('缺少 --at / --daily / --weekly / --every / --window'); process.exit(1); }
    if (schedule.kind === 'window') {
      const err = validateWindowSchedule(schedule);
      if (err) { console.error(`窗口参数非法: ${err}`); process.exit(1); }
    }
    if (!prompt) { console.error('缺少 --prompt'); process.exit(1); }

    const t = taskStore.add({ schedule, prompt, title });
    if (!t.nextRunAt) {
      console.error('时间无法解析，请检查格式（例：--at "2026-10-28 12:30"）');
      process.exit(1);
    }
    await taskStore.flush();
    console.log(`✅ 已添加任务 ${t.id}`);
    console.log(`   计划: ${describeSchedule(t.schedule)}`);
    console.log(`   下次: ${formatNextRun(t.nextRunAt)}`);
    console.log('   服务会在 1 秒内加载它。');
    return;
  }

  if (action === 'rm' || action === 'remove') {
    const selector = rest[0];
    if (!selector) { console.error('用法: task <id> rm <taskId|标题>'); process.exit(1); }
    const task = resolveOrExit(selector);
    taskStore.remove(task.id);
    await taskStore.flush();
    console.log(`✅ 已删除任务 ${task.id}「${task.title}」`);
    return;
  }

  if (action === 'enable' || action === 'disable') {
    const selector = rest[0];
    if (!selector) { console.error(`用法: task <id> ${action} <taskId|标题>`); process.exit(1); }
    const task = resolveOrExit(selector);
    taskStore.setEnabled(task.id, action === 'enable');
    await taskStore.flush();
    console.log(`✅ 已${action === 'enable' ? '启用' : '停用'}任务 ${task.id}「${task.title}」`);
    return;
  }

  if (action === 'update' || action === 'reschedule' || action === 'set') {
    const selector = rest[0];
    if (!selector) {
      console.error('用法: task <id> update <taskId|标题> --at "..." | --daily "..." | --weekly "..." | --every N');
      process.exit(1);
    }
    const schedule = parseTaskScheduleArgs(rest.slice(1));
    if (!schedule) { console.error('缺少 --at / --daily / --weekly / --every / --window'); process.exit(1); }
    if (schedule.kind === 'window') {
      const err = validateWindowSchedule(schedule);
      if (err) { console.error(`窗口参数非法: ${err}`); process.exit(1); }
    }
    const task = resolveOrExit(selector);
    if (!taskStore.setSchedule(task.id, schedule)) {
      console.error('时间无法解析，请检查格式');
      process.exit(1);
    }
    await taskStore.flush();
    const updated = taskStore.get(task.id);
    console.log(`✅ 已修改任务 ${updated.id}「${updated.title}」`);
    console.log(`   计划: ${describeSchedule(updated.schedule)}`);
    console.log(`   下次: ${formatNextRun(updated.nextRunAt)}`);
    return;
  }

  if (action === 'snooze' || action === 'delay' || action === 'later') {
    let selector = rest[0];
    if (selector?.startsWith('--')) selector = null;
    if (!selector) {
      const all = taskStore.list();
      if (all.length === 1) selector = all[0].id;
      else {
        console.error('用法: task <id> snooze <taskId|标题> [--minutes 10]');
        process.exit(1);
      }
    }
    const mi = rest.indexOf('--minutes');
    const minutes = mi >= 0 ? Number(rest[mi + 1]) : 10;
    if (!Number.isFinite(minutes) || minutes <= 0) {
      console.error('--minutes 必须是大于 0 的数字');
      process.exit(1);
    }
    const task = resolveOrExit(selector);
    if (!taskStore.snooze(task.id, minutes)) {
      console.error('推迟任务失败');
      process.exit(1);
    }
    await taskStore.flush();
    const updated = taskStore.get(task.id);
    console.log(`✅ 已推迟任务「${updated.title}」${minutes} 分钟，下次 ${formatNextRun(updated.nextRunAt)}`);
    return;
  }

  console.error(`未知操作: ${action}`);
  process.exit(1);
}
