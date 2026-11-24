import { test } from 'node:test';
import assert from 'node:assert/strict';
import { projectItemsToGrid, cellGridTables, foldMergedCellTails } from '../src/cellgrid.js';

function item(str, x, y, width = str.length * 8) {
  return { str, width, transform: [1, 0, 0, 1, x, y] };
}

// Some PDF generators put a text baseline exactly on a shared cell edge (the
// rectangle border between two rows). Each item must land in ONE logical row:
// the old per-row ±3pt test wrote it into both, producing "0 1" / "91 90".
test('baseline 落在共享行边界上时单元格不重复', () => {
  const items = [
    item('0', 100, 780), item('91', 200, 780),
    item('1', 100, 760), item('90', 200, 760),
    item('2', 100, 740), item('88', 200, 740),
  ];
  const rows = projectItemsToGrid(items, [90, 190, 290], [800, 780, 760, 740, 720]);
  assert.deepEqual(rows.slice(0, 3), [['0', '91'], ['1', '90'], ['2', '88']]);
  assert.deepEqual(rows[3], ['', '']);
});

test('同一行的多个数值 item 仍按列分割', () => {
  const items = [
    item('45', 100, 680), item('268.52', 200, 680), item('164.73', 300, 680),
    item('46', 100, 660), item('292.73', 200, 660), item('179.62', 300, 660),
  ];
  const rows = projectItemsToGrid(items, [90, 190, 290, 390], [700, 680, 660, 640]);
  assert.deepEqual(rows.slice(0, 2), [
    ['45', '268.52', '164.73'],
    ['46', '292.73', '179.62'],
  ]);
});

test('单个 item 打包多列数值时仍拆分到各列', () => {
  // One PDF run spanning 3 columns: centre of each token sits in its own
  // column band ([90,190],[190,290],[290,390]).
  const str = '144.89 114.24 91.91';
  const items = [{ str, width: 240, transform: [1, 0, 0, 1, 110, 680] }];
  const rows = projectItemsToGrid(items, [90, 190, 290, 390], [700, 680, 660]);
  assert.deepEqual(rows[0], ['144.89', '114.24', '91.91']);
});

test('数值行基线靠近共享行边（未压线）时也不重复到相邻行', () => {
  // The screenshot case: baselines sit ~2pt from each shared edge, within the
  // tolerant +/-3pt band, so the old test wrote every numeric cell into BOTH
  // neighbouring rows: "01"/"9190"/"12"/"9088" sliding duplicates.
  // Baselines 2pt ABOVE each shared edge (782/762/742) — inside their own
  // band but within +/-3pt of the edge below, so rowBands() returns two rows.
  const items = [
    item('0', 100, 782), item('91', 200, 782),
    item('1', 100, 762), item('90', 200, 762),
    item('2', 100, 742), item('88', 200, 742),
  ];
  const rows = projectItemsToGrid(items, [90, 190, 290], [800, 780, 760, 740, 720]);
  assert.deepEqual(rows.slice(0, 3), [['0', '91'], ['1', '90'], ['2', '88']]);
  assert.deepEqual(rows[3], ['', '']);
});

test('数值行靠下边（压线）仍归入上方行，不产生滑动重复', () => {
  // Baselines exactly on shared edges: still one row only, assigned to the
  // band ABOVE the edge (PDF baseline hugs its own cell's bottom border).
  const items = [
    item('0', 100, 780), item('91', 200, 780),
    item('1', 100, 760), item('90', 200, 760),
  ];
  const rows = projectItemsToGrid(items, [90, 190, 290], [800, 780, 760, 740]);
  assert.deepEqual(rows.slice(0, 2), [['0', '91'], ['1', '90']]);
});

test('跨行文本仍按容差写入各行带，不误伤合并单元格', () => {
  // "软件更新与技术支持" spans several rows in test.pdf; its fragments are
  // stacked text items. They must stay visible in every band they touch.
  const items = [
    item('更 新', 100, 762), item('与 技', 100, 742), item('术 支', 100, 722),
  ];
  const rows = projectItemsToGrid(items, [90, 190], [800, 780, 760, 740, 720]);
  assert.deepEqual(rows[1], ['更新']);
  assert.deepEqual(rows[2], ['更新与技']);
  assert.deepEqual(rows[3], ['与技术支']);
});

// A short numeric followed by a CJK unit ("3年交") whose bounding-box
// centre drifts left of the column edge must stay in ONE cell. The old
// centre-only placement split it into "3" + "年交" in adjacent columns.
test('数字+汉字单元的 glyph 起点落在格内时不跨列拆分', () => {
  const items = [
    item('交费期间年龄', 100, 700, 60),
    item('3年交', 203, 700, 26),   // centre 216 -> old rule puts it in col0; start 203 keeps col1
    item('5年交', 305, 700, 26),
  ];
  const rows = projectItemsToGrid(items, [90, 200, 300, 400], [720, 690]);
  assert.deepEqual(rows[0], ['交费期间年龄', '3年交', '5年交']);
});

// Decorative/shaded rectangles over a prose paragraph produce a handful of
// large boxes, not the dense per-cell tiling of a real table. They must not
// be turned into a Markdown table that chops sentences into fake columns.
function rectOps(rects) {
  const fnArray = [], argsArray = [];
  for (const r of rects) {
    fnArray.push(OPS.save, OPS.constructPath, OPS.restore);
    argsArray.push([], [[19], [...r]], []);
  }
  return { fnArray, argsArray };
}
const OPS = { save: 10, restore: 11, constructPath: 91 };

test('少量背景矩形覆盖正文段落时不误判为表格', () => {
  const items = [item('责任免除的情形包括故意杀害、故意伤害被保险人等，不承担保险金责任。', 70, 700, 400)];
  const rects = [
    [60, 650, 480, 30], [60, 620, 480, 30], [60, 590, 480, 30],
    [60, 650, 160, 90], [220, 650, 160, 90], [380, 650, 160, 90],
  ];
  const result = cellGridTables(rectOps(rects), OPS, items);
  assert.equal(result.tables.length, 0);
});

test('真正的单元格网格仍被识别为表格', () => {
  const items = [item('内容', 70, 690, 30)];
  const rects = [];
  for (let ri = 0; ri < 3; ri++) for (let ci = 0; ci < 3; ci++) rects.push([60 + ci * 100, 700 - ri * 30, 100, 30]);
  const result = cellGridTables(rectOps(rects), OPS, items);
  assert.equal(result.tables.length, 1);
});

// A vertically merged cell drawn as one tall rectangle carries stacked text
// fragments. The last fragment sits just below an internal row edge, so the
// baseline projection splits "软件更新与技术支持" into "...技术支" + "持"
// across two rows. The full text must be folded back into one cell.
test('跨行合并单元格末尾单字不被拆到下一行', () => {
  // Real geometry from test1.pdf: col0 merged rect 84..118.5 x 610..380.1
  // spans rows 2..4; the baseline projection left the last fragment ("持")
  // alone in row 4 after "软件更新与技术支" in row 3.
  const xs = [84.0, 118.4, 182.9, 516.0];
  const ys = [720.0, 652.0, 610.1, 548.1, 464.5, 380.1];
  const rect = { x: 84.0, x2: 118.5, y: 610.0, y2: 380.1 };
  const fragments = ['软 件', '更 新', '与 技', '术 支', '持'];
  const ysItem = [546.8, 525.2, 503.6, 482.0, 460.3];
  const items = fragments.map((str, i) => ({
    str, width: str.length * 11, transform: [1, 0, 0, 1, 90, ysItem[i]],
  }));
  const rows = [
    ['产品', '产品咨询', '…'],
    ['使用', '故障响应', '…'],
    ['软件', '缺陷修复', '…'],
    ['软件更新与技术支', '软件更新授权', '…'],
    ['持', '远程服务巡检', '…'],
  ];
  foldMergedCellTails(rows, xs, ys, [rect], items);
  assert.equal(rows[3][0], '软件更新与技术支持');
  assert.equal(rows[4][0], '');
});
