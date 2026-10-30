#!/usr/bin/env node
/**
 * DSH × 微信桥接入口。
 *
 * 命令实现在 src/cli/；三种运行形态共用这一个入口：
 *   node src/main.mjs doctor --check
 *   dsh-wechat-link -h
 *   ./build/dsh-wechat-link   (SEA)
 */

import { runCli } from './cli/index.mjs';

export { runCli };

runCli();
