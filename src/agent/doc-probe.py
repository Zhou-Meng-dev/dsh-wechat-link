#!/usr/bin/env python3
"""doc_probe.py — 打印文档结构与小段预览，避免把整份文件读进上下文。

由 dsh-wechat-link 自动写入 <workspace>/_tools/，每次租户启动会覆盖，请不要手改。

用法：
  python3 _tools/doc_probe.py FILE                     # 类型/页数/工作表/表头/前几行
  python3 _tools/doc_probe.py FILE --list              # 只列工作表
  python3 _tools/doc_probe.py FILE --sheet Sheet1 --rows 1:30
  python3 _tools/doc_probe.py FILE --page 3            # PDF 单页
  python3 _tools/doc_probe.py FILE --ocr-pages 3       # 扫描件 OCR 页数（0=全部）
  python3 _tools/doc_probe.py FILE --no-ocr            # 扫描件不做 OCR
  python3 _tools/doc_probe.py FILE --out _inbox/x.tsv  # 大内容落盘，再按行读

支持：
  .xlsx  零依赖（zipfile + XML），可选工作表/行范围/TSV 输出
  .docx  零依赖，按段落预览，--rows 选段落
  .pdf   需要 poppler-utils 的 pdftotext；没有就明确报错，不硬读二进制
         扫描件（无文本层）自动用 pdftoppm + tesseract OCR；
         缺工具时明确降级，不反复重试
  .csv/.tsv/.txt/.md/.json/...  行数 + 前若干行
"""

import argparse
import glob
import os
import re
import shutil
import subprocess
import sys
import tempfile
import zipfile
import xml.etree.ElementTree as ET

MAX_CHARS = 3000
MAX_OUT_ROWS = 20000
NS_M = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
NS_R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
NS_W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'

# 扫描件 OCR：pdftoppm 渲成图片，tesseract 识别。
# 默认只看前 5 页（预览场景足够），--ocr-pages 调整，0 表示全部（仍受上限约束）。
OCR_DPI = 200
OCR_DEFAULT_PAGES = 5
OCR_MAX_PAGES = 50


def q(ns, tag):
    return '{%s}%s' % (ns, tag)


def human_size(n):
    if n < 1024:
        return '%dB' % n
    if n < 1024 * 1024:
        return '%.1fKB' % (n / 1024)
    return '%.1fMB' % (n / 1024 / 1024)


def cap(s, limit):
    if limit <= 0 or len(s) <= limit:
        return s
    return s[:limit] + '\n[truncated: %d chars omitted; 用 --out / --rows / --page 缩小范围]' % (len(s) - limit)


def die(msg):
    print(msg, file=sys.stderr)
    sys.exit(2)


def sanitize_cell(v, width=200):
    s = str(v).replace('\t', ' ').replace('\r', ' ').replace('\n', ' ')
    return s if len(s) <= width else s[:width] + '…'


def kind_of(path):
    ext = os.path.splitext(path)[1].lower()
    head = b''
    try:
        with open(path, 'rb') as f:
            head = f.read(8)
    except OSError:
        pass
    if head.startswith(b'%PDF'):
        return 'pdf'
    if head.startswith(b'PK\x03\x04'):
        try:
            with zipfile.ZipFile(path) as z:
                ct = z.read('[Content_Types].xml').decode('utf-8', 'ignore')
            if 'spreadsheetml' in ct:
                return 'xlsx'
            if 'wordprocessingml' in ct:
                return 'docx'
            if 'presentationml' in ct:
                return 'pptx'
        except Exception:
            return 'zip'
        return 'zip'
    if head.startswith(b'\xd0\xcf\x11\xe0'):
        return 'ole'
    if ext in ('.csv', '.tsv', '.txt', '.md', '.json', '.log', '.xml', '.html', '.yaml', '.yml'):
        return 'text'
    try:
        with open(path, 'rb') as f:
            f.read(4096).decode('utf-8')
        return 'text'
    except Exception:
        return 'binary'


def parse_range(spec):
    if not spec:
        return (1, None)
    m = re.fullmatch(r'\s*(\d*)\s*:\s*(\d*)\s*', str(spec))
    if not m:
        die('--rows 格式应为 A:B（例如 1:30，行号从 1 开始）')
    a = int(m.group(1)) if m.group(1) else 1
    b = int(m.group(2)) if m.group(2) else None
    if b is not None and b < a:
        die('--rows 的结束行不能小于起始行')
    return (a, b)


# ---------------------------------------------------------------- xlsx

def col_index(ref):
    m = re.match(r'([A-Za-z]+)', ref or '')
    if not m:
        return 0
    n = 0
    for ch in m.group(1).upper():
        n = n * 26 + (ord(ch) - 64)
    return n - 1


def col_letter(idx):
    s = ''
    n = idx + 1
    while n > 0:
        n, r = divmod(n - 1, 26)
        s = chr(65 + r) + s
    return s


def read_xml(z, name):
    return ET.fromstring(z.read(name))


def xlsx_sheets(z):
    wb = read_xml(z, 'xl/workbook.xml')
    rels = {}
    try:
        rr = read_xml(z, 'xl/_rels/workbook.xml.rels')
        for rel in rr:
            rels[rel.get('Id')] = rel.get('Target', '')
    except KeyError:
        pass
    out = []
    for sh in wb.findall(q(NS_M, 'sheets') + '/' + q(NS_M, 'sheet')):
        target = rels.get(sh.get(q(NS_R, 'id')), '')
        if target.startswith('/'):
            target = target[1:]
        elif target and not target.startswith('xl/'):
            target = 'xl/' + target
        out.append((sh.get('name') or 'Sheet', target))
    return out


def xlsx_shared(z):
    if 'xl/sharedStrings.xml' not in z.namelist():
        return []
    root = read_xml(z, 'xl/sharedStrings.xml')
    return [''.join((t.text or '') for t in si.iter(q(NS_M, 't')))
            for si in root.findall(q(NS_M, 'si'))]


def xlsx_dimension(z, target):
    """只读 sheet XML 开头几 KB，拿 dimension，避免为了列表把整表解析一遍。"""
    try:
        with z.open(target) as f:
            head = f.read(8192)
        m = re.search(rb'<dimension[^>]*ref="([^"]+)"', head)
        return m.group(1).decode('utf-8', 'ignore') if m else ''
    except Exception:
        return ''


def dim_size(ref):
    m = re.fullmatch(r'([A-Z]+)(\d+):([A-Z]+)(\d+)', ref or '')
    if not m:
        return None
    rows = int(m.group(4)) - int(m.group(2)) + 1
    cols = col_index(m.group(3)) - col_index(m.group(1)) + 1
    return (rows, cols)


def xlsx_read_sheet(z, target, shared, max_row=None):
    """按行解析；最多读到 max_row 就停，避免大表一次性进内存。"""
    rows = []
    dimref = ''
    with z.open(target) as f:
        for _event, elem in ET.iterparse(f, events=('end',)):
            if elem.tag == q(NS_M, 'dimension') and not dimref:
                dimref = elem.get('ref') or ''
            if elem.tag != q(NS_M, 'row'):
                continue
            rn = int(elem.get('r') or (len(rows) + 1))
            cells = {}
            for c in elem.findall(q(NS_M, 'c')):
                idx = col_index(c.get('r'))
                t = c.get('t')
                if t == 'inlineStr':
                    val = ''.join((x.text or '') for x in c.iter(q(NS_M, 't')))
                else:
                    v = c.find(q(NS_M, 'v'))
                    raw = v.text if v is not None and v.text is not None else ''
                    if t == 's':
                        try:
                            val = shared[int(raw)]
                        except Exception:
                            val = raw
                    else:
                        val = raw
                cells[idx] = val
            width = max(cells) + 1 if cells else 0
            rows.append((rn, [cells.get(i, '') for i in range(width)]))
            elem.clear()
            if max_row is not None and rn >= max_row:
                break
    return dimref, rows


def probe_xlsx(path, args):
    size = os.path.getsize(path)
    with zipfile.ZipFile(path) as z:
        sheets = xlsx_sheets(z)
        if not sheets:
            die('这个 xlsx 里没有工作表')
        shared = xlsx_shared(z)
        names = [n for n, _ in sheets]
        print('文件: %s（Excel，%s）' % (path, human_size(size)))
        print('工作表: %d 个' % len(sheets))
        for name, target in sheets:
            ref = xlsx_dimension(z, target)
            size = dim_size(ref)
            shape = ('%d 行 × %d 列' % size) if size else '-'
            print('  - %s  %s  %s' % (name, ref or '-', shape))
        if args.list:
            return

        pick = args.sheet or names[0]
        target = dict(sheets).get(pick)
        if not target:
            die('没有工作表 %r；可选: %s' % (pick, ', '.join(names)))

        # 没给 --rows 时只看前 5 行；给了 A: 则最多看 100 行；--out 最多 2 万行
        a, b = parse_range(args.rows)
        if b is None:
            b = a + (99 if args.rows else 4)
        max_row = MAX_OUT_ROWS if args.out else b
        dimref, rows = xlsx_read_sheet(z, target, shared, max_row=max_row)

    total = dim_size(dimref)[0] if dim_size(dimref) else len(rows)
    selected = [(rn, cells) for rn, cells in rows if rn >= a and rn <= b]
    max_cols = max((len(c) for _, c in selected), default=0)
    cols = max_cols if args.cols <= 0 else min(max_cols, args.cols)

    # 表头：优先第 1 行；被 --rows 排除时也仍显示列字母
    header = next((cells for rn, cells in rows if rn == 1), [])
    hdr = []
    for i in range(cols):
        label = sanitize_cell(header[i], 40) if i < len(header) else ''
        hdr.append('%s:%s' % (col_letter(i), label) if label else col_letter(i))
    print('当前工作表: %s（--sheet 切换）' % pick)
    shown_b = min(b, total) if total else b
    print('预览: 行 %d-%d / 共 %d 行（--rows 缩小范围，--out 导出）' % (a, shown_b, total))
    if hdr:
        print('列: ' + ' | '.join(hdr))
    print('')
    lines = []
    for rn, cells in selected:
        row = [sanitize_cell(cells[i]) if i < len(cells) else '' for i in range(cols)]
        lines.append('%d\t%s' % (rn, '\t'.join(row)))
    body = '\n'.join(lines) if lines else '(该范围没有数据)'
    print(cap(body, args.max_chars))

    if args.out:
        out_rows = []
        for rn, cells in rows[:MAX_OUT_ROWS]:
            row = [sanitize_cell(cells[i]) if i < len(cells) else '' for i in range(max(len(cells), 1))]
            out_rows.append('\t'.join(row))
        write_out(args.out, '\n'.join(out_rows) + '\n')
        print('\n[written: %s（%d 行%s）]' % (
            args.out, len(out_rows), '，已截断' if len(rows) > MAX_OUT_ROWS else ''))


# ---------------------------------------------------------------- docx

def probe_docx(path, args):
    size = os.path.getsize(path)
    with zipfile.ZipFile(path) as z:
        root = read_xml(z, 'word/document.xml')
    paras = []
    for p in root.iter(q(NS_W, 'p')):
        text = ''.join((t.text or '') for t in p.iter(q(NS_W, 't'))).strip()
        if text:
            paras.append(text)
    print('文件: %s（Word，%s）' % (path, human_size(size)))
    print('段落: %d（非空）' % len(paras))

    a, b = parse_range(args.rows)
    selected = paras[a - 1:(b if b is not None else None)]
    print('预览: 段落 %d-%d / 共 %d' % (a, a + len(selected) - 1 if selected else a, len(paras)))
    print('')
    print(cap('\n'.join(selected), args.max_chars))

    if args.out:
        write_out(args.out, '\n'.join(paras) + '\n')
        print('\n[written: %s（%d 段）]' % (args.out, len(paras)))


# ---------------------------------------------------------------- pdf

def pdf_meta(path):
    """页数/是否加密。优先用 pdfinfo（能读对象流）；没有就退回原始字节扫描。"""
    pdfinfo = shutil.which('pdfinfo')
    encrypted = False
    if pdfinfo:
        r = subprocess.run([pdfinfo, path], capture_output=True)
        text = (r.stdout + r.stderr).decode('utf-8', 'replace')
        m = re.search(r'^Pages:\s+(\d+)', text, re.M | re.I)
        encrypted = bool(re.search(r'^Encrypted:\s+yes', text, re.M | re.I))
        if m:
            return int(m.group(1)), encrypted
        if encrypted:
            return 0, True
    try:
        with open(path, 'rb') as f:
            data = f.read()
        pages = len(re.findall(rb'/Type\s*/Page\b', data))
        count = re.search(rb'/Count\s+(\d+)', data)
        return pages or (int(count.group(1)) if count else 0), encrypted
    except OSError:
        return 0, encrypted


def ocr_tools():
    """返回 (pdftoppm, tesseract) 的可执行路径；缺失为 None。"""
    return shutil.which('pdftoppm'), shutil.which('tesseract')


def ocr_languages():
    """选择 tesseract 语言：BRIDGE_OCR_LANG 优先，否则优先中文+英文。"""
    override = os.environ.get('BRIDGE_OCR_LANG', '').strip()
    if override:
        return override
    tesseract = shutil.which('tesseract')
    if not tesseract:
        return ''
    r = subprocess.run([tesseract, '--list-langs'], capture_output=True)
    text = (r.stdout + r.stderr).decode('utf-8', 'replace')
    langs = set(re.findall(r'^\s*([A-Za-z0-9_]+)\s*$', text, re.M))
    if 'chi_sim' in langs:
        return 'chi_sim+eng' if 'eng' in langs else 'chi_sim'
    if 'chi_tra' in langs:
        return 'chi_tra+eng' if 'eng' in langs else 'chi_tra'
    return 'eng' if 'eng' in langs else ''


def ocr_hint():
    """OCR 工具缺失时给 agent 的明确降级说明；齐全时返回空串。"""
    pdftoppm, tesseract = ocr_tools()
    missing = []
    if not pdftoppm:
        missing.append('pdftoppm（poppler-utils）')
    if not tesseract:
        missing.append('tesseract（tesseract-ocr；中文需 tesseract-ocr-chi-sim）')
    if missing:
        return '扫描件 OCR 不可用：缺少 %s。' % '、'.join(missing)
    return ''


def ocr_page(path, page, max_chars):
    """OCR 单页：返回 (text, error)。"""
    pdftoppm, tesseract = ocr_tools()
    if not pdftoppm or not tesseract:
        return '', ocr_hint() or 'OCR 工具不可用'

    with tempfile.TemporaryDirectory(prefix='dsh-ocr-') as tmpdir:
        prefix = os.path.join(tmpdir, 'page')
        r = subprocess.run(
            [pdftoppm, '-f', str(page), '-l', str(page), '-r', str(OCR_DPI), '-png', path, prefix],
            capture_output=True)
        if r.returncode != 0:
            return '', 'pdftoppm 失败: %s' % r.stderr.decode('utf-8', 'replace')[:300]

        images = sorted(glob.glob(prefix + '*.png'))
        if not images:
            return '', 'pdftoppm 未生成图片（页码可能超出范围）'

        texts = []
        langs = ocr_languages()
        for image in images:
            cmd = [tesseract, image, 'stdout']
            if langs:
                cmd += ['-l', langs]
            r = subprocess.run(cmd, capture_output=True)
            if r.returncode != 0:
                return '', 'tesseract 失败: %s' % r.stderr.decode('utf-8', 'replace')[:300]
            body = r.stdout.decode('utf-8', 'replace').strip()
            if body:
                texts.append(body)
        return cap('\n'.join(texts), max_chars), ''


def ocr_page_limit(total, requested):
    """本次 OCR 最多处理多少页；0/None 取默认值，负数按全部处理。"""
    want = OCR_DEFAULT_PAGES if requested is None else requested
    if want <= 0:
        want = OCR_MAX_PAGES
    limit = min(want, OCR_MAX_PAGES)
    if total:
        limit = min(limit, total)
    return max(0, limit)


def ocr_document(path, pages, max_chars):
    """连续 OCR 若干页：返回 (text, errors, done_pages)。"""
    texts = []
    errors = []
    done = 0
    for page in range(1, pages + 1):
        text, err = ocr_page(path, page, max_chars)
        if err:
            # 页码超出范围属于正常结束，不当成错误
            if '未生成图片' in err and done > 0:
                break
            errors.append('第 %d 页: %s' % (page, err))
            break
        done += 1
        if text:
            texts.append('--- 第 %d 页（OCR）---\n%s' % (page, text))
    return '\n\n'.join(texts), errors, done


def probe_pdf(path, args):
    size = os.path.getsize(path)
    total, encrypted = pdf_meta(path)
    print('文件: %s（PDF，%s）' % (path, human_size(size)))
    print('页数: %s' % (total if total else '未知'))
    if encrypted:
        print('加密: 是（部分 PDF 只需所有者密码，可先尝试提取；失败则需用户提供密码/解锁版）')

    pdftotext = shutil.which('pdftotext')
    if not pdftotext:
        print('pdftotext: 未安装（poppler-utils），无法提取文本')
        print(ocr_hint() or '扫描件还需要 pdftoppm + tesseract 才能 OCR。')
        print('不要反复尝试 read 二进制。请让用户提供关键页文字/CSV，')
        print('或在宿主机安装 poppler-utils 后重试。')
        return

    if args.page:
        r = subprocess.run(
            [pdftotext, '-f', str(args.page), '-l', str(args.page), '-layout', path, '-'],
            capture_output=True)
        text = r.stdout.decode('utf-8', 'replace')
        if r.returncode != 0:
            print('pdftotext 失败: %s' % r.stderr.decode('utf-8', 'replace')[:300])
            return
        if text.strip():
            print('')
            print(cap(text, args.max_chars))
            return

        print('该页没有可提取文本（可能是扫描件）。')
        if args.no_ocr:
            print('已用 --no-ocr 跳过 OCR。')
            return
        hint = ocr_hint()
        if hint:
            print(hint)
            return
        print('尝试 OCR 第 %d 页（%d dpi）…' % (args.page, OCR_DPI))
        ocr_text, err = ocr_page(path, args.page, args.max_chars)
        if err:
            print('OCR 失败: %s' % err)
            return
        if not ocr_text:
            print('OCR 未识别出文字。')
            return
        print('')
        print(ocr_text)
        return

    r = subprocess.run([pdftotext, '-layout', path, '-'], capture_output=True)
    text = r.stdout.decode('utf-8', 'replace')
    if r.returncode != 0:
        die('pdftotext 失败: %s' % r.stderr.decode('utf-8', 'replace')[:300])

    has_text = bool(re.sub(r'\s+', '', text))
    if has_text:
        if args.out:
            write_out(args.out, text)
            print('\n[written: %s（%d chars）]' % (args.out, len(text)))
            return
        print('文本层: 有可提取文本（%d 字符）' % len(text.strip()))
        print('可用: --page N 提取单页，或 --out _inbox/x.txt 保存全文后再按行读')
        print('')
        print(cap(text, args.max_chars))
        return

    # 扫描件：完全没有文本层，才走 OCR（有任何字符都按正常文本层处理，
    # 避免把带页眉/水印的文本 PDF 误判成扫描件）
    print('文本层: 未检测到（扫描件），改用 OCR。')
    if args.no_ocr:
        print('已用 --no-ocr 跳过 OCR。')
        return
    hint = ocr_hint()
    if hint:
        print(hint)
        return

    limit = ocr_page_limit(total, args.ocr_pages)
    print('OCR: 最多处理 %d 页（--ocr-pages 调整，0 = 全部，上限 %d）…' % (limit, OCR_MAX_PAGES))
    ocr_text, errors, done = ocr_document(path, limit, args.max_chars)
    print('OCR: 已处理 %d 页' % done)
    for err in errors:
        print('OCR 失败: %s' % err)
    if not ocr_text:
        print('OCR 未识别出文字。')
        return

    if args.out:
        write_out(args.out, ocr_text)
        note = '，--ocr-pages 0 可处理全部' if (total and limit < total) else ''
        print('\n[written: %s（%d chars%s）]' % (args.out, len(ocr_text), note))
        return
    print('')
    print(cap(ocr_text, args.max_chars))


# ---------------------------------------------------------------- text / generic

def probe_text(path, args):
    size = os.path.getsize(path)
    with open(path, 'rb') as f:
        raw = f.read()
    text = raw.decode('utf-8', 'replace')
    lines = text.splitlines()
    print('文件: %s（文本，%s）' % (path, human_size(size)))
    print('行数: %d' % len(lines))
    print('')
    print(cap('\n'.join(lines[:args.lines]), args.max_chars))
    if len(lines) > args.lines:
        print('\n[只显示前 %d 行；用 read 的 offset/limit 或 grep/sed 读指定行]' % args.lines)


def probe_generic(path, kind):
    size = os.path.getsize(path)
    print('文件: %s（%s，%s）' % (path, kind, human_size(size)))
    if kind == 'ole':
        print('旧版 Office 二进制（.doc/.xls），无法零依赖解析。')
        print('请让用户另存为 .docx/.xlsx 或 CSV，不要直接 read 二进制。')
    elif kind == 'pptx':
        print('PPTX 暂未支持预览；可 unzip 后读 ppt/slides/slideN.xml，或让用户导出 PDF/文本。')
    else:
        print('不支持预览该格式；不要直接 read 二进制。请让用户提供文本/CSV，或用对应工具转换。')


def write_out(path, text):
    parent = os.path.dirname(os.path.abspath(path))
    if parent:
        os.makedirs(parent, exist_ok=True)
    with open(path, 'w', encoding='utf-8') as f:
        f.write(text)


def main():
    ap = argparse.ArgumentParser(
        description='探测文档结构并输出小段预览，避免整份读进上下文。')
    ap.add_argument('file')
    ap.add_argument('--sheet', help='xlsx 工作表名（默认第一个）')
    ap.add_argument('--rows', help='行/段落范围，A:B（从 1 开始）')
    ap.add_argument('--cols', type=int, default=12, help='预览列数（0 = 全部，默认 12）')
    ap.add_argument('--lines', type=int, default=20, help='文本文件预览行数（默认 20）')
    ap.add_argument('--page', type=int, help='PDF 页码（单页）')
    ap.add_argument('--ocr-pages', type=int,
                    help='扫描件 OCR 页数（默认 %d；0 = 全部，最多 %d）' % (OCR_DEFAULT_PAGES, OCR_MAX_PAGES))
    ap.add_argument('--no-ocr', action='store_true', help='扫描件不做 OCR')
    ap.add_argument('--max-chars', type=int, default=MAX_CHARS, help='输出上限（默认 3000）')
    ap.add_argument('--out', help='把完整内容写成文件（xlsx 为 TSV，docx 为 txt，pdf 为 txt）')
    ap.add_argument('--list', action='store_true', help='只列出工作表')
    args = ap.parse_args()

    if not os.path.isfile(args.file):
        die('文件不存在: %s' % args.file)

    kind = kind_of(args.file)
    if kind == 'xlsx':
        probe_xlsx(args.file, args)
    elif kind == 'docx':
        probe_docx(args.file, args)
    elif kind == 'pdf':
        probe_pdf(args.file, args)
    elif kind == 'text':
        probe_text(args.file, args)
    else:
        probe_generic(args.file, kind)


if __name__ == '__main__':
    main()
