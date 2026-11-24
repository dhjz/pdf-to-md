import { test } from 'node:test';
import assert from 'node:assert/strict';
import { twoColumnSplit, applyReadingOrder, isProseTable } from '../src/index.js';
import { classifyHeading, isProseRows } from '../src/render2.js';

function line(str, x, y, width) {
  return { text: str, x, y, right: x + width, width, dropped: false };
}

// --- Problem 1: two-column reading order -------------------------------- ---
test('双栏页面：标题置顶，先左栏后右栏', () => {
  const lines = [
    line('Paper Title', 117, 760, 364),            // full-width title
    line('Author', 122, 702, 357),
  ];
  for (let i = 1; i <= 10; i++) {
    lines.push(line('L' + i, 90, 600 - i * 20, 180));
    lines.push(line('R' + i, 310, 595 - i * 20, 180));
  }
  const split = twoColumnSplit(lines, 595);
  assert.ok(split, 'should detect two columns');
  const ordered = applyReadingOrder(lines, split);
  const seq = ordered.map(l => l.text);
  // Title/author stay at top
  assert.equal(seq[0], 'Paper Title');
  assert.equal(seq[1], 'Author');
  // All left-column lines come before all right-column lines, each top-to-bottom
  assert.deepEqual(seq.slice(2), [
    'L1', 'L2', 'L3', 'L4', 'L5', 'L6', 'L7', 'L8', 'L9', 'L10',
    'R1', 'R2', 'R3', 'R4', 'R5', 'R6', 'R7', 'R8', 'R9', 'R10',
  ]);
  assert.ok(ordered.every((l, i) => l.readSeq === i), 'readSeq assigned in order');
});

test('单栏页面不触发双栏重排', () => {
  const lines = [];
  for (let i = 0; i < 20; i++) lines.push(line('正文 ' + i, 90, 700 - i * 20, 200));
  assert.equal(twoColumnSplit(lines, 595), null);
});

// --- Problem 2: false tables -----------------------------------------------
test('段落长文本的伪表格被拒绝', () => {
  const rows = [['', '', ''], ['', '', 'A'.repeat(300)]];
  assert.equal(isProseRows(rows, 4), true);
  assert.equal(isProseTable({ rows, colEdges: [0, 1, 2, 3] }), true);
});

test('真实数据表（短单元格）保留', () => {
  const rows = [['名称', '值', '备注'], ['A', '1.5', '正常'], ['B', '2.3', '偏高']];
  assert.equal(isProseRows(rows, 3), false);
  assert.equal(isProseTable({ rows, colEdges: [0, 1, 2, 3] }), false);
});

test('空网格被拒绝', () => {
  assert.equal(isProseRows([['', ''], ['', '']], 2), true);
});

// --- Problem 3: numeric false headings -------------------------------------
test('纯数字/百分比/坐标轴刻度不判为标题', () => {
  for (const t of ['0.650', '80.5%', '10.5.', '3.14159', '-4.2', '1,234,567']) {
    assert.equal(classifyHeading(t, null, []), false, t);
  }
});

test('百分比开头的续行不是标题', () => {
  assert.equal(classifyHeading('80.5% (7.7% point absolute improvement)', null, []), false);
});

test('真实编号标题仍判为标题', () => {
  assert.equal(classifyHeading('2.1 系统设计', null, []), true);
  assert.equal(classifyHeading('一、项目目标', null, []), true);
  assert.equal(classifyHeading('（1）需求', null, []), true);
});
