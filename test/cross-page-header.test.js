import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeSplitBoundaryRows, mergeSplitBoundaryRowsAt, dedupeHeaderRows } from '../src/render2.js';
import { sameTableGrid, alignMergedCells } from '../src/crosspage.js';

test('续页重复表头不得并入上一页末行', () => {
  const rows = [
    ['类型', '配置', '解决什么问题'],
    ['工具调用', '云盘/机器人', '取源数据'],
    ['知识增强', '运维管理规定', '让结论有依据'],
    ['类型', '配置', '解决什么问题'], // continuation-page repeated header
    ['Rules', '各省考核规则', '避免口径混用'],
  ];
  const headerSigs = new Set([rows[0].join('\u0000')]);
  const result = mergeSplitBoundaryRows(rows, 3, headerSigs);
  assert.equal(result.merged, 0);
  assert.deepEqual(result.rows[2], ['知识增强', '运维管理规定', '让结论有依据']);
});

test('续页表头与首行相同时即使结构可拼也不合并', () => {
  const rows = [
    ['列A', '列B'],
    ['末行', '数据'],
    ['列A', '列B'],
  ];
  const result = mergeSplitBoundaryRows(rows, 2, null);
  assert.equal(result.merged, 0);
});

test('真正的跨页断行仍可合并', () => {
  const rows = [
    ['所属板', '参数完'],
    ['块', '整性'],
  ];
  const result = mergeSplitBoundaryRows(rows, 1, new Set());
  assert.equal(result.merged, 1);
  assert.deepEqual(result.rows[0], ['所属板块', '参数完整性']);
});

test('dedupeHeaderRows 保留数值表头去重行为', () => {
  const rows = [
    ['年龄', '费率'],
    ['18', '1.5'],
    ['年龄', '费率'], // repeated
    ['19', '1.6'],
  ];
  assert.deepEqual(dedupeHeaderRows(rows), [rows[0], rows[1], rows[3]]);
});

test('跨页合并单元格表：列边界变化仍可拼接', () => {
  const prev = { colEdges: [84, 182, 516], bottom: 80 };
  const next = { colEdges: [84, 118, 183, 516], top: 720 };
  assert.equal(sameTableGrid(prev, next), true);
});

test('不同页面的相邻表格不会因列数接近而误拼接', () => {
  const prev = { colEdges: [84, 182, 516], bottom: 500 };
  const next = { colEdges: [84, 118, 183, 516], top: 300 };
  assert.equal(sameTableGrid(prev, next), false);
});

test('合并单元格行按最大列数补齐', () => {
  assert.deepEqual(alignMergedCells([['服务内容', '说明']], 3), [['服务内容', '', '说明']]);
});

test('三页表格的两个分页边界都应合并断行', () => {
  const rows = [
    ['职责', '平台侧', '交易域'],
    ['1. 接入', '制定协议', '完成注册'],
    ['2. 网关接入', '负责统一网关与限流熔断', '配合联调，提交异常与回滚用例'],
    ['3. 审计与留痕', '统一审计日志平台、留存期管理', '上报交易草稿，并配合双录留'],
    ['', '', '痕'],
    ['4. 回复生成', '统一生成与合规包装', '返回结构化结果'],
  ];
  const merged = mergeSplitBoundaryRowsAt(rows, [2, 4]);
  assert.deepEqual(merged[2], ['2. 网关接入', '负责统一网关与限流熔断', '配合联调，提交异常与回滚用例']);
  assert.deepEqual(merged[3], ['3. 审计与留痕', '统一审计日志平台、留存期管理', '上报交易草稿，并配合双录留痕']);
  assert.deepEqual(merged[4], ['4. 回复生成', '统一生成与合规包装', '返回结构化结果']);
  assert.equal(merged.length, 5);
});
