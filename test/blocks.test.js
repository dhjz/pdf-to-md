import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectStandaloneLines } from '../src/blocks.js';

function line(str, x, y, n = 1) {
  const width = str.length * 9;
  return {
    text: str, x, y, right: x + width, height: 9, dropped: false,
    items: Array.from({ length: n }, (_, i) => ({ str: str.slice(i, i + 1), transform: [1, 0, 0, 1, x + i * 9, y], width: 9 })),
  };
}

// Same geometry, completely different vocabulary. If the old business-word
// regexes were still in play these would be reflowed into a paragraph.
test('短行元数据块靠几何识别，与业务词无关', () => {
  const labels = [
    line('客户 企业客户', 49, 592, 6),
    line('产品 标准版', 49, 573, 5),
    line('渠道 线上 线下', 49, 554, 7),
    line('地区 华东 华南 华北', 49, 535, 9),
  ];
  const tableHeader = line('地区 华东 华南 华北 西南 东北 西北 华中', 55, 516, 40);
  const body = line('18 25.86 26.00 26.14 26.29 26.43 26.57 26.71', 55, 500, 22);
  const page = { lines: [line('章节标题', 49, 640), ...labels, tableHeader, body], tableTops: [516] };
  detectStandaloneLines([page]);
  for (const l of labels) assert.equal(l.standalone, true, `应识别为独立行: ${l.text}`);
  assert.equal(tableHeader.standalone, false);
});

test('英文/数字词汇同样按几何识别', () => {
  const labels = [
    line('PLAN A | BASIC', 60, 592, 6),
    line('TERM 20Y', 60, 573, 3),
    line('SEX M F', 60, 554, 3),
  ];
  const table = line('AGE 3Y 5Y 10Y 15Y 20Y 30Y 40Y 50Y 60Y ...', 66, 535, 40);
  detectStandaloneLines([{ lines: [...labels, table], tableTops: [535] }]);
  for (const l of labels) assert.equal(l.standalone, true);
  assert.equal(table.standalone, false);
});

test('普通连续正文不会被误判为独立行', () => {
  // Long lines at the page's normal width are prose, even if evenly spaced.
  const prose = [
    line('这是一句正常的正文内容它占据了页面大部分宽度并且语义完整。', 49, 592, 30),
    line('这是下一句正常的正文内容同样占据了页面大部分宽度且语义完整。', 49, 573, 30),
    line('这是第三句正常的正文内容仍然占据页面宽度构成连续段落文字。', 49, 554, 30),
  ];
  detectStandaloneLines([{ lines: prose }]);
  for (const l of prose) assert.equal(l.standalone, false);
});

test('shell/JSON/图注靠语法标记，与词表无关', () => {
  const code = [
    line('$ curl -X POST http://x/api', 49, 700),
    line('-F "file=doc.pdf"', 49, 689),
    line('{"ok": true}', 49, 678),
    line('图 3:示意图', 49, 600),
  ];
  detectStandaloneLines([{ lines: code }]);
  for (const l of code) assert.equal(l.standalone, true);
});
