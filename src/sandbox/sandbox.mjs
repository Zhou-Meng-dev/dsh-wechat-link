/**
 * 为 dsh 子进程构造 bubblewrap 沙箱命令行。
 *
 * 设计：桥接进程跑在宿主机（需要读配置、连 iLink），
 * 只有 **dsh 子进程**（及其派生的 bash 工具）进入沙箱。
 *
 * agent 因此看不到：
 *   - 宿主 ~/.ssh、~/code、其它仓库
 *   - 桥接的 config.json / secrets.json（~/.dsh-wechat-link，含 bot token）—— 不在沙箱挂载表里
 *   - 宿主 ~/.dsh（会话、其它凭据）
 *
 * agent 能看到：
 *   - 系统运行库（只读）、node + dsh（只读）
 *   - 本租户的 DSH_HOME（读写，只含凭据）
 *   - 本租户的工作目录（读写）
 */

import { existsSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * 允许透传进沙箱的宿主环境变量：只包含运行/网络/编码必需、且不含凭据的项。
 * 其它变量（BRIDGE_*、CRED_SOURCE、宿主 DEEPSEEK_API_KEY 等）默认全部丢弃。
 */
export const SANDBOX_ENV_PASSTHROUGH = Object.freeze([
  'TZ',
  'LANG',
  'LANGUAGE',
  'LC_ALL',
  'LC_CTYPE',
  'LC_MESSAGES',
  'LC_NUMERIC',
  'LC_TIME',
  'TERM',
  'COLORTERM',
  'NO_COLOR',
  'FORCE_COLOR',
  'CLICOLOR',
  'CLICOLOR_FORCE',
  'SHELL',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'NODE_EXTRA_CA_CERTS',
  // 非凭据的 dsh 运行偏好
  'DEEPSEEK_BASE_URL',
  'DSH_TELEMETRY_DISABLED',
  'DSH_WEB_FETCH_PROVIDER',
  'DSH_WEB_SEARCH_PROVIDER',
  'DSH_BUNDLED_SKILL_DIR',
]);

/** 由 bwrap 固定设置、不允许被透传或 extra 覆盖的变量 */
const RESERVED_ENV = new Set(['HOME', 'DSH_HOME', 'DSH_IN_CONTAINER', 'PATH', 'PWD', 'TMPDIR']);

/** 允许通过 BRIDGE_SANDBOX_ENV_PASSTHROUGH 额外透传的变量名 */
function extraPassthroughNames(hostEnv) {
  return String(hostEnv?.BRIDGE_SANDBOX_ENV_PASSTHROUGH ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((name) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(name));
}

/**
 * 计算沙箱内要显式设置的环境变量。
 *
 * - 默认只取 SANDBOX_ENV_PASSTHROUGH，宿主其它变量（含密钥）全部丢弃
 * - `extra`（租户 API key）优先覆盖同名宿主变量
 * - BRIDGE_SANDBOX_ENV_PASSTHROUGH 可追加变量名，但保留变量始终由 bwrap 固定
 *
 * @param {NodeJS.ProcessEnv} [hostEnv]
 * @param {Record<string, string>} [extra]
 * @returns {Record<string, string>}
 */
export function sandboxEnvFrom(hostEnv = process.env, extra = {}) {
  const names = new Set([...SANDBOX_ENV_PASSTHROUGH, ...extraPassthroughNames(hostEnv)]);
  const out = {};
  for (const name of names) {
    if (RESERVED_ENV.has(name)) continue;
    const value = hostEnv?.[name];
    if (value !== undefined) out[name] = String(value);
  }
  for (const [name, value] of Object.entries(extra ?? {})) {
    if (RESERVED_ENV.has(name) || value === undefined) continue;
    out[name] = String(value);
  }
  return out;
}

/**
 * @param {object} opts
 * @param {string} opts.cwd       - 租户工作目录（宿主机绝对路径）
 * @param {string} opts.dshHome   - 租户独立 DSH_HOME（宿主机绝对路径）
 * @param {string} opts.homeDir   - 要遮蔽的宿主家目录（如 /home/zhoumeng）
 * @param {string} opts.voltaRoot - 宿主工具根（node/dsh 所在目录），只读挂载到 /opt/volta
 * @param {string} opts.nodeBin   - 沙箱内 node 路径
 * @param {string} opts.dshJs     - 沙箱内 dsh bin.js 路径
 * @param {string[]} opts.dshArgs - dsh 参数（如 ['--profile','sdk']）
 * @returns {string[]} 交给 spawn 的 argv
 */
export function buildSandboxArgv(opts) {
  const { cwd, dshHome, homeDir, voltaRoot, nodeBin, dshJs, dshArgs } = opts;

  const args = [
    '--ro-bind', voltaRoot, '/opt/volta',
    // 系统运行库
    '--ro-bind', '/usr', '/usr',
    '--ro-bind', '/lib', '/lib',
    '--ro-bind', '/lib64', '/lib64',
    '--ro-bind', '/bin', '/bin',
    '--ro-bind', '/sbin', '/sbin',
    // 网络与身份所需的最小 /etc
    '--ro-bind', '/etc/resolv.conf', '/etc/resolv.conf',
    '--ro-bind', '/etc/hosts', '/etc/hosts',
    '--ro-bind', '/etc/ssl', '/etc/ssl',
    '--ro-bind', '/etc/passwd', '/etc/passwd',
    '--ro-bind', '/etc/group', '/etc/group',
  ];
  if (existsSync('/etc/nsswitch.conf')) {
    args.push('--ro-bind', '/etc/nsswitch.conf', '/etc/nsswitch.conf');
  }
  if (existsSync('/etc/localtime')) {
    args.push('--ro-bind', '/etc/localtime', '/etc/localtime');
  }

  args.push(
    // 遮住整个家目录，再只露出本租户的 DSH_HOME 与工作目录
    // 注意：bwrap 的源路径在宿主命名空间解析，所以 tmpfs 之后仍可 bind 宿主路径
    '--tmpfs', homeDir,
    // /tmp 必须在 bind 租户目录之前遮住：否则 BRIDGE_HOME 放在 /tmp 下时，
    // 先 bind 的 cwd/dsh-home 会被这个 tmpfs 盖掉，bwrap 报 "Can't chdir ..."。
    '--tmpfs', '/tmp',
    '--bind', dshHome, `${homeDir}/.dsh`,
    // 凭据文件额外覆盖为只读：dsh 只需读它（静态 API key，无刷新），
    // 只读可防止 agent 篡改/清空凭据把 bot 弄坏。
    ...(existsSync(`${dshHome}/.credentials.yaml`)
      ? ['--ro-bind', `${dshHome}/.credentials.yaml`, `${homeDir}/.dsh/.credentials.yaml`]
      : []),
    '--bind', cwd, cwd,
    // 额外只读挂载（如租户 persona patch），只读可防 agent 改自己的提示词
    ...(opts.extraRoBinds ?? []).flatMap(({ src, dst }) =>
      existsSync(src) ? ['--ro-bind', src, dst] : [],
    ),
    '--proc', '/proc',
    '--dev', '/dev',
    '--unshare-all',
    '--share-net',
    '--die-with-parent',
    '--new-session',
    '--chdir', cwd,
    // 先清空宿主环境，再只设置白名单/租户变量；否则 agent 能通过 env 读到
    // BRIDGE_* / CRED_SOURCE / 宿主 DEEPSEEK_API_KEY 等。
    '--clearenv',
    '--setenv', 'HOME', homeDir,
    '--setenv', 'DSH_HOME', `${homeDir}/.dsh`,
    '--setenv', 'DSH_IN_CONTAINER', '1',
    '--setenv', 'PATH', `${dirname(nodeBin)}:/usr/local/bin:/usr/bin:/bin`,
    '--setenv', 'PWD', cwd,
    '--setenv', 'TMPDIR', '/tmp',
    // 额外环境变量（如租户自己的 DEEPSEEK_API_KEY）。
    // 用 --setenv 注入，不落盘到任何文件，agent 只能通过自己的环境读到本租户的 key。
    ...Object.entries(opts.envVars ?? {})
      .filter(([k]) => !RESERVED_ENV.has(k))
      .flatMap(([k, v]) => ['--setenv', k, String(v)]),
    nodeBin, dshJs, ...dshArgs,
  );
  return args;
}
