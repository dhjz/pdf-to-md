/**
 * Table detection from vector borders and text columns.
 * This is the structural counterpart of MinerU's layout model, implemented
 * directly on pdf.js operator lists and positioned text.
 */

const LINE_TOL = 1.5;

import { mul as multiply, apply as applyMatrix, cluster as clusterValues } from './geom.js';

/**
 * Collect horizontal/vertical rules in the same coordinate space as text items.
 * PDF operators may be wrapped in transforms (sample.pdf offsets every table,
 * test.pdf flips Y), so two candidate coordinate spaces are scored against
 * real text baselines and the closer one is used.
 */
export function collectRules(operatorList, OPS, options = {}) {
  const pageHeight = typeof options === 'number' ? options : (options.pageHeight || 0);
  const textYs = Array.isArray(options) ? options : (options.textYs || []);
  const groups = [
    { h: [], v: [], projected: false },
    { h: [], v: [], projected: true },
  ];
  const stack = [];
  let ctm = [1, 0, 0, 1, 0, 0];

  for (let i = 0; i < operatorList.fnArray.length; i++) {
    const fn = operatorList.fnArray[i];
    if (fn === OPS.save) { stack.push([...ctm]); continue; }
    if (fn === OPS.restore) { ctm = stack.pop() || ctm; continue; }
    if (fn === OPS.transform) { ctm = multiply(ctm, operatorList.argsArray[i]); continue; }
    if (fn !== OPS.constructPath) continue;

    const [ops, shapes] = operatorList.argsArray[i];
    const rects = shapes.length === 4 && shapes.every(n => typeof n === 'number') ? [shapes] : shapes;
    for (let j = 0; j < rects.length; j++) {
      const r = rects[j];
      // A constructPath group has one op per shape, except rectangles where
      // pdf.js puts a single op followed by a flat list of all rectangles.
      const op = ops.length === 1 ? ops[0] : ops[j];
      if (!Array.isArray(r) || r.length < 4) continue;

      for (const g of groups) {
        const map = (x, y) => {
          if (!g.projected) return [x, y];
          // pdf.js text transforms already include the operator CTM, so the
          // matching coordinate space is the CTM-projected one (no extra flip).
          return applyMatrix(ctm, x, y);
        };
        if (op === (OPS.rectangle ?? 19)) { // rectangle: [x, y, w, h]
          const [x, y, w, hh] = r;
          if (w < 2 || hh < 2) continue;
          const a = map(x, y), b = map(x + w, y + hh);
          const x1 = Math.min(a[0], b[0]), x2 = Math.max(a[0], b[0]);
          const y1 = Math.min(a[1], b[1]), y2 = Math.max(a[1], b[1]);
          g.h.push({ x1, x2, y: y1 });
          g.h.push({ x1, x2, y: y2 });
          g.v.push({ y1, y2, x: x1 });
          g.v.push({ y1, y2, x: x2 });
        } else if (op === (OPS.moveTo ?? 13) || op === (OPS.lineTo ?? 14)) { // [x1,y1,x2,y2]
          const [x1, y1, x2, y2] = r;
          const a = map(x1, y1), b = map(x2, y2);
          if (Math.abs(a[1] - b[1]) < LINE_TOL && Math.abs(a[0] - b[0]) > 5) {
            g.h.push({ x1: Math.min(a[0], b[0]), x2: Math.max(a[0], b[0]), y: a[1], rule: true });
          } else if (Math.abs(a[0] - b[0]) < LINE_TOL && Math.abs(a[1] - b[1]) > 5) {
            g.v.push({ y1: Math.min(a[1], b[1]), y2: Math.max(a[1], b[1]), x: a[0], rule: true });
          }
        }
      }
    }
  }

  const scored = groups.map(g => {
    const h = prepare(g.h, true), v = prepare(g.v, false);
    // Many PDFs draw tables as one rectangle per cell (edges carry no `rule`
    // flag). Score ALL horizontal edges so cell grids align with the text.
    const ys = h.map(r => r.y);
    const longV = v.filter(r => r.y2 - r.y1 > 30);
    let score = 0, count = 0;
    if (textYs.length && ys.length) {
      score += ys.reduce((sum, y) => sum + Math.min(...textYs.map(t => Math.abs(t - y))), 0) / ys.length;
      count++;
    }
    // Table columns must span text: in the wrong coordinate space long
    // vertical rules sit far from every text baseline.
    for (const seg of longV) {
      const m = (seg.y1 + seg.y2) / 2;
      score += Math.min(...textYs.map(t => Math.abs(t - m))) * 2;
      count++;
    }
    score = count ? score / count : Infinity;
    return { h, v, score };
  });
  const chosen = scored[0].score <= scored[1].score ? scored[0] : scored[1];
  return { h: chosen.h, v: chosen.v };
}

function prepare(rules, horizontal) {
  const pageW = Math.max(1, ...rules.map(r => horizontal ? r.x2 : r.x));
  const pageH = Math.max(1, ...rules.map(r => horizontal ? r.y : r.y2));
  const isFrame = horizontal
    ? (r => r.x1 <= 1 && r.x2 >= pageW - 1 && (r.y <= 2 || r.y >= pageH - 2))
    : (r => r.y1 <= 1 && r.y2 >= pageH - 1 && (r.x <= 1 || r.x >= pageW - 1));
  const kept = rules.filter(r => !isFrame(r));
  return horizontal ? mergeHorizontal(kept) : mergeVertical(kept);
}

/** Merge collinear segments that overlap or touch into one continuous rule. */
function mergeHorizontal(rules) {
  const groups = new Map();
  for (const r of rules) {
    if (!r.rule) continue;
    const k = Math.round(r.y / 2);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  const out = [];
  for (const list of groups.values()) {
    list.sort((a, b) => a.x1 - b.x1);
    let cur = { ...list[0] };
    for (const r of list.slice(1)) {
      if (r.x1 <= cur.x2 + 2) cur.x2 = Math.max(cur.x2, r.x2);
      else { out.push(cur); cur = { ...r }; }
    }
    out.push(cur);
  }
  // keep non-rule rectangle edges too
  out.push(...rules.filter(r => !r.rule));
  return out;
}
function mergeVertical(rules) {
  const groups = new Map();
  for (const r of rules) {
    if (!r.rule) continue;
    const k = Math.round(r.x / 2);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  const out = [];
  for (const list of groups.values()) {
    list.sort((a, b) => a.y1 - b.y1);
    let cur = { ...list[0] };
    for (const r of list.slice(1)) {
      if (r.y1 <= cur.y2 + 2) cur.y2 = Math.max(cur.y2, r.y2);
      else { out.push(cur); cur = { ...r }; }
    }
    out.push(cur);
  }
  out.push(...rules.filter(r => !r.rule));
  return out;
}

// Original local cluster returned descending averages; preserve that order.
const cluster = (values, tol) => clusterValues(values, tol, { desc: true });

/** Detect grid tables from long horizontal rules and cell rectangles. */
export function detectGridTables(rules) {
  const { h, v } = rules;
  const rulesV = v.filter(r => r.rule && r.y2 - r.y1 > 30);
  if (rulesV.length < 2) return [];
  const xs = cluster(rulesV.map(r => r.x), 2);
  if (xs.length < 2) return [];
  const left = Math.min(...xs), right = Math.max(...xs), span = right - left;
  if (span < 50) return [];

  const longYs = cluster(h.filter(r => r.rule && r.x2 - r.x1 > span * 0.7).map(r => r.y), 3);
  if (longYs.length < 2) return [];

  // Adjacent long rules at roughly equal spacing belong to the same table.
  // A gap > 2.5x the local row height starts a new table.
  const groups = [];
  let group = [longYs[0]];
  for (let i = 1; i < longYs.length; i++) {
    const gap = group[group.length - 1] - longYs[i];
    const typical = group.length > 1 ? Math.min(...group.slice(1).map((y, j) => group[j] - y)) : gap;
    if (gap < typical * 2.5) group.push(longYs[i]);
    else { groups.push(group); group = [longYs[i]]; }
  }
  groups.push(group);

  // Rectangle edges supply within-band row splits; keep edges inside the grid.
  const rectYs = cluster(h.filter(r => !r.rule && r.x2 - r.x1 > 15
    && r.x1 >= left - 3 && r.x2 <= right + 3).map(r => r.y), 1.5);

  return groups.map(g => {
    const top = g[0], bottom = g[g.length - 1];
    if (top - bottom < 12 || g.length < 2) return null;
    // Only vertical rules substantially overlapping this row band are column
    // borders; rules belonging to a different table must not be merged in
    // (test.pdf p5), while partial-height inner borders must still count.
    const cols = cluster(rulesV.filter(r => {
      const overlap = Math.min(r.y2, top) - Math.max(r.y1, bottom);
      return overlap >= Math.min(r.y2 - r.y1, top - bottom) * 0.6;
    }).map(r => r.x), 2);
    if (cols.length < 2) return null;
    const rowEdges = cluster([...g, ...rectYs.filter(y => y <= top + 1 && y >= bottom - 1)], 1.5);
    return { top, bottom, left: Math.min(...cols), right: Math.max(...cols),
      colEdges: cols, rowEdges, rows: rowEdges.length - 1, cols: cols.length - 1 };
  }).filter(Boolean);
}

/** Assign lines to table cells using column/row boundaries. */
export function fillTable(table, lines) {
  const rowEdges = table.rowEdges;
  const colEdges = table.colEdges;
  const rows = [];
  for (let r = 0; r < rowEdges.length - 1; r++) {
    const top = rowEdges[r], bottom = rowEdges[r + 1];
    const cells = Array.from({ length: colEdges.length - 1 }, () => []);
    for (const line of lines) {
      if (line.y > top + 2 || line.y < bottom - 2) continue;
      const cx = (line.x + line.right) / 2;
      let c = colEdges.findIndex((edge, i) => i < colEdges.length - 1 && cx >= edge - 2 && cx < colEdges[i + 1] - 2);
      if (c < 0) {
        // assign by closest column
        let best = Infinity;
        colEdges.forEach((edge, i) => { const d = Math.abs(cx - edge); if (d < best) { best = d; c = Math.min(i, colEdges.length - 2); } });
      }
      cells[c].push(line);
    }
    rows.push(cells.map(cl => cl.map(l => l.text).join(' ').trim()));
  }
  return rows;
}

/** Render rows to a Markdown table, skipping fully empty leading rows. */
export function rowsToMarkdown(rows) {
  const clean = rows.filter(row => row.some(cell => cell.trim()));
  if (clean.length === 0) return '';
  const cols = Math.max(...clean.map(r => r.length));
  const norm = clean.map(r => {
    const out = r.slice(0, cols);
    while (out.length < cols) out.push('');
    return out;
  });
  const [header, ...body] = norm;
  const lines = [
    '| ' + header.map(c => escapeCell(c)).join(' | ') + ' |',
    '| ' + header.map(() => '---').join(' | ') + ' |',
    ...body.map(r => '| ' + r.map(c => escapeCell(c)).join(' | ') + ' |'),
  ];
  return lines.join('\n');
}

function escapeCell(s) {
  return String(s ?? '').replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim();
}

const isNumItem = it => /^[+-]?\d[\d,]*\.?\d*$/.test(String(it.str || '').trim());

function groupByY(items) {
  const groups = new Map();
  for (const it of items) {
    if (it.str === undefined || !String(it.str).trim()) continue;
    const key = it.transform[5].toFixed(1);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(it);
  }
  return [...groups.entries()].map(([y, items]) => ({
    y: Number(y), items: items.sort((a, b) => a.transform[4] - b.transform[4]),
  })).sort((a, b) => b.y - a.y);
}

/**
 * Detect borderless numeric grids (e.g. rate tables drawn with only a shaded
 * header row). A run of >=5 baselines where each line has >=6 aligned numeric
 * items is treated as a table; column centres come from the item x positions.
 * This complements detectGridTables, which needs vector rules.
 */
export function borderlessNumericTables(items) {
  const lines = groupByY(items);
  // A data line has >=6 numeric items and at least half carry a decimal point
  // (rates like 25.86). This excludes label lines such as "男3年 男5年" whose
  // bare digits (3/5/10) would otherwise be mistaken for data.
  const dataLine = l => {
    const nums = l.items.filter(isNumItem);
    return nums.length >= 6 && nums.filter(n => String(n.str).includes('.')).length >= nums.length / 2;
  };
  const tables = [];
  let i = 0;
  while (i < lines.length) {
    if (!dataLine(lines[i])) { i++; continue; }
    let j = i;
    while (j + 1 < lines.length && dataLine(lines[j + 1])) j++;
    const run = j - i + 1;
    if (run < 5) { i = j + 1; continue; }

    // Column centres from the first data line (all lines share the grid).
    const centres = cluster(lines[i].items.filter(isNumItem).map(it => it.transform[4]), 4).sort((a, b) => a - b);
    if (centres.length < 6) { i = j + 1; continue; }
    const colEdges = [centres[0] - 12, ...centres.slice(0, -1).map((c, k) => (c + centres[k + 1]) / 2), centres[centres.length - 1] + 20];

    // Include the aligned label line just above the data as a header row.
    const firstLine = lines[i];
    let headerLine = null;
    if (i > 0) {
      const cand = lines[i - 1];
      const aligned = cand.items.filter(it => colEdges.some((e, k) =>
        k < colEdges.length - 1 && it.transform[4] >= e - 6 && it.transform[4] < colEdges[k + 1] - 6)).length;
      if (aligned >= centres.length - 1) headerLine = cand;
    }
    const rowLines = headerLine ? [headerLine, ...lines.slice(i, j + 1)] : lines.slice(i, j + 1);
    const rows = rowLines.map(l => {
      const cells = Array(colEdges.length - 1).fill('');
      for (const it of l.items) {
        const cx = it.transform[4] + (it.width || 0) / 2;
        let c = colEdges.findIndex((e, k) => k < colEdges.length - 1 && cx >= e - 3 && cx <= colEdges[k + 1] + 3);
        if (c < 0) c = colEdges.findIndex((e, k) => k < colEdges.length - 1 && it.transform[4] >= e - 6 && it.transform[4] < colEdges[k + 1] - 6);
        if (c >= 0) cells[c] += it.str;
      }
      return cells.map(s => s.replace(/\s+/g, ' ').trim());
    });
    const top = rowLines[0].y, bottom = rowLines[rowLines.length - 1].y;
    tables.push({ top: top + 6, bottom: bottom - 6, left: colEdges[0], right: colEdges[colEdges.length - 1],
      colEdges, rowEdges: [top + 6, ...rowLines.map(l => l.y), bottom - 6], rows, source: 'borderless' });
    i = j + 1;
  }
  return tables;
}

/**
 * Detect borderless 2-column label tables from text geometry alone.
 * Chrome/Skia draws table borders as thin filled rectangles that the
 * line-rule detector cannot see. Signal: >=4 consecutive baselines each
 * starting an item at the same second-column x with near-even row spacing.
 */
export function borderlessLabelTables(items) {
  const lines = groupByY(items).filter(l => l.items.some(it => String(it.str || '').trim()));
  const tables = [];
  const withCol2 = lines.filter(l => l.items.length >= 2);
  if (withCol2.length < 4) return tables;

  // Candidate second-column x positions: any item that isn't the first on its
  // baseline and repeats on >=4 lines.
  const counts = new Map();
  for (const l of withCol2) {
    for (const it of l.items.slice(1)) {
      const k = Math.round(it.transform[4] / 5) * 5;
      counts.set(k, (counts.get(k) || 0) + 1);
    }
  }
  const col2Xs = [...counts].filter(([, n]) => n >= 4).map(([k]) => k).sort((a, b) => a - b);

  for (const x0 of col2Xs) {
    const matches = lines.filter(l => l.items.length >= 2 &&
      l.items.slice(1).some(it => Math.abs(it.transform[4] - x0) <= 6));
    // Split into consecutive runs by y.
    let run = [];
    const runs = [];
    for (const l of matches) {
      if (run.length && run[run.length - 1].y - l.y > 40) { runs.push(run); run = []; }
      run.push(l);
    }
    if (run.length) runs.push(run);

    for (const r of runs) {
      if (r.length < 4) continue;
      const gaps = r.slice(1).map((l, k) => r[k].y - l.y).filter(g => g > 3);
      if (gaps.length < 3) continue;
      const med = [...gaps].sort((a, b) => a - b)[Math.floor(gaps.length / 2)];
      if (med < 12 || gaps.filter(g => Math.abs(g - med) <= 6).length < gaps.length * 0.7) continue;
      const col2 = x0;
      const col1 = cluster(r.map(l => l.items[0].transform[4]), 6)[0];
      const right = Math.max(...r.flatMap(l => l.items.map(it => it.transform[4] + (it.width || 0))));
      const colEdges = [col1 - 6, (col1 + col2) / 2, right + 6];
      const rows = r.map(l => {
        const cells = ['', ''];
        for (const it of l.items) {
          cells[it.transform[4] < colEdges[1] ? 0 : 1] += it.str;
        }
        return cells.map(v => String(v).replace(/\s+/g, ' ').trim());
      });
      if (rows.filter(row => row[0] && row[1]).length < r.length - 1) continue;
      // A concept/label table has short CJK labels in column 1 and text (not
      // dense numbers) in column 2. Rate tables with packed numeric cells do
      // not match, so those keep their existing table detection.
      const c1Lens = rows.map(row => row[0].length);
      if (c1Lens.some(n => n > 12)) continue;
      const hasShortLabel = rows.filter(row => row[0].length <= 6).length >= r.length - 1;
      if (!hasShortLabel) continue;
      const numericHeavy = rows.filter(row => /^\d[\d.,]*$/.test(row[1].replace(/\s/g, ''))).length;
      if (numericHeavy > r.length * 0.3) continue;
      if (rows[0][0].length > 6 || rows[0][1].length > 6) continue;
      // A leading ordinal/heading marker paired with a long second column is
      // a prose list (e.g. "1. 一段说明…"), not a two-column term table.
      const ordinal = /^(?:[①-⑳]|[（(]?\d+[)）.、]|[一二三四五六七八九十]+[、.])\s*$/;
      const ordinalRows = rows.filter(row => ordinal.test(row[0]));
      const longSentences = ordinalRows.filter(row => row[1].length > 20).length;
      if (ordinalRows.length >= 2 && longSentences >= 2) continue;
      // Concept tables carry short terms in both columns (header included).
      // Long sentences in the second column are wrapped body text, not cells.
      if (rows.filter(row => row[1].length <= 20).length < r.length - 1) continue;
      const top = r[0].y + 6, bottom = r[r.length - 1].y - 6;
      tables.push({ top, bottom, left: colEdges[0], right: colEdges[2],
        colEdges, rowEdges: [top, ...r.map(l => l.y), bottom], rows, source: 'borderless-label' });
    }
  }
  return tables;
}
