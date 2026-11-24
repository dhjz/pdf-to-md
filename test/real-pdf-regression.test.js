import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { convert } from '../src/index.js';
import { render2 } from '../src/render2.js';

// Regressions found on REAL user-supplied PDFs (Issue #34), not hand-built
// fixtures. Keep these documents: they catch failure modes that constructed
// "answer-driven" tests never surface (dedicated code fonts, mixed-font field
// lists, numbered items at body size, prose wrapping under a table).
const evalDir = new URL('../evaluation/', import.meta.url);
const load = name => new Uint8Array(readFileSync(fileURLToPath(new URL(name, evalDir))));

test('real-guide.pdf: 编号列表项逐行保留，不当标题、不粘连', async () => {
  const { markdown } = await convert(load('real-guide.pdf'));
  const md = markdown.replace(/\u0000/g, '');
  for (const item of [
    '1. 实时预览', '2. 模板切换', '3. 自定义样式', '4. 多格式导出',
  ]) {
    assert.match(md, new RegExp(`^${item.replace('.', '\\.')}`, 'm'), `${item} 应独立成行`);
  }
  assert.doesNotMatch(md, /^##\s+\d+\.\s/m, '正文编号列表项不应被判成标题');
  // Label heading and the quoted body must be separate physical lines; the
  // quote bar turns the latter into a Markdown block quote.
  assert.match(md, /引用块\n\n> 这是一段引用文字/, '引用正文应识别为 Markdown 引用块且与小标题断行');
});

test('real-guide.pdf: 代码块完整闭合、容器内代码保留缩进', async () => {
  const { markdown } = await convert(load('real-guide.pdf'));
  assert.match(markdown, /```javascript\nfunction hello\(\) \{/, '代码块应存在');
  assert.match(markdown, /console\.log\('Hello, Markdown!'\)/);
  assert.match(markdown, /\}\n```/, '闭合花括号应在代码块内');
});

test('real-golang.pdf: 专属等宽字体的代码行整体成块（含纯数据行）', async () => {
  const { markdown } = await convert(load('real-golang.pdf'));
  const md = markdown.replace(/\u0000/g, '');
  // "ptr *T", "len int" carry no lexical signal — they are code only because
  // of their monospace font. A keyword-based detector drops them.
  assert.match(md, /```go\ntype slice struct \{\n(?: {2,})?ptr \*T\n(?: {2,})?len int\n(?: {2,})?cap int\n\}/,
    '纯数据行应随代码块保留');
  assert.match(md, /type CallCenterClient interface \{/, 'interface 代码块应存在');
  assert.doesNotMatch(md, /^- (ptr|len|cap|Dial|Hangup|Transfer)\b/m,
    '代码行不应被误判成 bullet 列表');
});

test('real-golang.pdf: 跨页代码块闭合行并入同一代码块', async () => {
  const { markdown } = await convert(load('real-golang.pdf'));
  const md = markdown.replace(/\u0000/g, '');
  // `func f()` ends on one PDF page, its closing `}` starts the next.
  const m = md.match(/```go\nfunc f\(\) \(result int\) \{[\s\S]*?\n```/);
  assert.ok(m, 'defer 示例应是一个完整代码块');
  assert.match(m[0], /\n\}\n```/, '闭合花括号应并入同一块，而非另起一块');
});

test('real-golang.pdf: 表格不吞掉页面底部的正文段落', async () => {
  const { markdown } = await convert(load('real-golang.pdf'));
  const md = markdown.replace(/\u0000/g, '');
  assert.doesNotMatch(md, /内核\/OS 管理goroutine/,
    '表格最后一个单元格不得吞并后续正文');
  assert.match(md, /Go 通过 GMP 模型/, '被表格吞掉的正文应作为段落保留');
});

test('real-golang.pdf: 标题层级完整（含编号长标题）', async () => {
  const { markdown } = await convert(load('real-golang.pdf'));
  const md = markdown.replace(/\u0000/g, '');
  assert.match(md, /^### 1\.6 interface 底层？nil interface 和 nil 的区别？$/m,
    '编号长标题不应因长度被降级为正文');
  assert.match(md, /^## 一、语言基础/m);
  assert.match(md, /^#### 参考答案/m);
});

test('test.pdf: 正文段落（与标题同字体、最小字号）不得被误判为代码块', async () => {
  // Word/WPS documents print body + headings in the SAME font, and the body
  // size can be the smallest on the page. The font-cluster code detector must
  // not fence these long paragraphs just because they share one font.
  const { markdown } = await convert(load('test.pdf'));
  const md = markdown.replace(/\u0000/g, '');
  assert.doesNotMatch(md, /```txt\n\s*本项目主要在某证券客户 APP 中构建/,
    '项目目标正文段落不应被包成代码块');
  assert.match(md, /^本项目主要在某证券客户 APP 中构建[^\n]*完善的 AI 服务能力/m,
    '正文应作为普通段落逐字输出');
  // No fences at all in this prose document (it has no real code blocks).
  assert.equal((md.match(/```/g) || []).length, 0,
    '纯文档不应出现任何代码块围栏');
});

// Issue #34 "越改问题越多" batch: regressions introduced by the code-font /
// inline-number work on real user PDFs. Each assertion pins ONE symptom from
// the eight screenshots so the next refactor cannot silently reintroduce it.

test('v2v2.pdf: 一级编号标题 (大字) 不因字号簇缺失被降级为正文', async () => {
  // "5. 案例demo" is 18.7pt and occurs once, so it never forms a >=2 line
  // heading-size cluster. It must still be a heading, not fall back to body.
  const { markdown } = await convert(load('v2v2.pdf'));
  assert.match(markdown, /^## 5\. 案例demo/m, '唯一出现的大字号一级标题应保留为 H2');
});

test('v2v2.pdf: AGENTS.md 大纲作为 markdown 源码输出成代码块，不是标题', async () => {
  const { markdown } = await convert(load('v2v2.pdf'));
  const fence = markdown.match(/```txt\n(# 生产管理域交付平台[\s\S]*?## 8\. 交付与提交约定[^\n]*)\n```/);
  assert.ok(fence, '连续的 # / ## 大纲行应被包成一个 fenced 代码块');
  const block = fence[1];
  for (const h of ['# 生产管理域交付平台', '## 1. 项目概述与业务边界', '## 2. 架构与目录职责', '## 8. 交付与提交约定']) {
    assert.ok(block.split('\n').some(l => l.startsWith(h)), `代码块内应逐行保留源码: ${h}`);
  }
  // It is literal source, not live headings: the # lines all sit inside one
  // fenced block (proven by the regex above), never as standalone headings.
  assert.doesNotMatch(markdown, /项目说明书 （AGENTS\.md）## 1\./,
    '连续的 # / ## 源码行不得被 reflow 粘成一行');
});

test('sample.pdf: 项目符号与步骤序号不被拆成独立行', async () => {
  const { markdown } = await convert(load('sample.pdf'));
  assert.doesNotMatch(markdown, /^•\s*$/m, 'bullet 不得独占一行');
  assert.doesNotMatch(markdown, /^\d\s*$/m, '步骤序号不得独占一行');
  assert.match(markdown, /•无序项二:检查表格列数。/, 'bullet 应粘回其标注行');
});

test('sample.pdf: 无线费率表数字行不成代码块（年龄列非行号）', async () => {
  const { markdown } = await convert(load('sample.pdf'));
  assert.match(markdown, /\| 18 \| 25\.86 \|/, '费率数据应输出为 Markdown 表格');
  assert.doesNotMatch(markdown, /```txt\n年龄 男3年[\s\S]*25\.86 26\.00/,
    '年龄列连续递增不得被当成行号，整表不得塌陷成代码块');
});

test('real-guide.pdf: /Link 注释还原为 Markdown 链接', async () => {
  const { markdown } = await convert(load('real-guide.pdf'));
  for (const [label, url] of [
    ['Vue.js 官方文档', 'https://vuejs.org/'],
    ['Element Plus 组件库', 'https://element-plus.org/'],
    ['Marked.js 解析库', 'https://marked.js.org/'],
  ]) {
    assert.match(markdown, new RegExp(`\\[${label.replace('.', '\\.')}\\]\\(${url.replaceAll('.', '\\.')}\\)`),
      `${label} 应由 PDF 链接注释还原为 Markdown 链接`);
  }
});


test('real-golang.pdf: defer 讲解里的单行代码（完整背景色块）各自成代码块', async () => {
  // The three code lines ("2", "result = 1", "result++") are printed one per
  // full-width rounded gray bar between prose. They carry no syntax signal
  // and form no multi-line group, so only the shaded-bar signal can recover
  // them. Their font is the page's dedicated code face; prose on similar
  // bars (the quote/callout) must stay prose.
  const { markdown } = await convert(load('real-golang.pdf'));
  const md = markdown.replace(/\u0000/g, '');
  assert.match(md, /返回值是[：:]\n\n```txt\n2\n```/, '返回值 2 应是单行代码块');
  assert.match(md, /给命名返回变量赋值[：:]\n\n```txt\nresult = 1\n```/, 'result = 1 应是单行代码块');
  assert.match(md, /然后执行 defer[：:]\n\n```txt\nresult\+\+\n```/, 'result++ 应是单行代码块');
  // The verbatim defer function and its closing brace remain one block.
  assert.match(md, /```go\nfunc f\(\) \(result int\) \{[\s\S]*?\n\}\n```/);
  // Quote block on a similar bar must not be turned into code.
  assert.match(md, /^> 资源获取之后立刻登记释放动作/m, '引用块不应被误判成代码块');
});

test('同一链接内的独立空格 item 不打断链接分组', () => {
  const item = (str, x, url) => ({
    str, width: str.length * 6, transform: [1, 0, 0, 1, x, 700], ...(url ? { linkUrl: url } : {}),
  });
  const line = {
    text: 'OpenAI API', y: 700, x: 0, right: 120, height: 11, fontSize: 11,
    dropped: false,
    items: [
      item('OpenAI', 0, 'https://example.com/docs'),
      item(' ', 36),
      item('API', 42, 'https://example.com/docs'),
    ],
  };
  const md = render2([{ pageNumber: 1, lines: [line], tables: [], images: [], pageHeight: 842, pageWidth: 595 }]);
  assert.match(md, /^\[OpenAI API\]\(https:\/\/example\.com\/docs\)$/m,
    '空格 item 不带 linkUrl 时也应并入两侧同 URL 的链接');
});

test('链接文字与 URL 解耦：只归一化可见文字，不改写 URL', () => {
  const item = (str, x, url) => ({
    str, width: str.length * 6, transform: [1, 0, 0, 1, x, 700], ...(url ? { linkUrl: url } : {}),
  });
  const line = {
    text: '详见“API：说明”', y: 700, x: 0, right: 120, height: 11, fontSize: 11,
    dropped: false,
    items: [
      item('详见“API：说明”', 0, 'https://example.com/a:b?q=中文'),
    ],
  };
  const md = render2([{ pageNumber: 1, lines: [line], tables: [], images: [], pageHeight: 842, pageWidth: 595 }]);
  assert.match(md, /^\[详见"API:说明"\]\(https:\/\/example\.com\/a:b\?q=中文\)$/m,
    '链接文字走标点归一化，URL 保持原样');
});

test('单行的局部链接、同行多链接和含括号 URL 保持精确', () => {
  const item = (str, x, url) => ({
    str, width: str.length * 6, transform: [1, 0, 0, 1, x, 700], ...(url ? { linkUrl: url } : {}),
  });
  const line = {
    text: '详见 官方文档 与 API 说明', y: 700, x: 0, right: 160, height: 11, fontSize: 11,
    dropped: false,
    items: [
      item('详见 ', 0),
      item('官方文档', 24, 'https://docs.example.com'),
      item(' 与 ', 72),
      item('API', 96, 'https://example.com/wiki/Foo_(bar)'),
      item(' 说明', 132),
    ],
  };
  const md = render2([{ pageNumber: 1, lines: [line], tables: [], images: [], pageHeight: 842, pageWidth: 595 }]);
  assert.match(md, /^详见 \[官方文档\]\(https:\/\/docs\.example\.com\) 与 \[API\]\(<https:\/\/example\.com\/wiki\/Foo_\(bar\)>\) 说明$/m,
    '只包裹链接覆盖的文字，同行两个链接都保留，括号 URL 用尖括号保护');
});
