/**
 * CLI 版本号。
 *
 * 单文件（Node SEA）里没有 package.json 可读，所以版本在这里单独维护；
 * test/cli.test.mjs 会断言它与 package.json 的 version 一致，防止漂移。
 */
export const VERSION = '0.1.1';
