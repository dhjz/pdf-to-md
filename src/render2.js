/**
 * render2 — semantic renderer: cell-grid tables (one logical cell per Markdown
 * cell) + reflowed prose paragraphs + heading classification. No similarity
 * hacks; output targets the visual reading order of the source PDF.
 */
import { formatTocLine } from './doc-format.js';
import { pageContentMinX, joinGap, SHORT_NUMERIC } from './text.js';
import { cellGridTables } from './cellgrid.js';
import { evaluateBoundaryRow } from './table-continuation.js';
import { detectStandaloneLines, detectCodeBlocks } from './blocks.js';
import { detectCodeLanguage } from './code-lang.js';
import { gridColumns, sameTableGrid, alignMergedCells } from './crosspage.js';

const CN_HEADING = /^[一二三四五六七八九十]+、\s*\S/;
const NUM_HEADING = /^\d+(?:\.\d+)*[.、]?\s+\S/;
const COLON_HEADING = /^(?:核心目标|功能需求详述|功能目标|技术要求)\s*[:：]/;
const PAREN_HEADING = /^（\d+）\s*\S/;
const LOG_PREFIX = '[pdf-to-md]';

function diag(options, ...args) {
  if (options?.debug) console.log(LOG_PREFIX, ...args);
}

/**
 * Render one physical line, wrapping only runs actually covered by a /Link
 * annotation. Each item carries its own linkUrl (set by applyLinkAnnotations);
 * consecutive items with the same URL become one link, so multiple links on
 * one line stay distinct and unlinked text stays plain.
 */
function linkText(ev) {
  const items = Array.isArray(ev?.items) ? ev.items : null;
  const text = String(ev?.text ?? '').trim();
  if (!text) return '';
  // URLs may contain parentheses; angle brackets keep them intact in Markdown.
  const href = url => {
    const raw = String(url).trim();
    return /[()<>]/.test(raw) ? `<${raw.replace(/</g, '%3C').replace(/>/g, '%3E')}>` : raw;
  };
  if (!items || !items.some(i => i?.linkUrl)) {
    const url = ev?.linkUrl;
    if (!url) return text;
    return /[\[\]]/.test(text) ? text : `[${text}](${href(url)})`;
  }
  const pieces = [];
  let groupText = '';
  let groupUrl = null;
  let prev = null;
  const rendered = []; // { text, url } — url is null for plain runs
  const lastNonEmpty = i => {
    for (let k = i - 1; k >= 0; k--) if (String(items[k]?.str ?? '').trim()) return items[k];
    return null;
  };
  const nextNonEmpty = i => {
    for (let k = i + 1; k < items.length; k++) if (String(items[k]?.str ?? '').trim()) return items[k];
    return null;
  };
  const push = (text, url) => {
    if (text) rendered.push({ text, url: url || null });
  };
  const flush = () => {
    if (groupText) push(groupText, groupUrl);
    groupText = '';
    groupUrl = null;
  };
  for (let idx = 0; idx < items.length; idx++) {
    const item = items[idx];
    const raw = String(item?.str ?? '');
    if (!raw) continue;
    // PDF text layers split a multi-word link around a bare space item. Keep
    // that space in the same link when both neighbours point to the same URL.
    const url = item.linkUrl || null;
    if (!raw.trim()) {
      const before = lastNonEmpty(idx), after = nextNonEmpty(idx);
      const shared = before && after && before.linkUrl && before.linkUrl === after.linkUrl;
      if (shared) groupUrl = before.linkUrl;
      groupText += (prev ? joinGap(prev, item, prev.str) : '') + raw;
      prev = item;
      continue;
    }
    if (groupText && url !== groupUrl) flush();
    groupUrl = url;
    groupText += (prev ? joinGap(prev, item, prev.str) : '') + raw;
    prev = item;
  }
  flush();
  for (const { text, url } of rendered) {
    // normalizePunctuation trims; normalize the core and keep the original
    // boundary spaces outside the Markdown link so neighbors stay separate.
    const leading = (text.match(/^\s*/) || [''])[0];
    const trailing = (text.match(/\s*$/) || [''])[0];
    const core = normalizePunctuation(text);
    if (!core) continue;
    if (!url || /[\[\]]/.test(core)) { pieces.push(leading + core + trailing); continue; }
    pieces.push(leading + `[${core}](${href(url)})` + trailing);
  }
  return pieces.join('').trim();
}

/** Most common (median-ish) line height — the body text size of a page. */
export function dominantLineHeight(lines, fallback = 11) {
  const counts = new Map();
  for (const l of lines) {
    if (l.dropped || !String(l.text || '').trim()) continue;
    const h = Number((l.fontSize ?? l.height ?? 0).toFixed?.(1) || 0);
    if (h > 0) counts.set(h, (counts.get(h) || 0) + 1);
  }
  if (!counts.size) return fallback;
  return [...counts].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0][0];
}

/**
 * Infer the document's heading font size(s): a size shared by >=2 short,
 * unpunctuated left-margin lines and clearly larger than the body text.
 * Unnumbered visual headings ("简单总结") can then be promoted by matching
 * this size, while body lines and table rows keep their original role.
 * Centered lines are deliberately excluded: they are layout lines (titles,
 * captions), not section headings. Their line breaks are preserved as body
 * text by the geometry-only path in render2, independent of heading sizes.
 */
export function headingSizesFromLines(lines) {
  // Collect per-size stats: a heading style size is clearly larger than body
  // text and appears on >=2 short, unpunctuated left-margin lines. Body-size
  // lines (however short) are excluded by the body baseline check.
  const globalMinX = pageContentMinX(lines);
  const bodyCounts = new Map();
  const candidates = [];
  for (const l of lines) {
    const t = String(l.text || '').trim();
    if (!t || l.dropped) continue;
    const h = Number((l.fontSize ?? l.height ?? 0).toFixed?.(1) || 0);
    if (h > 0) bodyCounts.set(h, (bodyCounts.get(h) || 0) + 1);
    if (l.standalone || t.length > 30 || /[。；，,、]$/.test(t)) continue;
    if (/^[•·○●*\-—\d\s.、]+$/.test(t)) continue; // bullets / bare numbers
    const x = l.x ?? l.items?.[0]?.transform?.[4] ?? 0;
    // Word/WPS A4 defaults to ~90pt margins; a fixed 75pt threshold drops every
    // heading in those documents. Use the page's inferred body left edge.
    // Per-page left edge: a few wide-table pages must not drag the baseline
    // down for ordinary body pages (and vice versa).
    const minX = Number.isFinite(l.pageContentMinX) ? l.pageContentMinX : globalMinX;
    if (x - minX > 25) continue; // headings sit at the left margin; centered lines are not headings
    candidates.push({ h, x });
  }
  if (!bodyCounts.size) return [];
  // Body text is the dominant size among longer lines; short lines may all be
  // headings on a TOC/summary page and must not define the body baseline.
  const longCounts = new Map();
  for (const l of lines) {
    const t = String(l.text || '').trim();
    if (l.dropped || t.length < 12) continue;
    const h = Number((l.fontSize ?? l.height ?? 0).toFixed?.(1) || 0);
    if (h > 0) longCounts.set(h, (longCounts.get(h) || 0) + 1);
  }
  const tally = longCounts.size ? longCounts : bodyCounts;
  const bodyH = [...tally].sort((a, b) => b[1] - a[1])[0][0];
  const groups = new Map();
  for (const c of candidates) {
    if (c.h <= bodyH * 1.15) continue;
    const key = `${c.h}:${Math.round(c.x)}`;
    groups.set(key, (groups.get(key) || 0) + 1);
  }
  const sizes = new Set();
  for (const [key, n] of groups) if (n >= 2) sizes.add(Number(key.split(':')[0]));
  const sorted = [...sizes].sort((a, b) => b - a);
  // Only the largest one/two tiers count as heading styles; body-sized text
  // in dense two-column layouts must never promote ordinary lines.
  const max = sorted[0];
  // Keep a gradient of heading tiers (H1/H2) but never the body-size tier.
  // 0.7 admits a 16pt H2 under a 20pt H1 while excluding 11pt body text.
  return sorted.filter(h => h >= Math.max(bodyH * 1.25, max * 0.7));
}

/** Is this line a visual heading matching the document's established size? */
export function isOversizedHeading(line, headingSizes) {
  if (!Array.isArray(headingSizes) || !headingSizes.length) return false;
  const size = Number((line.fontSize ?? line.height ?? 0).toFixed?.(1) || 0);
  const text = String(line.text || '').trim();
  if (!text) return false;
  // Explicit numbering ("1.6 xxx") is strong evidence, so allow longer text;
  // unnumbered visual headings stay short to avoid promoting body lines.
  const numbered = /^\d+(?:\.\d+)*[.、\s]/.test(text);
  if (text.length > (numbered ? 48 : 30)) return false;
  if (/^[•·○●*\-—\d\s.、]+$/.test(text)) return false;
  return headingSizes.some(h => Math.abs(size - h) <= 0.6);
}

/**
 * A short line centred on the page is a standalone visual line (title/caption).
 * Keep it on its own Markdown line even when heading-size inference fails —
 * line breaks belong to the layout, not to heading classification.
 */
export function isCenteredShortLine(line, pageWidth) {
  if (!line || line.dropped || !Number.isFinite(pageWidth) || pageWidth <= 0) return false;
  const text = String(line.text || '').trim();
  if (!text || text.length > 30) return false;
  if (/[。；，,、.!?！？：:]$/.test(text)) return false;
  if (/^[•·○●*\-—\d\s.、]+$/.test(text)) return false;
  const x = line.x ?? line.items?.[0]?.transform?.[4];
  const right = line.right ?? x + (line.items?.[line.items.length - 1]?.width || 0);
  if (!Number.isFinite(x) || !Number.isFinite(right)) return false;
  const span = right - x;
  if (span <= 0 || span >= pageWidth * 0.8) return false;
  return Math.abs((x + right) / 2 - pageWidth / 2) <= 40;
}

/**
 * Quote bars are a LAST-RESORT signal: only lines that no higher-priority
 * semantic pass claimed (heading, code, table, list, standalone label) may
 * become Markdown quotes. A bar alone is never enough to override those.
 */
function markQuoteEvents(pageEvents) {
  for (const ev of pageEvents) {
    if (!ev.quoteBar) continue;
    // 'raw' here may be a line starting with a quote mark (“...”), which is a
    // style hint, not a claim by a higher-priority structural pass. Structural
    // claims (heading/code/table/list/standalone label) must stay untouched.
    if (ev.kind !== 'text' && ev.kind !== 'raw') continue;
    if (ev.heading || ev.isList || ev.isSourceLine || ev.standalone) continue;
    ev.quote = true;
    ev.kind = 'raw';
  }
}

/** Identity of the quote bar that owns a line (undefined when untagged). */
function quoteGroup(ev) {
  return ev.quoteBarId ?? `${ev.x ?? ''}:${ev.y ?? ''}`;
}

/** Right-most x occupied by a line's text items (a layout fact, not a text guess). */
function quoteLineRight(ev) {
  let r = Number.isFinite(ev?.right) ? ev.right : -Infinity;
  for (const it of ev?.items || []) {
    const x = it?.transform?.[4];
    if (typeof x === 'number') r = Math.max(r, x + (it.width || 0));
  }
  return r;
}

/** Column right edge: the widest non-quote line on the page. Quote lines are
 * excluded so a block of short unpunctuated quotes cannot define its own edge. */
function quoteColumnRight(page) {
  let r = 0;
  for (const l of page?.lines || []) {
    if (l.dropped || l.quoteBar) continue;
    r = Math.max(r, quoteLineRight(l));
  }
  return r;
}

const QUOTE_HARD_STOP = /[。！？!?；;：:"”』】）)]$/;
const QUOTE_EDGE_TOL = 24; // ~2 CJK chars shy of the column edge still counts as a wrap

/**
 * One blockquote per bar. A physical line is a PDF wrap only when it runs to
 * the column's right edge — a short line that stops early is a deliberate line
 * end even without sentence punctuation. Wraps join back without inserting a
 * space (CJK wraps carry no real whitespace). Hard sentence punctuation always
 * ends a line, so quoted dialogue like `您好…？”` stays one line per turn.
 */
function renderQuoteRun(run, columnRight) {
  const texts = run.map(r => String(r.text || '').replace(/\u0000/g, '').trim());
  const out = [];
  let prevText = '';
  let prevWasWrap = false;
  for (let i = 0; i < texts.length; i++) {
    const line = texts[i];
    const right = quoteLineRight(run[i]);
    const atEdge = Number.isFinite(columnRight) && columnRight > 0 && right >= columnRight - QUOTE_EDGE_TOL;
    const isWrap = out.length > 0 && prevWasWrap && !QUOTE_HARD_STOP.test(prevText);
    if (isWrap) out[out.length - 1] += line;
    else out.push(line);
    prevText = line;
    prevWasWrap = atEdge;
  }
  return out.join('  \n');
}

/** Indexes of lines in a centred title block (>=2 consecutive centred short lines). */
export function centeredLineBlock(lines, pageWidth) {
  const flags = (lines || []).map(l => isCenteredShortLine(l, pageWidth));
  const block = new Set();
  for (let i = 0; i < flags.length; i++) {
    if (!flags[i]) continue;
    const prev = i > 0 && flags[i - 1] && !lines[i - 1].dropped;
    const next = i + 1 < flags.length && flags[i + 1] && !lines[i + 1].dropped;
    if (prev || next) block.add(i);
  }
  return block;
}

/** Dump raw per-line geometry/font info so conversion steps can be debugged. */
export function logLineDetails(options, pageNo, lines, { bodyHeight = 0, stage = 'lines', bgRects = 0 } = {}) {
  if (!options?.debug) return;
  diag(options, `page ${pageNo} ${stage}: bodyHeight=${bodyHeight.toFixed(1)} lines=${lines.length} bgRects=${bgRects}`);
  lines.forEach((l, i) => {
    if (l.dropped) return;
    const size = (l.fontSize ?? l.height ?? 0).toFixed(1);
    const x = l.x ?? l.items?.[0]?.transform?.[4] ?? 0;
    const y = l.y ?? l.items?.[0]?.transform?.[5] ?? 0;
    const fonts = (l.fonts || (l.fontName ? [l.fontName] : [])).join('/');
    diag(options, `page ${pageNo} line[${i}] y=${y.toFixed(1)} x=${x.toFixed(1)} h=${size} font=${fonts} text=${JSON.stringify(l.text)}`);
  });
}

export function normalizePunctuation(text) {
  return text
    .replace(/：/g, ':').replace(/[“”]/g, '"').replace(/[‘’]/g, "'")
    .replace(/([\u4e00-\u9fff]) +(?=[\u4e00-\u9fff])/g, '$1')
    .replace(/ +([，。、；：！？）】》])/g, '$1')
    .replace(/([A-Za-z])([\u4e00-\u9fff])/g, '$1 $2')
    .replace(/([《【（]) +/g, '$1')
    .replace(/\s+/g, ' ').trim();
}

// Lines that must never be glued to the next physical line: shell snippets,
// fenced-code content, JSON payloads and figure captions. The PDF text layer
// has no block markup, so recognise them by leading token shapes.
function isStandaloneLine(text) {
  const t = text.trim();
  if (!t) return true;
  if (/^[$>]\s/.test(t) || /^\$?curl\b/i.test(t)) return true;
  if (/^[-+]?[A-Za-z][\w.-]*\s+[=\-]|^-F\b/.test(t)) return true;
  if (/^[\{\[]/.test(t) && /[\}\]]$/.test(t)) return true;
  if (/^图\s*\d+[:：]/.test(t)) return true;
  return false;
}

function headingLevel(text, line, headingSizes) {
  const m = text.match(/^(\d+(?:\.\d+)*)/);
  if (m) { const d = m[1].split('.').length; return d <= 1 ? 2 : d === 2 ? 3 : 4; }
  if (CN_HEADING.test(text)) return 2;
  if (COLON_HEADING.test(text) || PAREN_HEADING.test(text)) return 3;
  // Unnumbered visual headings: map the matched font size to its rank in the
  // document's heading-size gradient (largest -> H2, next -> H3, ...).
  if (line && Array.isArray(headingSizes) && headingSizes.length) {
    const size = Number((line.fontSize ?? line.height ?? 0).toFixed?.(1) || 0);
    let best = -1, dist = Infinity;
    headingSizes.forEach((h, i) => {
      const d = Math.abs(size - h);
      if (d < dist) { dist = d; best = i; }
    });
    if (best >= 0 && dist <= 0.6) return Math.min(6, 2 + best);
  }
  return 2;
}

// Pure numbers / percentages / axis ticks are never section headings (e.g.
// chart ticks "0.650" or "80.5%"). Apply before every other heading signal,
// including the visual-size rule: figure labels often share a heading size.
const NOT_HEADING_TEXT = /^[\d.,%+\-]+\s*$/;
// A line opening with a percentage / measurement ("80.5% (7.7% point ...)")
// is prose continuing from a wrapped sentence, never a section heading.
const NUMERIC_LEAD = /^[+-]?\d[\d,]*(\.\d+)?\s*[%‰]/;

export function classifyHeading(text, line, headingSizes) {
  if (NOT_HEADING_TEXT.test(text) || NUMERIC_LEAD.test(text)) return false;
  // Visually oversized+bold-ish lines are headings even without a numbering
  // marker, e.g. the unnumbered "典型智能客服通话流程"/"简单总结".
  if (line && isOversizedHeading(line, headingSizes)) return true;
  // Table-resident lines are excluded before classification, so classify by
  // text alone — sample.pdf's "1. 双栏正文" sits at a larger x than test's.
  if (CN_HEADING.test(text) && !/[。；]$/.test(text)) return true;
  if (/^\d+\.\d+/.test(text) && text.length <= 40) return true;
  // A numbered line ending with sentence punctuation (。！？；) is a list item
  // or a prose sentence, not a section heading — e.g. "1. 用户拨打客服电话。"
  if (/[。！？；;!?]$/.test(text)) return false;
  // "1. xxx" is ambiguous: a section heading ("4. 无线费率表") OR an ordered
  // list item at body size ("1. 实时预览 - 左侧输入", "1. 找可运行的 G").
  // Only promote it when its font is one of the document's heading sizes;
  // body-sized numbered lines are list items and must stay in the paragraph
  // flow. This is decided by typography, not by guessing from the text.
  if (/^\d+\.\s*\S/.test(text) && text.length <= 30) {
    // When the document establishes heading sizes, require a heading font —
    // otherwise body-sized "1. xxx" list items get promoted (temp.pdf's
    // "1. 实时预览 - 左侧输入", temp.pdf's "1. 找可运行的 G"). Only when NO
    // heading size exists at all do we fall back to the text-only reading.
    if (Array.isArray(headingSizes) && headingSizes.length) {
      // A single top-level heading may occur only once, so it never forms a
      // 2+ line size cluster and is absent from headingSizes. When its font
      // is clearly larger than every established heading size, trust the
      // typography and keep it a heading (e.g. "5. 案例demo" at 18.7pt vs
      // body 11pt / H2 15.4pt).
      const size = Number((line?.fontSize ?? line?.height ?? 0).toFixed?.(1) || 0);
      if (line && size > 0 && headingSizes.every(h => size > h + 0.6)) return true;
      return line ? isOversizedHeading(line, headingSizes) : false;
    }
    return true;
  }
  if (COLON_HEADING.test(text) || PAREN_HEADING.test(text)) return true;
  // A 顿号 (、) list item with a trailing colon ("1、数据传输加密:…") is prose.
  return false;
}

function tableKey(t) {
  return `${t.colEdges.length}:${t.colEdges.map(x => x.toFixed(0)).join(',')}`;
}
/**
 * Prose/figures sometimes satisfy grid geometry (dense text layouts, caption
 * rectangles). Such a "table" would swallow paragraphs into one cell. Real
 * tables carry short labels/numbers per cell, so reject grids whose cells hold
 * paragraph-length text or which are mostly empty around one long prose blob.
 */
export function isProseRows(rows, colCount, maxTableCellLength = 200) {
  if (!Array.isArray(rows) || !rows.length) return true;
  const cells = rows.flat().map(c => String(c ?? '').trim()).filter(Boolean);
  if (!cells.length) return true;
  const maxLen = Math.max(...cells.map(c => c.length));
  const cols = Math.max(1, colCount || 1); // colCount is already a real column count
  const fill = cells.length / (rows.length * cols);
  if (maxLen > maxTableCellLength) return true;
  if (fill < 0.25 && cells.some(c => c.length > 60)) return true;
  return false;
}

function escapeCell(s) { return String(s ?? '').replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim(); }

/** Markdown image reference for an extracted image, matching the manifest path. */
export function imagePlaceholder(img, index) {
  const ext = img.contentType === 'image/jpeg' ? 'jpg' : 'png';
  return `![${img.name}](images/p${img.page}-${index + 1}-${img.name}.${ext})`;
}

/** Anchor an image placeholder at its visual y, between the surrounding text. */
function imageEvents(page) {
  const images = (page.images || []).filter(img => Number.isFinite(img.top));
  if (!images.length) return [];
  return images.map(img => ({
    kind: 'image', y: img.top, raw: imagePlaceholder(img, (img.index || 1) - 1),
  }));
}

const isDataRow = row => {
  const first = String(row[0] ?? '').trim();
  return /^[+-]?\d/.test(first);
};
const rowSig = row => row.map(c => String(c ?? '').trim()).join('\u0000');

/**
 * Signatures of the leading header block. A repeated header on a continuation
 * page matches these exactly. Unlike the old numeric-first-column boundary,
 * text-first tables (API fields, module names) are covered too.
 */
function headerSignatureSet(rows) {
  const sigs = new Set();
  for (let i = 0; i < headerBlockEnd(rows); i++) {
    const sig = rowSig(rows[i]);
    if (sig && !/^[\u0000\s]*$/.test(sig)) sigs.add(sig);
  }
  return sigs;
}
/**
 * Index of the first data row: header rows precede it. For text-first tables
 * (API fields, module names) there is no numeric first column, so fall back to
 * a short leading block whose rows lack a numeric cell anywhere.
 */
function headerBlockEnd(rows) {
  const numeric = rows.findIndex(isDataRow);
  if (numeric >= 1) return numeric;
  let end = 0;
  for (const r of rows.slice(0, 4)) {
    const cells = r.map(c => String(c ?? '').trim());
    // "2025年" / "1级分类" are header labels, not data. Only a row dominated
    // by pure numbers (or keyed by a plain serial) starts the data block.
    const numericCells = cells.filter(c => SHORT_NUMERIC.test(c)).length;
    if (numericCells > cells.length / 2 || /^\d+$/.test(cells[0] || '')) break;
    end++;
  }
  return Math.max(1, Math.min(end, 2));
}

/**
 * Cross-page tables repeat a multi-line header (ReportLab does this on every
 * page). Detect the leading header block — consecutive rows before the first
 * data row — and drop any later run of rows that repeats that block, aligned
 * to the table_ext.py rule of removing continuation headers rather than
 * treating them as records.
 */
export function dedupeHeaderRows(rows) {
  if (rows.length < 3) return rows;
  const headerSigs = headerSignatureSet(rows);
  if (!headerSigs.size) return rows;
  const blockEnd = headerBlockEnd(rows);
  const out = [];
  for (let i = 0; i < rows.length; i++) {
    // Any leading-header signature reappearing after the first data row is a
    // continuation-page repeat — drop every matching row of the multi-line
    // block. Rows before blockEnd are the real leading header.
    if (i >= blockEnd && headerSigs.has(rowSig(rows[i]))) continue;
    out.push(rows[i]);
  }
  return out;
}

/**
 * Merge a page-boundary row that was split across pages. Delegates the
 * all-or-nothing decision to the ported table_ext.py heuristic: strong
 * separator / CJK boundary / blank-column signals, with independent-record
 * vetoes. Only the first row of the continued page is a candidate.
 */
export function mergeSplitBoundaryRows(rows, boundaryIdx, headerSigs = null) {
  if (boundaryIdx <= 0 || boundaryIdx >= rows.length) return { rows, merged: 0 };
  const prev = rows[boundaryIdx - 1], cur = rows[boundaryIdx];
  // A repeated table header on the continuation page is NOT a wrapped data
  // row. Merging it would produce cells like "知识增强类型". Veto by signature
  // (exact cell text) and by a generic-header shape shared with the first row.
  const sig = r => rowSig(r);
  if (headerSigs && headerSigs.has(sig(cur))) return { rows, merged: 0 };
  if (rows.length && sig(cur) === sig(rows[0])) return { rows, merged: 0 };
  const pipe = r => '| ' + r.map(c => String(c ?? '')).join(' | ') + ' |';
  const verdict = evaluateBoundaryRow(pipe(prev), pipe(cur));
  if (!verdict.merge) return { rows, merged: 0 };
  const merged = [...rows];
  merged[boundaryIdx - 1] = verdict.cells;
  merged.splice(boundaryIdx, 1);
  return { rows: merged, merged: 1 };
}

/** Merge split rows at every stitch boundary of a table spanning N pages.
 * Work back-to-front so earlier boundary indices survive row removals. */
export function mergeSplitBoundaryRowsAt(rows, boundaryIdxs) {
  let out = rows.map(r => [...r]);
  for (const b of [...(boundaryIdxs || [])].reverse()) {
    const headerSigs = headerSignatureSet(out);
    // A continuation page repeats the whole leading header block verbatim at
    // the stitch boundary. Strip that *complete block* before merging: left in
    // place, the repeated header sits at `b` and vetoes the merge, and the real
    // first data row (b+blockLen) never gets to join the split record at b-1.
    // Match the full consecutive block, not a lone row that merely equals one
    // header line (which could be a genuine repeated data value).
    const headerLen = headerBlockEnd(out);
    let matched = 0;
    while (matched < headerLen && b + matched < out.length &&
           rowSig(out[b + matched]) === rowSig(out[matched])) matched++;
    if (matched === headerLen) out.splice(b, headerLen);
    out = mergeSplitBoundaryRows(out, b, headerSigs).rows;
    // Fallback: a leftover row at the boundary that still matches a header
    // signature is a repeated header (possibly a different multi-line block).
    if (b < out.length && headerSigs.has(rowSig(out[b]))) out.splice(b, 1);
  }
  return out;
}

// ---- Punctuation classes used when gluing wrapped prose inside code blocks ----
// A physical line ending with a SENTENCE_END closes a statement: never join it
// to the following line. The complete set of ending punctuation (Chinese + ASCII):
//   句号 。．.  /  问号 ？?  /  感叹号 ！!  /  分号 ；;  /  冒号 ：:  /  省略号 ……
// plus closing quotes/brackets that terminate a statement: ""''」』】》）〉)]
const SENTENCE_END = /[。．！？；：….!?;:""'']$/;
const SENTENCE_END_CLOSERS = /[”"』」】》）〉)\]]$/;

// Comma (，,) and enumeration comma (、) are NOT endings — they only pause
// mid-sentence. A line ending in one is an unfinished statement and must join
// the next line regardless of its width.
const CONTINUATION_PUNCT = /[，,、]$/;

// A wrapped physical line inside a code block reaches near the block's right
// edge with no ending punctuation; the next line continues the same sentence.
// Join those so a prompt pasted into a PDF doesn't break mid-word. Real code
// syntax (braces, comments, shell flags, key/value, operators) and tree/config
// lines are never joined.
function shouldJoinCodeLine(prev, next, prevWidth, blockWidth) {
  const a = String(prev).trimEnd();
  const b = String(next).trimStart();
  if (!a || !b) return false;
  // Ending punctuation (incl. a closer right after terminal punctuation) ends
  // the statement — never join past it.
  if (SENTENCE_END.test(a) || SENTENCE_END_CLOSERS.test(a)) return false;
  // A new logical line starts with a code/shell/markdown marker, a box-drawing
  // tree branch, or a leading number — never a continuation of prose.
  if (/^[$\#>@/+*（([{\-│├└┌┐┘┬┴┼─═║╔╗╚╝╠╣]|^[-+]?\d+[.)]\s|^\s/.test(String(next))) return false;
  if (/[{};=`|<>]|=>|\/\//.test(a) || /[{};=`|<>]|=>|\/\//.test(b)) return false;
  // Both lines must read like natural-language prompt text: leading @name,
  // slash command, or Chinese sentence. Excludes config/data/tree syntax.
  const prose = t => /^@\w/.test(t) || /^\/\w/.test(t) || /[\u4e00-\u9fff]/.test(t);
  if (!prose(a) || !prose(b)) return false;
  // A comma / 顿号 explicitly signals “sentence continues” — join unconditionally.
  if (CONTINUATION_PUNCT.test(a)) return true;
  // Otherwise the line must have run to the code column's right edge to count
  // as a soft wrap; short lines are deliberate breaks. A line whose leading
  // gutter number survived into the text counts as wrapped despite its width.
  const numbered = /^\d{1,3}\s/.test(String(prev));
  return numbered || (Number.isFinite(prevWidth) && Number.isFinite(blockWidth) && blockWidth > 0 &&
    prevWidth >= blockWidth * 0.85);
}

export function render2(pages, options = {}) {
  // Mark atomic layout lines once per page: code/JSON/captions and the
  // evenly-spaced short label rows above a dense table body.
  // Mark geometry-only label rows. A line truly inside a vector grid is a
  // table cell and is excluded, so rule tables' evenly-spaced rows are safe.
  for (const page of pages) {
    const cells = (page.tables || []).filter(t => Array.isArray(t.rows) && t.rows.length && t.source !== 'borderless');
    page.isTableLine = line => cells.find(t => line.y <= t.top + 3 && line.y >= t.bottom - 3);
    page.tableTops = (page.tables || []).filter(t => t.source === 'borderless').map(t => t.top);
  }
  detectStandaloneLines(pages);
  detectCodeBlocks(pages);
  // One global event stream with explicit page order, so cross-page table
  // continuations and their orphan edge-lines can be joined deterministically.
  const events = []; // {kind:'toc'|'heading'|'text'|'table', ...}
  const pageHeightById = new Map(pages.map(p => [p.pageNumber, p.pageHeight]));
  const headingLines = pages.flatMap(p => {
    const minX = Number.isFinite(p.contentMinX) ? p.contentMinX : pageContentMinX(p.lines);
    return (p.lines || []).map(l => ({ ...l, pageContentMinX: minX, pageWidth: p.pageWidth }));
  });
  const headingSizes = headingSizesFromLines(headingLines);
  diag(options, `headingSizes=[${headingSizes.join(',')}]`);
  let tocDone = false;
  let carryToNext = []; // bottom-of-page orphan lines belonging to next page's table

  for (let pi = 0; pi < pages.length; pi++) {
    const { lines, tables, pageNumber, pageHeight } = pages[pi];
    const contentMinX = pageContentMinX(lines);
    // Emit every detected grid: cell-grid tables (per-cell rectangles, test.pdf)
    // and rule-based tables (moveTo/lineTo borders, sample.pdf) both carry rows.
    const cells = tables.filter(t => Array.isArray(t.rows) && t.rows.length);
    const pageH = Number.isFinite(pageHeight) ? pageHeight : 792;
    const dotCount = lines.filter(l => !l.dropped && /\.{4,}|·{4,}|…{4,}/.test(l.text)).length;
    if (dotCount >= 3 && lines.length >= 3) {
      if (!tocDone) { events.push({ kind: 'raw', text: '## 目录' }); tocDone = true; }
      const body = lines.filter(l => !l.dropped && l.text.trim() !== '目录');
      const parsed = body.map(l => formatTocLine(l.text.trim()));
      const width = parsed.reduce((w, p) => Math.max(w, p.label.length), 0);
      for (const p of parsed) events.push({ kind: 'raw', text: `- ${p.label.padEnd(width)}${p.dots}${p.page ? ' ' + p.page : ''}` });
      continue;
    }

    // Lines carried from the previous page's bottom belong to this page's
    // first table as a wrapped header/first row.
    if (carryToNext.length && cells.length) {
      const first = [...cells].sort((a, b) => b.top - a.top)[0];
      const edges = first.colEdges;
      const width = edges.length - 1;
      const carryRows = [];
      for (const items of carryToNext) {
        const bucket = Array(width).fill('');
        for (const it of items) {
          const cx = it.transform[4] + (it.width || 0) / 2;
          let ci = 0;
          for (let k = 0; k < width; k++) if (cx >= edges[k] - 6) ci = k;
          bucket[ci] += it.str;
        }
        carryRows.push(bucket.map(c => normalizePunctuation(c)));
      }
      // Merge wrapped continuation rows: a row with only the first column
      // filled continues the previous row's first cell (e.g. "…且无" + "绕行）").
      const mergedRows = [];
      for (const r of carryRows) {
        const prev = mergedRows[mergedRows.length - 1];
        const onlyFirst = r.slice(1).every(c => !c);
        if (prev && onlyFirst && r[0] && !/[。；）]/.test(prev[0])) {
          prev[0] += r[0];
        } else mergedRows.push(r);
      }
      first.rows.unshift(...mergedRows); // preserve reading order
      carryToNext = [];
    }
    const inTable = line => cells.find(t => line.y <= t.top + 3 && line.y >= t.bottom - 3);
    const centeredBlock = centeredLineBlock(lines, pages[pi].pageWidth);
    const pageEvents = [];
    for (const [lineIdx, line] of lines.entries()) {
      if (line.dropped || line.codeSkip) continue;
      const text = normalizePunctuation(line.text.trim());
      if (!text) continue;
      if (line.codeBlock) {
        // Code / config text is layout-marked; keep each physical line atomic
        // and fenced together by its block id below.
        pageEvents.push({ kind: 'code', text: line.codeText, y: line.y, x: line.x, width: (line.right ?? line.x) - line.x, codeBlock: line.codeBlock, readSeq: line.readSeq });
        continue;
      }
      // A geometry-detected standalone label row is prose metadata printed on
      // top of a borderless grid; it must be emitted as its own line even
      // though the grid covers its coordinates. Only trust it when NO vector
      // grid actually contains the line (rule tables produce the same shape).
      if (line.standalone) {
        // A bigger-font numbered line in the label run is still a section
        // heading, not a table label.
        const isTitle = classifyHeading(text, line, headingSizes);
        pageEvents.push({ kind: isTitle ? 'heading' : 'raw', text, y: line.y, items: line.items, standalone: true, readSeq: line.readSeq, fontSize: line.fontSize ?? line.height, quoteBar: !!line.quoteBar, quoteBarId: line.quoteBarId, linkUrl: line.linkUrl });
        continue;
      }
      if (inTable(line)) continue; // table emitted separately
      const heading = classifyHeading(text, line, headingSizes);
      diag(options, `page ${pageNumber} classify y=${line.y.toFixed(1)} h=${(line.fontSize ?? line.height ?? 0).toFixed(1)} heading=${heading} text=${JSON.stringify(text)}`);
      // A line that opens with a quote mark is a quoted example / callout:
      // keep it on its own line rather than reflowing into prose.
      const quoted = /^[“"《]/.test(text);
      // A centred block keeps its physical line breaks regardless of whether
      // it was promoted to a heading — layout must not depend on heading sizes.
      const keepLine = quoted || line.standalone || centeredBlock.has(lineIdx) || isStandaloneLine(text);
      pageEvents.push({ kind: heading ? 'heading' : keepLine ? 'raw' : 'text', text, y: line.y, items: line.items, standalone: !!line.standalone, readSeq: line.readSeq, fontSize: line.fontSize ?? line.height, quoteBar: !!line.quoteBar, quoteBarId: line.quoteBarId, heading, linkUrl: line.linkUrl });
    }
    for (const t of cells) pageEvents.push({ kind: 'table', table: t, y: t.top, top: t.top, bottom: t.bottom });
    pageEvents.push(...imageEvents(pages[pi]));
    // Two-column pages carry an explicit readSeq on every line. Map tables and
    // images onto that sequence by y so the sort stays consistent; single-column
    // pages have no readSeq and keep the original visual y-order.
    const hasReadSeq = pageEvents.some(e => Number.isFinite(e.readSeq));
    if (hasReadSeq) {
      const seqOf = y => {
        let best = Infinity, seq = -1;
        for (const e of pageEvents) {
          if (!Number.isFinite(e.readSeq)) continue;
          const d = Math.abs(e.y - y);
          if (d < best) { best = d; seq = e.readSeq; }
        }
        return seq;
      };
      for (const e of pageEvents) if (!Number.isFinite(e.readSeq)) e.readSeq = seqOf(e.y);
    }
    pageEvents.sort((a, b) => a.readSeq - b.readSeq ||
      b.y - a.y || (a.kind === 'table' ? -1 : 1));

    // A visual bullet list is a run of >=3 short, equally indented text lines
    // with even vertical spacing. Quotes and wrapped prose lack the even
    // spacing / run length, so geometry alone separates them from lists.
    for (let k = 0; k < pageEvents.length; k++) {
      const ev = pageEvents[k];
      if (ev.kind !== 'text' || ev.isList !== undefined) continue;
      const x = ev.items?.length ? Math.min(...ev.items.map(i => i.transform[4])) : 0;
      // Indent is relative to the page's body left margin, not absolute A4 pixels.
      const indent = x - contentMinX;
      if (indent < 12 || indent > 35 || String(ev.text || '').length > 22 || /^[“"《]/.test(ev.text)) continue;
      const run = [ev];
      for (let m = k + 1; m < pageEvents.length; m++) {
        const nx = pageEvents[m];
        if (nx.kind !== 'text') break;
        const nxx = nx.items?.length ? Math.min(...nx.items.map(i => i.transform[4])) : 0;
        if (Math.abs(nxx - x) > 5 || String(nx.text || '').length > 22 || /^[“"《]/.test(nx.text)) break;
        if (run.length > 1 && Math.abs((run[run.length - 1].y - nx.y) - (run[0].y - run[1].y)) > 4) break;
        run.push(nx);
      }
      if (run.length >= 3) run.forEach(r => { r.isList = true; });
    }

    // Markdown source shown inside a document (e.g. an AGENTS.md outline
    // pasted as `# title` / `## 1. ...` lines) is a code sample, not live
    // headings: the caption above it says it is an example, and the lines are
    // printed one-per-baseline in a monospace face. Genuine headings were
    // already classified out above. A run of >=2 text lines that literally
    // start with a markdown heading marker is such a sample — fence it as a
    // code block so the `#` stays literal instead of becoming an H1/H2.
    for (let k = 0; k < pageEvents.length; k++) {
      const ev = pageEvents[k];
      if (ev.kind !== 'text' || ev.isList !== undefined) continue;
      if (!/^#{1,6}\s+\S/.test(ev.text)) continue;
      let n = 1;
      while (k + n < pageEvents.length &&
             pageEvents[k + n].kind === 'text' &&
             /^#{1,6}\s+\S/.test(pageEvents[k + n].text)) n++;
      if (n >= 2) {
        const id = `p${pageNumber}-mdsrc-${k}`;
        for (let j = k; j < k + n; j++) {
          pageEvents[j].kind = 'code';
          pageEvents[j].codeBlock = id;
        }
      }
      k += n - 1;
    }

    // Cross-page edge lines: the very top line of a page continues the
    // previous page's last table; trailing bottom lines continue THIS page's
    // first table (or the next page's table if none here).
    for (let k = 0; k < pageEvents.length; k++) {
      const ev = pageEvents[k];
      if (ev.kind !== 'text') continue;
      const isTop = ev.y >= pageH * 0.85;
      const isBottom = ev.y <= pageH * 0.14;
      if (isTop && !/^\d+、/.test(ev.text) && events.length) {
        // A page-top orphan line is the wrapped tail of the previous page's
        // last table row: append its full text to that row's last filled cell.
        const lastTbl = [...events].reverse().find(e => e.kind === 'table');
        // Only a table that actually reaches the page bottom can have a
        // wrapped cell continuing at the top of the next page.
        const lastTblBottom = lastTbl ? lastTbl.table.bottom : Infinity;
        // A complete prose sentence at the top of a page is NOT a wrapped
        // table cell — it just happens to follow a table that reached the
        // bottom (temp.pdf's "goroutine 不是…。"). Only an unfinished fragment
        // (no terminal punctuation) can continue a cell.
        const isComplete = /[。；！？.!?]$/.test(ev.text);
        if (lastTbl && lastTblBottom < pageH * 0.18 && lastTbl.table.rows.length && !isComplete) {
          const lastRow = lastTbl.table.rows[lastTbl.table.rows.length - 1];
          let j = lastRow.length - 1;
          while (j > 0 && !String(lastRow[j] || '').trim()) j--;
          lastRow[j] = String(lastRow[j] || '') + ev.text;
          pageEvents.splice(k--, 1);
          continue;
        }
      }
      if (isBottom && !classifyHeading(ev.text, ev, headingSizes) && !/^\d+、/.test(ev.text)) {
        // A "1、…" list item is never a table row. Only page-bottom lines laid
        // out in >=2 separated x-columns are table
        // header/first rows to carry to the next page. Plain prose wrapping at
        // the page bottom (e.g. a paragraph's last lines) stays in the flow.
        const its = (ev.items || []).filter(it => String(it.str || '').trim());
        let cols = 0, lastX = -1e9;
        for (const it of its.sort((a, b) => a.transform[4] - b.transform[4])) {
          if (it.transform[4] - lastX > 25) cols++;
          lastX = it.transform[4] + (it.width || 0);
        }
        // A wrapped table row has no sentence-ending punctuation; a normal
        // bottom-of-page prose line ("Go 通过 GMP …执行。") does. Requiring
        // both >=2 x-columns and an unfinished tail avoids swallowing prose
        // into the last table cell (temp.pdf's GMP paragraph).
        const isComplete = /[。；！？.!?]$/.test(ev.text);
        if (cols >= 2 && !isComplete) {
          carryToNext.push(ev.items || [{ str: ev.text, transform: [0, 0, 0, 0, 0, ev.y], width: 0 }]);
          pageEvents.splice(k--, 1);
        }
      }
    }
    markQuoteEvents(pageEvents);
    events.push(...pageEvents.map(e => ({ ...e, pageNumber })));
  }

  // Build output blocks. Consecutive tables on the SAME grid across pages are
  // stitched; a repeated multi-line header emitted by ReportLab on the next
  // page is removed (table_ext.py continuation-header rule).
  const out = [];
  let para = [];
  let paraEvents = [];
  // Previous output block is an unfinished "N." item awaiting its wrapped
  // tail. Carries geometry so a nearby line can be recognised as a true wrap
  // (tight leading) vs a new paragraph/section (wide vertical gap).
  let orderedOpen = null;
  const flushOrdered = () => { orderedOpen = null; };
  const flushPara = () => {
    if (!para.length) return;
    // Join wrapped physical lines with no inserted space for CJK continuity,
    // but keep a space when the next line starts with a Latin token.
    let text = para[0];
    for (let i = 1; i < para.length; i++) {
      const next = para[i];
      text += (/^[A-Za-z]/.test(next) ? ' ' : '') + next;
    }
    out.push(text);
    para = [];
    paraEvents = [];
  };
  let tableBuf = null;
  const seenHeaderBlocks = new Set();
  const isTableText = t => typeof t === 'string' && /^\| .+ \|$/.test(t.split('\n')[0] || '') && t.split('\n')[1]?.startsWith('| ---');
  const flushTable = () => {
    if (!tableBuf) return;
    let rows = tableBuf.rows.map(r => [...r]);
    if (!tableBuf.mergedLayout) rows = mergeSplitBoundaryRowsAt(rows, tableBuf.boundaryIdxs);
    // Wrapped tail in the first column: "绕行）" continues "P0（…且无".
    const folded = [];
    for (const r of rows) {
      const prev = folded[folded.length - 1];
      const onlyFirst = r.slice(1).every(c => !String(c).trim());
      if (prev && onlyFirst && String(r[0] || '').trim() && !/[。；！？.!?）】]/.test(String(prev[0] || ''))) {
        prev[0] = String(prev[0] || '') + String(r[0]);
      } else folded.push([...r]);
    }
    rows = dedupeHeaderRows(folded);
    rows = alignMergedCells(rows, Math.max(...rows.map(r => r.length)));
    // Final rows may have grown via cross-page carry/folding; drop prose that
    // geometry mis-detected as a table so its text stays in the reading flow.
    if (isProseRows(rows, tableBuf.cols, options.maxTableCellLength)) { tableBuf = null; return; }
    // A table that starts with a header block identical to one already emitted
    // is a cross-page continuation. ReportLab repeats the whole multi-line
    // header on each page; drop it so only data rows remain (table_ext.py).
    let isContinuation = false;
    // Cross-page continuation uses the numeric-first-column boundary: it is
    // validated against the continuation tables in test3.pdf. Text-first
    // header blocks are handled by dedupeHeaderRows instead, so this path is
    // left unchanged to avoid regressions.
    const he0 = rows.findIndex(isDataRow);
    if (he0 > 0) {
      const blockKey = rows.slice(0, he0).map(rowSig).join('\u0001');
      if (seenHeaderBlocks.has(blockKey)) { rows = rows.slice(he0); isContinuation = true; }
      else seenHeaderBlocks.add(blockKey);
    }
    if (isContinuation && rows.length) {
      // Continuation of a table already emitted (split by a page-footer note).
      // Drop the footer note(s) and append data rows to that table block so it
      // stays one logical GFM table instead of a second headerless table.
      while (out.length && /^(注:|单位:)/.test(out[out.length - 1])) out.pop();
      // Only fold back when the table is now the immediately preceding block;
      // if other prose sits between, keep this as a normal table.
      const prevIdx = isTableText(out[out.length - 1]) ? out.length - 1 : -1;
      if (prevIdx >= 0) {
        const width = (out[prevIdx].split('\n')[0].match(/\|/g) || []).length - 1;
        const dataLines = rows.map(r => {
          const o = r.slice(0, width); while (o.length < width) o.push('');
          return '| ' + o.map(escapeCell).join(' | ') + ' |';
        });
        out[prevIdx] += '\n' + dataLines.join('\n');
        tableBuf = null;
        return;
      }
    }
    if (rows.length >= 2) {
      const width = Math.max(...rows.map(r => r.length));
      const norm = rows.map(r => { const o = r.slice(0, width); while (o.length < width) o.push(''); return o; });
      const header = '| ' + norm[0].map(escapeCell).join(' | ') + ' |';
      const sep = '| ' + Array(width).fill('---').join(' | ') + ' |';
      const bodyLines = norm.slice(1).map(r => '| ' + r.map(escapeCell).join(' | ') + ' |');
      const prev = out[out.length - 1];
      // A continuation table whose header is identical to the table just
      // emitted: append its data rows and drop this repeated header block.
      if (isTableText(prev) && prev.split('\n')[0] === header) {
        out[out.length - 1] = prev + '\n' + bodyLines.join('\n');
      } else {
        out.push([header, sep, ...bodyLines].join('\n'));
      }
    }
    tableBuf = null;
  };
  // Coalesce quote lines by their bar into one block-quote event. The bar is
  // the physical boundary — two bars are two quotes even if adjacent; lines
  // sharing a bar stay one quote. Each physical PDF line becomes one line in
  // the blockquote (Markdown hard break), so the viewer shows the same layout
  // as the source instead of reflowing dialogue or wrapping CJK with spaces.
  const quoteEvents = [];
  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    if (!ev.quote) continue;
    let j = i + 1;
    while (j < events.length && events[j].quote && events[j].pageNumber === ev.pageNumber &&
           quoteGroup(events[j]) === quoteGroup(ev)) j++;
    const run = events.slice(i, j);
    quoteEvents.push({ idx: i, del: j - i, ev: { ...ev, quoteText: renderQuoteRun(run, quoteColumnRight(pages.find(p => p.pageNumber === ev.pageNumber))), quoteRun: run } });
    i = j - 1;
  }
  // Replace runs in-place (single event per run).
  for (let k = quoteEvents.length - 1; k >= 0; k--) {
    const { idx, del, ev } = quoteEvents[k];
    events.splice(idx, del, ev);
  }

  for (const ev of events) {
    if (ev.kind === 'table') {
      const key = tableKey(ev.table);
      const canStitch = tableBuf && ev.pageNumber !== (tableBuf.lastPage ?? -1)
        && (tableBuf.key === key || sameTableGrid(tableBuf.table, ev.table, {
            prevPageHeight: pageHeightById.get(tableBuf.lastPage),
            nextPageHeight: pageHeightById.get(ev.pageNumber),
          }));
      if (canStitch) {
        const layoutChanged = gridColumns(tableBuf.table) !== gridColumns(ev.table);
        if (!layoutChanged) {
          tableBuf.boundaryIdxs = tableBuf.boundaryIdxs || [];
          tableBuf.boundaryIdxs.push(tableBuf.rows.length);
        }
        if (layoutChanged) tableBuf.mergedLayout = true;
        tableBuf.rows.push(...ev.table.rows);
        tableBuf.lastPage = ev.pageNumber;
      } else {
        flushTable(); flushPara(); flushOrdered();
        tableBuf = { key, table: ev.table, rows: [...ev.table.rows], cols: gridColumns(ev.table), lastPage: ev.pageNumber };
      }
      continue;
    }
    flushTable();
    if (ev.kind === 'image') { flushPara(); flushOrdered(); out.push(ev.raw); continue; }
    if (ev.kind === 'code') { flushPara(); flushOrdered(); out.push({ type: 'code', id: ev.codeBlock, text: ev.text, width: ev.width }); continue; }
    if (ev.quote) { flushPara(); flushOrdered(); out.push(ev.quoteText.split('\n').map(l => '> ' + l).join('\n')); continue; }
    if (ev.kind === 'raw' || ev.isSourceLine) { flushPara(); flushOrdered(); out.push(linkText(ev)); continue; }
    if (ev.kind === 'heading') { flushPara(); flushOrdered(); out.push(`${'#'.repeat(headingLevel(ev.text, ev, headingSizes))} ${linkText(ev)}`); continue; }
    // A numbered list item ("1. xxx", "2. xxx") is a visual line of its own —
    // printed on a separate baseline at the same size/indent. Keep each item
    // atomic, but a physical wrap of a long item (no terminal punctuation)
    // must stay attached to that item instead of becoming a second paragraph.
    if (/^\d+\.\s+\S/.test(ev.text)) {
      flushPara();
      out.push(linkText(ev));
      // Keep the item open only when its text runs on (no terminal rule). A
      // new "N." line always starts its own item via this branch, so two
      // adjacent items can never be merged by the tail logic below.
      orderedOpen = /[。；！？.!?]$/.test(ev.text) ? null : {
        y: ev.y, pageNumber: ev.pageNumber, fontSize: ev.fontSize,
      };
      continue;
    }
    // A nearby line below an unfinished "N." item is its physical wrap; join
    // it back into the same item. The vertical gap distinguishes a wrap (one
    // tight line leading, ~1.5x font size) from a new paragraph/section
    // (2.5x+), so labels like "代码示例" or "例如:" never get swallowed.
    if (orderedOpen && para.length === 0 && out.length) {
      const gap = orderedOpen.y - ev.y;
      const maxGap = Math.max(24, (orderedOpen.fontSize || 11) * 2.2);
      const prev = out[out.length - 1];
      // If the item line was partly wrapped into a Markdown link, appending
      // the tail after `](url)` would corrupt the link label. Keep such cases
      // as-is (the pre-existing link behaviour) rather than breaking the URL.
      const endsWithLink = /\]\([^)]*\)$/.test(typeof prev === 'string' ? prev : '');
      if (orderedOpen.pageNumber === ev.pageNumber && gap > 0 && gap <= maxGap && !endsWithLink) {
        const tail = linkText(ev);
        out[out.length - 1] += (/^[A-Za-z]/.test(tail) ? ' ' : '') + tail;
        if (/[。；！？.!?]$/.test(ev.text)) orderedOpen = null;
        else orderedOpen = { ...orderedOpen, y: ev.y }; // allow multi-line wraps
        continue;
      }
      orderedOpen = null; // not a wrap — fall through as normal text
    }
    // Indented short lines (bullet/label lists) are one item per visual line;
    // x>65pt at 11pt font marks the indented list level in these documents.
    if (ev.isList) { flushPara(); flushOrdered(); out.push('- ' + linkText(ev)); continue; }
    // A font-size change between adjacent prose lines is a layout boundary:
    // a bold/small label followed by body text ("引用块" -> quoted text,
    // "主要功能" -> list) must not be glued into one paragraph.
    if (para.length && Number.isFinite(ev.fontSize)) {
      const last = paraEvents[paraEvents.length - 1];
      // Bullet glyphs / step numbers are printed in a larger face than the
      // text they mark; that size jump is NOT a section boundary. Let them
      // stay attached to the neighbouring line instead of splitting it.
      const bulletMark = t => /^[•·○●*\-\s]+$/.test(t) || /^\d{1,3}$/.test(t.trim());
      if (last && Number.isFinite(last.fontSize) && Math.abs(last.fontSize - ev.fontSize) > 0.6 &&
          !bulletMark(last.text) && !bulletMark(ev.text)) {
        flushPara();
      }
    }
    // A physical line ending with terminal punctuation completes a sentence;
    // only join the next line when this one has no punctuation (true wrap).
    para.push(linkText(ev));
    paraEvents.push(ev);
    if (/[。；！？.!?]$/.test(ev.text) || ev.text.length > 120) flushPara();
  }
  flushTable(); flushPara();
  // Wrap runs of code/config lines into fenced blocks. Geometry-marked code
  // keeps its own block id (so distinct blocks never merge); the legacy
  // curls/JSON regex still handles ad-hoc snippets in other documents.
  // A leading '> ' is a Markdown block quote, not a shell prompt — never fence quotes.
  const isCode = t => !/^>\s/.test(t) && (/^[$>]\s|^\$?curl\b/i.test(t) || /^-F\b/.test(t) || (/^[{\[]/.test(t) && /[}\]]$/.test(t)));
  const final = [];
  for (let i = 0; i < out.length; i++) {
    const item = out[i];
    if (item && typeof item === 'object' && item.type === 'code') {
      const raw = [item];
      while (i + 1 < out.length && out[i + 1] && out[i + 1].type === 'code' && out[i + 1].id === item.id) {
        i++;
        raw.push(out[i]);
      }
      const blockWidth = Math.max(...raw.map(r => Number(r.width) || 0));
      const code = raw.map(r => r.text);
      for (let k = 1; k < code.length; k++) {
        if (shouldJoinCodeLine(code[k - 1], code[k], raw[k - 1].width, blockWidth)) {
          code[k - 1] += code.splice(k, 1)[0];
          raw.splice(k, 1);
          k--;
        }
      }
      const lang = detectCodeLanguage(code);
      final.push(['```' + (lang || 'txt'), ...code, '```'].join('\n'));
    } else if (typeof item === 'string' && isCode(item)) {
      const code = [];
      while (i < out.length && typeof out[i] === 'string' && isCode(out[i])) code.push(out[i++]);
      i--;
      const lang = detectCodeLanguage(code);
      final.push(['```' + (lang || 'txt'), ...code, '```'].join('\n'));
    } else final.push(item);
  }
  let md = '';
  for (let i = 0; i < final.length; i++) {
    if (!md) { md = final[i]; continue; }
    // TOC entries (long dot leaders) keep blank lines; only tight bullets and
    // ordered list items join with a single newline.
    const isTight = t => (typeof t === 'string' && !t.startsWith('```') && (/^[-*] /.test(t) || (/^\d+\.\s/.test(t) && /[。]$/.test(t))) && !/\.{4,}|·{4,}|…{4,}/.test(t));
    const prevList = isTight(final[i - 1]);
    const curList = isTight(final[i]);
    md += (prevList && curList ? '\n' : '\n\n') + final[i];
  }
  // Some PDF fonts encode citation markers as NUL-separated glyph runs.
  // They are data separators, not content — strip before emitting Markdown.
  return md.replace(/\u0000/g, '') + '\n';
}
