import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateBoundaryRow, foldContinuationHeadRows } from '../src/table-continuation.js';

test('词中截断的中日文片段应合并（mineru_ext 核心场景）', () => {
  const v = evaluateBoundaryRow('| 所属板 | 参数完 |', '| 块 | 整性 |');
  assert.equal(v.merge, true);
  assert.deepEqual(v.cells, ['所属板块', '参数完整性']);
});

test('CJK 词中截断配合分隔符是强证据', () => {
  // 模拟“内容包括以下场/景”被分页切断：第二列以 '：' 结尾，
  // 第三列 CJK 相接；首列不收口，第二列不收口。
  const v = evaluateBoundaryRow('| 所属板块参数完 | 待监控的字段和指 | 当前状', '| 整性检查说明 | 标列表 | 态信息 |');
  assert.equal(v.merge, true);
  assert.ok(v.score >= 3);
});

test('下页整列缺失时应加分合并', () => {
  const v = evaluateBoundaryRow('| 对象 | 描述 | 备注 |', '| 说明 |  |  |');
  assert.equal(v.merge, true);
});

test('两条独立记录（同列重复）不得合并', () => {
  const v = evaluateBoundaryRow('| 甲 | 100 |', '| 甲 | 200 |');
  assert.equal(v.merge, false);
  assert.match(v.reason, /重复/);
});

test('同模板不同值（编号递增）不得合并', () => {
  const v = evaluateBoundaryRow('| 第1章 | 说明A |', '| 第2章 | 说明B |');
  assert.equal(v.merge, false);
});

test('上页末行除首列外都以标点收口 => 独立记录', () => {
  const v = evaluateBoundaryRow('| 标题 | 汇总。 | 完毕。 |', '| 记录2 | 数据。 | 结束。 |');
  assert.equal(v.merge, false);
});

test('纯数字上下两行不得合并', () => {
  const v = evaluateBoundaryRow('| 2023 | 100 |', '| 2024 | 200 |');
  assert.equal(v.merge, false);
});

test('下页首行以独立行首短语开头不得合并', () => {
  const v = evaluateBoundaryRow('| 需求 | 描述 |', '| 提供 | 支持能力 |');
  assert.equal(v.merge, false);
});

test('严格模式无强证据不合并', () => {
  const v = evaluateBoundaryRow('| 前面内容很长 | 另外内容很长 |', '| 后面内容 | 续写内容 |', { strict: true });
  assert.equal(v.merge, false);
  assert.match(v.reason, /严格模式/);
});

test('续表首行折行合并：仅一列有内容', () => {
  const prev = ['| 项目 | 说明 |', '| --- | --- |', '| 所属板 | 内容 |'];
  const next = ['| 块 |  |', '| 下一行 | 其他 |'];
  const r = foldContinuationHeadRows(prev, next);
  assert.equal(r.folded, 1);
  assert.deepEqual(r.rows, ['| 下一行 | 其他 |']);
  assert.match(r.prevRows.at(-1), /所属板块/);
});

test('折行以“合计”开头时不得合并', () => {
  const prev = ['| 项目 | 说明 |', '| --- | --- |', '| 内容 | 说明 |'];
  const next = ['| 合计 |  |', '| 下一行 | 其他 |'];
  const r = foldContinuationHeadRows(prev, next);
  assert.equal(r.folded, 0);
});
