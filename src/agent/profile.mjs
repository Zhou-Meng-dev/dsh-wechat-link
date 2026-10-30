/**
 * 租户 profile 管理：persona、skills、插件的落盘位置与生成逻辑。
 *
 * 每个租户有独立的 DSH_HOME（<tenantRoot>/dsh-home），因此：
 *   - skills  → <dshHome>/skills/            （DSH 的用户级技能扫描根）
 *   - plugins → <dshHome>/profiles/sdk/package.json 的 dependencies
 *   - persona → <tenantRoot>/persona.md      （原文，CLI 编辑）
 *               <tenantRoot>/persona.patch.yml（据此生成，dsh --patch 叠加）
 *
 * persona 单独成文件而不是写进 profiles/sdk/cordis.patch.yml，
 * 是为了不覆盖用户自己在那里的插件配置。
 */

import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { tenantRoot, tenantDshHome } from '../config.mjs';

/** 租户技能目录 */
export function tenantSkillsDir(id) {
  return join(tenantDshHome(id), 'skills');
}

/** persona patch 文件路径 */
export function personaPatchPath(id) {
  return join(tenantRoot(id), 'persona.patch.yml');
}

/**
 * 建立租户必需目录，并在首次创建时放入凭据。
 * @param {object} opts
 * @param {string} opts.id
 * @param {string} [opts.credSource] - 宿主凭据文件路径
 */
export async function ensureTenantLayout({ id, credSource }) {
  const root = tenantRoot(id);
  const dshHome = tenantDshHome(id);
  const skills = tenantSkillsDir(id);

  await mkdir(root, { recursive: true });
  await mkdir(dshHome, { recursive: true });
  await mkdir(skills, { recursive: true });
  await mkdir(join(dshHome, 'profiles', 'sdk'), { recursive: true });

  const credDst = join(dshHome, '.credentials.yaml');
  if (credSource && existsSync(credSource) && !existsSync(credDst)) {
    const { copyFile, chmod } = await import('node:fs/promises');
    await copyFile(credSource, credDst);
    await chmod(credDst, 0o600);
  }
  return { root, dshHome, skills };
}

/**
 * 把 persona 写成 dsh 的 patch 叠加文件。
 * persona 为空时删除该文件并返回 null。
 *
 * @param {string} path  - persona.patch.yml 的绝对路径
 * @param {string} persona
 * @returns {Promise<string|null>} 写入的路径，或 null（表示无需 patch）
 */
export async function writePersonaPatch(path, persona, systemSuffix = '') {
  const prefix = (persona ?? '').trim();
  const suffix = (systemSuffix ?? '').trim();

  if (!prefix && !suffix) {
    const { rm } = await import('node:fs/promises');
    await rm(path, { force: true }).catch(() => {});
    return null;
  }

  // YAML 块标量，逐行缩进（位于 `xxx: |` 之下）
  const block = (text) =>
    text
      .split('\n')
      .map((line) => (line.length ? `      ${line}` : ''))
      .join('\n');

  // 当前 DSH 版本使用的字段是 personaPrefix / personaSuffix（其他字段会被 schema 忽略）。
  //   personaPrefix — 顺序 0，第一方指导之前，放角色/语气（用户可改）
  //   personaSuffix — 顺序 10200，第一方指导之后，放运维能力说明（桥接注入）
  let yaml = `# 由 dsh-wechat-link 根据租户配置生成，请勿手改
# 修改租户 persona 请用: node src/main.mjs persona <id> --set "..."
`;
  if (prefix || suffix) {
    yaml += `- id: system-prompt
  config:
`;
    if (prefix) yaml += `    personaPrefix: |\n${block(prefix)}\n`;
    if (suffix) yaml += `    personaSuffix: |\n${block(suffix)}\n`;
  }

  // sdk profile 不含时钟。模型要理解"明天 12:30""每周五"必须先知道今天几号，
  // 所以把 time-context 插进来（每条符合条件的步骤注入当前时间与时区）。
  yaml += `# 注入时钟：让模型知道"现在几点"，否则无法把"明天/每周五"换算成日期
- insert:
    - id: time-context
      name: '@deepseek-ai/dsh-time-context'
      config:
        refreshIntervalMs: 0
`;

  await writeFile(path, yaml, { mode: 0o600 });
  return path;
}

/**
 * 列出某个租户的技能（目录名）。
 * @param {string} skillsDir
 * @returns {Promise<string[]>}
 */
export async function listSkills(skillsDir) {
  const { readdir } = await import('node:fs/promises');
  if (!existsSync(skillsDir)) return [];
  const entries = await readdir(skillsDir, { withFileTypes: true }).catch(() => []);
  return entries.filter((e) => e.isDirectory() || e.isFile()).map((e) => e.name);
}

/**
 * 读取租户 profile 里已安装的插件（dependencies 键）。
 * @param {string} dshHome
 * @returns {Promise<Record<string,string>>}
 */
export async function listPlugins(dshHome) {
  const pkgPath = join(dshHome, 'profiles', 'sdk', 'package.json');
  if (!existsSync(pkgPath)) return {};
  try {
    const pkg = JSON.parse(await readFile(pkgPath, 'utf8'));
    return pkg.dependencies ?? {};
  } catch {
    return {};
  }
}
