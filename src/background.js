/**
 * Browser-printed PDFs often draw code/config/note blocks as one light filled
 * rectangle behind the text. That rectangle is an explicit visual signal —
 * more reliable than font size or keywords, which change from document to
 * document. This module recovers those rectangles from the pdf.js operator
 * stream, in the same coordinate space pdf.js reports text baselines in.
 */

import { mul, apply } from './geom.js';

/** Normalize a fill-color operator's args to 0–255 RGB, or null if unknown. */
function rgb(args, op, OPS) {
  if (!args) return null;
  if (op === OPS.setFillRGBColor) return [args[0] ?? args['0'], args[1] ?? args['1'], args[2] ?? args['2']];
  if (op === OPS.setFillGray) { const g = (args[0] ?? args['0']) * 255; return [g, g, g]; }
  return null; // CMYK/HSB/pattern — keep the rect, geometry still applies.
}
const nearWhite = c => c && c.every(v => Number(v) >= 245);

/** Axis-aligned bounding box of a filled path after CTM (bezier control points
 *  stay inside the box, so rounded corners give the same box as a rectangle). */
function shapeBox(shape, ctm) {
  const xs = [], ys = [];
  for (let k = 0; k + 1 < shape.length; k += 2) {
    const p = apply(ctm, shape[k], shape[k + 1]);
    xs.push(p[0]); ys.push(p[1]);
  }
  if (xs.length < 2) return null;
  const x1 = Math.min(...xs), x2 = Math.max(...xs);
  const y1 = Math.min(...ys), y2 = Math.max(...ys);
  return { x1, y1, x2, y2, w: x2 - x1, h: y2 - y1 };
}

/** A closed path of only move/line/bezier/close ops is a rounded rectangle.
 *  Browser print renders CSS-shaded one-line code bars this way instead of a
 *  literal `rectangle` op. */
function isRoundedBox(ops, OPS) {
  const moveTo = OPS.moveTo ?? 13;
  const lineTo = OPS.lineTo ?? 14;
  const curveTo = OPS.curveTo ?? 15;
  const closePath = OPS.closePath ?? 18;
  const eoFill = OPS.eoFill ?? 23;
  if (!ops.includes(curveTo)) return false;                     // has bezier curves
  if (!ops.includes(closePath) && !ops.includes(eoFill)) return false; // closed
  return ops.every(op => op === moveTo || op === lineTo || op === curveTo ||
    op === closePath || op === eoFill);
}

/** Tag single lines that sit inside a short, full-width shaded bar drawn as a
 *  rounded path. Multi-line blocks and the quote-bar feature are unaffected:
 *  only one-line-height bars (14–45pt) are considered here, and the tag is
 *  consumed solely by the code detector's isolated-line path. */
export function markShadedSingleLines(opList, OPS, lines, options = {}) {
  const pageWidth = options.pageWidth || 595;
  const pageHeight = options.pageHeight || 842;
  // A shaded one-line bar spans the text column, not the whole PDF page.
  // Only treat it as such when the caller can infer a real body span.
  const columnWidth = options.contentWidth;
  const fn = opList.fnArray, args = opList.argsArray;
  let ctm = [1, 0, 0, 1, 0, 0];
  const stack = [], bars = [];
  let color = null;
  for (let i = 0; i < fn.length; i++) {
    const f = fn[i], a = args[i];
    if (f === OPS.save) { stack.push({ ctm: [...ctm], color }); continue; }
    if (f === OPS.restore) {
      const prev = stack.pop();
      if (prev) { ctm = prev.ctm; color = prev.color; }
      continue;
    }
    if (f === OPS.transform) { ctm = mul(ctm, a); continue; }
    if (f === OPS.setFillRGBColor || f === OPS.setFillGray || f === OPS.setFillColor) {
      color = rgb(a, f, OPS); continue;
    }
    if (f !== OPS.constructPath) continue;
    const [ops, shapes] = a;
    if (!isRoundedBox(ops, OPS)) continue;
    const list = shapes.length && typeof shapes[0] === 'number' ? [shapes] : shapes;
    for (const shape of list) {
      if (!Array.isArray(shape) || shape.length < 4) continue;
      const box = shapeBox(shape, ctm);
      if (!box || !color || nearWhite(color)) continue;
      const { x1, y1, x2, y2, w, h } = box;
      if (w < 120 || h < 14 || h > 45) continue;
      // Near-full-width relative to the body column: inline-code chips and
      // table cells stay much narrower than the text span. Without a body
      // span we stay conservative and skip rather than fall back to page size.
      if (!Number.isFinite(columnWidth) || columnWidth <= 0 || w < columnWidth * 0.9) continue;
      if (x2 < -2 || x1 > pageWidth + 2 || y2 < -2 || y1 > pageHeight + 2) continue;
      bars.push(box);
    }
  }
  if (!bars.length) return;
  for (const line of lines) {
    if (line.dropped || !String(line.text || '').trim()) continue;
    const x = line.x ?? line.items?.[0]?.transform?.[4] ?? 0;
    const right = line.right ?? x + (line.items?.[0]?.width || 0);
    for (const b of bars) {
      if (line.y <= b.y2 + 3 && line.y >= b.y1 - 3 && right >= b.x1 - 8 && x <= b.x2 + 8) {
        line.shadedSingle = true;
        break;
      }
    }
  }
}

/**
 * Filled axis-aligned rectangles large enough to back a block of text.
 *
 * Table header cells are drawn as several short rectangles tiled at the same
 * y band; those are dropped so a real grid never turns into a code fence. The
 * page's white background is dropped by the near-white filter.
 */
export function backgroundBlocks(opList, OPS, options = {}) {
  const pageWidth = options.pageWidth || 595;
  const pageHeight = options.pageHeight || 842;
  const fn = opList.fnArray, args = opList.argsArray;
  let ctm = [1, 0, 0, 1, 0, 0];
  const stack = [], rects = [];
  let color = null;

  for (let i = 0; i < fn.length; i++) {
    const f = fn[i], a = args[i];
    if (f === OPS.save) { stack.push({ ctm: [...ctm], color }); continue; }
    if (f === OPS.restore) {
      const prev = stack.pop();
      if (prev) { ctm = prev.ctm; color = prev.color; }
      continue;
    }
    if (f === OPS.transform) { ctm = mul(ctm, a); continue; }
    if (f === OPS.setFillRGBColor || f === OPS.setFillGray || f === OPS.setFillColor) {
      color = rgb(a, f, OPS);
      continue;
    }
    if (f !== OPS.constructPath) continue;
    const [ops, shapes] = a;
    const list = shapes.length && typeof shapes[0] === 'number' ? [shapes] : shapes;
    for (let j = 0; j < list.length; j++) {
      const r = list[j];
      if (!Array.isArray(r) || r.length < 4) continue;
      const op = ops.length === 1 ? ops[0] : ops[j];
      if (op !== (OPS.rectangle ?? 19)) continue; // filled rectangle
      const p1 = apply(ctm, r[0], r[1]);
      const p2 = apply(ctm, r[0] + r[2], r[1] + r[3]);
      const x1 = Math.min(p1[0], p2[0]), x2 = Math.max(p1[0], p2[0]);
      const y1 = Math.min(p1[1], p2[1]), y2 = Math.max(p1[1], p2[1]);
      const w = x2 - x1, h = y2 - y1;
      // Only trust an explicit light fill. Default/unknown-color rects include
      // the content-area frame drawn with the initial fill color, which must
      // not be mistaken for a shaded block (and would merge with real ones).
      if (!color || nearWhite(color)) continue;
      if (w < 120 || h < 14) continue;                 // too small to back a block
      if (h > pageHeight * 1.2) continue;              // overflowing page-size junk
      if (x2 < -2 || x1 > pageWidth + 2 || y2 < -2 || y1 > pageHeight + 2) continue;
      // A real code/note block spans the text column, but a short wide strip
      // (a table rule or header band) must not be treated as one. Keep the
      // original page-frame guard as well.
      if (h <= 60 && w > pageWidth * 0.95) continue;              // wide short strip
      if (w > pageWidth * 0.95 && h > pageHeight * 0.85) continue; // page frame
      rects.push({ x1, y1, x2, y2, w, h });
    }
  }

  // The same rect is often emitted several times; collapse exact duplicates
  // before deciding whether a y band is one shaded block or a row of cells.
  const unique = [];
  for (const r of rects) {
    if (unique.some(u => Math.abs(u.x1 - r.x1) < 2 && Math.abs(u.y1 - r.y1) < 2 &&
        Math.abs(u.x2 - r.x2) < 2 && Math.abs(u.y2 - r.y2) < 2)) continue;
    unique.push(r);
  }
  // Distinct rectangles sharing a y band tile a row (table header cells,
  // underlines). A shaded code/note block is a single wide rect on its band.
  const sorted = unique.sort((a, b) => a.y1 - b.y1);
  const bands = [];
  for (const r of sorted) {
    const band = bands.find(b => Math.abs(b.y - r.y1) <= 3);
    if (band) { band.items.push(r); }
    else bands.push({ y: r.y1, items: [r] });
  }
  return bands.filter(b => b.items.length === 1).map(b => b.items[0]);
}

/** Tag lines whose baseline sits inside a background rectangle. */
export function markBackgroundLines(lines, rects) {
  for (const line of lines) {
    if (line.dropped || !String(line.text || '').trim()) continue;
    const x = line.x ?? line.items?.[0]?.transform?.[4] ?? 0;
    const right = line.right ?? x + (line.items?.[0]?.width || 0);
    for (let i = 0; i < rects.length; i++) {
      const r = rects[i];
      // In text-baseline space larger y is higher; rect y2 is the top edge.
      if (line.y <= r.y2 + 3 && line.y >= r.y1 - 3 && right >= r.x1 - 8 && x <= r.x2 + 8) {
        line.bgBlock = i;   // first (outermost) rect wins
        break;
      }
    }
  }
}


/**
 * Thin filled vertical bars used as quote/callout markers.
 *
 * These are deliberately separate from `backgroundBlocks`: a quote marker is
 * 1–8pt wide, not a wide rectangle behind text. Detection is geometry-only —
 * a coloured narrow bar with text immediately to its right, on the same y
 * band. It never inspects the text itself, so language and vocabulary are
 * irrelevant. Table borders (many tiled bars sharing a band) and code-gutter
 * rectangles (paired with a wide shaded block) are excluded.
 */
export function quoteBarRects(opList, OPS, options = {}) {
  const pageWidth = options.pageWidth || 595;
  const pageHeight = options.pageHeight || 842;
  const fn = opList.fnArray, args = opList.argsArray;
  let ctm = [1, 0, 0, 1, 0, 0];
  const stack = [], bars = [];
  let color = null;
  for (let i = 0; i < fn.length; i++) {
    const f = fn[i], a = args[i];
    if (f === OPS.save) { stack.push({ ctm: [...ctm], color }); continue; }
    if (f === OPS.restore) {
      const prev = stack.pop();
      if (prev) { ctm = prev.ctm; color = prev.color; }
      continue;
    }
    if (f === OPS.transform) { ctm = mul(ctm, a); continue; }
    if (f === OPS.setFillRGBColor || f === OPS.setFillGray || f === OPS.setFillColor) {
      color = rgb(a, f, OPS);
      continue;
    }
    if (f !== OPS.constructPath) continue;
    const [ops, shapes] = a;
    const list = shapes.length && typeof shapes[0] === 'number' ? [shapes] : shapes;
    for (let j = 0; j < list.length; j++) {
      const r = list[j];
      if (!Array.isArray(r) || r.length < 4) continue;
      const op = ops.length === 1 ? ops[0] : ops[j];
      if (op !== (OPS.rectangle ?? 19)) continue;
      const p1 = apply(ctm, r[0], r[1]);
      const p2 = apply(ctm, r[0] + r[2], r[1] + r[3]);
      const x1 = Math.min(p1[0], p2[0]), x2 = Math.max(p1[0], p2[0]);
      const y1 = Math.min(p1[1], p2[1]), y2 = Math.max(p1[1], p2[1]);
      const w = x2 - x1, h = y2 - y1;
      // A visible (non-white) narrow vertical bar, tall enough to mark text.
      if (!color || nearWhite(color)) continue;
      if (w < 1 || w > 8 || h < 8) continue;
      if (x2 < 0 || x1 > pageWidth || y2 < 0 || y1 > pageHeight) continue;
      if (h > pageHeight * 0.85) continue; // page frame / full-height rule
      bars.push({ x1, x2, y1, y2, w, h });
    }
  }

  // De-duplicate the same rect emitted repeatedly by Chrome/Skia.
  const unique = [];
  for (const b of bars) {
    if (unique.some(u => Math.abs(u.x1 - b.x1) < 1.5 && Math.abs(u.y1 - b.y1) < 1.5 &&
        Math.abs(u.x2 - b.x2) < 1.5 && Math.abs(u.y2 - b.y2) < 1.5)) continue;
    unique.push(b);
  }
  // One logical marker can be painted as several vertically stacked segments
  // (one per paragraph). Merge horizontally aligned, near-contiguous segments
  // first — before the table-border filter — so they count as a single bar.
  const stacked = [];
  for (const b of unique.sort((a, c) => c.y2 - a.y2)) {
    const prev = stacked.find(s => Math.abs(s.x1 - b.x1) < 2 && Math.abs(s.x2 - b.x2) < 2 &&
      s.y1 - b.y2 >= -2 && s.y1 - b.y2 < 20 && b.y2 <= s.y2 + 2);
    if (prev) {
      prev.y1 = Math.min(prev.y1, b.y1);
      prev.y2 = Math.max(prev.y2, b.y2);
      prev.h = prev.y2 - prev.y1;
    } else stacked.push({ ...b });
  }
  // A table cell grid paints several bars in the same y band (row edges).
  // Group bars whose y ranges overlap and keep only singleton groups.
  const groups = [];
  for (const b of stacked.sort((a, c) => c.y2 - a.y2)) {
    const g = groups.find(g => b.y1 < g.y2 - 2 && b.y2 > g.y1 + 2);
    if (g) g.bars.push(b);
    else groups.push({ y1: b.y1, y2: b.y2, bars: [b] });
  }
  return groups.flatMap(g => g.bars.length === 1
    ? g.bars.map(b => ({ ...b, id: `${b.x1.toFixed(1)}:${b.y2.toFixed(1)}:${b.h.toFixed(1)}` }))
    : []);
}

/**
 * Tag lines positioned immediately to the right of a quote bar as quote
 * candidates. Only geometry is used; semantic passes decide whether to emit
 * them as Markdown block quotes, so a false positive here cannot steal lines
 * that already belong to a table, code block or heading.
 */
export function markQuoteLines(lines, bars, bgRects = []) {
  for (const line of lines) {
    if (line.dropped || !String(line.text || '').trim()) continue;
    const x = line.x ?? line.items?.[0]?.transform?.[4] ?? 0;
    for (const b of bars) {
      // Baseline inside the bar's vertical span, text starts just right of it,
      // and the bar is not the left edge of a wide shaded block/cell.
      if (line.y > b.y2 + 4 || line.y < b.y1 - 4) continue;
      if (x < b.x2 - 2 || x - b.x2 > 60) continue;
      if (bgRects.some(r => Math.abs(r.x1 - b.x1) < 3 && line.y <= r.y2 && line.y >= r.y1)) continue;
      line.quoteBar = true;
      line.quoteBarId = b.id ?? `${b.x1}:${b.y1}:${b.y2}`;
      break;
    }
  }
}
