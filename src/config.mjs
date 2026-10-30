/**
 * 配置层：把「可读配置 / 秘密 / persona 长文本」拆成三层，
 * 全部落在同一个根目录 `~/.dsh-wechat-link` 下（可用 BRIDGE_HOME 覆盖）。
 *
 *   ~/.dsh-wechat-link/config.json      version 2，只放可读配置（0600，含 ownerId）
 *   ~/.dsh-wechat-link/secrets.json     token / apiKey / defaultApiKey（0600）
 *   ~/.dsh-wechat-link/setup.json       首次启动配置完成标记
 *   ~/.dsh-wechat-link/deploy.env       systemd 部署解析出的 node/dsh 路径（0600）
 *   ~/.dsh-wechat-link/tenants/<id>/    租户数据根（persona / 任务 / 会话 / dsh-home）
 *   ~/.dsh-wechat-link/workspace/<id>/  租户工作目录（agent 的 cwd）
 *
 * 配置与秘密放在同一个根下，但仍然分文件：config.json 可以给人看/备份，
 * secrets.json 只有 0600；备份时整个 ~/.dsh-wechat-link 一起拿走即可。
 *
 * config.json（v2）:
 * {
 *   "version": 2,
 *   "tenants": [
 *     {
 *       "id": "t-ef0cfbe30d30",
 *       "ownerId": "xxx@im.wechat",
 *       "createdAt": "2026-10-27T...",
 *       "model": "deepseek-flash"        // 仅当与默认值不同才写
 *     }
 *   ]
 * }
 *
 * 派生值不落盘：
 *   root       = ${WECHAT_SANDBOX_ROOT ?? <root>/tenants}/<id>
 *   cwd        = ${WECHAT_WORKSPACES ?? <root>/workspace}/<id>
 *   botId      = token 中第一个 ':' 之前的部分
 *   dshHome    = root/dsh-home
 *   baseUrl    = https://ilinkai.weixin.qq.com
 *
 * 只支持 v2：读到 version !== 2 的文件会直接报错，不会静默改写用户数据。
 */

import { readFile, writeFile, rename, rm, mkdir, chmod } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { assetFilePath } from './assets.mjs';
import { dirname, join, resolve } from 'node:path';

export const DEFAULT_PROVIDER = 'deepseek-official';
export const DEFAULT_MODEL = 'deepseek-flash';
export const DEFAULT_BASE_URL = 'https://ilinkai.weixin.qq.com';
export const CONFIG_VERSION = 2;
export const SECRETS_VERSION = 1;

// ---------------------------------------------------------------- 基础工具

function isObject(x) {
  return Boolean(x) && typeof x === 'object' && !Array.isArray(x);
}

/** 去掉首尾空白；非字符串返回 '' */
function trimStr(v) {
  return typeof v === 'string' ? v.trim() : '';
}

function parseJson(text, path) {
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error(`文件不是合法 JSON：${path}（${err.message}）`);
  }
}

let tmpSeq = 0;

/**
 * 原子写文本：先写同目录临时文件（0600）再 rename。
 * 写到一半失败不会破坏原文件。
 */
async function atomicWriteText(path, text) {
  // 目录按 0700 创建（仅对本次新建的目录生效，不会改动已存在的父目录）
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.tmp-${process.pid}-${tmpSeq++}`;
  try {
    await writeFile(tmp, text, { mode: 0o600 });
    await chmod(tmp, 0o600);
    await rename(tmp, path);
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

function atomicWriteJson(path, value) {
  return atomicWriteText(path, `${JSON.stringify(value, null, 2)}\n`);
}

// ---------------------------------------------------------------- 路径派生

function home() {
  return process.env.HOME || homedir();
}

/**
 * 桥接根目录：配置、凭据、租户数据和标记文件都在这里。
 *
 * 默认 `~/.dsh-wechat-link`，可用 BRIDGE_HOME 覆盖（容器里指向持久卷）。
 * 刻意不跟随 XDG_CONFIG_HOME：这是一个自包含的数据目录，
 * 备份/迁移只需要拷走这一个目录。
 */
export function bridgeHome() {
  return process.env.BRIDGE_HOME ?? join(home(), '.dsh-wechat-link');
}

/**
 * 工作区根。可用 WECHAT_WORKSPACES 覆盖。
 *
 * 默认 `<bridgeHome>/workspace`，和租户数据根分开：
 * agent 的 cwd 会被挂进沙箱，任务/会话等元数据不跟着进去。
 */
export function workspacesRoot() {
  return process.env.WECHAT_WORKSPACES ?? join(bridgeHome(), 'workspace');
}

/**
 * 租户数据根。可用 WECHAT_SANDBOX_ROOT 覆盖；默认 `<bridgeHome>/tenants`。
 * 注意：不能直接 join(process.env.WECHAT_SANDBOX_ROOT, ...) —— 未设置时它不存在。
 */
export function sandboxRoot() {
  return process.env.WECHAT_SANDBOX_ROOT ?? join(bridgeHome(), 'tenants');
}

/**
 * 配置目录。preflight 等通过它定位 bridgeHome；
 * 配置文件、凭据、部署 env、租户数据都在这个目录之下。
 */
export function configDir() {
  return bridgeHome();
}

/** 默认配置文件路径 */
export function defaultConfigPath() {
  return join(configDir(), 'config.json');
}

/** 默认凭据文件路径（与配置同目录） */
export function defaultSecretsPath() {
  return join(configDir(), 'secrets.json');
}

/**
 * 首次配置完成标记。存在即不再自动询问（`setup` 显式命令仍可重跑）。
 * 与配置同目录，便于整个 ~/.dsh-wechat-link 一起备份。
 */
export function setupMarkerPath() {
  return join(bridgeHome(), 'setup.json');
}

/**
 * 读人设模板。可用 BRIDGE_PERSONA_TEMPLATE 指向自己的模板。
 * 模板不存在时返回空文本（不阻塞 login）。
 * @returns {Promise<{path:string, text:string}>}
 */
export async function loadPersonaTemplate() {
  const path = process.env.BRIDGE_PERSONA_TEMPLATE || await assetFilePath('examples/persona.md');
  try {
    return { path, text: (await readFile(path, 'utf8')).trim() };
  } catch {
    return { path, text: '' };
  }
}

/**
 * 给新租户应用人设模板。已有 persona.md 时绝不动它。
 * @param {ConfigStore} store
 * @param {string} id
 * @returns {Promise<string|null>} 写入路径；没写返回 null
 */
export async function applyPersonaTemplate(store, id) {
  const existing = await store.readPersona(id).catch(() => '');
  if (existing.trim()) return null;
  const { text } = await loadPersonaTemplate();
  if (!text) return null;
  return store.writePersona(id, text);
}

/** 租户根目录（存 bridge-state.json / tasks.json / persona.md / dsh-home） */
export function tenantRoot(id) {
  return join(sandboxRoot(), id);
}

/** 租户工作目录（agent 的 cwd）。cwdOverride 是 login --cwd 留下的例外 */
export function tenantWorkspace(id, cfgEntry) {
  return cfgEntry?.cwdOverride ?? join(workspacesRoot(), id);
}

/** 租户 DSH_HOME */
export function tenantDshHome(id) {
  return join(tenantRoot(id), 'dsh-home');
}

/** 租户人设文件 */
export function personaPath(id) {
  return join(tenantRoot(id), 'persona.md');
}

/** 从 token 派生 botId：'ef0cfbe30d30@im.bot:0600...' → 'ef0cfbe30d30@im.bot' */
export function botIdFromToken(token) {
  const s = String(token ?? '');
  const i = s.indexOf(':');
  return i >= 0 ? s.slice(0, i) : s;
}

/** 从 botId 或 token 里派生一个稳定、可读的租户 id */
export function tenantIdFrom(seed) {
  const s = String(seed ?? '');
  const m = s.match(/^([a-z0-9]+)@im\.bot/i);
  if (m) return `t-${m[1]}`;
  // 退化为短哈希，避免把 token 明文带进 id
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return `t-${(h >>> 0).toString(16).slice(0, 8)}`;
}

/** bot 的展示名（用于日志） */
export function tenantLabel(t) {
  if (t?.botId) return t.botId;
  return t?.id;
}

/** 掩码显示 API key，绝不输出明文 */
export function maskKey(k) {
  if (!k) return '(未设置)';
  const s = String(k);
  if (s.length <= 12) return '****';
  return `${s.slice(0, 3)}****${s.slice(-4)}`;
}

/** key 的短指纹：参与热加载比对，但不泄露明文 */
export function apiKeyFingerprint(k) {
  if (!k) return '';
  return createHash('sha256').update(String(k)).digest('hex').slice(0, 12);
}

function isDefaultBaseUrl(url) {
  return trimStr(url).replace(/\/+$/, '') === DEFAULT_BASE_URL;
}

// ---------------------------------------------------------------- 归一化

/**
 * 不属于配置的顶层字段。
 * - version / tenants 是结构本身
 * - token / apiKey / defaultApiKey / persona 属于秘密或人设，写进配置就是泄露
 * - 其余是租户级字段，出现在顶层说明字段位置不合法
 */
const NON_CONFIG_KEYS = [
  'version', 'tenants',
  'token', 'apiKey', 'defaultApiKey', 'persona',
  'botId', 'ownerId', 'cwd', 'cwdOverride', 'baseUrl', 'provider', 'model', 'createdAt',
];

/**
 * 由租户条目生成 v2 配置条目（不含秘密）。
 * 默认值一律不写，保证"以后改全局默认，已有租户跟着变"。
 */
function configEntryFrom(src) {
  if (!isObject(src)) return null;
  const id = trimStr(src.id);
  if (!id) return null;

  const entry = { id };
  const ownerId = trimStr(src.ownerId);
  if (ownerId) entry.ownerId = ownerId;
  const createdAt = trimStr(src.createdAt);
  if (createdAt) entry.createdAt = createdAt;

  // 默认值不落盘
  const provider = trimStr(src.provider);
  if (provider && provider !== DEFAULT_PROVIDER) entry.provider = provider;
  const model = trimStr(src.model);
  if (model && model !== DEFAULT_MODEL) entry.model = model;
  const baseUrl = trimStr(src.baseUrl);
  if (baseUrl && !isDefaultBaseUrl(baseUrl)) entry.baseUrl = baseUrl;

  // login --cwd 留下的例外
  const cwdOverride = trimStr(src.cwdOverride);
  if (cwdOverride) entry.cwdOverride = cwdOverride;

  // 预留项：只读，从不由 CLI 写入，但手工改过要能生效
  const dshHome = trimStr(src.dshHome);
  if (dshHome) entry.dshHome = dshHome;
  if (Array.isArray(src.allowUsers)) {
    entry.allowUsers = src.allowUsers.filter((u) => typeof u === 'string' && u.trim());
  }
  if (Number.isFinite(src.maxChars)) entry.maxChars = src.maxChars;
  if (Number.isFinite(src.ackDelayMs)) entry.ackDelayMs = src.ackDelayMs;
  // token 预算（可选）：日/月超限时给 owner 发一条提醒，每周期一次
  if (Number.isFinite(src.budgetTokensPerDay) && src.budgetTokensPerDay > 0) {
    entry.budgetTokensPerDay = src.budgetTokensPerDay;
  }
  if (Number.isFinite(src.budgetTokensPerMonth) && src.budgetTokensPerMonth > 0) {
    entry.budgetTokensPerMonth = src.budgetTokensPerMonth;
  }

  return entry;
}

/**
 * 归一化为 v2 纯配置：剥掉秘密字段，保留未知顶层字段（写回时不丢）。
 * 不做磁盘 I/O；只接受当前版本。
 */
export function normalizeConfig(raw) {
  if (!isObject(raw)) return { version: CONFIG_VERSION, tenants: [] };

  const extras = {};
  for (const [k, v] of Object.entries(raw)) {
    if (!NON_CONFIG_KEYS.includes(k)) extras[k] = v;
  }

  const list = Array.isArray(raw.tenants) ? raw.tenants : [];
  return {
    ...extras,
    version: CONFIG_VERSION,
    tenants: list.map(configEntryFrom).filter(Boolean),
  };
}

/** 归一化 secrets 文件结构 */
function normalizeSecrets(raw) {
  const src = isObject(raw) ? raw : {};
  const tenants = {};
  if (isObject(src.tenants)) {
    for (const [id, s] of Object.entries(src.tenants)) {
      if (!isObject(s) || !id) continue;
      const entry = {};
      const token = trimStr(s.token);
      const apiKey = trimStr(s.apiKey);
      if (token) entry.token = token;
      if (apiKey) entry.apiKey = apiKey;
      if (entry.token || entry.apiKey) tenants[id] = entry;
    }
  }
  const out = { version: SECRETS_VERSION };
  const def = trimStr(src.defaultApiKey);
  if (def) out.defaultApiKey = def;
  out.tenants = tenants;
  return out;
}

// ---------------------------------------------------------------- 合并视图

/**
 * 把 config + secrets + persona 文件合并成一个运行时对象。
 * 调用方只跟这个对象打交道，不直接读配置文件。
 *
 * token 缺失是硬错误：没有 token 的租户无法收发消息，宁可明确报错。
 */
export function resolveTenant({ configEntry, secretEntry, personaText, id } = {}) {
  const cfg = isObject(configEntry) ? configEntry : {};
  const sec = isObject(secretEntry) ? secretEntry : {};
  const tid = id ?? cfg.id;
  if (!tid) throw new Error('租户缺少 id');

  const token = trimStr(sec.token);
  if (!token) {
    throw new Error(`租户 ${tid} 缺少 token（secrets.json 中没有该租户的凭据）`);
  }

  return {
    id: tid,
    ownerId: trimStr(cfg.ownerId) || null,
    createdAt: trimStr(cfg.createdAt) || null,
    // 秘密
    token,
    apiKey: trimStr(sec.apiKey) || undefined,
    // 派生
    botId: botIdFromToken(token),
    cwd: tenantWorkspace(tid, cfg),
    root: tenantRoot(tid),
    dshHome: trimStr(cfg.dshHome) || tenantDshHome(tid),
    baseUrl: trimStr(cfg.baseUrl) || DEFAULT_BASE_URL,
    // 有默认值的
    provider: trimStr(cfg.provider) || DEFAULT_PROVIDER,
    model: trimStr(cfg.model) || DEFAULT_MODEL,
    persona: typeof personaText === 'string' ? personaText : '',
    // 预留项（原样透传）
    allowUsers: Array.isArray(cfg.allowUsers) ? cfg.allowUsers : undefined,
    maxChars: Number.isFinite(cfg.maxChars) ? cfg.maxChars : undefined,
    ackDelayMs: Number.isFinite(cfg.ackDelayMs) ? cfg.ackDelayMs : undefined,
    budgetTokensPerDay: Number.isFinite(cfg.budgetTokensPerDay) ? cfg.budgetTokensPerDay : undefined,
    budgetTokensPerMonth: Number.isFinite(cfg.budgetTokensPerMonth) ? cfg.budgetTokensPerMonth : undefined,
  };
}

/**
 * 解析生效的预设 API key。
 *
 * 优先级：
 *   1. secrets.json 里的 defaultApiKey（显式设置的意图，应该赢）
 *   2. 环境变量 BRIDGE_DEFAULT_API_KEY（部署时注入，适合 systemd / 容器）
 *
 * @param {object} secrets
 * @returns {string} 空串表示未配置
 */
export function resolveDefaultApiKey(secrets) {
  const fromFile = trimStr(secrets?.defaultApiKey);
  if (fromFile) return fromFile;
  return (process.env.BRIDGE_DEFAULT_API_KEY ?? '').trim();
}

// ---------------------------------------------------------------- secrets 存储

/** secrets.json 的读写。结构见文件头注释。 */
export class SecretsStore {
  /** @param {string} path */
  constructor(path) {
    this.path = path;
  }

  async read() {
    if (!existsSync(this.path)) return normalizeSecrets(null);
    return normalizeSecrets(parseJson(await readFile(this.path, 'utf8'), this.path));
  }

  /** 原子写入；全空时删除文件，避免留下空壳 */
  async write(secrets) {
    const norm = normalizeSecrets(secrets);
    if (Object.keys(norm.tenants).length === 0 && !norm.defaultApiKey) {
      await rm(this.path, { force: true }).catch(() => {});
      return;
    }
    return atomicWriteJson(this.path, norm);
  }
}

// ---------------------------------------------------------------- 配置存储

export class ConfigStore {
  /**
   * @param {string} path - config.json 路径
   * @param {object} [opts]
   * @param {string} [opts.secretsPath] - 默认同目录 secrets.json（可用 BRIDGE_SECRETS 覆盖）
   */
  constructor(path, opts = {}) {
    this.path = path;
    this.secretsPath = opts.secretsPath
      ?? process.env.BRIDGE_SECRETS
      ?? join(dirname(path), 'secrets.json');
    this.secrets = new SecretsStore(this.secretsPath);
  }

  /**
   * 读配置。文件不存在时返回空租户列表（**不创建文件**）——
   * 首次启动不该留下空配置；有 bot 登录成功才落盘。
   *
   * 只接受 version 2。其他版本直接报错，由用户决定怎么处理，绝不静默改写。
   */
  async read() {
    if (!existsSync(this.path)) return normalizeConfig(null);
    const raw = parseJson(await readFile(this.path, 'utf8'), this.path);

    if (raw?.version !== CONFIG_VERSION) {
      throw new Error(
        `配置版本不兼容：${this.path} 是 v${raw?.version ?? 1}，当前只支持 v${CONFIG_VERSION}。`
        + '请删除该文件后重新 login（凭据在 secrets.json 里，不受影响）。',
      );
    }
    return normalizeConfig(raw);
  }

  /**
   * 原子写入。若配置实质为空（没有租户、也没有未知顶层字段），
   * 则删除文件而不是留下空壳。
   */
  async write(cfg) {
    const norm = normalizeConfig(cfg);
    const extras = Object.keys(norm).filter((k) => k !== 'version' && k !== 'tenants');
    if (norm.tenants.length === 0 && extras.length === 0) {
      await rm(this.path, { force: true }).catch(() => {});
      return;
    }
    return atomicWriteJson(this.path, norm);
  }

  // ---- persona 文件 ----

  /** 读租户 persona；文件不存在返回 '' */
  async readPersona(id) {
    const path = personaPath(id);
    if (!existsSync(path)) return '';
    return readFile(path, 'utf8');
  }

  /** 写租户 persona；空内容删除文件 */
  async writePersona(id, text) {
    const path = personaPath(id);
    const body = typeof text === 'string' ? text.trim() : '';
    if (!body) {
      await rm(path, { force: true }).catch(() => {});
      return null;
    }
    await atomicWriteText(path, body);
    return path;
  }

  // ---- 合并视图 ----

  /**
   * 读出全部租户的合并视图。
   * 缺 token 的租户不抛出，而是放进 failures，让其它租户继续跑。
   *
   * @returns {Promise<{config, secrets, tenants: object[], failures: {id, error, configEntry}[]}>}
   */
  async resolveAll() {
    const config = await this.read();
    const secrets = await this.secrets.read();
    const tenants = [];
    const failures = [];

    for (const entry of config.tenants) {
      try {
        const personaText = await this.readPersona(entry.id);
        tenants.push(
          resolveTenant({
            configEntry: entry,
            secretEntry: secrets.tenants[entry.id],
            personaText,
            id: entry.id,
          }),
        );
      } catch (err) {
        failures.push({ id: entry.id, error: err.message, configEntry: entry });
      }
    }
    return { config, secrets, tenants, failures };
  }

}

// ---------------------------------------------------------------- 新租户构造

/**
 * 构造一个新租户的定义（登录成功后调用）。
 *
 * 返回 { config, secret }：config 写 config.json，secret 写 secrets.json。
 * 抽成纯函数，便于单测「预设 key 继承」这类规则，不必真的扫码。
 *
 * @param {object} login - qrLogin 的返回：{token, baseUrl, botId, ownerId}
 * @param {object} [opts]
 * @param {string} [opts.cwdOverride] - 仅当用户用 login --cwd 指定了非默认路径
 * @param {string} [opts.defaultApiKey] - 预设 key，新租户自动继承
 * @param {string} [opts.provider]
 * @param {string} [opts.model]
 * @param {string} [opts.now]
 * @returns {{config: object, secret: object}}
 */
export function buildTenantDef(login, opts = {}) {
  if (!isObject(login) || !trimStr(login.token)) {
    throw new Error('登录结果缺少 token');
  }
  const id = tenantIdFrom(login.botId ?? login.token);

  const config = { id };
  const ownerId = trimStr(login.ownerId);
  if (ownerId) config.ownerId = ownerId;
  config.createdAt = trimStr(opts.now) || new Date().toISOString();

  // 默认值不写，这样以后改全局默认，已有租户会跟着变
  const provider = trimStr(opts.provider);
  if (provider && provider !== DEFAULT_PROVIDER) config.provider = provider;
  const model = trimStr(opts.model);
  if (model && model !== DEFAULT_MODEL) config.model = model;
  const baseUrl = trimStr(login.baseUrl);
  if (baseUrl && !isDefaultBaseUrl(baseUrl)) config.baseUrl = baseUrl;

  const cwdOverride = trimStr(opts.cwdOverride);
  if (cwdOverride && resolve(cwdOverride) !== resolve(tenantWorkspace(id))) {
    config.cwdOverride = cwdOverride;
  }

  const secret = { token: trimStr(login.token) };
  const preset = trimStr(opts.defaultApiKey);
  if (preset) secret.apiKey = preset;

  return { config, secret };
}
