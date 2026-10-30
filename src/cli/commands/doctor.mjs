/**
 * `doctor`：检查运行依赖。`--check` 只读，不创建目录。
 */

import { formatPreflight, runPreflight } from '../../ops/preflight.mjs';
import { applySandboxEnv, resolveSandbox } from '../../sandbox/sandbox-env.mjs';

export async function cmdDoctor(argv = []) {
  const unknown = argv.filter((a) => a !== '--check' && a !== '-n');
  if (unknown.length > 0) {
    console.error(`未知参数: ${unknown.join(' ')}（doctor 支持 --check / -n）`);
    process.exit(2);
  }
  const readOnly = argv.length > 0;
  let sandboxError = null;
  try {
    applySandboxEnv(await resolveSandbox());
  } catch (err) {
    sandboxError = err;
  }
  const result = await runPreflight({ readOnly, sandboxError });
  console.log(formatPreflight(result));
  if (readOnly) console.log('\n（--check 只读模式：未创建任何目录）');
  process.exit(result.ok ? 0 : 1);
}
