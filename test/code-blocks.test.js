import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectCodeBlocks } from '../src/blocks.js';
import { render2 } from '../src/render2.js';

function line(text, x, y, { h = 9.9, font = 'mono' } = {}) {
  return {
    text, x, y, right: x + text.length * h * 0.6, height: h, fontSize: h,
    fontName: font, dropped: false, items: [{ str: text, transform: [1, 0, 0, 1, x, y], width: text.length * h * 0.6 }],
  };
}

// A browser-printed JSON block: small font, line-number gutter, deep indents.
// Body text is 11pt; the snippet is 9.9pt. No literal curl/JSON single-line
// regex can catch "schema: x" or "├─ ..." — geometry must.
test('小字号 + 行号栏识别成代码块并按层级缩进', () => {
  const code = [
    line('{', 82, 362),
    line('"mcpServers": {', 93, 347),
    line('"url": "http://x"', 115, 316),
    line('}', 93, 296),
    line('}', 82, 280),
  ];
  const gutter = [364, 349, 318, 298, 282].map((y, i) => line(String(i + 1), 60, y));
  const prose = [line('一段正常的正文内容，字号大于代码，不应进块。', 56, 500, { h: 11, font: 'body' })];
  const page = { pageNumber: 1, lines: [...prose, ...code, ...gutter] };
  detectCodeBlocks([page]);
  const marked = code.filter(l => l.codeBlock);
  assert.equal(marked.length, code.length);
  const md = render2([{ ...page, tables: [], images: [], pageHeight: 842 }]);
  assert.match(md, /```json\n\{\n  "mcpServers": \{\n      "url": /);
  assert.ok(!gutter.some(l => md.includes(`\n${l.text}\n`)), '行号不应出现在输出');
});

test('目录树与 YAML 配置靠缩进和语法被识别', () => {
  const tree = [
    line('repo/', 64, 500),
    line('├─ AGENTS.md 项目说明书', 64, 484),
    line('│ ├─ rules/ 编码规范', 75, 468),
    line('└─ plantuml-images/', 64, 452),
  ];
  const page = {
    pageNumber: 2,
    lines: [line('正文段落字号较大。', 56, 600, { h: 11, font: 'body' }), ...tree],
  };
  detectCodeBlocks([page]);
  assert.ok(tree.every(l => l.codeBlock), '目录树每行都应被标记');
});

test('正文段落不会被误判为代码块', () => {
  const prose = [];
  for (let i = 0; i < 6; i++) {
    prose.push(line('这是一句普通的正文内容占据了页面宽度并且语义完整没有语法标记。', 56, 600 - i * 18, { h: 11, font: 'body' }));
  }
  const page = { pageNumber: 3, lines: prose };
  detectCodeBlocks([page]);
  assert.ok(prose.every(l => !l.codeBlock), '正文不应被标记');
});

test('同字体的长段落即使字号最小也不得靠字体簇判成代码', () => {
  // Regression: body + headings share one font on the page; the smallest
  // size IS the body size. "dominant single font" alone would fence it.
  const prose = [];
  for (let i = 0; i < 5; i++) {
    prose.push(line('这是一段正常的项目建设内容正文占据页面大部分宽度且语义完整。', 90, 600 - i * 18, { h: 10.5, font: 'same' }));
  }
  // A heading in the same font, larger size.
  prose.push(line('一、项目目标', 90, 700, { h: 14, font: 'same' }));
  detectCodeBlocks([{ pageNumber: 9, lines: prose }]);
  assert.ok(prose.every(l => !l.codeBlock), '正文与标题共用字体时不应判成代码块');
});

test('短行专属字体仍判成代码块（含无语法信号的纯数据行）', () => {
  const code = [
    line('type slice struct {', 82, 500, { h: 9.9, font: 'mono' }),
    line('ptr *T', 93, 484, { h: 9.9, font: 'mono' }),
    line('len int', 93, 468, { h: 9.9, font: 'mono' }),
    line('}', 82, 452, { h: 9.9, font: 'mono' }),
  ];
  const body = [];
  for (let i = 0; i < 4; i++) {
    body.push(line('这是一段普通的正文内容占据页面大部分宽度语义完整没有语法标记。', 90, 700 - i * 20, { h: 11, font: 'body' }));
  }
  detectCodeBlocks([{ pageNumber: 1, lines: [...body, ...code] }]);
  assert.ok(code.every(l => l.codeBlock), '短行专属等宽字体应整体成块');
  assert.ok(body.every(l => !l.codeBlock), '正文不应被带入代码块');
});

function codeLine(text, x, y) {
  return {
    text, x, y, right: x + text.length * 9, height: 9.9, fontSize: 9.9,
    fontName: 'mono', fonts: ['mono'], dropped: false, codeBlock: 'p1-bg0',
    codeText: text,
    items: [{ str: text, transform: [1, 0, 0, 1, x, y], width: text.length * 9 }],
  };
}

// Wrapped prompt lines pasted into a PDF: a physical line that reaches the
// block's right edge without ending punctuation is a soft wrap and must be
// joined to the next line. Comma / 顿号 are mid-sentence pauses (NOT endings),
// so they join too; only sentence terminals (。！？；：!?;:) end a line.
test('代码块内接近全宽的折行合并；逗号和顿号不是结束符号，继续合并', () => {
  const prompt = [
    '@product-prd 请基于以下结构化功能清单撰写PRD内容，严格',
    '遵循微交互状态机要求，',
    '明确各功能的微交互流程、异常边界约束；同时对微交',
    '互状态转换、',
    '核心业务流程生成PlantUML代码，符合说明书的',
    '标准结构。',
  ];
  const rect = { x1: 56, y1: 60, x2: 520, y2: 200, w: 464, h: 140 };
  const lines = prompt.map((text, i) => {
    // Emulate the real layout: wrapped lines are near-full width, complete
    // short lines stop well before the right edge.
    const full = /严格$|微交$|的$/.test(text);
    const width = full ? 462 : (text.length * 9.9 * 0.9);
    return {
      ...codeLine(text, 82, 190 - i * 18), bgBlock: 0, codeBlock: 'p1-bg0',
      codeText: text, right: 82 + width,
    };
  });
  const md = render2([{ pageNumber: 1, lines, bgRects: [rect], tables: [], images: [], pageHeight: 842 }]);
  // 逗号（，）/ 顿号（、）/ 无标点但顶到右缘的折行全部接回，合为一句。
  // 句末的 ； 在物理行中间（该行以“微交”结尾），不构成断句；只有最后的 。 收尾。
  assert.match(md, /```txt\n@product-prd 请基于以下结构化功能清单撰写PRD内容，严格遵循微交互状态机要求，明确各功能的微交互流程、异常边界约束；同时对微交互状态转换、核心业务流程生成PlantUML代码，符合说明书的标准结构。\n```/);
});

test('代码块内真正的代码行（括号/冒号/注释）不被折行合并', () => {
  const code = [
    'status: applied',
    'created: 2026-05-18',
    '{',
    '"url": "http://x"',
    '// comment',
    '  indented => 值',
  ];
  const lines = code.map((text, i) => ({
    ...codeLine(text, 82, 190 - i * 18), bgBlock: 0, codeBlock: 'p1-bg0',
    codeText: text, right: 82 + Math.max(text.length, 40) * 9.9 * 0.9, // wide enough to pass width gate; syntax gates must reject
  }));
  const md = render2([{ pageNumber: 1, lines, bgRects: [{ x1: 56, y1: 60, x2: 520, y2: 200, w: 464, h: 140 }], tables: [], images: [], pageHeight: 842 }]);
  for (const l of code) assert.ok(md.includes(l.trim()), `代码行 "${l}" 不应被合并`);
});

test('代码块内短行（未达块宽）即使无标点也不合并', () => {
  const wide = { ...codeLine('CONFIG_BLOCK_WIDTH_MARKER_XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX', 82, 215), codeText: 'CONFIG_BLOCK_WIDTH_MARKER_XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX', right: 82 + 462 };
  const lines = [wide, ...['第一行较短。', '第二行也短。'].map((text, i) => ({
    ...codeLine(text, 82, 190 - i * 18), bgBlock: 0, codeBlock: 'p1-bg0',
    codeText: text, right: 82 + text.length * 9.9 * 0.9, // ~90pt, far from 464
  }))];
  const md = render2([{ pageNumber: 1, lines, bgRects: [{ x1: 56, y1: 60, x2: 520, y2: 200, w: 464, h: 140 }], tables: [], images: [], pageHeight: 842 }]);
  assert.match(md, /第一行较短。\n第二行也短。/);
});

// The full set of statement-ending symbols (Chinese and English) closes a
// code-block prose line; comma/顿号 do not. Each ending symbol below must
// keep the following line separate, while comma/顿号 must join it back.
test('结束符号完整定义：中英文句号问号感叹号分号冒号断句，逗号顿号不断句', () => {
  const endings = ['。', '．', '.', '？', '?', '！', '!', '；', ';', '：', ':', '…', '”', '）'];
  const rect = { x1: 56, y1: 60, x2: 520, y2: 600, w: 464, h: 540 };
  let y = 580;
  for (const mark of endings) {
    const lines = [
      { ...codeLine(`第一句陈述内容${mark}`, 82, y), bgBlock: 0, codeBlock: `p1-e${y}`, codeText: `第一句陈述内容${mark}`, right: 82 + 462 },
      { ...codeLine(`下一句另起一行${mark}`, 82, y - 18), bgBlock: 0, codeBlock: `p1-e${y}`, codeText: `下一句另起一行${mark}`, right: 82 + 462 },
    ];
    const md = render2([{ pageNumber: 1, lines, bgRects: [rect], tables: [], images: [], pageHeight: 842 }]);
    assert.ok(md.includes(`第一句陈述内容${mark}\n下一句另起一行${mark}`),
      `结束符号 "${mark}" 应当断句，不应合并`);
    y -= 40;
  }
  // 逗号 / 顿号结尾：短行也必须接回下一行（它们是句中停顿，不是结束）
  for (const mark of ['，', ',', '、']) {
    const lines = [
      { ...codeLine(`半句暂停${mark}`, 82, y), bgBlock: 0, codeBlock: `p1-c${y}`, codeText: `半句暂停${mark}`, right: 82 + 100 },
      { ...codeLine('后半句继续。', 82, y - 18), bgBlock: 0, codeBlock: `p1-c${y}`, codeText: '后半句继续。', right: 82 + 100 },
    ];
    const md = render2([{ pageNumber: 1, lines, bgRects: [rect], tables: [], images: [], pageHeight: 842 }]);
    assert.ok(md.includes(`半句暂停${mark}后半句继续。`),
      `停顿符号 "${mark}" 不应断句，应合并到下一行`);
    y -= 40;
  }
});
