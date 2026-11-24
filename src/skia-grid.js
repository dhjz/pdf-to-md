/**
 * Skia/Chrome draws table borders as thin filled rectangles (0.5–1pt) walked
 * along each cell edge, not as moveTo/lineTo rules. This detector reconstructs
 * a grid from those line segments. It is a fallback only — pages already
 * carrying a vector or borderless table never invoke it — so legacy PDFs keep
 * their existing output byte-for-byte.
 */
import { projectItemsToGrid } from './cellgrid.js';
import { mul, apply, cluster as clusterValues } from './geom.js';

// Local cluster keeps the original descending order for y-band iteration.
const cluster = (values, tol) => clusterValues(values, tol, { desc: true });

/** Gather thin horizontal/vertical segments in pdf.js text-baseline space. */
function thinSegments(opList, OPS, pageWidth = 595, pageHeight = 842) {
  const h = [], v = [], stack = [];
  let ctm = [1, 0, 0, 1, 0, 0];
  for (let i = 0; i < opList.fnArray.length; i++) {
    const fn = opList.fnArray[i];
    if (fn === OPS.save) { stack.push([...ctm]); continue; }
    if (fn === OPS.restore) { ctm = stack.pop() || ctm; continue; }
    if (fn === OPS.transform) { ctm = mul(ctm, opList.argsArray[i]); continue; }
    if (fn !== OPS.constructPath) continue;
    const [ops, shapes] = opList.argsArray[i];
    const rects = shapes.length && typeof shapes[0] === 'number' ? [shapes] : shapes;
    for (let j = 0; j < rects.length; j++) {
      const r = rects[j];
      if (!Array.isArray(r) || r.length < 4) continue;
      const op = ops.length === 1 ? ops[0] : ops[j];
      if (op !== (OPS.rectangle ?? 19)) continue;
      const [x, y, w, hh] = r;
      if (w > 480 && hh > 700) continue; // page frame
      const a = apply(ctm, x, y), b = apply(ctm, x + w, y + hh);
      const x1 = Math.min(a[0], b[0]), x2 = Math.max(a[0], b[0]);
      const y1 = Math.min(a[1], b[1]), y2 = Math.max(a[1], b[1]);
      if (x1 < -2 || x2 > pageWidth + 2 || y1 < -2 || y2 > pageHeight + 2) continue;
      if (y2 - y1 <= 3 && x2 - x1 >= 12) h.push({ y: (y1 + y2) / 2, x1, x2 });
      else if (x2 - x1 <= 3 && y2 - y1 >= 8) v.push({ x: (x1 + x2) / 2, y1, y2 });
    }
  }
  return { h, v };
}

/**
 * Detect one grid from a run of horizontal line bands whose segments tile the
 * same left..right span, plus verticals crossing that band. Returns tables in
 * the same shape as cellgrid.js so render2 can project text the usual way.
 */
export function skiaGridTables(opList, OPS, items, options = {}) {
  const { h, v } = thinSegments(opList, OPS, options.pageWidth, options.pageHeight);
  if (h.length < 4 || v.length < 4) return [];
  const tables = [];

  // Group horizontal segments into y bands.
  const yBands = [];
  for (const y of cluster(h.map(s => s.y), 2.5)) {
    const segs = h.filter(s => Math.abs(s.y - y) <= 2.5).sort((a, b) => a.x1 - b.x1);
    // Segments must tile a span (max gap <= 6pt) so scattered underlines and
    // decorative bars are rejected.
    const merged = [];
    for (const s of segs) {
      const last = merged[merged.length - 1];
      if (last && s.x1 - last.x2 <= 6) last.x2 = Math.max(last.x2, s.x2);
      else merged.push({ x1: s.x1, x2: s.x2 });
    }
    for (const m of merged) if (m.x2 - m.x1 >= 100) {
      const splits = [...new Set(segs.filter(s => s.x1 >= m.x1 - 2 && s.x2 <= m.x2 + 2).flatMap(s => [s.x1, s.x2]))]
        .sort((a, b) => a - b);
      yBands.push({ y, left: m.x1, right: m.x2, splits });
    }
  }
  if (yBands.length < 3) return [];

  // Group horizontal bands into tables. Bands sorted top-to-bottom; split when
  // the vertical gap is large or the column split pattern changes — distinct
  // tables on one page often share the same left/right outer border.
  const bands = yBands.sort((a, b) => b.y - a.y);
  const groups = [];
  let group = [bands[0]];
  for (let i = 1; i < bands.length; i++) {
    const b = bands[i], prev = bands[i - 1];
    const gap = prev.y - b.y;
    const sameSpan = Math.abs(b.left - prev.left) <= 8 && Math.abs(b.right - prev.right) <= 8;
    // Compare column-split structure by edge positions, not raw segment count:
    // a shared border is often drawn twice where two tables meet.
    const sameCols = b.splits.length === prev.splits.length &&
      b.splits.every((x, i) => Math.abs(x - prev.splits[i]) <= 6);
    if (!sameSpan || gap > 130 || !sameCols) { groups.push(group); group = []; }
    group.push(b);
  }
  groups.push(group);

  for (const g of groups) {
    if (g.length < 3) continue;
    const top = Math.max(...g.map(b => b.y)), bottom = Math.min(...g.map(b => b.y));
    if (top - bottom < 25) continue;
    const left = Math.min(...g.map(b => b.left)), right = Math.max(...g.map(b => b.right));
    if (right - left < 120) continue;
    // Column boundaries from verticals that actually walk this band's rows.
    const xs = cluster(v.filter(s => s.y1 <= top + 3 && s.y2 >= bottom - 3
      && s.x >= left - 4 && s.x <= right + 4).map(s => s.x), 3).sort((a, b) => a - b);
    if (xs.length < 3 || xs[0] > left + 8 || xs[xs.length - 1] < right - 8) continue;
    const ys = [...new Set(g.map(b => b.y))].sort((a, b) => b - a);
    if (ys.length < 3) continue;
    const cells = (ys.length - 1) * (xs.length - 1);
    // A real grid walks most cell edges; a decorative box touches only a few.
    if (h.length + v.length < cells * 0.5) continue;
    const rows = projectItemsToGrid(items, xs, ys);
    tables.push({ top: ys[0], bottom: ys[ys.length - 1], left: xs[0], right: xs[xs.length - 1],
      colEdges: xs, rowEdges: ys, rows, source: 'skia-grid' });
  }
  return tables;
}
