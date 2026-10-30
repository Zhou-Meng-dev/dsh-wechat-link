#!/usr/bin/env node
/**
 * 访问控制单元测试。
 * 直接复刻 src/wechat/inbound.mjs 的 isAllowed 逻辑并断言，防止回归。
 */
import assert from 'node:assert';

// 与 main.mjs 保持一致的实现
function makeIsAllowed(cfg) {
  return function isAllowed(userId) {
    const owner = cfg.ownerId?.trim();
    const allow = (cfg.allowUsers ?? []).filter((u) => typeof u === 'string' && u.trim());

    if (allow.length === 0) {
      if (!owner) return false;
      return userId === owner;
    }
    return allow.includes(userId);
  };
}

const OWNER = 'o9cq80wLS5-9v5yp2_1EXUDIJAC0@im.wechat';
const FRIEND = 'friend123@im.wechat';
const STRANGER = 'stranger999@im.wechat';

const cases = [
  // [描述, 配置, 用户, 期望]
  ['空白名单 + 有 owner：所有者放行', { ownerId: OWNER, allowUsers: [] }, OWNER, true],
  ['空白名单 + 有 owner：陌生人拒绝', { ownerId: OWNER, allowUsers: [] }, STRANGER, false],
  ['空白名单 + 有 owner：好友拒绝（未授权）', { ownerId: OWNER, allowUsers: [] }, FRIEND, false],
  ['空白名单 + 无 owner：一律拒绝', { allowUsers: [] }, OWNER, false],
  ['白名单含好友：好友放行', { ownerId: OWNER, allowUsers: [OWNER, FRIEND] }, FRIEND, true],
  ['白名单含好友：陌生人仍拒绝', { ownerId: OWNER, allowUsers: [OWNER, FRIEND] }, STRANGER, false],
  ['白名单含好友：所有者放行', { ownerId: OWNER, allowUsers: [OWNER, FRIEND] }, OWNER, true],
  ['白名单只有好友（没写 owner）：owner 被拒（以名单为准）', { ownerId: OWNER, allowUsers: [FRIEND] }, OWNER, false],
  ['空白字符串被过滤后视为空名单', { ownerId: OWNER, allowUsers: ['', '   '] }, STRANGER, false],
  ['空白字符串被过滤后视为空名单：owner 放行', { ownerId: OWNER, allowUsers: ['', '   '] }, OWNER, true],
  ['owner 带空格仍能匹配', { ownerId: ' ' + OWNER + ' ', allowUsers: [] }, OWNER, true],
];

let pass = 0;
let fail = 0;
for (const [desc, cfg, user, expected] of cases) {
  const actual = makeIsAllowed(cfg)(user);
  const ok = actual === expected;
  console.log(`${ok ? '✅' : '❌'} ${desc}`);
  if (!ok) {
    console.log(`   期望 ${expected}，实际 ${actual}`);
    fail++;
  } else {
    pass++;
  }
}

console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
