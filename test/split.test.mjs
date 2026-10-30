#!/usr/bin/env node
/**
 * 分段逻辑单元测试。
 */
import assert from 'node:assert';
import { splitMessage, labelChunks, DEFAULT_MAX_CHARS } from '../src/wechat/split.mjs';

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

check('空字符串返回空数组', () => {
  assert.deepStrictEqual(splitMessage(''), []);
});
check('null 返回空数组', () => {
  assert.deepStrictEqual(splitMessage(null), []);
});
check('短文本原样返回单段', () => {
  const t = '你好';
  assert.deepStrictEqual(splitMessage(t, 1800), [t]);
});
check('刚好等于上限不切', () => {
  const limit = 1800 - 8; // 预留后缀
  const t = 'a'.repeat(limit);
  const r = splitMessage(t, 1800);
  assert.strictEqual(r.length, 1);
});
check('超长文本被切分', () => {
  const t = '字'.repeat(5000);
  const r = splitMessage(t, 1800);
  assert.ok(r.length >= 3, `应>=3段，实际${r.length}`);
  r.forEach((c) => assert.ok(c.length <= 1792 + 1, `段长度 ${c.length} 超限`));
});
check('所有片段拼接后内容不丢失（忽略空白差异）', () => {
  const t = Array.from({ length: 400 }, (_, i) => `第${i}行内容`).join('\n');
  const r = splitMessage(t, 500);
  const joined = r.join('\n');
  const norm = (s) => s.replace(/\s+/g, '');
  assert.strictEqual(norm(joined), norm(t));
});
check('优先在段落边界切分', () => {
  const para = 'A'.repeat(300);
  const t = [para, para, para, para, para].join('\n\n');
  const r = splitMessage(t, 400);
  // 每段应大致是整数个段落
  r.forEach((c) => assert.ok(!c.startsWith('\n'), '段首不应是换行'));
  assert.ok(r.length >= 4);
});
check('优先在句子边界切分', () => {
  const t = '这是一个句子。'.repeat(400);
  const r = splitMessage(t, 300);
  r.forEach((c) => {
    // 除最后一段，其他应大致以句号结尾
    if (c !== r[r.length - 1]) {
      assert.ok(/[。！？；!?;]/.test(c.slice(-2)), `段尾不是句末标点: "${c.slice(-5)}"`);
    }
  });
});
check('无任何分隔符时硬切且不丢内容', () => {
  const t = 'X'.repeat(3000);
  const r = splitMessage(t, 1000);
  assert.strictEqual(r.join(''), t);
});
check('labelChunks 单段不加标记', () => {
  assert.deepStrictEqual(labelChunks(['hello']), ['hello']);
});
check('labelChunks 多段加 (i/n)', () => {
  const r = labelChunks(['a', 'b', 'c']);
  assert.strictEqual(r[0], 'a\n\n(1/3)');
  assert.strictEqual(r[2], 'c\n\n(3/3)');
});
check('带标记后总长仍不超限', () => {
  const t = '句'.repeat(6000);
  const chunks = labelChunks(splitMessage(t, 1800));
  chunks.forEach((c) => assert.ok(c.length <= 1800, `带标记后 ${c.length} 超限`));
});
check('保留 Markdown 代码块内容完整', () => {
  const code = '```js\n' + Array.from({ length: 100 }, (_, i) => `const v${i} = ${i};`).join('\n') + '\n```';
  const r = splitMessage(code, 500);
  assert.strictEqual(r.join('\n').replace(/\s/g, ''), code.replace(/\s/g, ''));
});
check('不产生空段', () => {
  const t = 'a\n\n\n\n' + 'b'.repeat(5000);
  const r = splitMessage(t, 1000);
  r.forEach((c) => assert.ok(c.trim().length > 0, '出现空段'));
});
check('默认上限是 1800', () => {
  assert.strictEqual(DEFAULT_MAX_CHARS, 1800);
});

console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
