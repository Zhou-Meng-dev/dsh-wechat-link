/**
 * 治理回归测试：锁住"文档/部署配置不漂移"的最低要求。
 *
 * 这些断言不测业务逻辑，只测仓库自身的约定：
 *   - systemd 模板不硬编码个人绝对路径，只用占位符
 *   - 仓库文档里的相对链接都真实存在
 *   - npm 包不包含本地开发文档 docs/
 *
 * 失败时先看 GOVERNANCE.md 的「事实来源」与「文档治理」。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

test('systemd 模板：只用占位符，不硬编码个人绝对路径', async () => {
  const unit = await readFile(join(ROOT, 'deploy/dsh-wechat-link.service'), 'utf8');

  assert.match(unit, /^WorkingDirectory=@REPO@$/m);
  assert.match(unit, /^ExecStart=@REPO@\/sandbox\.sh$/m);
  assert.match(unit, /^EnvironmentFile=-@BRIDGE_HOME@\/env$/m);
  assert.doesNotMatch(unit, /\/home\/[A-Za-z0-9._-]+/);
});

test('install.sh 只委托 doctor，不复制依赖检查清单', async () => {
  const sh = await readFile(join(ROOT, 'install.sh'), 'utf8');

  assert.match(sh, /node src\/main\.mjs "\$\{args\[@\]\}"/);
  // 一旦这里出现 dsh/python/Pillow 的检查，就说明又分叉出了第二份清单
  assert.doesNotMatch(sh, /command -v dsh|pdftotext|Pillow/);
});

test('仓库文档里的相对链接都指向真实文件', async () => {
  const docs = ['README.md', 'CONTRIBUTING.md', 'GOVERNANCE.md', 'SECURITY.md', 'CHANGELOG.md'];
  const missing = [];

  for (const doc of docs) {
    const text = await readFile(join(ROOT, doc), 'utf8');
    for (const match of text.matchAll(/\]\(([^)\s]+)\)/g)) {
      const target = match[1];
      if (/^[a-z]+:/i.test(target) || target.startsWith('#')) continue; // 外链 / 锚点
      const clean = target.split('#')[0];
      if (!clean) continue;
      try {
        await access(join(ROOT, clean));
      } catch {
        missing.push(`${doc} → ${target}`);
      }
    }
  }

  assert.deepEqual(missing, [], `以下相对链接不存在:\n${missing.join('\n')}`);
});

test('npm 包不包含本地开发文档', async () => {
  const pkg = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'));
  assert.ok(Array.isArray(pkg.files));
  assert.ok(!pkg.files.includes('docs/'), 'docs/ 是本地开发文档，不应打进 npm 包');
});
