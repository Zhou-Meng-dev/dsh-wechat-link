/**
 * 把 quiz.py 写进租户工作区 `_tools/`。
 *
 * quiz.py 负责窗口随机任务的“当前题目 / 分数 / 历史”状态；
 * 内容和仓库模板不一致时覆盖（agent 改坏会在下次启动恢复）。
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { assetFilePath } from '../assets.mjs';

/** 脚本在工作区里的相对路径（agent 的 cwd 就是工作区） */
export const QUIZ_REL = '_tools/quiz.py';

/**
 * @param {string} workspace
 * @returns {Promise<string>} 脚本绝对路径
 */
export async function ensureQuizTool(workspace) {
  const dir = join(workspace, '_tools');
  await mkdir(dir, { recursive: true });
  const dest = join(dir, 'quiz.py');
  const template = await readFile(await assetFilePath('src/tasks/quiz.py'), 'utf8');
  const current = await readFile(dest, 'utf8').catch(() => null);
  if (current !== template) {
    await writeFile(dest, template, { mode: 0o644 });
  }
  return dest;
}
