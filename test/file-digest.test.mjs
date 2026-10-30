#!/usr/bin/env node
/**
 * 文件接收策略：类型/体积展示、注入文案、doc_probe.py 的落盘与解析行为。
 *
 * 依赖 python3（探测脚本本身就是 Python）；没有则跳过脚本级断言。
 */
import assert from 'node:assert';
import { mkdtemp, mkdir, readFile, stat, writeFile, rm, chmod, symlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

import { ensureDocProbe, formatFileNote, fileKind, formatBytes } from '../src/agent/file-digest.mjs';

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

const root = await mkdtemp(join(tmpdir(), 'file-digest-'));
const ws = join(root, 'ws');

// ---------------------------------------------------------------- 纯函数

await check('fileKind 识别常见类型', () => {
  assert.strictEqual(fileKind('a.pdf'), 'PDF');
  assert.strictEqual(fileKind('B.XLSX'), 'Excel');
  assert.strictEqual(fileKind('c.docx'), 'Word');
  assert.strictEqual(fileKind('d.csv'), 'CSV');
  assert.strictEqual(fileKind('noext'), '文件');
});

await check('formatBytes 人类可读', () => {
  assert.strictEqual(formatBytes(512), '512B');
  assert.strictEqual(formatBytes(2048), '2.0KB');
  assert.strictEqual(formatBytes(2.5 * 1024 * 1024), '2.5MB');
});

await check('文件说明包含路径/类型/大小，选项交给 --help', () => {
  const note = formatFileNote([
    { ok: true, path: '/w/_inbox/a.pdf', name: 'a.pdf', bytes: 2411724 },
    { ok: true, path: '/w/_inbox/b.xlsx', name: 'b.xlsx', bytes: 122880 },
  ]);
  assert.ok(note.includes('/w/_inbox/a.pdf（a.pdf，PDF，2.3MB）'));
  assert.ok(note.includes('/w/_inbox/b.xlsx（b.xlsx，Excel，120.0KB）'));
  assert.ok(note.includes('不要把整份文件读进上下文'));
  assert.ok(note.includes('python3 _tools/doc_probe.py'));
  assert.ok(note.includes('--help'), '选项细节应指向脚本帮助');
  assert.ok(note.includes('pdftotext'), '缺工具时要明确降级');
  assert.ok(!note.includes('--sheet'), '不要重复列出脚本选项');
  assert.ok(!note.includes('--out'), '不要重复列出脚本选项');
  assert.ok(note.length < 450, `文件说明应保持精简，实际 ${note.length} 字符`);
});

await check('下载失败也列出来', () => {
  const note = formatFileNote([{ ok: false, name: 'bad.xlsx' }]);
  assert.ok(note.includes('bad.xlsx（下载失败，无法读取）'));
});

await check('没有文件时返回空串', () => {
  assert.strictEqual(formatFileNote([]), '');
});

// ---------------------------------------------------------------- 脚本落盘

await check('ensureDocProbe 写入 _tools/doc_probe.py（0644）', async () => {
  const dest = await ensureDocProbe(ws);
  assert.strictEqual(dest, join(ws, '_tools', 'doc_probe.py'));
  assert.ok(existsSync(dest));
  const body = await readFile(dest, 'utf8');
  assert.ok(body.includes('probe_xlsx'));
  assert.ok(body.includes('pdftotext'));
  assert.strictEqual((await stat(dest)).mode & 0o777, 0o644);
});

await check('ensureDocProbe 幂等（重复调用不报错）', async () => {
  const a = await ensureDocProbe(ws);
  const b = await ensureDocProbe(ws);
  assert.strictEqual(a, b);
});

// ---------------------------------------------------------------- 脚本行为

const probe = join(ws, '_tools', 'doc_probe.py');
const pyPath = (spawnSync('sh', ['-c', 'command -v python3'], { encoding: 'utf8' }).stdout || '').trim();
const hasPython = Boolean(pyPath);
const hasPoppler = spawnSync('sh', ['-c', 'command -v pdftotext'], { encoding: 'utf8' }).status === 0;

if (!hasPython) {
  console.log('⚠️ 未找到 python3，跳过 doc_probe.py 的解析测试');
} else {
  const fixtures = join(root, 'fixtures');
  await mkdir(fixtures, { recursive: true });
  const builder = join(root, 'build-fixtures.py');
  await writeFile(builder, String.raw`
import zipfile, os, sys
root = sys.argv[1]

def build_xlsx(path):
    ct = '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/></Types>'
    rels = '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'
    wb = '<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="成绩" sheetId="1" r:id="rId1"/><sheet name="名单" sheetId="2" r:id="rId2"/></sheets></workbook>'
    wbrels = '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/></Relationships>'
    shared = '<?xml version="1.0" encoding="UTF-8"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><si><t>姓名</t></si><si><t>分数</t></si></sst>'
    s1 = '<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="A1:B4"/><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>张三</t></is></c><c r="B2"><v>90</v></c></row><row r="3"><c r="A3" t="inlineStr"><is><t>李四</t></is></c><c r="B3"><v>85</v></c></row><row r="4"><c r="A4" t="inlineStr"><is><t>王五</t></is></c><c r="B4"><v>77</v></c></row></sheetData></worksheet>'
    s2 = '<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="A1:B2"/><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>部门</t></is></c><c r="B1" t="inlineStr"><is><t>人数</t></is></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>研发</t></is></c><c r="B2"><v>12</v></c></row></sheetData></worksheet>'
    with zipfile.ZipFile(path, 'w', zipfile.ZIP_DEFLATED) as z:
        z.writestr('[Content_Types].xml', ct); z.writestr('_rels/.rels', rels)
        z.writestr('xl/workbook.xml', wb); z.writestr('xl/_rels/workbook.xml.rels', wbrels)
        z.writestr('xl/sharedStrings.xml', shared)
        z.writestr('xl/worksheets/sheet1.xml', s1); z.writestr('xl/worksheets/sheet2.xml', s2)

def build_docx(path):
    ct = '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'
    rels = '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'
    doc = '<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>第一段：背景</w:t></w:r></w:p><w:p><w:r><w:t>第二段：结论</w:t></w:r></w:p></w:body></w:document>'
    with zipfile.ZipFile(path, 'w', zipfile.ZIP_DEFLATED) as z:
        z.writestr('[Content_Types].xml', ct); z.writestr('_rels/.rels', rels); z.writestr('word/document.xml', doc)

build_xlsx(os.path.join(root, 'data.xlsx'))
build_docx(os.path.join(root, 'doc.docx'))
with open(os.path.join(root, 'note.txt'), 'w') as f:
    f.write('\n'.join('line %d' % i for i in range(1, 31)))
def build_pdf(path):
    objs = [
        b'<< /Type /Catalog /Pages 2 0 R >>',
        b'<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
        b'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
        None,
        b'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    ]
    stream = b'BT /F1 18 Tf 20 100 Td (Hello PDF) Tj ET'
    objs[3] = b'<< /Length %d >>\nstream\n%s\nendstream' % (len(stream), stream)
    out = bytearray(b'%PDF-1.4\n')
    offsets = []
    for i, obj in enumerate(objs, 1):
        offsets.append(len(out))
        out += b'%d 0 obj\n' % i + obj + b'\nendobj\n'
    xref = len(out)
    out += b'xref\n0 %d\n' % (len(objs) + 1)
    out += b'0000000000 65535 f \n'
    for off in offsets:
        out += b'%010d 00000 n \n' % off
    out += b'trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n' % (len(objs) + 1, xref)
    with open(path, 'wb') as f:
        f.write(out)

def build_blank_pdf(path):
    """没有文本层的扫描件（内容流为空）。"""
    objs = [
        b'<< /Type /Catalog /Pages 2 0 R >>',
        b'<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
        b'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents 4 0 R >>',
        b'<< /Length 0 >>\nstream\n\nendstream',
    ]
    out = bytearray(b'%PDF-1.4\n')
    offsets = []
    for i, obj in enumerate(objs, 1):
        offsets.append(len(out))
        out += b'%d 0 obj\n' % i + obj + b'\nendobj\n'
    xref = len(out)
    out += b'xref\n0 %d\n' % (len(objs) + 1)
    out += b'0000000000 65535 f \n'
    for off in offsets:
        out += b'%010d 00000 n \n' % off
    out += b'trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n' % (len(objs) + 1, xref)
    with open(path, 'wb') as f:
        f.write(out)

build_pdf(os.path.join(root, 'sample.pdf'))
build_blank_pdf(os.path.join(root, 'scanned.pdf'))
`, 'utf8');

  const build = spawnSync(pyPath, [builder, fixtures], { encoding: 'utf8' });
  assert.strictEqual(build.status, 0, build.stderr);

  const run = (...args) => spawnSync(pyPath, [probe, ...args], { encoding: 'utf8' });
  const runNoPoppler = (...args) => spawnSync(pyPath, [probe, ...args], {
    encoding: 'utf8',
    env: { ...process.env, PATH: '/nonexistent' },
  });

  await check('xlsx：列出工作表 + 表头 + 预览行', () => {
    const r = run(join(fixtures, 'data.xlsx'));
    assert.strictEqual(r.status, 0, r.stderr);
    assert.ok(r.stdout.includes('工作表: 2'));
    assert.ok(r.stdout.includes('成绩'));
    assert.ok(r.stdout.includes('A:姓名'));
    assert.ok(r.stdout.includes('张三\t90'));
  });

  await check('xlsx：--sheet 切换工作表', () => {
    const r = run(join(fixtures, 'data.xlsx'), '--sheet', '名单');
    assert.strictEqual(r.status, 0, r.stderr);
    assert.ok(r.stdout.includes('研发\t12'));
  });

  await check('xlsx：--rows 只输出指定行', () => {
    const r = run(join(fixtures, 'data.xlsx'), '--rows', '3:3');
    assert.strictEqual(r.status, 0, r.stderr);
    assert.ok(r.stdout.includes('李四\t85'));
    assert.ok(!r.stdout.includes('张三\t90'));
  });

  await check('xlsx：--out 落盘 TSV', async () => {
    const out = join(fixtures, 'out.tsv');
    const r = run(join(fixtures, 'data.xlsx'), '--out', out);
    assert.strictEqual(r.status, 0, r.stderr);
    assert.ok(r.stdout.includes('[written:'));
    const text = await readFile(out, 'utf8');
    assert.ok(text.startsWith('姓名\t分数'));
    assert.ok(text.includes('王五\t77'));
  });

  await check('docx：按段落预览', () => {
    const r = run(join(fixtures, 'doc.docx'));
    assert.strictEqual(r.status, 0, r.stderr);
    assert.ok(r.stdout.includes('第一段：背景'));
    assert.ok(r.stdout.includes('段落: 2'));
  });

  await check('text：行数 + 前 N 行', () => {
    const r = run(join(fixtures, 'note.txt'), '--lines', '3');
    assert.strictEqual(r.status, 0, r.stderr);
    assert.ok(r.stdout.includes('行数: 30'));
    assert.ok(r.stdout.includes('line 3'));
  });

  await check('pdf：缺 pdftotext 时明确降级、不硬读', () => {
    const r = runNoPoppler(join(fixtures, 'sample.pdf'));
    assert.strictEqual(r.status, 0, r.stderr);
    assert.ok(r.stdout.includes('页数: 1'));
    assert.ok(r.stdout.includes('pdftotext'));
    assert.ok(r.stdout.includes('不要反复尝试 read 二进制'));
  });

  if (hasPoppler) {
    await check('pdf：有 poppler 时按页提取文本', () => {
      const r = run(join(fixtures, 'sample.pdf'), '--page', '1');
      assert.strictEqual(r.status, 0, r.stderr);
      assert.ok(r.stdout.includes('页数: 1'));
      assert.ok(r.stdout.includes('Hello PDF'));
    });

    await check('pdf：--out 保存全文', async () => {
      const out = join(fixtures, 'sample.txt');
      const r = run(join(fixtures, 'sample.pdf'), '--out', out);
      assert.strictEqual(r.status, 0, r.stderr);
      assert.ok(r.stdout.includes('[written:'));
      assert.ok((await readFile(out, 'utf8')).includes('Hello PDF'));
    });

    // ---- 扫描件 OCR（用 fake pdftoppm/tesseract，结果确定、不依赖 tesseract 语言包） ----
    const fakeBin = join(root, 'fake-ocr-bin');
    await mkdir(fakeBin, { recursive: true });

    const pdftoppmPath = join(fakeBin, 'pdftoppm');
    await writeFile(pdftoppmPath, `#!/bin/sh
last=""
for a in "$@"; do last="$a"; done
: > "\${last}-1.png"
exit 0
`, 'utf8');
    await chmod(pdftoppmPath, 0o755);

    const tesseractPath = join(fakeBin, 'tesseract');
    await writeFile(tesseractPath, `#!/bin/sh
if [ "$1" = "--version" ]; then echo "tesseract 5.0.0"; exit 0; fi
if [ "$1" = "--list-langs" ]; then printf "List of available languages (1):\\neng\\n"; exit 0; fi
echo "扫描件 OCR 文字：发票金额 1234 元"
exit 0
`, 'utf8');
    await chmod(tesseractPath, 0o755);

    const runOcr = (...args) => spawnSync(pyPath, [probe, ...args], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${fakeBin}:${process.env.PATH}`,
        BRIDGE_OCR_LANG: 'eng',
      },
    });

    await check('pdf：扫描件无文本层时自动 OCR', () => {
      const r = runOcr(join(fixtures, 'scanned.pdf'));
      assert.strictEqual(r.status, 0, r.stderr);
      assert.ok(r.stdout.includes('文本层: 未检测到（扫描件）'));
      assert.ok(r.stdout.includes('OCR: 已处理 1 页'));
      assert.ok(r.stdout.includes('扫描件 OCR 文字：发票金额 1234 元'));
      assert.ok(!r.stdout.includes('扫描件 OCR 不可用'));
    });

    await check('pdf：--no-ocr 明确跳过 OCR', () => {
      const r = runOcr(join(fixtures, 'scanned.pdf'), '--no-ocr');
      assert.strictEqual(r.status, 0, r.stderr);
      assert.ok(r.stdout.includes('已用 --no-ocr 跳过 OCR'));
      assert.ok(!r.stdout.includes('扫描件 OCR 文字'));
    });

    await check('pdf：--ocr-pages 控制 OCR 页数', () => {
      const r = runOcr(join(fixtures, 'scanned.pdf'), '--ocr-pages', '1');
      assert.strictEqual(r.status, 0, r.stderr);
      assert.ok(r.stdout.includes('OCR: 最多处理 1 页'));
    });

    await check('pdf：缺 OCR 工具时明确降级', async () => {
      // 只暴露 pdftotext，不暴露 pdftoppm/tesseract
      const onlyPdftotext = join(root, 'only-pdftotext-bin');
      await mkdir(onlyPdftotext, { recursive: true });
      const real = spawnSync('sh', ['-c', 'command -v pdftotext'], { encoding: 'utf8' }).stdout.trim();
      await symlink(real, join(onlyPdftotext, 'pdftotext'));

      const r = spawnSync(pyPath, [probe, join(fixtures, 'scanned.pdf')], {
        encoding: 'utf8',
        env: { ...process.env, PATH: onlyPdftotext },
      });
      assert.strictEqual(r.status, 0, r.stderr);
      assert.ok(r.stdout.includes('扫描件 OCR 不可用'));
      assert.ok(r.stdout.includes('tesseract'));
    });
  } else {
    console.log('⚠️ 未找到 pdftotext，跳过 PDF 提取测试');
  }

  await check('不存在的文件退出码非 0', () => {
    const r = run(join(fixtures, 'nope.xlsx'));
    assert.notStrictEqual(r.status, 0);
  });
}

await rm(root, { recursive: true, force: true });

console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
