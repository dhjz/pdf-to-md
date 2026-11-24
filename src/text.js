/**
 * Text layer utilities: turn pdf.js text items into positioned lines.
 * Pure layout geometry — no OCR, no heuristics about the content itself.
 */

const EPS = 0.5;

/** Group raw pdf.js text items into lines by baseline Y. */
export function itemsToLines(items) {
  const byY = new Map();
  for (const item of items) {
    if (item.str === undefined) continue;
    const y = item.transform[5];
    // find an existing baseline within tolerance
    let key = null;
    for (const k of byY.keys()) {
      if (Math.abs(k - y) <= 2.5) { key = k; break; }
    }
    if (key === null) { key = y; byY.set(key, []); }
    byY.get(key).push(item);
  }
  const lines = [];
  for (const [y, group] of byY) {
    group.sort((a, b) => a.transform[4] - b.transform[4]);
    // A two-column page has left/right baselines aligned to the same y. Grouping
    // purely by y would merge them into one overlong line, which destroys the
    // left-margin histogram twoColumnSplit depends on. Split such a group at a
    // wide inter-item gutter before joining text.
    for (const part of splitColumnGroup(group)) {
      const text = joinItems(part);
      if (!text.trim()) continue;
      lines.push({
        y,
        x: Math.min(...part.map(i => i.transform[4])),
        right: Math.max(...part.map(i => i.transform[4] + (i.width || 0))),
        height: Math.max(...part.map(i => i.height || 0), 8),
        fontSize: dominantHeight(part),
        fontName: part.find(i => String(i.str || '').trim())?.fontName,
        fonts: [...new Set(part.map(i => i.fontName).filter(Boolean))],
        font: part.find(i => i.height > 0)?.fontName || '',
        items: part,
        text,
        dropped: false,
      });
    }
  }
  lines.sort((a, b) => b.y - a.y); // top to bottom in PDF coords (Y grows upward)
  return lines;
}

const LONG_GAP = 25;
export const SHORT_NUMERIC = /^[+-]?\d[\d,.]*[%‰]?$/;
/** Enough text on one side of a gutter to be a real column, not a table cell. */
function substantialRun(items) {
  const text = items.map(i => String(i.str ?? '')).join('').trim();
  if (text.length >= 6) return true;
  const left = Math.min(...items.map(i => i.transform[4]));
  const right = Math.max(...items.map(i => i.transform[4] + (i.width || 0)));
  return right - left >= 60;
}
/**
 * Split one baseline group across a wide blank gutter (two columns). A lone
 * wide gap between short numeric cells (rate tables) is not a column seam.
 * Returns [group] for normal lines so callers need no special case.
 */
function splitColumnGroup(group) {
  if (group.length < 2) return [group];
  // pdf.js emits '' placeholder items; never let them define a gap. Whitespace
  // items with real width stay: they carry the PDF's own column spacing (e.g.
  // Word table rows where a wide ' ' glyph bridges two visual columns).
  const solid = group
    .map((item, idx) => ({ item, idx }))
    .filter(({ item }) => String(item.str ?? '') !== '' && item.str !== undefined);
  if (solid.length < 2) return [group];
  // Numeric table rows can be spaced far apart across several cells; treat a
  // row dominated by short numeric items as one line even with wide gaps.
  const visible = solid.filter(({ item }) => String(item.str).trim());
  if (visible.length < 2) return [group];
  const numericCount = visible.filter(({ item }) => SHORT_NUMERIC.test(String(item.str).trim())).length;
  if (numericCount >= visible.length * 0.7) return [group];
  const cuts = [];
  for (let k = 1; k < solid.length; k++) {
    const prev = solid[k - 1].item, cur = solid[k].item;
    const gap = cur.transform[4] - (prev.transform[4] + (prev.width || 0));
    if (gap <= LONG_GAP) continue;
    // Numeric table cells can be far apart; that is a row, not two columns.
    if (SHORT_NUMERIC.test(String(prev.str ?? '').trim()) &&
        SHORT_NUMERIC.test(String(cur.str ?? '').trim())) continue;
    // Only split when BOTH sides carry a substantial run of text. Short table
    // headers, two-column labels and TOC page numbers stay one line so the
    // page-bottom multi-column carry detection can still see their cells.
    if (!substantialRun(solid.slice(0, k).map(s => s.item)) ||
        !substantialRun(solid.slice(k).map(s => s.item))) continue;
    cuts.push(solid[k].idx);
  }
  if (!cuts.length) return [group];
  const parts = [];
  let start = 0;
  for (const end of [...cuts, group.length]) {
    const seg = group.slice(start, end);
    start = end;
    if (seg.some(i => String(i.str ?? '').trim())) parts.push(seg);
  }
  return parts.length > 1 ? parts : [group];
}

/**
 * PDF hyperlinks are /Link annotations over a rectangle, separate from the
 * text layer. Tag each text item with its link URL (same coordinate space as
 * item.transform) so the renderer can wrap the line text in `[...](url)`.
 */
export function applyLinkAnnotations(lines, links) {
  for (const line of lines || []) {
    if (line.dropped || !Array.isArray(line.items)) continue;
    const tagged = line.items.map(item => {
      const x = item.transform?.[4], y = item.transform?.[5];
      if (!Number.isFinite(x) || !Number.isFinite(y) || !String(item.str || '').trim()) return item;
      const w = item.width || 0, h = item.height || 0;
      const link = links.find(l => {
        const [x1, y1, x2, y2] = l.rect;
        const lo = Math.min(y1, y2), hi = Math.max(y1, y2);
        const cx = x + w / 2, cy = y + h / 2;
        return cx >= x1 - 1 && cx <= x2 + 1 && cy >= lo - 1 && cy <= hi + 1;
      });
      return link ? { ...item, linkUrl: link.url } : item;
    });
    const urls = [...new Set(tagged.map(i => i.linkUrl).filter(Boolean))];
    if (urls.length) line.items = tagged;
    if (urls.length === 1) line.linkUrl = urls[0];
    else if (urls.length > 1) line.linkUrls = urls;
  }
  return lines;
}

/** Left edge of a page's body text — baseline for relative-indent checks. */
export function pageContentMinX(lines) {
  const xs = (lines || [])
    .filter(l => !l.dropped && String(l.text || '').trim())
    .map(l => l.x ?? l.items?.[0]?.transform?.[4] ?? Infinity)
    .filter(Number.isFinite);
  if (!xs.length) return 0;
  // 10th percentile ignores a few indented table cells while keeping the
  // real body margin even when headings sit further left.
  xs.sort((a, b) => a - b);
  return xs[Math.floor((xs.length - 1) * 0.1)];
}

/** Right edge of the page's body text — counterpart of pageContentMinX. */
export function pageContentRight(lines) {
  const rights = (lines || [])
    .filter(l => !l.dropped && String(l.text || '').trim())
    .map(l => {
      if (Number.isFinite(l.right)) return l.right;
      const items = l.items || [];
      const last = items[items.length - 1];
      return last ? last.transform?.[4] + (last.width || 0) : l.x;
    })
    .filter(Number.isFinite);
  return rights.length ? Math.max(...rights) : 0;
}

/** Horizontal span of the body text column, not the whole PDF page. */
export function pageContentWidth(lines) {
  const minX = pageContentMinX(lines);
  const right = pageContentRight(lines);
  return right > minX ? right - minX : 0;
}

/** Most common non-zero glyph height: one oversized glyph cannot dominate a line. */
function dominantHeight(group) {
  const counts = new Map();
  for (const h of group.map(i => i.height || 0).filter(h => h > 0)) {
    counts.set(h, (counts.get(h) || 0) + 1);
  }
  if (!counts.size) return 0;
  return [...counts].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0][0];
}

/** Exact spacing rule used by joinItems; also reused for inline link segments. */
export function joinGap(prev, item, out) {
  if (!out || !prev) return '';
  const gap = item.transform[4] - (prev.transform[4] + (prev.width || 0));
  const width = item.width || 0;
  const prevWidth = prev.width || 0;
  // CJK has compact spacing; latin words need a space on visible gaps.
  // Two-column PDFs lay out independent columns with a large gap yet no
  // real word break — don't glue an artificial space into that seam.
  const columnGap = gap > 17 && /[^\s]$/.test(out) && /[\u4e00-\u9fff]/.test(String(item.str || ''));
  if (gap > Math.max(1.2, Math.min(prevWidth, width || prevWidth) * 0.28) &&
      !columnGap && !/^\s/.test(String(item.str || '')) && !/\s$/.test(out)) return ' ';
  return '';
}

function joinItems(items) {
  let out = '';
  let prev = null; // last NON-EMPTY item; pdf.js emits '' spacer items
  for (const item of items) {
    const s = item.str;
    if (!s) continue;
    out += joinGap(prev, item, out) + s;
    prev = item;
  }
  return out.trim().replace(/[ \t]+/g, ' ');
}

/** Merge lines into paragraphs using vertical gap and indentation signals. */
export function linesToParagraphs(lines, { bodyHeight } = {}) {
  const paras = [];
  let current = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const prev = lines[i - 1];
    if (current && prev) {
      const gap = prev.y - line.y;
      const indentJump = line.x - prev.x;
      const bottom = prev.y - prev.height;
      const prevEndsText = /[^\s。！？；：,.!?;:）)\]}”’"']$/.test(prev.text);
      const lineStartsText = /^[^\s）)\]}”’"',，。；：！？]/.test(line.text);
      const sameColumn = Math.abs(line.x - current.x) < 12;
      const bigGap = gap > Math.max(prev.height * 1.55, 12);
      const newBullet = /^[•●▪·・]\s|^[-—]\s/.test(line.text);
      if (bigGap || (indentJump > 14 && sameColumn === false) || newBullet || !prevEndsText === false && lineStartsText && bigGap) {
        paras.push(current);
        current = null;
      }
    }
    if (!current) current = { x: line.x, y: line.y, lines: [] };
    current.lines.push(line);
  }
  if (current) paras.push(current);
  return paras;
}

/** Escape strings for Markdown table cells. */
export function escapeCell(text) {
  return String(text ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>');
}
