import { test } from 'node:test';
import assert from 'node:assert/strict';
import { itemsToLines } from '../src/text.js';

function item(str, x, y, width = str.length * 8, height = 10) {
  return { str, width, height, transform: [1, 0, 0, 1, x, y], fontName: 'F1', dir: 'ltr' };
}

test('按 baseline 聚合成行并按 x 排序', () => {
  const lines = itemsToLines([
    item('世界', 110, 700), item('你好', 100, 700),
    item('第二行', 100, 680),
  ]);
  assert.equal(lines.length, 2);
  assert.equal(lines[0].text, '你好世界');
  assert.equal(lines[1].text, '第二行');
});

test('过滤空白 item', () => {
  const lines = itemsToLines([item('', 100, 700), item('文本', 100, 700)]);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].text, '文本');
});

test(' latin 单词间插入空格，CJK 不插空格', () => {
  const lines = itemsToLines([
    { ...item('Hello', 100, 700, 40), width: 40 },
    { ...item('World', 160, 700, 40), width: 40 },
    { ...item('中文', 220, 700, 20), width: 20 },
    { ...item('接续', 244, 700, 20), width: 20 },
  ]);
  assert.match(lines[0].text, /Hello World/);
  assert.match(lines[0].text, /中文接续/);
});
