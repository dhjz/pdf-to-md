import { test } from 'node:test';
import assert from 'node:assert/strict';
import { itemsToLines, pageContentMinX, pageContentRight, pageContentWidth } from '../src/text.js';
import { stripRunningFooters } from '../src/index.js';
import { sameTableGrid } from '../src/crosspage.js';
import { render2, isProseRows, headingSizesFromLines, classifyHeading } from '../src/render2.js';

function item(str, x, y, width = str.length * 8, height = 10, fontName = 'F1') {
  return { str, width, height, transform: [1, 0, 0, 1, x, y], fontName, dir: 'ltr' };
}
function line(str, x, y, height = 11) {
  return {
    text: str, x, y, right: x + str.length * 7, height, fontSize: height,
    dropped: false,
    items: [{ str, transform: [1, 0, 0, 1, x, y], width: str.length * 7 }],
  };
}

// --- #1: itemsToLines replaces the lossy readingOrderLines ---------------
test('乱序输入的同行 item 按 x 排序，不在 Latin 词间丢空格', () => {
  const lines = itemsToLines([
    { ...item('World', 160, 700, 40), fontName: 'F2' },
    { ...item('Hello', 100, 700, 40) },
  ]);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].text, 'Hello World');
  assert.deepEqual(lines[0].items.map(i => i.str), ['Hello', 'World']);
});

test('itemsToLines 输出下游需要的 fontSize / fonts / dropped 字段', () => {
  const lines = itemsToLines([
    item('A', 100, 700, 10, 10, 'F1'),
    item('B', 120, 700, 10, 10, 'F2'),
    item('C', 140, 700, 10, 18, 'F1'), // one oversized glyph must not dominate
    item('标题', 100, 680, 40, 15),
  ]);
  assert.equal(lines.length, 2);
  assert.equal(lines[0].fontSize, 10);
  assert.deepEqual(new Set(lines[0].fonts), new Set(['F1', 'F2']));
  assert.equal(lines[1].fontSize, 15);
  assert.equal(lines[0].dropped, false);
});

// --- #4: page furniture --------------------------------------------------
test('英文页码 Page N of M 跨页重复会被过滤', () => {
  const pages = [1, 2, 3, 4].map(n => ({
    pageNumber: n, pageHeight: 842,
    lines: [line('正文内容', 90, 700), line(`Page ${n} of 4`, 300, 30)],
  }));
  stripRunningFooters(pages);
  assert.ok(pages.every(p => p.lines[0].dropped === false));
  assert.ok(pages.every(p => p.lines[1].dropped === true));
});

test('每页顶部重复的公司页眉按 80% 频率过滤，正文不误伤', () => {
  const pages = [1, 2, 3, 4].map(n => ({
    pageNumber: n, pageHeight: 842,
    lines: [line('ACME Confidential', 80, 830), line('正文内容', 90, 700)],
  }));
  stripRunningFooters(pages);
  assert.ok(pages.every(p => p.lines[0].dropped === true));
  assert.ok(pages.every(p => p.lines[1].dropped === false));
});

// --- #3: relative geometry ----------------------------------------------
test('横向页（pageHeight 595）跨页表格不再因绝对值 600 而误判', () => {
  const prev = { colEdges: [84, 182, 516], bottom: 80 };
  const next = { colEdges: [84, 118, 183, 516], top: 540 };
  assert.equal(sameTableGrid(prev, next, { prevPageHeight: 595, nextPageHeight: 595 }), true);
  assert.equal(sameTableGrid(prev, next), false); // A4 fallback still rejects
});

test('正文左边界按页面实际内容推断，不限死 56/90', () => {
  const lines = [line('正文', 150, 700), line('另一行', 150, 680), line('缩进项', 170, 660)];
  assert.equal(pageContentMinX(lines), 150);
});

test('横向页底部列表按相对缩进识别为 bullet', () => {
  const lines = [
    line('总览:', 120, 560),
    line('ASR:语音识别', 140, 540),
    line('TTS:语音合成', 140, 520),
    line('NLU:意图识别', 140, 500),
  ];
  const md = render2([{ pageNumber: 1, lines, tables: [], images: [], pageHeight: 595 }]);
  assert.match(md, /- ASR:语音识别/);
  assert.match(md, /- TTS:语音合成/);
  assert.match(md, /- NLU:意图识别/);
});

// --- Round 2 expert findings ---------------------------------------------
test('双栏同基线文字拆成独立行，不再拼成跨栏长行', () => {
  const items = [
    item('左栏正文', 90, 700, 60), item('右栏正文', 310, 700, 60),
    item('left column', 90, 680, 60), item('right column', 310, 680, 60),
    item('1', 90, 660, 12), item('2.5', 150, 660, 20), item('3', 210, 660, 12),
  ];
  const lines = itemsToLines(items);
  const y700 = lines.filter(l => l.y === 700);
  assert.equal(y700.length, 2);
  assert.equal(y700[0].text, '左栏正文');
  assert.equal(y700[1].text, '右栏正文');
  assert.ok(y700[0].right < 200 && y700[1].x > 200);
  // 数值行的大间隔不应被误拆成两栏
  assert.equal(lines.filter(l => l.y === 660).length, 1);
});

test('空串占位 item 不干扰英文单词间距', () => {
  const lines = itemsToLines([
    item('Hello', 100, 700, 40),
    { ...item('', 142, 700, 0) },
    item('World', 160, 700, 40),
  ]);
  assert.equal(lines[0].text, 'Hello World');
});

test('Word 默认左边距 90pt 时标题字号仍被识别', async () => {
  const { headingSizesFromLines } = await import('../src/render2.js');
  const lines = [
    { ...line('第一章 概述', 90, 740), fontSize: 18, height: 18 },
    { ...line('第二章 架构', 90, 700), fontSize: 18, height: 18 },
    { ...line('这是一段足够长的正文内容用于推断正文字号', 90, 660), fontSize: 11, height: 11 },
  ];
  assert.deepEqual(headingSizesFromLines(lines), [18]);
});

test('无编号标题按字号梯度映射 H1/H2，不再全部折叠成 H2', () => {
  const h1 = (s, y) => ({ ...line(s, 90, y), fontSize: 20, height: 20 });
  const h2 = (s, y) => ({ ...line(s, 90, y), fontSize: 16, height: 16 });
  const lines = [
    h1('系统总览', 780), line('这是一段足够长的正文内容用于推断字号。', 90, 760),
    h2('模块划分', 740), line('这是另一段足够长的正文内容也用于推断字号。', 90, 720),
    h1('部署说明', 700), h2('接口设计', 680),
  ];
  const md = render2([{ pageNumber: 1, lines, tables: [], images: [] }]);
  assert.match(md, /^## 系统总览$/m);
  assert.match(md, /^### 模块划分$/m);
  assert.match(md, /^## 部署说明$/m);
});

test('首列为文本的跨页表格重复表头被去除', async () => {
  const { dedupeHeaderRows } = await import('../src/render2.js');
  const rows = [
    ['接口字段', '类型', '说明'],
    ['userId', 'string', '用户标识'],
    ['amount', 'number', '金额'],
    ['接口字段', '类型', '说明'], // continuation-page repeated header
    ['status', 'string', '状态'],
  ];
  assert.deepEqual(dedupeHeaderRows(rows), [rows[0], rows[1], rows[2], rows[4]]);
});

// --- Round 3 expert findings ---------------------------------------------
test('空串占位 item 不参与双栏间距计算', () => {
  const lines = itemsToLines([
    item('左栏正文', 90, 700, 60),
    { ...item('', 151, 700, 0) }, // empty spacer sits in the gutter
    item('右栏正文', 310, 700, 60),
  ]);
  assert.equal(lines.filter(l => l.y === 700).length, 2);
});

test('文字型多列表头保持单条 line（供跨页 carryToNext 识别）', () => {
  const lines = itemsToLines([
    item('接口字段', 90, 700, 48),
    item('类型', 190, 700, 24),
    item('说明', 280, 700, 24),
  ]);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].text, '接口字段类型说明');
});

test('两个足够长的文字栏仍会拆成独立行', () => {
  const lines = itemsToLines([
    item('这是一段足够长的左栏正文内容', 90, 700, 130),
    item('这是一段足够长的右栏正文内容', 310, 700, 130),
  ]);
  assert.equal(lines.filter(l => l.y === 700).length, 2);
});

test('重复的数据行不会被误当重复表头删掉', async () => {
  const { mergeSplitBoundaryRowsAt } = await import('../src/render2.js');
  const rows = [
    ['字段', '默认值'],
    ['状态', '启用'],
    ['状态', '启用'], // repeated data row at boundary
    ['级别', '高'],
    ['状态', '启用'],
  ];
  const out = mergeSplitBoundaryRowsAt(rows, [2]);
  assert.equal(out.length, 4);
  assert.deepEqual(out[3], ['状态', '启用']);
});

test('含年份的表头单元格不被误判为数据行', async () => {
  const { dedupeHeaderRows } = await import('../src/render2.js');
  const rows = [
    ['项目', '2025年', '2026年'],
    ['字段', '1级分类', '2级分类'],
    ['项目', '2025年', '2026年'],
    ['项目', '2025年', '2026年'], // continuation repeat
    ['预算', '100', '200'],
  ];
  assert.deepEqual(dedupeHeaderRows(rows), [rows[0], rows[1], rows[4]]);
});

test('稀疏的 2 列装饰框按真实列数计算填充率', () => {
  const rows = [['标签', ''], ['', '说明文字'.repeat(20)], ['', ''], ['', ''], ['', ''], ['', ''], ['', ''], ['', '']];
  assert.equal(isProseRows(rows, 2), true);
});

test('宽表页不污染其他页的标题字号识别', () => {
  const wideLine = (t, y, h) => ({ ...line(t, 25, y, h), fontSize: h, height: h });
  const body = (t, y) => ({ ...line(t, 90, y), fontSize: 11, height: 11 });
  const head = (t, y) => ({ ...line(t, 90, y), fontSize: 18, height: 18 });
  const lines = [
    wideLine('1', 800, 9), wideLine('2', 780, 9),
    head('第一章 概述', 740), head('第二章 架构', 700),
    body('这是一段足够长的正文内容用于推断正文字号', 660),
  ];
  lines.forEach((l, i) => { l.pageContentMinX = i < 2 ? 25 : 90; });
  assert.deepEqual(headingSizesFromLines(lines), [18]);
});

test('standalone 标题行携带 fontSize，层级按字号梯度判定', () => {
  const h1 = (s, y) => ({ ...line(s, 90, y), fontSize: 20, height: 20, standalone: true });
  const lines = [
    h1('系统总览', 780), line('这是一段足够长的正文内容用于推断字号。', 90, 760),
    h1('部署说明', 700),
  ];
  const md = render2([{ pageNumber: 1, lines, tables: [{ top: 100, bottom: 0, rows: [], colEdges: [90, 200] }], images: [] }]);
  assert.match(md, /^## 系统总览$/m);
});


test('带实际宽度的空白 item 提供列间距，不过度拆开表格行', () => {
  const wideSpace = { ...item(' ', 150, 700, 160, 0) };
  const lines = itemsToLines([
    item('P0（智能体全部不可用且无', 90, 700, 115),
    wideSpace,
    item('15', 234, 700, 12),
    item('分钟', 249, 700, 21),
    item('双方专属', 378, 700, 42),
  ]);
  assert.equal(lines.length, 1, 'wide whitespace glyph keeps one logical row');
});

test('居中多行文本保留换行但不被当作标题（费率表封面）', () => {
  // test3.pdf cover: three centered large short lines. They are layout lines,
  // not section headings. They must keep their physical line breaks as plain
  // body text — never promoted to Markdown headings regardless of font size.
  const center = (str, y, h, width) => {
    const x = width / 2 - str.length * h * 0.5;
    return { ...line(str, x, y), right: x + str.length * h, fontSize: h, height: h };
  };
  const body = (t, y) => ({ ...line(t, 90, y), fontSize: 10.6, height: 10.6, right: 520 });
  const lines = [
    center('利安人寿保险股份有限公司', 753, 18, 595),
    center('利安利利爱家守护定期寿险', 731, 14, 595),
    center('费率表', 709, 14, 595),
    body('这是一段用于推断正文字号的长文本占据页面大部分宽度并且语义完整', 680),
    body('这是第二段长文本同样占据页面宽度用来稀释标题字号让正文成为主导', 660),
    body('这是第三段长文本继续占据页面宽度确保正文十点六号是页面主字号', 640),
  ];
  lines.forEach(l => { l.pageWidth = 595; l.pageContentMinX = 82; });
  // Centered lines must never seed heading-size inference, even when larger
  // than body text — they are titles/captions, not section headings.
  assert.deepEqual(headingSizesFromLines(lines), [], '居中的大字短行不应被识别为标题字号');

  const page = { pageNumber: 1, lines: lines.map(l => ({ ...l, items: [] })), tables: [], images: [], pageHeight: 842, pageWidth: 595, contentMinX: 82 };
  const md = render2([page]);
  const first = md.split('\n').filter(Boolean);
  assert.ok(first.every(s => !s.startsWith('#')), '居中文本不应输出为 Markdown 标题');
  assert.ok(first[0].includes('利安人寿保险股份有限公司'), '首行应为居中文本');
  assert.ok(first.some(s => s.includes('费率表')) && first[0].indexOf('费率表') === -1, '费率表应独占一行，不被粘进上一段');
});

test('居中多行文本即使不识别为标题也保留各自换行', () => {
  // Regression: line breaks are a layout fact, not a heading-classification
  // by-product. The old code only kept these lines apart because they were
  // promoted to headings; with no heading sizes they were reflowed into one
  // paragraph. Verify the geometry-only path.
  const center = (str, y, h, width) => {
    const x = width / 2 - str.length * h * 0.5;
    return { ...line(str, x, y), right: x + str.length * h, fontSize: h, height: h };
  };
  const lines = [
    center('产品与服务总览', 753, 11, 595),
    center('第一章的补充说明材料', 731, 11, 595),
    center('更多细节', 709, 11, 595),
  ];
  // Body text at the SAME size as these lines: heading-size inference has no
  // oversized tier to promote, so heading detection definitely returns [].
  const body = (t, y) => ({ ...line(t, 90, y), right: 520, fontSize: 11, height: 11 });
  const all = [
    ...lines,
    body('这是一段足够长的正文内容用来稀释所有的字号差异让标题检测返回空数组', 660),
    body('这是第二段足够长的正文内容确保页面主导字号就是十一号不会被误判', 640),
    body('这是第三段足够长的正文内容继续巩固十一号作为唯一的主导正文字号', 620),
  ];
  assert.deepEqual(headingSizesFromLines(all), [], '前提：本场景不应识别到标题字号');
  // The centred lines must not be promoted by text heuristics either.
  for (const l of lines) assert.equal(classifyHeading(l.text, l, []), false);

  const page = {
    pageNumber: 1, lines: all, tables: [], images: [],
    pageHeight: 842, pageWidth: 595, contentMinX: 82,
  };
  const md = render2([page]);
  const first = md.split('\n').filter(Boolean);
  assert.equal(first[0], '产品与服务总览');
  assert.equal(first[1], '第一章的补充说明材料');
  assert.equal(first[2], '更多细节');
  assert.ok(first.every(s => !s.startsWith('#')), '居中文本未被识别为标题时应保留纯文本');
});


test('pageContentRight / pageContentWidth 描述正文栏而非整页', () => {
  const pageWidth = 900;
  const lines = [
    { text: '正文', x: 56, right: 480, dropped: false },
    { text: '另一行', x: 60, right: 534, dropped: false },
    { text: '目录', x: 56, right: 90, dropped: false },
    { text: 'dropped', x: 0, right: 850, dropped: true },
  ];
  assert.equal(pageContentMinX(lines), 56);
  assert.equal(pageContentRight(lines), 534);
  assert.equal(pageContentWidth(lines), 478);
  assert.ok(pageContentWidth(lines) < pageWidth * 0.7, '正文栏远窄于页宽时，页宽不能当栏宽用');
});
