/**
 * 启动前依赖检查。
 *
 * 桥接进程本身只依赖 Node；但完整功能还依赖：
 *   - dsh        —— 必需，桥接会 spawn `dsh --profile sdk`
 *   - python3    —— 任务/文件探测脚本（taskctl.py / doc_probe.py）
 *   - Pillow     —— 入站大图压缩、bmp/tiff/heic 转码（可选，缺失则降级）
 *   - pdftotext  —— PDF 文本提取（可选，缺失则 PDF 只能报页数）
 *   - pdftoppm / tesseract —— 扫描版 PDF OCR（可选，缺失则明确降级）
 *   - matplotlib / graphviz / qrencode —— agent 生成图表、流程图、二维码（可选）
 *   - bwrap      —— 默认沙箱模式（BRIDGE_DSH_MODE=container 或 DSH_SANDBOX=0 除外）
 *
 * 设计成可注入 exec/paths，便于测试；服务启动前调用 assertPreflight()。
 */

import { spawnSync } from 'node:child_process';
import { constants, existsSync } from 'node:fs';
import { access, mkdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import { configDir, sandboxRoot, workspacesRoot } from '../config.mjs';
import { assetFilePath, isSeaRuntime } from '../assets.mjs';
import { sandboxMode } from '../sandbox/sandbox-env.mjs';

const REQUIRED_NODE_MAJOR = 22;
/** sdk profile 需要的最低 dsh 版本；低于此版本 spawn 会失败。 */
const MIN_DSH_VERSION = [0, 2, 0];

/** 默认执行器。返回 { ok, stdout, stderr, error }，不抛异常。 */
function defaultExec(command, args, env) {
  const res = spawnSync(command, args, {
    encoding: 'utf8',
    timeout: 10_000,
    env,
  });
  return {
    ok: !res.error && res.status === 0,
    stdout: (res.stdout ?? '').trim(),
    stderr: (res.stderr ?? '').trim(),
    error: res.error,
  };
}

function push(checks, status, name, detail, required = false) {
  checks.push({ status, name, detail, required });
}

/** 从 `dsh --version` 的输出里抠出版本；解析不了返回 null。 */
function parseDshVersion(text) {
  const m = /(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(String(text ?? ''));
  if (!m) return null;
  return {
    core: [Number(m[1]), Number(m[2]), Number(m[3])],
    raw: m[0],
  };
}

/** 只比较 core：sdk profile 从 0.2.0 起提供，0.2.0-rc 也按 0.2.0 计。 */
function meetsMinVersion(version, minCore) {
  for (let i = 0; i < minCore.length; i += 1) {
    if (version.core[i] !== minCore[i]) return version.core[i] > minCore[i];
  }
  return true;
}

/** secrets.json 里是否有可直接继承的 defaultApiKey。 */
async function hasDefaultApiKey(file) {
  try {
    const raw = JSON.parse(await readFile(file, 'utf8'));
    return Boolean(String(raw?.defaultApiKey ?? '').trim());
  } catch {
    return false;
  }
}

/**
 * 检查目录可写。
 * readOnly=true 时不创建目录：已存在的目录检查 W_OK，不存在的目录检查最近的
 * 已存在父目录是否可写，并标注“将创建”。
 */
async function checkDir(checks, name, dir, readOnly = false) {
  try {
    const current = await stat(dir).catch(() => null);
    if (current?.isDirectory()) {
      await access(dir, constants.W_OK);
      push(checks, 'ok', name, dir, true);
      return true;
    }
    if (current) throw new Error('已存在但不是目录');

    if (readOnly) {
      let parent = dirname(dir);
      for (;;) {
        const pst = await stat(parent).catch(() => null);
        if (pst) {
          if (!pst.isDirectory()) throw new Error(`${parent} 不是目录`);
          await access(parent, constants.W_OK);
          push(checks, 'ok', name, `${dir}（将创建）`, true);
          return true;
        }
        const next = dirname(parent);
        if (next === parent) throw new Error('找不到可写父目录');
        parent = next;
      }
    }

    await mkdir(dir, { recursive: true, mode: 0o700 });
    await access(dir, constants.W_OK);
    push(checks, 'ok', name, dir, true);
    return true;
  } catch (err) {
    push(checks, 'fail', name, `${dir}: ${err.message}`, true);
    return false;
  }
}

/**
 * @param {object} [opts]
 * @param {NodeJS.ProcessEnv} [opts.env]
 * @param {string} [opts.nodeVersion] - 测试注入
 * @param {(cmd: string, args: string[], env: object) => {ok:boolean,stdout:string,stderr:string,error?:Error}} [opts.exec]
 * @param {{configDir?:string, sandboxRoot?:string, workspacesRoot?:string, credentialsFile?:string, secretsFile?:string}} [opts.paths]
 * @param {boolean} [opts.readOnly] - 只检查，不创建目录（doctor --check）
 * @param {Error} [opts.sandboxError] - 沙箱工具链解析失败（doctor 用）
 * @returns {Promise<{ok:boolean, checks:object[], failures:object[], warnings:object[]}>}
 */
export async function runPreflight(opts = {}) {
  const env = opts.env ?? process.env;
  const exec = opts.exec ?? defaultExec;
  const readOnly = opts.readOnly === true;
  const paths = {
    configDir: opts.paths?.configDir ?? configDir(),
    sandboxRoot: opts.paths?.sandboxRoot ?? sandboxRoot(),
    workspacesRoot: opts.paths?.workspacesRoot ?? workspacesRoot(),
  };
  // 宿主 DSH_HOME / HOME 可能被覆盖；优先用调用方传入的环境
  const dshHome = String(env.DSH_HOME ?? '').trim()
    || join(String(env.HOME ?? '').trim() || homedir(), '.dsh');
  const credentialsFile = opts.paths?.credentialsFile ?? join(dshHome, '.credentials.yaml');
  const secretsFile = opts.paths?.secretsFile
    ?? (String(env.BRIDGE_SECRETS ?? '').trim() || join(paths.configDir, 'secrets.json'));
  const nodeVersion = opts.nodeVersion ?? process.versions.node;
  const checks = [];

  // Node
  const nodeMajor = Number(String(nodeVersion).split('.')[0]);
  push(
    checks,
    nodeMajor >= REQUIRED_NODE_MAJOR ? 'ok' : 'fail',
    'Node.js',
    `v${nodeVersion}（需要 >= ${REQUIRED_NODE_MAJOR}）`,
    true,
  );

  // DSH
  const minDsh = MIN_DSH_VERSION.join('.');
  const sandboxNode = String(env.WECHAT_NODE_BIN ?? '').trim();
  const dshJs = String(env.WECHAT_DSH_JS ?? env.DSH_JS_PATH ?? '').trim();
  const sea = opts.isSea ?? await isSeaRuntime();
  let dshOk = false;
  let dshOutput = '';
  let dshDetail = '';
  if (sandboxNode && dshJs) {
    // 默认沙箱已解析出宿主 node + dsh bin.js；SEA 下也走这条
    const r = exec(sandboxNode, [dshJs, '--version'], env);
    dshOk = r.ok;
    dshOutput = `${r.stdout} ${r.stderr}`.trim();
    dshDetail = r.ok
      ? `${r.stdout || '(无版本输出)'}（WECHAT_DSH_JS=${dshJs}）`
      : `无法运行 ${dshJs}: ${r.stderr || r.error?.message || '未知错误'}`;
  } else if (dshJs && !sea) {
    // 源码运行时 process.execPath 是 node，可以直接执行 dsh 的 bin.js
    const r = exec(process.execPath, [dshJs, '--version'], env);
    dshOk = r.ok;
    // 有的 CLI 把版本打到 stderr；解析时两边都看，展示仍用 stdout
    dshOutput = `${r.stdout} ${r.stderr}`.trim();
    dshDetail = r.ok
      ? `${r.stdout || '(无版本输出)'}（DSH_JS_PATH=${dshJs}）`
      : `无法运行 ${dshJs}: ${r.stderr || r.error?.message || '未知错误'}`;
  } else {
    // SEA 单文件的 process.execPath 是桥接自己，不能再拿来跑 dsh/bin.js
    const r = exec('dsh', ['--version'], env);
    const suffix = dshJs && sea ? '（SEA 单文件忽略 DSH_JS_PATH，需要 PATH 里有 dsh）' : '';
    dshOk = r.ok;
    dshOutput = `${r.stdout} ${r.stderr}`.trim();
    dshDetail = r.ok
      ? `${r.stdout || '(无版本输出)'}${suffix}`
      : `PATH 里找不到 dsh（安装 @deepseek-ai/dsh${sea ? '' : '，或设置 DSH_JS_PATH'}）`;
  }
  push(checks, dshOk ? 'ok' : 'fail', 'DSH', dshDetail, true);

  // sdk profile 对版本有硬要求：低版本能跑 --version，但 spawn 会话会失败
  if (dshOk) {
    const version = parseDshVersion(dshOutput);
    if (!version) {
      push(checks, 'warn', 'DSH 版本', `无法解析版本输出：${dshOutput || '(空)'}（需要 >= ${minDsh}）`, false);
    } else {
      const versionOk = meetsMinVersion(version, MIN_DSH_VERSION);
      push(
        checks,
        versionOk ? 'ok' : 'fail',
        'DSH 版本',
        `v${version.raw}（需要 >= ${minDsh}）`,
        !versionOk,
      );
    }
  }

  // 宿主 DSH 凭据（没有 key 时启动会进 setup 或回退租户 key）
  let credentialDetail = '';
  if (await hasDefaultApiKey(secretsFile)) {
    credentialDetail = `${secretsFile} 中有 defaultApiKey`;
  } else if (String(env.BRIDGE_DEFAULT_API_KEY ?? '').trim()) {
    credentialDetail = '环境变量 BRIDGE_DEFAULT_API_KEY';
  } else if (existsSync(credentialsFile)) {
    credentialDetail = credentialsFile;
  }
  push(
    checks,
    credentialDetail ? 'ok' : 'warn',
    'DSH 凭据',
    credentialDetail || `未找到 ${credentialsFile}；启动时可填 API key，或设置 BRIDGE_DEFAULT_API_KEY`,
    false,
  );

  // Python（任务/文件探测）
  const py = exec('python3', ['--version'], env);
  const pyOk = py.ok && /Python\s+3\./i.test(`${py.stdout} ${py.stderr}`);
  push(
    checks,
    pyOk ? 'ok' : 'warn',
    'Python 3',
    pyOk
      ? `${(py.stdout || py.stderr).replace(/^Python\s+/i, '')}`
      : '未找到 python3：定时任务/文件探测不可用',
    false,
  );

  // Pillow（可选）
  if (pyOk) {
    const pil = exec('python3', ['-c', 'import PIL; print(PIL.__version__)'], env);
    push(
      checks,
      pil.ok ? 'ok' : 'warn',
      'Pillow',
      pil.ok
        ? pil.stdout
        : '未安装 Pillow：大图压缩、bmp/tiff/heic 转码不可用（apt install python3-pil）',
      false,
    );
  } else {
    push(checks, 'warn', 'Pillow', '跳过（没有 python3）', false);
  }

  // pdftotext（可选）
  const pdf = exec('pdftotext', ['-v'], env);
  push(
    checks,
    pdf.ok ? 'ok' : 'warn',
    'pdftotext',
    pdf.ok
      ? (pdf.stderr.split('\n')[0] || '已安装')
      : '未安装 poppler-utils：PDF 只能报页数，无法提取文本',
    false,
  );

  // 扫描版 PDF OCR（可选）：pdftoppm 渲染 + tesseract 识别
  const pdftoppm = exec('pdftoppm', ['-v'], env);
  push(
    checks,
    pdftoppm.ok ? 'ok' : 'warn',
    'pdftoppm',
    pdftoppm.ok
      ? ((pdftoppm.stderr || pdftoppm.stdout).split('\n')[0] || '已安装')
      : '未安装 poppler-utils：扫描版 PDF 无法 OCR',
    false,
  );
  const tesseract = exec('tesseract', ['--version'], env);
  push(
    checks,
    tesseract.ok ? 'ok' : 'warn',
    'tesseract',
    tesseract.ok
      ? ((tesseract.stdout || tesseract.stderr).split('\n')[0] || '已安装')
      : '未安装 tesseract：扫描版 PDF 无法 OCR（apt install tesseract-ocr tesseract-ocr-chi-sim）',
    false,
  );

  // 媒体工具链（可选）：agent 生成图表 / 流程图 / 二维码
  const matplotlib = pyOk
    ? exec('python3', ['-c', 'import matplotlib; print(matplotlib.__version__)'], env)
    : null;
  push(
    checks,
    matplotlib?.ok ? 'ok' : 'warn',
    'matplotlib',
    matplotlib?.ok
      ? matplotlib.stdout
      : (pyOk
        ? '未安装 matplotlib：agent 无法生成图表（apt install python3-matplotlib）'
        : '跳过（没有 python3）'),
    false,
  );
  const graphviz = exec('dot', ['-V'], env);
  push(
    checks,
    graphviz.ok ? 'ok' : 'warn',
    'graphviz',
    graphviz.ok
      ? ((graphviz.stderr || graphviz.stdout).split('\n')[0] || '已安装')
      : '未安装 graphviz：agent 无法生成流程图（apt install graphviz）',
    false,
  );
  const qrencode = exec('qrencode', ['-V'], env);
  push(
    checks,
    qrencode.ok ? 'ok' : 'warn',
    'qrencode',
    qrencode.ok
      ? ((qrencode.stdout || qrencode.stderr).split('\n')[0] || '已安装')
      : '未安装 qrencode：agent 无法生成二维码（apt install qrencode）',
    false,
  );

  // 沙箱工具链解析失败（doctor 传入；serve 会在 preflight 前直接退出）
  if (opts.sandboxError) {
    push(
      checks,
      'fail',
      '沙箱工具链',
      opts.sandboxError.message ?? String(opts.sandboxError),
      true,
    );
  }

  // bwrap（默认裸机沙箱模式必需）
  const mode = sandboxMode(env);
  if (mode === 'bwrap') {
    const bwrap = exec(env.BWRAP_BIN || 'bwrap', ['--version'], env);
    push(
      checks,
      bwrap.ok ? 'ok' : 'fail',
      'bubblewrap',
      bwrap.ok
        ? (bwrap.stdout || '已安装')
        : '默认沙箱模式但找不到 bwrap（apt install bubblewrap；确认不需要可设 DSH_SANDBOX=0）',
      true,
    );
  } else {
    push(
      checks,
      'ok',
      'bubblewrap',
      mode === 'container' ? '容器模式不需要' : '已显式关闭（DSH_SANDBOX=0）',
      false,
    );
  }

  // 内置资源（单文件模式下验证 SEA assets 是否完整）
  const assets = ['examples/persona.md', 'src/tasks/taskctl.py', 'src/agent/doc-probe.py'];
  for (const name of assets) {
    try {
      const p = await assetFilePath(name);
      const body = await readFile(p);
      push(checks, body.length > 0 ? 'ok' : 'fail', `资源 ${name}`, body.length > 0 ? `${body.length} 字节` : '内容为空', true);
    } catch (err) {
      push(checks, 'fail', `资源 ${name}`, err.message, true);
    }
  }

  // 可写目录
  await checkDir(checks, '配置目录', paths.configDir, readOnly);
  await checkDir(checks, '租户数据根', paths.sandboxRoot, readOnly);
  await checkDir(checks, '工作区根', paths.workspacesRoot, readOnly);

  const failures = checks.filter((c) => c.status === 'fail');
  const warnings = checks.filter((c) => c.status === 'warn');
  return { ok: failures.length === 0, checks, failures, warnings };
}

/** 渲染成人类可读的多行报告。 */
export function formatPreflight(result) {
  const icon = { ok: '✅', warn: '⚠️', fail: '❌' };
  const lines = ['🔍 启动前依赖检查'];
  for (const c of result.checks) {
    lines.push(`  ${icon[c.status] ?? '•'} ${c.name}: ${c.detail}`);
  }
  if (result.ok) {
    lines.push(`\n依赖检查通过${result.warnings.length ? `（${result.warnings.length} 个可选项缺失）` : ''}。`);
  } else {
    lines.push(`\n❌ 缺少 ${result.failures.length} 个必需依赖，启动中止。`);
  }
  return lines.join('\n');
}

/**
 * 服务启动前调用：必需依赖缺失时打印报告并退出。
 * @returns {Promise<void>}
 */
export async function assertPreflight() {
  const result = await runPreflight();
  if (!result.ok) {
    console.error(formatPreflight(result));
    process.exit(1);
  }
  for (const w of result.warnings) {
    console.error(`⚠️ ${w.name}: ${w.detail}`);
  }
  return result;
}
