import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diagnoseNoTextPage } from '../src/index.js';

const base = { textItems: 0, showTextOps: 0, vectorOps: 0, imageOps: 0 };

test('图片型 PDF 给出 OCR 提示', () => {
  assert.match(diagnoseNoTextPage({ ...base, imageOps: 3 }), /纯图片页.*OCR/);
});

test('轮廓文字 PDF 给出矢量路径提示', () => {
  assert.match(diagnoseNoTextPage({ ...base, vectorOps: 20 }), /矢量路径.*OCR/);
});

test('有文本绘制指令但未提取到文字时单独提示', () => {
  assert.match(diagnoseNoTextPage({ ...base, showTextOps: 4 }), /有文本绘制指令.*OCR/);
});

test('空白页给出明确提示', () => {
  assert.match(diagnoseNoTextPage(base), /没有可提取的文字层/);
});
