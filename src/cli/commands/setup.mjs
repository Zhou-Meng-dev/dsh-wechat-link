/**
 * `setup`：先做依赖自检，再走首次配置向导（API key；可重跑）。
 */

import { bridgeHome } from '../../config.mjs';
import { assertPreflight } from '../../ops/preflight.mjs';
import { runSetup } from '../../ops/setup.mjs';
import { CLI, log, store, warn } from '../context.mjs';

export async function cmdSetup() {
  // 场景要求：先检测依赖，再填配置
  await assertPreflight();
  await runSetup({ store, force: true, log, warn });
  console.log(`\n配置目录: ${bridgeHome()}`);
  console.log(`下一步:   ${CLI} login    扫码添加第一个 bot`);
}
