/**
 * `usage`：查看租户的 turn / token / 模型用量与预算。
 *
 * 只读 <租户根>/usage.json，不依赖运行中的服务；服务在运行时会持续追加，
 * 这里按天/月汇总（--day / --month 可查历史）。
 */

import { join } from 'node:path';

import { tenantRoot } from '../../config.mjs';
import { UsageStore, dayKey, formatUsageSummary, monthKey } from '../../ops/usage.mjs';
import { requireTenant } from '../tenant-context.mjs';
import { CLI } from '../context.mjs';

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_RE = /^\d{4}-\d{2}$/;

export async function cmdUsage(argv) {
  const [id, ...rest] = argv;
  if (!id) {
    console.error(`用法:
  ${CLI} usage <id>                    今日 + 本月汇总
  ${CLI} usage <id> --day 2026-10-30    指定日期
  ${CLI} usage <id> --month 2026-10     指定月份
  ${CLI} usage <id> --json              输出 JSON（脚本用）`);
    process.exit(1);
  }

  let day = dayKey();
  let month = monthKey();
  let json = false;
  let showDay = true;

  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg === '--json') {
      json = true;
    } else if (arg === '--day') {
      const value = rest[++i];
      if (!DAY_RE.test(String(value ?? ''))) {
        console.error('--day 格式应为 YYYY-MM-DD');
        process.exit(1);
      }
      day = value;
      month = value.slice(0, 7);
      showDay = true;
    } else if (arg === '--month') {
      const value = rest[++i];
      if (!MONTH_RE.test(String(value ?? ''))) {
        console.error('--month 格式应为 YYYY-MM');
        process.exit(1);
      }
      month = value;
      // 只给月份时只展示月汇总，避免出现"今日 某月 1 号"这种误导
      day = `${value}-01`;
      showDay = false;
    } else {
      console.error(`未知参数: ${arg}`);
      process.exit(1);
    }
  }

  const { tenant } = await requireTenant(id);
  const store = new UsageStore({ path: join(tenantRoot(id), 'usage.json') });
  await store.load();
  const summary = store.summary({ day, month });

  if (json) {
    console.log(JSON.stringify(summary, null, 2));
    return;
  }

  const title = `租户 ${tenant.botId ?? id} 用量`;
  console.log(formatUsageSummary(summary, { title, showDay }));
  console.log(`\n数据文件: ${join(tenantRoot(id), 'usage.json')}`);
}
