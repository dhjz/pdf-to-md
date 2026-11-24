import { test } from 'node:test';
import assert from 'node:assert/strict';
import { backgroundBlocks, markBackgroundLines, markShadedSingleLines } from '../src/background.js';
import { detectCodeBlocks } from '../src/blocks.js';
import { render2 } from '../src/render2.js';

// Minimal pdf.js operator ids used by backgroundBlocks.
const OPS = {
  save: 10, restore: 11, transform: 12, constructPath: 91,
  fill: 22, eoFill: 23,
  setFillRGBColor: 59, setFillGray: 57, setFillColor: 54,
};

function opList(ops) {
  return { fnArray: ops.map(o => o[0]), argsArray: ops.map(o => o[1]) };
}
function setColor(r, g, b) { return [OPS.setFillRGBColor, { 0: r, 1: g, 2: b }]; }
function fillRect(x, y, w, h) {
  return [OPS.constructPath, [[19], [x, y, w, h]]];
}
function fillRoundRect(x, y, w, h) {
  // Browser print draws a shaded inline-code bar as a closed bezier path,
  // not a literal `rectangle` op: move/line/curve/close, corners inside box.
  const pts = [x, y, x + w, y, x + w, y, x + w, y + h,
               x + w, y + h, x, y + h, x, y + h, x, y];
  return [OPS.constructPath, [[13, 14, 15, 18], pts]];
}
function tagged(text, x, y, { h = 9.9, font = 'code' } = {}) {
  return {
    text, x, y, right: x + text.length * h * 0.6, height: h, fontSize: h,
    fontName: font, fonts: [font], dropped: false,
    items: [{ str: text, transform: [1, 0, 0, 1, x, y], width: text.length * h * 0.6 }],
  };
}
function codeLine(text, x, y, { h = 9.9 } = {}) {
  return {
    text, x, y, right: x + text.length * h * 0.6, height: h, fontSize: h,
    dropped: false, items: [{ str: text, transform: [1, 0, 0, 1, x, y], width: text.length * h * 0.6 }],
  };
}

test('浅灰背景矩形被识别为块，页面白底与表格表头被排除', () => {
  const ops = opList([
    [OPS.save, null],
    setColor(255, 255, 255), fillRect(56, 56, 483, 729), [OPS.fill, null], // page frame
    setColor(246, 248, 250), fillRect(113, 573, 209, 25), [OPS.fill, null], // table header cell A
    setColor(246, 248, 250), fillRect(322, 573, 217, 25), [OPS.fill, null], // table header cell B (tiled row)
    setColor(238, 238, 238), fillRect(56, 184, 483, 601), [OPS.fill, null], // shaded code block
    [OPS.restore, null],
  ]);
  const rects = backgroundBlocks(ops, OPS, { pageWidth: 595, pageHeight: 842 });
  assert.equal(rects.length, 1);
  assert.ok(Math.abs(rects[0].w - 483) < 1 && Math.abs(rects[0].h - 601) < 1);
});

test('背景矩形内的正文行被标记并输出为代码块', () => {
  const rect = { x1: 56, y1: 184, x2: 539, y2: 785, w: 483, h: 601 };
  const code = [
    codeLine('status: applied', 64, 774),
    codeLine('created: 2026-05-18', 64, 757),
    codeLine('owner: backend', 64, 741),
    codeLine('## 1. Background', 64, 724),
  ];
  const prose = [codeLine('这是一段普通正文没有背景色块。', 56, 820, { h: 12 })];
  const lines = [...prose, ...code];
  markBackgroundLines(lines, [rect]);
  assert.ok(code.every(l => l.bgBlock === 0), '背景内的行都应被标记');
  assert.equal(prose[0].bgBlock, undefined);

  const page = { pageNumber: 1, lines, tables: [], images: [], pageHeight: 842 };
  const md = render2([page]);
  assert.match(md, /```yaml\nstatus: applied\ncreated: 2026-05-18\nowner: backend\n## 1\. Background\n```/);
  assert.ok(md.indexOf('这是一段普通正文') < md.indexOf('```'), '块外正文应保留在代码块之外');
});

test('背景块内的行号栏被剔除，不进入输出', () => {
  const rect = { x1: 56, y1: 184, x2: 539, y2: 785, w: 483, h: 601 };
  const content = [
    codeLine('first line', 90, 774),
    codeLine('second line', 90, 757),
    codeLine('third line', 90, 740),
  ];
  const nums = [774, 757, 740].map((y, i) => codeLine(String(i + 1), 62, y));
  const lines = [...content, ...nums];
  markBackgroundLines(lines, [rect]);
  const page = { pageNumber: 2, lines, tables: [], images: [], pageHeight: 842 };
  const md = render2([page]);
  assert.match(md, /```txt\nfirst line\nsecond line\nthird line\n```/);
  for (const n of nums) assert.ok(!md.includes(`\n${n.text}\n`), '行号不应出现在输出');
});

test('行号栏画在背景块外侧仍被剔除', () => {
  // Browser-printed docs often paint the number gutter in a narrow column
  // just OUTSIDE the shaded rectangle. Those number lines are not tagged with
  // bgBlock, so the block-local scan misses them and they leak into the output.
  const rect = { x1: 70, y1: 700, x2: 540, y2: 790, w: 470, h: 90 };
  const content = [
    codeLine('{', 82, 770),
    codeLine('"mcpServers": {', 93, 755),
    codeLine('"url": "http://127.0.0.1:3845/sse"', 115, 740),
    codeLine('}', 93, 725),
    codeLine('}', 82, 710),
  ];
  const nums = [770, 755, 740, 725, 710].map((y, i) => codeLine(String(i + 1), 50, y));
  const lines = [...content, ...nums];
  markBackgroundLines(lines, [rect]);
  // gutter lines are outside the rect -> no bgBlock, exactly the reported case.
  assert.ok(nums.every(n => n.bgBlock === undefined));
  const page = { pageNumber: 3, lines, tables: [], images: [], pageHeight: 842, bgRects: [rect] };
  const md = render2([page]);
  assert.match(md, /```json\n/);
  assert.ok(md.includes('"mcpServers"'), '代码正文应保留');
  for (const n of nums) assert.ok(!new RegExp('(^|\\n)' + n.text + '(\\n|$)').test(md), `行号 ${n.text} 不应出现在输出`);
});

test('行号被 pdf.js 合并进代码行文本/items 时仍被剔除', () => {
  const rect = { x1: 75, y1: 260, x2: 650, y2: 380, w: 575, h: 120 };
  // Browser PDFs often paint "1 ", "2 " into the SAME baseline as the code,
  // so itemsToLines joins them into one line rather than a separate gutter.
  function numbered(text, number, x, y) {
    const h = 9.9;
    const nw = 1 * h * 0.6;
    return {
      text: `${number} ${text}`, x, y, right: x + (text.length + 2) * h * 0.6,
      height: h, fontSize: h, dropped: false,
      items: [
        { str: String(number), transform: [1, 0, 0, 1, x, y], width: nw },
        { str: text, transform: [1, 0, 0, 1, x + nw + 3, y], width: text.length * h * 0.6 },
      ],
    };
  }
  const code = [
    numbered('{', 1, 60, 362),
    numbered('"mcpServers": {', 2, 60, 347),
    numbered('"figma": {', 3, 60, 332),
    numbered('"url": "http://127.0.0.1:3845/sse"', 4, 60, 317),
    codeLine('}', 93, 302), codeLine('}', 82, 287), codeLine('}', 71, 272),
  ];
  const lines = [...code];
  markBackgroundLines(lines, [rect]);
  const page = { pageNumber: 4, lines, tables: [], images: [], pageHeight: 842, bgRects: [rect] };
  const md = render2([page]);
  assert.match(md, /```json\n\{\n"mcpServers": \{\n"figma": \{\n"url": "http:\/\/127\.0\.0\.1:3845\/sse"/);
  for (const n of [1, 2, 3, 4]) {
    assert.ok(!new RegExp('(^|\\n)' + n + '\\s', 'm').test(md), `合并进文本的行号 ${n} 不应出现在输出`);
  }
});

test('单行浅灰背景块（如单条 prompt）不应被丢弃', () => {
  const rect = { x1: 75, y1: 180, x2: 650, y2: 210, w: 575, h: 30 };
  const one = codeLine('/propose 根据 Figma 设计图实现 PC 端大屏首页，先确定整体布局，不逐像素抠细节。', 60, 195);
  const filler = [
    codeLine('图6 按设计稿生成的大屏首页最终效果', 56, 500, { h: 11 }),
    codeLine('③ 对话内容与上下文配置原文（Qwen CLI，Figma 个人访问令牌以 <TOKEN> 代替）：', 56, 480, { h: 11 }),
  ];
  const lines = [...filler, one];
  markBackgroundLines(lines, [rect]);
  assert.equal(one.bgBlock, 0);
  const page = { pageNumber: 5, lines, tables: [], images: [], pageHeight: 842, bgRects: [rect] };
  const md = render2([page]);
  assert.match(md, /```txt\n\/propose 根据 Figma 设计图实现 PC 端大屏首页/);
  assert.ok(md.includes('不逐像素抠细节。'), '单行代码块的全部文本都应保留');
});

// Regression for v2v2.pdf (Issue #34): the code block has NO background
// rectangle, so it goes through the small-font pass — not the bg-rect pass.
// pdf.js merges each "1 ", "2 " gutter number into the code line's own text
// and items. Without inline resolution here the numbers leak and the closing
// brace lines (separate, unnumbered) get stranded as prose.
test('无背景矩形的小字号代码块：合并行号剔除 + 缺失代码片段补全', () => {
  const H = 9.9;
  const ln = (text, x, y, items) => ({
    text, x, y, right: x + text.length * H * 0.6, height: H, fontSize: H,
    dropped: false, items: items || [{ str: text, transform: [1, 0, 0, 1, x, y], width: text.length * H * 0.6 }],
  });
  const num = (n, text, nx, cx, y, cw) => ln(`${n} ${text}`, nx, y, [
    { str: '', transform: [1, 0, 0, 1, nx, y], width: 0 },
    { str: String(n), transform: [1, 0, 0, 1, nx, y], width: 5.4 },
    { str: '', transform: [1, 0, 0, 1, cx, y], width: 0 },
    { str: text, transform: [1, 0, 0, 1, cx, y], width: cw },
  ]);
  const codeLines = [
    num(1, '{', 60.6, 81.8, 362, 5.4),
    num(2, '"mcpServers": {', 60.6, 92.7, 345.5, 65.3),
    num(3, '"figma": {', 60.6, 103.6, 329, 38.1),
    ln('"url": "http://127.0.0.1:3845/sse"', 114.5, 312.5),
    ln('}', 103.6, 296), ln('}', 92.7, 279.5), ln('}', 81.8, 263),
  ];
  // Body prose at a larger size must stay outside the block.
  const prose = [codeLine('图 6 按设计稿生成的大屏首页最终效果', 56, 500, { h: 11 })];
  const page = { pageNumber: 9, lines: [...prose, ...codeLines], tables: [], images: [], pageHeight: 842 };
  const md = render2([page]);
  assert.match(md, /```json\n\{\n  "mcpServers": \{\n    "figma": \{\n      "url": "http:\/\/127\.0\.0\.1:3845\/sse"\n    \}\n  \}\n\}/,
    '行号应剔除、缩进按内容 x 还原、未被编号的右花括号也要留在代码块内');
  for (const n of [1, 2, 3]) {
    assert.ok(!new RegExp('(^|\\n)' + n + ' +["{]', 'm').test(md), `行号 ${n} 不应出现在输出`);
  }
  assert.ok(md.indexOf('图 6') < md.indexOf('```'), '块外正文顺序不变');
});

// A numbered line glued to a real section heading ("4 " + "3. xxx") is not a
// code prompt. It must keep the leading number as prose, not become fenced.
test('孤立数字行号 + 章节编号标题不应被误判为代码块', () => {
  const headings = [codeLine('4 3. 对自有产品的启示和建议', 60, 774, { h: 9.9 })];
  const prose = [codeLine('这是一段普通正文说明内容。', 56, 820, { h: 11 })];
  const page = { pageNumber: 10, lines: [...prose, ...headings], tables: [], images: [], pageHeight: 842 };
  const md = render2([page]);
  assert.ok(!md.includes('```'), '不应产生代码块');
  assert.match(md, /4 3\. 对自有产品的启示和建议/, '编号标题原样保留');
});


test('单行代码的全宽圆角色块（bezier 路径）被标记，普通正文不受影响', () => {
  const ops = opList([
    [OPS.save, null],
    setColor(238, 238, 238), fillRoundRect(56, 607, 483, 30), [OPS.fill, null],
    setColor(255, 255, 255), fillRoundRect(56, 500, 483, 30), [OPS.fill, null], // 白色背景不算
    [OPS.restore, null],
  ]);
  const shaded = tagged('2', 64, 620);
  const onWhite = tagged('普通正文', 64, 512, { h: 11, font: 'body' });
  const lines = [shaded, onWhite];
  markShadedSingleLines(ops, OPS, lines, { pageWidth: 595, pageHeight: 842, contentWidth: 483 });
  assert.equal(shaded.shadedSingle, true, '与正文栏同宽的灰色条内的单行应被标记');
  assert.equal(onWhite.shadedSingle, undefined, '白色背景上的正文不应被标记');
});

test('全宽判断以正文栏宽为准，而非整页宽度', () => {
  // Page is much wider than the text column; a bar covering the full column
  // is far below pageWidth * 0.9 but must still be recognised as a full bar.
  const ops = opList([
    setColor(238, 238, 238), fillRoundRect(56, 607, 483, 30), [OPS.fill, null],
    setColor(238, 238, 238), fillRoundRect(700, 607, 120, 30), [OPS.fill, null], // 页边窄条
  ]);
  const column = tagged('result++', 64, 620);
  const margin = tagged('chip', 608, 620);
  markShadedSingleLines(ops, OPS, [column, margin], {
    pageWidth: 900, pageHeight: 842, contentWidth: 478,
  });
  assert.equal(column.shadedSingle, true, '占满正文栏(483/478)的灰条应被标记');
  assert.equal(margin.shadedSingle, undefined, '页边 120pt 窄条不应被标记');
});

test('无正文栏宽时退回页宽判断', () => {
  const ops = opList([
    setColor(238, 238, 238), fillRoundRect(56, 607, 483, 30), [OPS.fill, null],
  ]);
  const line = tagged('2', 64, 620);
  markShadedSingleLines(ops, OPS, [line], { pageWidth: 595, pageHeight: 842 });
  assert.equal(line.shadedSingle, undefined, '无正文栏宽信息时保守跳过，避免误判窄条');
});

test('窄圆角色块（内联代码 chip）不按全宽单行代码处理', () => {
  const ops = opList([
    setColor(238, 238, 238), fillRoundRect(180, 607, 120, 30), [OPS.fill, null],
  ]);
  const line = tagged('code', 188, 620);
  markShadedSingleLines(ops, OPS, [line], { pageWidth: 595, pageHeight: 842 });
  assert.equal(line.shadedSingle, undefined, '只有 120pt、非全宽的灰条不应被标记');
});

test('矩形短而近全宽的条（表格规则线）不构成背景块', () => {
  const ops = opList([
    setColor(238, 238, 238), fillRect(10, 600, 580, 30), [OPS.fill, null],
  ]);
  const rects = backgroundBlocks(ops, OPS, { pageWidth: 595, pageHeight: 842 });
  assert.equal(rects.length, 0, '近全宽的短条应被排除');
});

test('过高的圆角色块（多行/引用框）不按单行代码处理', () => {
  const ops = opList([
    setColor(238, 238, 238), fillRoundRect(56, 600, 483, 120), [OPS.fill, null],
  ]);
  const line = tagged('多行引用', 64, 660);
  markShadedSingleLines(ops, OPS, [line], { pageWidth: 595, pageHeight: 842 });
  assert.equal(line.shadedSingle, undefined, '120pt 高的块不是单行条');
});

test('单页只有一条圆角阴影单行时仍识别为代码块', () => {
  const ops = opList([
    setColor(238, 238, 238), fillRoundRect(56, 607, 483, 30), [OPS.fill, null],
  ]);
  const solo = tagged('done', 64, 620);
  const prose = tagged('这是一段普通正文说明内容。', 56, 720, { h: 12, font: 'body' });
  const others = [1, 2].map(n => tagged(`普通正文第 ${n} 行说明文字，保持同一正文字体。`, 56, 500 - n * 20, { h: 12, font: 'body' }));
  const codeSupport = tagged('another code line', 64, 660);
  markShadedSingleLines(ops, OPS, [solo, prose, ...others, codeSupport], { pageWidth: 595, pageHeight: 842, contentWidth: 483 });
  assert.equal(solo.shadedSingle, true);
  const page = { pageNumber: 1, lines: [solo, prose, ...others, codeSupport], tables: [], images: [], pageHeight: 842, pageWidth: 595 };
  detectCodeBlocks([page]);
  assert.ok(solo.codeBlock, '仅 1 条阴影单行也应进入 shadedCodeSolo 路径');
  assert.equal(solo.codeText, 'done');
});

test('isRoundedBox 使用传入 OPS 的操作码而不是硬编码魔数', () => {
  const shifted = {
    ...OPS,
    moveTo: 101, lineTo: 102, curveTo: 103, closePath: 104, eoFill: 105,
  };
  const pts = [56, 607, 539, 607, 539, 607, 539, 637, 539, 637, 56, 637, 56, 637, 56, 607];
  const ops = opList([[shifted.moveTo, null], [shifted.lineTo, null],
    [shifted.curveTo, null], [shifted.closePath, null]]);
  ops.argsArray[0] = pts;
  // constructPath args: [opcodes, shapes]
  const stream = opList([
    [shifted.setFillRGBColor, { 0: 238, 1: 238, 2: 238 }],
    [shifted.constructPath, [[shifted.moveTo, shifted.lineTo, shifted.curveTo, shifted.closePath], [pts]]],
    [OPS.fill, null],
  ]);
  const line = tagged('done', 64, 620);
  markShadedSingleLines(stream, shifted, [line], { pageWidth: 595, pageHeight: 842, contentWidth: 483 });
  assert.equal(line.shadedSingle, true, '自定义 OPS 枚举值也应识别圆角阴影条');
});
