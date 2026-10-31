/**
 * 测试 harness（轻量版）：与 `node:test` 并存。
 *
 * 新测试优先用 `node:test`；`test/*.test.mjs` 里沿用的 `check()` 风格统一由这里提供，
 * 避免每个文件复制一份「计数 + ✅/❌ + 汇总退出」的实现。
 */

export function createChecker() {
  let pass = 0;
  let fail = 0;

  async function check(desc, fn) {
    try {
      await fn();
      console.log(`✅ ${desc}`);
      pass++;
    } catch (err) {
      console.log(`❌ ${desc}\n   ${err.message}`);
      fail++;
    }
  }

  /** 打印汇总并按 0/1 退出，与原来每个文件末尾的写法一致。 */
  function done() {
    console.log(`\n${pass} 通过 / ${fail} 失败`);
    process.exit(fail === 0 ? 0 : 1);
  }

  return { check, done };
}
