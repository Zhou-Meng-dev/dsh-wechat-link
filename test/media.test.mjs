#!/usr/bin/env node
/**
 * 图片下载/解密单元测试（不依赖网络）。
 */
import assert from 'node:assert';
import { createCipheriv, randomBytes } from 'node:crypto';
import {
  parseAesKey,
  buildDownloadUrl,
  decryptAesEcb,
  sniffImageMime,
  detectImageMime,
  CDN_BASE_URL,
  sanitizeFileName,
} from '../src/wechat/media.mjs';

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

// ---- 密钥解析 ----
check('32 字符 hex → 16 字节', () => {
  const hex = '0123456789abcdef0123456789abcdef';
  const k = parseAesKey(hex);
  assert.strictEqual(k.length, 16);
  assert.strictEqual(k.toString('hex'), hex);
});

check('base64(原始16字节) → 16 字节', () => {
  const raw = randomBytes(16);
  const k = parseAesKey(raw.toString('base64'));
  assert.ok(k.equals(raw));
});

check('base64(32字符hex) → 16 字节', () => {
  const hex = 'fedcba9876543210fedcba9876543210';
  const k = parseAesKey(Buffer.from(hex, 'ascii').toString('base64'));
  assert.strictEqual(k.toString('hex'), hex);
});

check('非法密钥返回 null', () => {
  assert.strictEqual(parseAesKey(''), null);
  assert.strictEqual(parseAesKey(null), null);
  assert.strictEqual(parseAesKey('not-a-key'), null);
  assert.strictEqual(parseAesKey(Buffer.from('short').toString('base64')), null);
});

// ---- URL 构造 ----
check('优先使用 full_url', () => {
  const u = buildDownloadUrl({ full_url: 'https://x/y', encrypt_query_param: 'p' });
  assert.strictEqual(u, 'https://x/y');
});

check('无 full_url 时用 encrypt_query_param 拼接', () => {
  const u = buildDownloadUrl({ encrypt_query_param: 'a b&c' });
  assert.ok(u.startsWith(`${CDN_BASE_URL}/download?encrypted_query_param=`));
  assert.ok(u.includes(encodeURIComponent('a b&c')));
});

check('两者都无时返回 null', () => {
  assert.strictEqual(buildDownloadUrl({}), null);
  assert.strictEqual(buildDownloadUrl(null), null);
});

// ---- 加解密往返 ----
check('AES-128-ECB 加解密往返一致', () => {
  const key = randomBytes(16);
  const plain = Buffer.from('假装这是一张JPEG图片的内容'.repeat(10));
  const cipher = createCipheriv('aes-128-ecb', key, null);
  const enc = Buffer.concat([cipher.update(plain), cipher.final()]);
  assert.ok(!enc.equals(plain));
  const dec = decryptAesEcb(enc, key);
  assert.ok(dec.equals(plain));
});

// ---- MIME 嗅探 ----
check('识别 JPEG', () => {
  assert.strictEqual(sniffImageMime(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0])), 'image/jpeg');
});
check('识别 PNG', () => {
  assert.strictEqual(
    sniffImageMime(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])),
    'image/png',
  );
});
check('识别 GIF', () => {
  assert.strictEqual(sniffImageMime(Buffer.from('GIF89a' + '\0'.repeat(6))), 'image/gif');
});
check('识别 WEBP', () => {
  const b = Buffer.alloc(16);
  b.write('RIFF', 0, 'ascii');
  b.write('WEBP', 8, 'ascii');
  assert.strictEqual(sniffImageMime(b), 'image/webp');
});
check('非图片返回 null', () => {
  assert.strictEqual(sniffImageMime(Buffer.from('hello world!!!!')), null);
  assert.strictEqual(sniffImageMime(Buffer.alloc(0)), null);
});


check('detectImageMime 识别 BMP', () => {
  assert.strictEqual(detectImageMime(Buffer.from('BM' + '\0'.repeat(20))), 'image/bmp');
});
check('detectImageMime 识别 TIFF（大小端）', () => {
  assert.strictEqual(detectImageMime(Buffer.from([0x49, 0x49, 0x2a, 0x00, 0, 0, 0, 0])), 'image/tiff');
  assert.strictEqual(detectImageMime(Buffer.from([0x4d, 0x4d, 0x00, 0x2a, 0, 0, 0, 0])), 'image/tiff');
});
check('detectImageMime 识别 HEIC / AVIF', () => {
  const heic = Buffer.alloc(16);
  heic.write('ftyp', 4, 'ascii');
  heic.write('heic', 8, 'ascii');
  assert.strictEqual(detectImageMime(heic), 'image/heic');
  const avif = Buffer.alloc(16);
  avif.write('ftyp', 4, 'ascii');
  avif.write('avif', 8, 'ascii');
  assert.strictEqual(detectImageMime(avif), 'image/avif');
});
check('detectImageMime 对支持的格式与 sniffImageMime 一致', () => {
  assert.strictEqual(detectImageMime(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0])), 'image/jpeg');
  assert.strictEqual(detectImageMime(Buffer.from('hello world!!!!')), null);
});

// ---- 端到端（离线模拟：加密真实 JPEG 头）----
check('模拟：加密的 JPEG 能被解密并识别', () => {
  const key = randomBytes(16);
  // 构造一个最小 JPEG 头 + 填充
  const jpeg = Buffer.concat([
    Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]),
    randomBytes(200),
  ]);
  const cipher = createCipheriv('aes-128-ecb', key, null);
  const enc = Buffer.concat([cipher.update(jpeg), cipher.final()]);
  const dec = decryptAesEcb(enc, key);
  assert.strictEqual(sniffImageMime(dec), 'image/jpeg');
});

// ---- 文件名清洗（防目录穿越）----

check('去掉路径分隔符', () => {
  assert.strictEqual(sanitizeFileName('../../etc/passwd'), 'passwd');
  assert.strictEqual(sanitizeFileName('/etc/shadow'), 'shadow');
  assert.strictEqual(sanitizeFileName('..\\..\\win.ini'), 'win.ini');
});
check('去掉非法字符', () => {
  assert.strictEqual(sanitizeFileName('a<b>c:d"e|f?g*h.txt'), 'a_b_c_d_e_f_g_h.txt');
});
check('去掉控制字符', () => {
  assert.ok(!/[\u0000-\u001f]/.test(sanitizeFileName('a\u0000b\u001fc.txt')));
});
check('空名用回退值', () => {
  assert.strictEqual(sanitizeFileName(''), 'file');       // 默认回退
  assert.strictEqual(sanitizeFileName('...'), 'file');    // 全点号被剥掉
  assert.strictEqual(sanitizeFileName('', 'fallback'), 'fallback'); // 显式回退
  assert.strictEqual(sanitizeFileName(null, 'x'), 'x');
});
check('超长名截断', () => {
  const long = 'a'.repeat(300) + '.txt';
  assert.ok(sanitizeFileName(long).length <= 180);
});
check('正常中文名保留', () => {
  assert.strictEqual(sanitizeFileName('季度报表.xlsx'), '季度报表.xlsx');
});

console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
