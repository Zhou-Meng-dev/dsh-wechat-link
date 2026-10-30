/**
 * dsh 沙箱的默认配置解析。
 *
 * 目标：`node src/main.mjs` 与 SEA 单文件都默认把 dsh 关进 bwrap，
 * 不再要求用户先执行 sandbox.sh 或手工导出 SANDBOX_* 变量。
 *
 * 判定顺序：
 *   1. BRIDGE_DSH_MODE=container → 容器模式，不套 bwrap（容器即边界）
 *   2. DSH_SANDBOX=0/false/no/off → 显式关闭（用户明确知情）
 *   3. 其余情况 → bwrap 沙箱（默认）
 *
 * 工具链解析：找到宿主 node 与 dsh 的 bin.js，取共同父目录作为
 * “工具根”，只读挂载到沙箱内的 /opt/volta。
 */

import { accessSync, constants, existsSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, sep } from 'node:path';

import { isSeaRuntime } from '../assets.mjs';

/** 工具根在沙箱内的挂载点，必须与 src/sandbox/sandbox.mjs 保持一致。 */
export const SANDBOX_TOOL_MOUNT = '/opt/volta';

const OFF_VALUES = new Set(['0', 'false', 'no', 'off']);

/**
 * 当前应该用哪种隔离模式。
 * @returns {'bwrap'|'container'|'off'}
 */
export function sandboxMode(env = process.env) {
  if (String(env.BRIDGE_DSH_MODE ?? '').trim() === 'container') return 'container';
  if (OFF_VALUES.has(String(env.DSH_SANDBOX ?? '').trim().toLowerCase())) return 'off';
  return 'bwrap';
}

function realFile(path, label) {
  let real;
  try {
    real = realpathSync(path);
  } catch {
    throw new Error(`${label} 不存在: ${path}`);
  }
  if (!statSync(real).isFile()) throw new Error(`${label} 不是文件: ${path}`);
  return real;
}

function which(cmd, pathValue) {
  for (const dir of String(pathValue ?? '').split(':')) {
    if (!dir) continue;
    const candidate = join(dir, cmd);
    try {
      accessSync(candidate, constants.X_OK);
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // 继续找下一个 PATH 目录
    }
  }
  return '';
}

function resolveNode(env, { sea, execPath }) {
  const explicit = String(env.WECHAT_NODE_BIN ?? '').trim();
  if (explicit) return realFile(explicit, 'WECHAT_NODE_BIN');

  if (!sea) return realFile(execPath, '当前 node');

  const found = which('node', env.PATH);
  if (!found) {
    throw new Error('SEA 模式找不到 node：请把 node 放进 PATH，或设置 WECHAT_NODE_BIN');
  }
  return realFile(found, 'node');
}

function resolveDshJs(env) {
  const explicit = String(env.WECHAT_DSH_JS ?? env.DSH_JS_PATH ?? '').trim();
  if (explicit) return realFile(explicit, 'WECHAT_DSH_JS');

  const dshCmd = which('dsh', env.PATH);
  if (dshCmd) {
    let real = '';
    try {
      real = realpathSync(dshCmd);
    } catch {
      // 断链的 shim：继续按已知安装布局找
    }
    if (real.endsWith('.js')) return realFile(real, 'dsh bin.js');
  }

  const home = String(env.HOME ?? '').trim() || homedir();
  const candidates = [];
  const voltaHomes = [String(env.VOLTA_HOME ?? '').trim(), join(home, '.volta')].filter(Boolean);
  for (const volta of voltaHomes) {
    candidates.push(join(
      volta,
      'tools/image/packages/@deepseek-ai/dsh/lib/node_modules/@deepseek-ai/dsh/lib/bin.js',
    ));
  }
  if (dshCmd) {
    // npm 全局安装：/usr/local/bin/dsh → /usr/local/lib/node_modules/...
    candidates.push(join(
      dirname(dirname(dshCmd)),
      'lib/node_modules/@deepseek-ai/dsh/lib/bin.js',
    ));
  }
  for (const prefix of ['/usr/local', '/usr']) {
    candidates.push(join(prefix, 'lib/node_modules/@deepseek-ai/dsh/lib/bin.js'));
  }

  for (const candidate of candidates) {
    if (existsSync(candidate)) return realFile(candidate, 'dsh bin.js');
  }
  throw new Error(
    '找不到 dsh 的 bin.js：请安装 @deepseek-ai/dsh，或设置 WECHAT_DSH_JS=/path/to/dsh/lib/bin.js',
  );
}

/** node 与 dsh 的共同父目录；两者不在同一棵树时报错（与 deploy/install.sh 的约束一致）。 */
function commonToolRoot(nodeBin, dshJs) {
  const a = nodeBin.split(sep);
  const b = dshJs.split(sep);
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i += 1;
  const root = a.slice(0, i).join(sep) || sep;
  if (root === sep) {
    throw new Error(
      'node 与 dsh 不在同一个可挂载目录下：请用 WECHAT_TOOL_ROOT 指定共同根，或把两者装到同一前缀（如 Volta / npm 全局）',
    );
  }
  return root;
}

function under(path, root) {
  const prefix = root.endsWith(sep) ? root : `${root}${sep}`;
  return path.startsWith(prefix);
}

function toSandboxPath(hostPath, toolRoot) {
  return `${SANDBOX_TOOL_MOUNT}/${hostPath.slice(toolRoot.length).replace(/^\/+/, '')}`;
}

function realOr(path) {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/** 工具根会被只读挂进沙箱；不能是家目录或其祖先，否则 ~/.ssh 等会暴露给 agent。 */
function assertSafeToolRoot(toolRoot, homeDir) {
  if (toolRoot === sep || homeDir === toolRoot || under(homeDir, toolRoot)) {
    throw new Error(
      `工具根 ${toolRoot} 是家目录或其祖先，会向沙箱暴露宿主文件；请把 node/dsh 装到更小的共同前缀，或用 WECHAT_TOOL_ROOT 指定`,
    );
  }
}

/**
 * 解析默认沙箱配置；不修改 process.env。
 * @param {object} [opts]
 * @param {NodeJS.ProcessEnv} [opts.env]
 * @param {boolean} [opts.isSea] - 测试注入；默认探测 node:sea
 * @param {string} [opts.execPath] - 测试注入；默认 process.execPath
 */
export async function resolveSandbox(opts = {}) {
  const env = opts.env ?? process.env;
  const mode = sandboxMode(env);
  if (mode !== 'bwrap') return { mode };

  const homeDir = String(env.SANDBOX_HOME ?? env.HOME ?? '').trim() || homedir();
  const homeReal = realOr(homeDir);
  const credSource = String(env.CRED_SOURCE ?? '').trim()
    || join(String(env.DSH_HOME ?? '').trim() || join(homeDir, '.dsh'), '.credentials.yaml');

  // sandbox.sh 已经把沙箱内路径算好了，直接沿用，避免二次解析出偏差
  if (env.SANDBOX_NODE && env.SANDBOX_DSH_JS && env.VOLTA_ROOT) {
    const toolRoot = realFileDir(env.VOLTA_ROOT);
    assertSafeToolRoot(toolRoot, homeReal);
    return {
      mode,
      toolRoot,
      nodeBin: String(env.WECHAT_NODE_BIN ?? '').trim() || null,
      dshJs: String(env.WECHAT_DSH_JS ?? '').trim() || null,
      sandboxNode: env.SANDBOX_NODE,
      sandboxDshJs: env.SANDBOX_DSH_JS,
      homeDir,
      credSource: existsSync(credSource) ? credSource : null,
      reused: true,
    };
  }

  const sea = opts.isSea ?? await isSeaRuntime();
  const nodeBin = resolveNode(env, { sea, execPath: opts.execPath ?? process.execPath });
  const dshJs = resolveDshJs(env);
  const explicitRoot = String(env.WECHAT_TOOL_ROOT ?? env.VOLTA_ROOT ?? '').trim();
  const toolRoot = explicitRoot ? realFileDir(explicitRoot) : commonToolRoot(nodeBin, dshJs);

  assertSafeToolRoot(toolRoot, homeReal);

  if (!under(nodeBin, toolRoot)) {
    throw new Error(`node (${nodeBin}) 不在工具根 ${toolRoot} 下：请调整 WECHAT_TOOL_ROOT`);
  }
  if (!under(dshJs, toolRoot)) {
    throw new Error(`dsh (${dshJs}) 不在工具根 ${toolRoot} 下：请调整 WECHAT_TOOL_ROOT`);
  }

  return {
    mode,
    toolRoot,
    nodeBin,
    dshJs,
    sandboxNode: toSandboxPath(nodeBin, toolRoot),
    sandboxDshJs: toSandboxPath(dshJs, toolRoot),
    homeDir,
    credSource: existsSync(credSource) ? credSource : null,
  };
}

function realFileDir(path) {
  let real;
  try {
    real = realpathSync(path);
  } catch {
    throw new Error(`WECHAT_TOOL_ROOT 不存在: ${path}`);
  }
  if (!statSync(real).isDirectory()) throw new Error(`WECHAT_TOOL_ROOT 不是目录: ${path}`);
  return real;
}

/**
 * 把解析结果写回环境变量，后续 Tenant / preflight 只读 env。
 * @param {Awaited<ReturnType<typeof resolveSandbox>>} sandbox
 */
export function applySandboxEnv(sandbox, env = process.env) {
  if (sandbox.mode === 'bwrap') {
    env.DSH_SANDBOX = '1';
    env.VOLTA_ROOT = sandbox.toolRoot;
    env.SANDBOX_NODE = sandbox.sandboxNode;
    env.SANDBOX_DSH_JS = sandbox.sandboxDshJs;
    env.SANDBOX_HOME = sandbox.homeDir;
    if (sandbox.credSource) env.CRED_SOURCE = sandbox.credSource;
    // 给 doctor 的版本探测用（沙箱内路径不能拿来在宿主执行）
    if (sandbox.nodeBin) env.WECHAT_NODE_BIN = sandbox.nodeBin;
    if (sandbox.dshJs) env.WECHAT_DSH_JS = sandbox.dshJs;
    return sandbox;
  }

  env.DSH_SANDBOX = '0';
  if (sandbox.mode === 'container') env.BRIDGE_DSH_MODE = 'container';
  return sandbox;
}
