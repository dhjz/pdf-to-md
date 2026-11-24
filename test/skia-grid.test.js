import { test } from 'node:test';
import assert from 'node:assert/strict';
import { skiaGridTables } from '../src/skia-grid.js';

// pdf.js operator ids (stable across the versions this project pins).
const OPS = { save: 10, restore: 11, transform: 12, constructPath: 91 };

function thinRect(x, y, w, h) {
  return [91, [[19], [x, y, w, h]]];
}
function toOpList(ops) {
  return { fnArray: ops.map(o => o[0]), argsArray: ops.map(o => o[1]) };
}
function item(str, x, y, width = str.length * 7) {
  return { str, width, transform: [1, 0, 0, 1, x, y] };
}

test('Skia 细矩形边框能还原成表格网格（含 CTM 翻转）', () => {
  // Build a simple page-space grid directly: three horizontal bands, four
  // verticals, each drawn as a thin filled rectangle.
  const ops = [];
  const xs = [60, 160, 260, 360], ys = [700, 660, 620, 580];
  for (const y of ys) {
    for (let c = 0; c < xs.length - 1; c++) ops.push(thinRect(xs[c], y - 0.5, xs[c + 1] - xs[c], 1));
  }
  for (const x of xs) {
    for (let r = 0; r < ys.length - 1; r++) ops.push(thinRect(x - 0.5, ys[r + 1], 1, ys[r] - ys[r + 1]));
  }
  const items = [
    item('A', 65, 688), item('B', 165, 688),
    item('C', 65, 648), item('D', 165, 648),
    item('E', 65, 608), item('F', 165, 608),
  ];
  const tables = skiaGridTables(toOpList(ops), OPS, items, { pageWidth: 595, pageHeight: 842 });
  assert.equal(tables.length, 1);
  assert.equal(tables[0].colEdges.length, 4);
  assert.equal(tables[0].rowEdges.length, 4);
  assert.deepEqual(tables[0].rows.map(r => r.slice(0, 2)), [
    ['A', 'B'], ['C', 'D'], ['E', 'F'],
  ]);
});

test('同页两组不同列结构的网格拆成两张表', () => {
  const ops = [];
  // table 1: x 60..360, 3 rows
  for (const y of [700, 660, 620]) for (let c = 0; c < 3; c++) ops.push(thinRect(60 + c * 100, y - 0.5, 100, 1));
  for (const x of [60, 160, 260, 360]) ops.push(thinRect(x - 0.5, 620, 1, 80));
  // table 2: same outer span, different inner columns, far below
  for (const y of [400, 360, 320]) for (let c = 0; c < 4; c++) ops.push(thinRect(60 + c * 75, y - 0.5, 75, 1));
  for (const x of [60, 135, 210, 285, 360]) ops.push(thinRect(x - 0.5, 320, 1, 80));
  const tables = skiaGridTables(toOpList(ops), OPS, [], { pageWidth: 595, pageHeight: 842 });
  assert.equal(tables.length, 2);
});

test('零散装饰细线不产生表格', () => {
  const ops = [thinRect(60, 700, 120, 1), thinRect(60, 660, 120, 1)];
  assert.equal(skiaGridTables(toOpList(ops), OPS, [], { pageWidth: 595, pageHeight: 842 }).length, 0);
});
