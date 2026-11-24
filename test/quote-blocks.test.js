import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { convert } from '../src/index.js';
import { quoteBarRects, markQuoteLines } from '../src/background.js';
import { render2 } from '../src/render2.js';

const evalDir = new URL('../evaluation/', import.meta.url);
const load = name => new Uint8Array(readFileSync(fileURLToPath(new URL(name, evalDir))));

const OPS = { save: 10, restore: 11, transform: 12, constructPath: 91, setFillRGBColor: 59, setFillGray: 57, setFillColor: 54 };
function opList(ops) { return { fnArray: ops.map(o => o[0]), argsArray: ops.map(o => o[1]) }; }
function rect(x, y, w, h) { return [OPS.constructPath, [[19], [x, y, w, h]]]; }
function color(r,g,b) { return [OPS.setFillRGBColor, {0:r,1:g,2:b}]; }
function txt(text, x, y, h=11) {
  return { text, x, y, right: x+text.length*h*0.6, height:h, fontSize:h, dropped:false,
    items:[{str:text, transform:[1,0,0,1,x,y], width:text.length*h*0.6}] };
}

test('单行引用竖条被识别为 block quote（真实 PDF）', async () => {
  const { markdown } = await convert(load('temp_pdf.pdf'));
  assert.match(markdown, /引用块\n\n> 这是一段引用文字，可以用来强调重要内容或引用他人观点。\n\n链接与列表/,
    '单行蓝色竖条引用应输出为 > 引用，且不粘连前后段落');
});

test('多行灰色引用竖条逐行保留 >，不被当作标题或代码块', () => {
  const ops = opList([
    color(221,221,221), rect(56, 300, 3, 70), // one vertical bar spanning 2 lines
  ]);
  const bars = quoteBarRects(ops, OPS, { pageWidth: 595, pageHeight: 842 });
  assert.equal(bars.length, 1, '单根竖条应被识别');
  const lines = [txt('第一行引用内容', 70, 355), txt('第二行引用内容', 70, 335), txt('普通正文内容在这里不会太短。', 35, 280, 12)];
  markQuoteLines(lines, bars);
  assert.deepEqual(lines.slice(0,2).map(l=>!!l.quoteBar), [true, true], '竖条右侧同行文本应打标');
  assert.equal(!!lines[2].quoteBar, false, '竖条范围外的正文不应打标');
  const md = render2([{ pageNumber:1, lines, tables:[], images:[], pageHeight:842, pageWidth:595 }]);
  assert.match(md, /^> 第一行引用内容第二行引用内容$/m, '同一竖条内无句末标点的物理折行应接回同一行，不插空格');
  assert.match(md, /普通正文内容在这里不会太短。/, '正文不受影响');
  assert.doesNotMatch(md, /```/, '引用不应被包成代码块');
});

test('引用块内短句无标点结尾不应被强行合并（按行宽判断折行）', () => {
  const ops = opList([ color(221,221,221), rect(56, 300, 3, 90) ]);
  const bars = quoteBarRects(ops, OPS, { pageWidth: 595, pageHeight: 842 });
  // A long non-quote line establishes the column's right edge. The three
  // quote lines stop well before it: they are deliberate line breaks, even
  // though none ends with sentence punctuation. They exceed the bullet-list
  // length threshold so list detection cannot claim them first.
  const lines = [
    txt('这一行短句结尾没有标点但是表达的意思已经完整说完了呢', 70, 355),
    txt('下一行短句同样没有标点也是一句完整独立的话不需要接下文', 70, 335),
    txt('第三行短句还是没有标点仍然表达了一个完整清楚的意思内容', 70, 315),
    txt('这是一条特别特别长的普通正文行专门用来把栏目的右边距撑开方便判断折行位置', 35, 280, 12),
  ];
  markQuoteLines(lines, bars);
  assert.deepEqual(lines.slice(0,3).map(l=>!!l.quoteBar), [true, true, true]);
  const md = render2([{ pageNumber:1, lines, tables:[], images:[], pageHeight:842, pageWidth:595 }]);
  const quoteLines = md.split('\n').filter(l => l.startsWith('> '));
  assert.equal(quoteLines.length, 3, '三行短句各自独立成行，不应因无标点被合并');
  assert.match(md, /^> 这一行短句结尾没有标点但是表达的意思已经完整说完了呢  \n> 下一行短句同样没有标点也是一句完整独立的话不需要接下文  \n> 第三行短句还是没有标点仍然表达了一个完整清楚的意思内容$/m,
    '短句无标点结尾时仍逐行保留，折行只按是否到达栏右边距判断');
});

test('表格边框竖条（同一带多条）不会被误判为引用', () => {
  const ops = opList([
    color(221,221,221),
    rect(100,150,1,80), rect(200,150,1,80), rect(300,150,1,80), // table columns
  ]);
  const bars = quoteBarRects(ops, OPS, { pageWidth: 595, pageHeight: 842 });
  assert.equal(bars.length, 0, '同一 y 带多条竖线是表格边框，不应作为引用条');
});

test('代码行左侧竖条不应抢走已标记为代码的文本', () => {
  const ops = opList([ color(221,221,221), rect(56,300,3,50) ]);
  const bars = quoteBarRects(ops, OPS, { pageWidth: 595, pageHeight: 842 });
  const lines = [
    { ...txt('const x = 1;', 70, 340), codeBlock: 'p1-bg0', codeText: 'const x = 1;' },
    { ...txt('console.log(x);', 70, 320), codeBlock: 'p1-bg0', codeText: 'console.log(x);' },
  ];
  markQuoteLines(lines, bars);
  const md = render2([{ pageNumber:1, lines, tables:[], images:[], pageHeight:842, pageWidth:595, bgRects:[{x1:56,x2:539,y1:280,y2:360,w:483,h:80}] }]);
  assert.match(md, /```javascript\nconst x = 1;\nconsole\.log\(x\);\n```/, '已有代码块不应被引用逻辑覆盖');
});


test('带引号开头的多行引用（IVR 截图形状）逐行输出 >', () => {
  const ops = opList([ color(221,221,221), rect(56, 300, 3, 70) ]);
  const bars = quoteBarRects(ops, OPS, { pageWidth: 595, pageHeight: 842 });
  const lines = [
    txt('“您好，请问有什么可以帮您？”', 70, 355),
    txt('“用户：我要查一下上个月话费。”', 70, 335),
  ];
  markQuoteLines(lines, bars);
  const md = render2([{ pageNumber:1, lines, tables:[], images:[], pageHeight:842, pageWidth:595 }]);
  assert.match(md, /^> "您好，请问有什么可以帮您？"  \n> "用户:我要查一下上个月话费。"$/m,
    '句末标点结尾的对话逐行保留，不与下一行粘连');
});


test('同一竖条的分段绘制合并为一个引用块；不同竖条仍分开', () => {
  const ops = opList([
    color(221,221,221),
    rect(56, 380, 3, 40), rect(56, 320, 3, 55), // two segments of one marker
  ]);
  const bars = quoteBarRects(ops, OPS, { pageWidth: 595, pageHeight: 842 });
  const lines = [
    txt('第一段结论句。', 70, 400),
    txt('第二段开头，这里换行继续。', 70, 355),
    txt('接上一行的后半句。', 70, 335),
  ];
  markQuoteLines(lines, bars);
  const md = render2([{ pageNumber:1, lines, tables:[], images:[], pageHeight:842, pageWidth:595 }]);
  assert.equal((md.match(/^>/gm) || []).length, 3, '分段竖条下三行都带 >，只构成一个引用块');
  assert.match(md, /^> 第一段结论句。  \n> 第二段开头，这里换行继续。  \n> 接上一行的后半句。$/m,
    '每物理行都保留为引用块内的一行，viewer 不再并成一句');

  const two = opList([ color(221,221,221), rect(56, 300, 3, 40), rect(56, 200, 3, 40) ]);
  const bars2 = quoteBarRects(two, OPS, { pageWidth: 595, pageHeight: 842 });
  assert.equal(bars2.length, 2, '不重叠的两根竖条是两个独立引用块');
  const lines2 = [txt('引用甲。', 70, 330), txt('引用乙。', 70, 230)];
  markQuoteLines(lines2, bars2);
  const md2 = render2([{ pageNumber:1, lines:lines2, tables:[], images:[], pageHeight:842, pageWidth:595 }]);
  assert.match(md2, /^> 引用甲。\n\n> 引用乙。$/m, '不同竖条之间保留空行，渲染为两个引用块');
});

test('真实 Golang PDF：同一引用条的折行接回段落，句末标点才换行', async () => {
  const { markdown } = await convert(load('real-golang.pdf'));
  assert.match(markdown, /^> 本文基于原始[^\n]+参考答案。  \n> 使用方式:[^\n]+L401-L428$/m,
    '两句引用各占一行，段内中文物理折行接回且不插空格');
  assert.doesNotMatch(markdown, /AIMC 项  \n> 目落地/, '中文断行处不应残留空格');
  assert.doesNotMatch(markdown, /\u0000filecite/, 'PDF 文字层 NUL 不应泄漏到 Markdown');
});
