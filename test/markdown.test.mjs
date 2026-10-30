#!/usr/bin/env node
/**
 * Markdown → 微信纯文本转换，以及大代码块/大表格识别。
 */
import assert from 'node:assert';

import {
  markdownToPlainText,
  findOversizeBlock,
  DEFAULT_LARGE_BLOCK_CHARS,
} from '../src/wechat/markdown.mjs';

let pass = 0;
let fail = 0;
function check(desc, fn) {
  try {
    fn();
    console.log(`✅ ${desc}`);
    pass++;
  } catch (err) {
    console.log(`❌ ${desc}\n   ${err.message}`);
    fail++;
  }
}

check('标题去掉 #，一二级用【】突出', () => {
  assert.strictEqual(
    markdownToPlainText('# 大标题\n## 二级标题\n### 三级标题\n#### 四级'),
    '【大标题】\n【二级标题】\n三级标题\n四级',
  );
});

check('加粗/斜体/删除线/行内代码去掉标记', () => {
  assert.strictEqual(
    markdownToPlainText('这是 **加粗**、*斜体*、~~删除~~ 和 `代码`。'),
    '这是 加粗、斜体、删除 和 代码。',
  );
  assert.strictEqual(markdownToPlainText('__加粗__ 和 _斜体_'), '加粗 和 斜体');
});

check('链接转成「文字 (URL)」', () => {
  assert.strictEqual(
    markdownToPlainText('详见 [官方文档](https://example.com/a?b=1)。'),
    '详见 官方文档 (https://example.com/a?b=1)。',
  );
});

check('图片转成「[图片：说明] URL」', () => {
  assert.strictEqual(
    markdownToPlainText('![架构图](docs/arch.png)'),
    '[图片：架构图] docs/arch.png',
  );
  assert.strictEqual(markdownToPlainText('![](a.png)'), '[图片] a.png');
});

check('代码围栏去掉，内容原样保留（不再解析内部 Markdown）', () => {
  const src = [
    '说明：',
    '```js',
    'const x = "**不是加粗**";',
    '// # 不是标题 [不是链接](x)',
    '```',
    '结束',
  ].join('\n');
  assert.strictEqual(
    markdownToPlainText(src),
    '说明：\nconst x = "**不是加粗**";\n// # 不是标题 [不是链接](x)\n结束',
  );
});

check('表格去掉分隔行，按「列 | 列」逐行展开', () => {
  const src = [
    '| 名称 | 数量 |',
    '| --- | ---: |',
    '| 苹果 | 3 |',
    '| **香蕉** | 5 |',
  ].join('\n');
  assert.strictEqual(
    markdownToPlainText(src),
    '名称 | 数量\n苹果 | 3\n香蕉 | 5',
  );
});

check('表格里的管道与前后空格被清理', () => {
  assert.strictEqual(
    markdownToPlainText('|a|b|\n|-|-|\n|1|2|'),
    'a | b\n1 | 2',
  );
});

check('引用、无序列表与有序列表', () => {
  assert.strictEqual(
    markdownToPlainText('> 一句引用\n- 项目一\n* 项目二\n1. 第一\n2) 第二'),
    '一句引用\n• 项目一\n• 项目二\n1. 第一\n2. 第二',
  );
});

check('分割线被移除，多余空行折叠', () => {
  assert.strictEqual(
    markdownToPlainText('上文\n\n\n---\n\n\n下文'),
    '上文\n\n下文',
  );
});

check('HTML 标签被清理，<br> 变换行', () => {
  assert.strictEqual(
    markdownToPlainText('<b>粗体</b><br>下一行'),
    '粗体\n下一行',
  );
});

check('普通文本原样返回（幂等）', () => {
  const plain = '这是一段普通文字，包含 3.14 和 a_b_c，没有格式。';
  assert.strictEqual(markdownToPlainText(plain), plain);
});

check('snake_case 不会被当成斜体', () => {
  assert.strictEqual(
    markdownToPlainText('变量 snake_case_name 保持不变'),
    '变量 snake_case_name 保持不变',
  );
});

check('媒体指令原样保留（调用方会先提取它们）', () => {
  assert.strictEqual(
    markdownToPlainText('[[image: a.png]]\n[[file: b.md]]'),
    '[[image: a.png]]\n[[file: b.md]]',
  );
});

check('空输入返回空串', () => {
  assert.strictEqual(markdownToPlainText(''), '');
  assert.strictEqual(markdownToPlainText(null), '');
});

check('反斜杠转义被还原', () => {
  assert.strictEqual(markdownToPlainText('字面量 \\*星号\\*'), '字面量 *星号*');
});

check('大代码块能被识别', () => {
  assert.strictEqual(DEFAULT_LARGE_BLOCK_CHARS, 1500);
  const code = '```js\n' + 'const x = 1;\n'.repeat(200) + '```';
  const block = findOversizeBlock(code);
  assert.ok(block, '应识别到大代码块');
  assert.strictEqual(block.kind, 'code');
  assert.ok(block.chars > DEFAULT_LARGE_BLOCK_CHARS);
});

check('小代码块不触发', () => {
  assert.strictEqual(findOversizeBlock('```js\nconsole.log(1)\n```'), null);
});

check('大表格能被识别', () => {
  const rows = Array.from({ length: 200 }, (_, i) => `| 行${i} | 值${i} |`);
  const table = ['| 名称 | 值 |', '| --- | --- |', ...rows].join('\n');
  const block = findOversizeBlock(table);
  assert.ok(block);
  assert.strictEqual(block.kind, 'table');
  assert.strictEqual(block.lines, 201);
});

check('代码块里的 | 不会被当成表格', () => {
  const src = '```\n' + 'a | b\n'.repeat(400) + '```';
  const block = findOversizeBlock(src);
  assert.strictEqual(block.kind, 'code');
});

check('未闭合代码块也按大块处理', () => {
  const block = findOversizeBlock('```\n' + 'x'.repeat(2000));
  assert.ok(block);
  assert.strictEqual(block.kind, 'code');
});

console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
