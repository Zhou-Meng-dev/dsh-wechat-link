/**
 * CLI 共享上下文：配置路径、ConfigStore、带本地时间戳的日志、程序名。
 *
 * 所有命令模块都从这里取 store / log / warn / CLI，避免各自重复计算。
 * 只在 CLI 进程里 import：常驻服务也走 CLI 入口，因此配置在启动时读一次。
 */

import { basename } from 'node:path';

import { ConfigStore, defaultConfigPath } from '../config.mjs';

export const CONFIG_PATH = process.env.BRIDGE_CONFIG ?? defaultConfigPath();

export const store = new ConfigStore(CONFIG_PATH);

// 日志时间戳用**本地时间**，和 journald 对齐。
const timeFmt = new Intl.DateTimeFormat('en-GB', {
  hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
});
export function ts() {
  return timeFmt.format(new Date());
}
export const log = (...a) => console.log(`[${ts()}]`, ...a);
export const warn = (...a) => console.error(`[${ts()}] ⚠️`, ...a);

/**
 * 帮助与错误提示里怎么称呼当前程序。
 *
 * 同一个文件有三种运行形态，写死任何一种都会误导另外两种：
 *   源码     node src/main.mjs      → "node src/main.mjs"
 *   npm bin  dsh-wechat-link        → "dsh-wechat-link"
 *   SEA      ./dsh-wechat-link         → "dsh-wechat-link"（用户可能改过名，取实际 basename）
 *
 * SEA 下 process.argv[1] 是可执行文件路径；源码/bin 下是脚本路径。
 */
function cliName() {
  const base = basename(process.argv[1] ?? '');
  if (base === 'dsh-wechat-link' || base === 'dsh-wechat-link.mjs') return 'dsh-wechat-link';
  if (!base || base === 'main.mjs') return 'node src/main.mjs';
  return base;
}
export const CLI = cliName();
