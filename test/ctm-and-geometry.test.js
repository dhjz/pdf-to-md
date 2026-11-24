import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mul, apply, cluster } from '../src/geom.js';
import { cellGridTables } from '../src/cellgrid.js';
import { mergeSplitBoundaryRowsAt, isProseRows } from '../src/render2.js';
import { isProseTable } from '../src/index.js';

const OPS = { save: 10, restore: 11, transform: 12, constructPath: 91, rectangle: 19 };
const toOpList = ops => ({ fnArray: ops.map(o => o[0]), argsArray: ops.map(o => o[1]) });

test('geom mul 遵循右乘约定：Y 翻转后再平移得到 742 而非 942', () => {
  const flip = [1, 0, 0, -1, 0, 842];
  const trans = [1, 0, 0, 1, 0, 100];
  const ctm = mul(flip, trans); // ctm(flip) then a(trans) — the PDF convention
  assert.deepEqual(apply(ctm, 0, 0), [0, 742]);
});

test('geom mul 与逐元素矩阵乘一致（含平移分量）', () => {
  const a = [2, 0, 0, -1, 10, 842];
  const b = [1, 0, 0, 1, 30, 100];
  assert.deepEqual(mul(a, b), [
    2, 0, 0, -1,
    2 * 30 + 10, -1 * 100 + 842,
  ]);
});

test('cluster 升序/降序开关', () => {
  const vals = [10, 11, 50, 51, 52];
  assert.deepEqual(cluster(vals, 2), [10.5, 51]);
  assert.deepEqual(cluster(vals, 2, { desc: true }), [51, 10.5]);
});

test('cellGridTables 在嵌套 Y 翻转+平移 transform 下仍对齐页面文本', () => {
  // ReportLab/LaTeX style: a page Y-flip followed by a translation, both
  // inside save/restore. Rectangles are drawn in that transformed space while
  // text items report final page-space baselines. The CTM must accumulate as
  // mul(ctm, a): the correct chain maps local y=0 to page y=742, whereas the
  // wrong a*ctm order maps it to 942 (off-page, cells never match the text).
  const flip = [1, 0, 0, -1, 0, 842];
  const trans = [1, 0, 0, 1, 0, 100];
  const ctm = mul(flip, trans); // correct: apply flip, then trans
  assert.equal(apply(ctm, 0, 0)[1], 742);

  const project = (x, y) => apply(ctm, x, y);
  const ops = [[OPS.save], [OPS.transform, flip], [OPS.transform, trans]];
  // Grid rectangles in the local (flipped/translated) space.
  const xs = [60, 180, 300], ys = [600, 560, 520];
  const rectArgs = [];
  for (let r = 0; r < ys.length - 1; r++) {
    for (let c = 0; c < xs.length - 1; c++) {
      rectArgs.push([xs[c], ys[r + 1], xs[c + 1] - xs[c], ys[r] - ys[r + 1]]);
    }
  }
  ops.push([OPS.constructPath, [[OPS.rectangle], rectArgs]]);
  ops.push([OPS.restore]);

  // Text items at the projected page-space centres of each cell.
  const items = [];
  const labels = [['A', 'B'], ['C', 'D']];
  for (let r = 0; r < 2; r++) {
    for (let c = 0; c < 2; c++) {
      const [px, py] = project((xs[c] + xs[c + 1]) / 2, (ys[r] + ys[r + 1]) / 2);
      items.push({ str: labels[r][c], width: 10, transform: [1, 0, 0, 1, px, py] });
    }
  }
  const { tables } = cellGridTables(toOpList(ops), OPS, items);
  assert.equal(tables.length, 1, '应还原出一张表格');
  // The Y flip reverses order: local y=560 (C/D) lands above y=600 (A/B).
  assert.deepEqual(tables[0].rows[0], ['C', 'D']);
  assert.deepEqual(tables[0].rows[1], ['A', 'B']);
});

test('续页重复表头 + 跨页断行：剥离表头后首行数据仍与上一页合并', () => {
  const rows = [
    ['名称', '值'], ['单位', '说明'],
    ['服务器配', '高可'],            // split record, first half on previous page
    ['名称', '值'], ['单位', '说明'], // repeated 2-line header on continuation page
    ['置', '用'],                    // second half — must merge with row above
  ];
  const out = mergeSplitBoundaryRowsAt(rows, [3]);
  assert.deepEqual(out, [
    ['名称', '值'], ['单位', '说明'],
    ['服务器配置', '高可用'],
  ]);
});

test('maxTableCellLength 可配置：放行超出默认 200 字的单元格', () => {
  const long = '条'.repeat(260);
  assert.equal(isProseTable({ rows: [['条款', long]], colEdges: [0, 80, 400] }), true);
  assert.equal(isProseTable({ rows: [['条款', long]], colEdges: [0, 80, 400] }, 500), false);
  assert.equal(isProseRows([['条款', long]], 2), true);
  assert.equal(isProseRows([['条款', long]], 2, 500), false);
});
