/**
 * @dhjzz/pdf-to-md — PDF → Markdown converter.
 *
 * Fidelity backbone: pdf.js reading-order text, each physical line emitted
 * exactly once and in order.  Where a vector grid or a run of numeric rows is
 * detected, those same lines are wrapped as Markdown table cells — using the
 * grid's column boundaries — so a real table is produced without dropping or
 * reordering a single character.  Images are raw binary; no OCR is used.
 */
import { readFileSync } from 'node:fs';
import { createZip, createMarkdownZip } from './zip.js';
import { itemsToLines, pageContentMinX, pageContentWidth, applyLinkAnnotations } from './text.js';
import { getDocument, OPS } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { extractPageImages } from './images.js';
import { formatTocLine } from './doc-format.js';
import { collectRules, detectGridTables, borderlessNumericTables, borderlessLabelTables } from './tables.js';
import { evaluateBoundaryRow, foldContinuationHeadRows } from './table-continuation.js';
import { cellGridTables, projectItemsToGrid } from './cellgrid.js';
import { render2, logLineDetails, dominantLineHeight } from './render2.js';
import { skiaGridTables } from './skia-grid.js';
import { backgroundBlocks, markBackgroundLines, quoteBarRects, markQuoteLines, markShadedSingleLines } from './background.js';

const DOT_LEADER = /\.{3,}|·{3,}|…{3,}/;
const CN_HEADING = /^[一二三四五六七八九十]+、\s*\S/;
const NUM_HEADING = /^\d+(?:\.\d+)*[.、]?\s+\S/;
const COLON_HEADING = /^(?:核心目标|功能需求详述|功能目标|技术要求)\s*[:：]/;
const PAREN_HEADING = /^（\d+）\s*\S/;
const NUM_ROW = /^[+-]?\d[\d,]*\.?\d*$/;
const LOG_PREFIX = '[pdf-to-md]';

function diag(options, ...args) {
  if (options?.debug) console.log(LOG_PREFIX, ...args);
}

/** Why a page produced no text — used to turn a silent empty result into a clear message. */
export function diagnoseNoTextPage({ textItems, showTextOps, vectorOps, imageOps }) {
  if (textItems > 0) return null;
  if (showTextOps > 0) {
    return 'PDF 有文本绘制指令但 pdf.js 未提取到有效文字 item，可能是字体编码或文档结构异常；可先用 OCR 工具重建文字层。';
  }
  if (imageOps > 0 && vectorOps === 0) {
    return 'PDF 是纯图片页（扫描件/截图导出），没有文字层；本项目不做 OCR，需先用 OCR 工具处理。';
  }
  if (vectorOps > 0 && imageOps === 0) {
    return 'PDF 正文被输出为矢量路径（文字描边/轮廓），没有文字层；本项目不做 OCR，需先用 OCR 工具处理。';
  }
  if (vectorOps > 0 || imageOps > 0) {
    return 'PDF 内容主要是图片或矢量路径，没有可提取的文字层；本项目不做 OCR，需先用 OCR 工具处理。';
  }
  return 'PDF 页面没有可提取的文字层；请确认文件不是空白页，或先用 OCR 工具处理。';
}

function countOps(opList, OPS, names) {
  const ids = new Set(names.map(name => OPS[name]).filter(id => Number.isInteger(id)));
  let count = 0;
  for (const id of opList.fnArray) if (ids.has(id)) count++;
  return count;
}

/** Heading level from numbering: 1 → h2, 1.1 → h3, 1.1.1 → h4. */
function headingLevel(text) {
  const m = text.match(/^(\d+(?:\.\d+)*)/);
  if (m) {
    const depth = m[1].split('.').length;
    return depth <= 1 ? 2 : depth === 2 ? 3 : 4;
  }
  if (CN_HEADING.test(text)) return 2;
  if (COLON_HEADING.test(text)) return 3;
  if (PAREN_HEADING.test(text)) return 3;
  return 2;
}

export async function convert(source, options = {}) {
  const data = toUint8Array(source);
  diag(options, `convert start: ${data.length} bytes`);
  const task = getDocument({
    data, useSystemFonts: true, isEvalSupported: false, verbosityLevel: 0,
    ...(options.pdfjsOptions || {}),
  });
  const doc = await task.promise;
  const pageCount = doc.numPages;
  diag(options, `pdf loaded: ${pageCount} page(s)`);
  const pages = [];
  const images = [];
  try {
    for (let pno = 1; pno <= pageCount; pno++) {
      const page = await doc.getPage(pno);
      const [textContent, opList] = await Promise.all([page.getTextContent(), page.getOperatorList()]);
      let lines = itemsToLines(textContent.items);
      // Hyperlinks live in /Annots, not in the text layer. Attach link URIs to
      // the lines whose text sits inside a Link annotation rectangle so the
      // renderer can emit real Markdown links instead of bare label text.
      const links = await collectPageLinks(page);
      if (links.length) applyLinkAnnotations(lines, links);
      // Two-column academic papers interleave left/right lines by baseline;
      // reading them y-sorted scrambles sentences. Reorder column-wise before
      // any downstream layout analysis (pure geometry, no content vocabulary).
      lines = applyReadingOrder(lines, twoColumnSplit(lines, page.view[2]));
      const contentMinX = pageContentMinX(lines);
      // Browser-printed code/note blocks sit on a light background rectangle.
      // Recover those rects from the operator stream and tag their lines so the
      // block detector can treat the background as a strong signal.
      const bgRects = backgroundBlocks(opList, OPS, {
        pageWidth: page.view[2], pageHeight: page.view[3],
      });
      markBackgroundLines(lines, bgRects);
      // Quote/callout markers are thin filled vertical bars. Detect them
      // separately from background blocks, but let semantic passes decide
      // whether a tagged line is really a quote (last-resort emission).
      const quoteBars = quoteBarRects(opList, OPS, {
        pageWidth: page.view[2], pageHeight: page.view[3],
      });
      markQuoteLines(lines, quoteBars, bgRects);
      markShadedSingleLines(opList, OPS, lines, {
        pageWidth: page.view[2], pageHeight: page.view[3],
        contentWidth: pageContentWidth(lines),
      });
      const bodyHeight = dominantLineHeight(lines);
      logLineDetails(options, pno, lines, { bodyHeight, bgRects: bgRects.length });
      const textItems = textContent.items.filter(it => typeof it.str === 'string' && it.str.trim()).length;
      const showTextOps = countOps(opList, OPS, [
        'showText', 'showSpacedText', 'nextLineShowText', 'nextLineSetSpacingShowText',
      ]);
      const vectorOps = countOps(opList, OPS, ['constructPath', 'stroke', 'fill', 'eoFill']);
      const imageOps = countOps(opList, OPS, [
        'paintImageXObject', 'paintImageXObjectRepeat', 'paintInlineImageXObject',
        'paintInlineImageXObjectGroup', 'paintSolidColorImageMask',
        'paintImageMaskXObject', 'paintImageMaskXObjectRepeat',
      ]);
      const rules = collectRules(opList, OPS, {
        pageHeight: page.view[3],
        textYs: lines.filter(l => !l.dropped).map(l => l.y),
      });
      const legacy = detectGridTables(rules)
        .filter(t => !t.left || !t.right || t.right - t.left > 80)
        .filter(t => t.colEdges.length >= 2 && t.rowEdges.length >= 3)
        .map(t => ({ ...t, cols: [...t.colEdges].sort((a, b) => a - b) }));
      const grid = cellGridTables(opList, OPS, textContent.items).tables;
      // Rule-based (legacy) grids are drawn with moveTo/lineTo instead of cell
      // rectangles (e.g. sample.pdf). Still project text into them so the
      // renderer can emit them as real tables rather than swallowing the rows.
      for (const t of legacy) {
        if (!Array.isArray(t.rows)) t.rows = projectItemsToGrid(textContent.items, t.colEdges, t.rowEdges);
      }
      // Borderless numeric grids (rate tables with no data cell borders) are
      // detected from aligned numeric baselines; add them where no vector grid
      // already covers the same rows.
      const vectorTables = grid.length ? grid : legacy;
      const borderless = [
        ...borderlessNumericTables(textContent.items),
        ...borderlessLabelTables(textContent.items),
      ].filter(bt =>
        !vectorTables.some(t =>
          bt.bottom <= t.top + 6 && bt.top >= t.bottom - 6)); // y-interval overlap
      // Cell-grid reconstruction (one rectangle per cell) yields far cleaner
      // logical rows than the legacy line-rule detector; prefer it when present.
      const tables = grid.length ? grid : legacy;
      // Skia/Chrome (browser print) draws table borders as thin filled
      // rectangles. Only look for those when no table was found by the usual
      // detectors, so other PDFs keep their existing output.
      if (!tables.length) tables.push(...skiaGridTables(opList, OPS, textContent.items, {
        pageWidth: page.view[2], pageHeight: page.view[3],
      }));
      tables.push(...borderless);
      // Prose/figures can accidentally satisfy grid geometry (dense two-column
      // text, caption rectangles). A table whose cells hold paragraph-length
      // text, or whose grid is mostly empty with a single long blob, is not a
      // real table — emitting it would swallow the prose into one cell. Keep
      // genuine tables: their cells are short values/labels.
      for (let i = tables.length - 1; i >= 0; i--) {
        if (isProseTable(tables[i], options.maxTableCellLength)) tables.splice(i, 1);
      }
      tables.sort((a, b) => b.top - a.top);
      const pageImages = await extractPageImages(page, opList);
      for (const img of pageImages) {
        img.page = pno;
        img.index = images.length + 1;
      }
      images.push(...pageImages);
      const diagnosis = textItems === 0
        ? diagnoseNoTextPage({ textItems, showTextOps, vectorOps, imageOps })
        : null;
      diag(options, `page ${pno}: textItems=${textItems} lines=${lines.length} showTextOps=${showTextOps} vectorOps=${vectorOps} imageOps=${imageOps} tables=${tables.length} embeddedImages=${pageImages.length}`);
      if (diagnosis) diag(options, `page ${pno}: ${diagnosis}`);
      pages.push({ pageNumber: pno, lines, tables, images: pageImages, imageStartIndex: images.length - pageImages.length, diagnosis, bgRects, pageWidth: page.view[2], pageHeight: page.view[3], contentMinX, links });
      page.cleanup?.(); // release per-page opList/image caches for large PDFs
    }
  } finally {
    await doc.destroy();
  }
  stripRunningFooters(pages);
  for (const p of pages) p.blocks = buildBlocks(p.lines, p.tables);

  let markdown, stitchLog;
  if (options.legacyRender) {
    ({ markdown, stitchLog } = renderDocument(pages, options.tables !== false));
  } else {
    markdown = render2(pages, options);
    stitchLog = [];
  }
  const emptyPages = pages.filter(p => !p.lines.some(l => !l.dropped)).length;
  const noTextReason = pages.length > 0 && emptyPages === pages.length
    ? (pages.find(p => p.diagnosis)?.diagnosis || 'PDF 没有可提取的文字层。')
    : null;
  if (noTextReason) markdown = `<!-- ${noTextReason} -->\n\n未识别到文字内容。\n`;
  diag(options, `convert done: pages=${pageCount} textLines=${pages.reduce((n, p) => n + p.lines.filter(l => !l.dropped).length, 0)} tables=${pages.reduce((n, p) => n + p.tables.length, 0)}`);
  const stats = {
    pageCount,
    textItems: pages.reduce((n, p) => n + p.lines.filter(l => !l.dropped).length, 0),
    tableCount: pages.reduce((n, p) => n + p.tables.length, 0),
    imageCount: images.length,
  };
  const imageManifest = images.map((img, i) => {
    const ext = img.contentType === 'image/jpeg' ? 'jpg' : 'png';
    return {
      index: i + 1, page: img.page, name: img.name, width: img.width, height: img.height,
      contentType: img.contentType, bytesLength: img.bytes.length,
      placeholder: `images/p${img.page}-${i + 1}-${img.name}.${ext}`,
      fileName: `p${img.page}-${i + 1}-${img.name}.${ext}`,
    };
  });
  return {
    markdown, images, imageManifest, stats,
    diagnostics: { emptyPages, reason: noTextReason },
    pages: pages.map(p => ({ pageNumber: p.pageNumber, blocks: p.blocks, tables: p.tables, images: p.images })),
    stitchLog,
  };
}

/** Read /Link annotations (URI actions) from a page, in text-layer coordinates. */
async function collectPageLinks(page) {
  try {
    const annots = await page.getAnnotations({ intent: 'display' });
    return (annots || [])
      .filter(a => a?.subtype === 'Link' && typeof a.url === 'string' && a.url.trim())
      .map(a => ({ url: a.url.trim(), rect: a.rect }))
      .filter(l => Array.isArray(l.rect) && l.rect.length === 4);
  } catch {
    return [];
  }
}

function toUint8Array(source) {
  if (source instanceof Uint8Array) return source;
  if (typeof Buffer !== 'undefined' && Buffer.isBuffer && Buffer.isBuffer(source)) return new Uint8Array(source);
  if (typeof source === 'string') return new Uint8Array(readFileSync(source));
  if (source?.buffer) return new Uint8Array(source.buffer);
  throw new TypeError('convert() 需要文件路径、Buffer、Uint8Array 或 ArrayBuffer');
}

/**
 * Detect a two-column page from line-start geometry: two dominant left margins
 * far apart, and y-sorted lines alternating between them. Returns a column
 * classifier, or null for single-column / table pages. Pure geometry — no
 * content vocabulary — so arbitrary documents behave the same.
 */
export function twoColumnSplit(lines, pageWidth) {
  if (!pageWidth || lines.length < 20) return null;
  const hist = new Map();
  for (const l of lines) {
    const k = Math.round(l.x / 10) * 10;
    hist.set(k, (hist.get(k) || 0) + 1);
  }
  const peaks = [...hist].filter(([x, n]) => n >= 4 && x > 20 && x < pageWidth * 0.8)
    .sort((a, b) => b[1] - a[1]);
  if (peaks.length < 2) return null;
  let left = null, right = null;
  for (const [x, n] of peaks) {
    if (x < pageWidth * 0.42) { if (!left || n > left[1]) left = [x, n]; }
    else { if (!right || n > right[1]) right = [x, n]; }
  }
  if (!left || !right || right[0] - left[0] < pageWidth * 0.35 || left[1] < 6 || right[1] < 6) return null;
  const near = x => l => Math.abs(l.x - x) <= 25;
  const leftNear = near(left[0]), rightNear = near(right[0]);
  const seq = [...lines].sort((a, b) => b.y - a.y)
    .map(l => leftNear(l) ? 'L' : rightNear(l) ? 'R' : null).filter(Boolean);
  const ln = seq.filter(c => c === 'L').length, rn = seq.filter(c => c === 'R').length;
  if (ln < 6 || rn < 6) return null;
  let sw = 0;
  for (let i = 1; i < seq.length; i++) if (seq[i] !== seq[i - 1]) sw++;
  if (sw / (seq.length - 1) < 0.6) return null; // alternating => two real columns
  const gutter = (left[0] + right[0]) / 2;
  return { gutter, leftX: left[0], rightX: right[0],
    colOf: line => (line.x + (line.right - line.x) / 2) < gutter ? 0 : 1 };
}

/**
 * Reorder two-column lines into column-major reading order. Everything above
 * the point where both columns are simultaneously populated (title, authors,
 * abstract label, section heads) keeps its original top-to-bottom order; the
 * dense two-column body below is read left column first, then right.
 */
export function applyReadingOrder(lines, split) {
  if (!split) return lines;
  const { gutter, leftX, rightX, colOf } = split;
  const byY = (a, b) => b.y - a.y;
  const sorted = [...lines].sort(byY);
  // Column membership by line-start x near each column's left margin. Lines
  // starting elsewhere (centered titles, labels) are neutral (-1).
  const inCol = l => {
    if (!l.text.trim()) return -1;
    if (Math.abs(l.x - leftX) <= 25) return 0;
    if (Math.abs(l.x - rightX) <= 25) return 1;
    return l.x < gutter ? 0 : 1; // fallback: assign by side of gutter
  };
  // Find the top of the two-column body: the highest y from which onward
  // lines keep alternating between columns (≥6 alternations within 120pt).
  // A single title/author pair at the top does not qualify.
  let bodyTop = -Infinity;
  for (let i = 0; i < sorted.length; i++) {
    let sw = 0, last = null;
    for (let j = i; j < sorted.length && sorted[i].y - sorted[j].y < 120; j++) {
      const c = inCol(sorted[j]);
      if (c === -1 || c === last) continue;
      if (last !== null) sw++;
      last = c;
    }
    if (sw >= 6) { bodyTop = sorted[i].y; break; }
  }
  if (bodyTop === -Infinity) return lines;
  const head = sorted.filter(l => l.y > bodyTop); // top matter, keep y-order
  const body = sorted.filter(l => l.y <= bodyTop);
  const left = body.filter(l => inCol(l) === 0).sort(byY);
  const right = body.filter(l => inCol(l) === 1).sort(byY);
  const misc = body.filter(l => inCol(l) === -1).sort(byY);
  const ordered = [...head, ...left, ...misc, ...right];
  ordered.forEach((l, i) => { l.readSeq = i; });
  return ordered;
}

/**
 * Reject a "table" that is really detected prose/figure geometry.
 * Real tables carry short labels/numbers in each cell. A paragraph-length
 * cell, or a nearly-empty grid with one long prose blob, is a false positive
 * from dense text layouts — dropping it keeps the text in the reading flow.
 */
export function isProseTable(t, maxTableCellLength = 200) {
  if (!t || !Array.isArray(t.rows) || !t.rows.length) return false;
  const cells = t.rows.flat().map(c => String(c ?? '').trim()).filter(Boolean);
  if (!cells.length) return true; // empty grid carries nothing
  const maxLen = Math.max(...cells.map(c => c.length));
  const cols = Math.max(1, (t.colEdges?.length || 2) - 1);
  const fill = cells.length / (t.rows.length * cols);
  // A single paragraph crammed into one cell: prose, not a table.
  if (maxLen > maxTableCellLength) return true;
  // Sparse grid (<25% filled) whose text is long prose: a figure/box outline
  // around running text, not a data table. Genuine sparse tables have short
  // cell values.
  if (fill < 0.25 && cells.some(c => c.length > 60)) return true;
  return false;
}

// Page furniture: page numbers, and repeated short lines at extreme edges.
// Templates use # for digits so "- 1 -" and "Page 2 of 12" match across pages.
const PAGE_NUMBER = /^(?:第\s*#\s*页|-?\s*#\s*-?|page\s+#(?:\s+of\s+#)?|#\s*\/\s*#|#)$/i;
const template = s => String(s || '').replace(/\d+/g, '#').replace(/\s+/g, '').toLowerCase();

export function stripRunningFooters(pages) {
  if (pages.length < 3) return;
  // Count short edge lines by normalized template across pages.
  const seen = new Map(); // key -> Set(pageNumber)
  for (const p of pages) {
    const h = Number.isFinite(p.pageHeight) ? p.pageHeight : 792;
    for (const line of p.lines) {
      const text = String(line.text || '').trim();
      // Company + doc-number headers can be longer than a bare page number.
      if (!text || text.length > 80) continue;
      const tpl = template(text);
      const y = line.y ?? line.items?.[0]?.transform?.[5] ?? 0;
      const extreme = y >= h * 0.90 || y <= h * 0.10;
      if (!extreme) continue; // furniture lives in the extreme top/bottom bands
      const key = tpl;
      if (!seen.has(key)) seen.set(key, new Set());
      seen.get(key).add(p.pageNumber);
    }
  }
  const repeated = new Set();
  for (const [key, pageSet] of seen) {
    const n = pageSet.size;
    const isPageNumber = PAGE_NUMBER.test(key);
    if (n >= Math.ceil(pages.length * (isPageNumber ? 0.6 : 0.8))) repeated.add(key);
  }
  if (!repeated.size) return;
  for (const p of pages) {
    const h = Number.isFinite(p.pageHeight) ? p.pageHeight : 792;
    for (const line of p.lines) {
      const y = line.y ?? line.items?.[0]?.transform?.[5] ?? 0;
      const key = template(line.text);
      if (!repeated.has(key)) continue;
      // Both page numbers and repeated header/footer lines must sit in the
      // top and bottom 10% bands; mid-page headings are never furniture.
      if (y >= h * 0.90 || y <= h * 0.10) line.dropped = true;
    }
  }
}

function normalizePunctuation(text) {
  return text.replace(/：/g, ':').replace(/[“”]/g, '"').replace(/[‘’]/g, "'");
}

// Pure numbers / percentages / axis ticks are chart labels or table cells,
// never section headings (e.g. "0.650", "80.5%", "10.5.").
const NOT_HEADING_TEXT = /^[\d.,%+\-]+\s*$/;
// A line opening with a percentage / measurement is wrapped prose, not a heading.
const NUMERIC_LEAD = /^[+-]?\d[\d,]*(\.\d+)?\s*[%‰]/;

function classify(text, x = 0, right = 0, contentMinX = 0) {
  if (NOT_HEADING_TEXT.test(text) || NUMERIC_LEAD.test(text)) return 'text';
  if (text === '目录') return 'toc-heading';
  if (DOT_LEADER.test(text)) return 'toc';
  if (CN_HEADING.test(text) && !/[。；]$/.test(text)) return 'heading';
  // Numbered section headings sit at the left margin (x≈90).  Digits at an
  // indented x are table-cell/list content (e.g. "5 安全机制", "2. 内置…")
  // and must not become fake headings.
  if (NUM_HEADING.test(text) && text.length <= 40 && !/[。；]$/.test(text)
      && x <= contentMinX + 74
      && !/^\d+(?:\.\d+)?\s+\d[\d.]*(?:\s+\d[\d.]*)+\s*$/.test(text)) return 'heading';
  if (COLON_HEADING.test(text)) return 'heading';
  if (PAREN_HEADING.test(text) && text.length <= 20) return 'heading';
  return 'text';
}

function buildBlocks(lines, tables) {
  const blocks = [];
  // TOC page: long dot leaders aligned into columns, one "## 目录" heading.
  const dotCount = lines.filter(l => !l.dropped && /\.{4,}|·{4,}|…{4,}/.test(l.text)).length;
  if (dotCount >= 3 && lines.length >= 3) {
    const body = lines.filter(l => !l.dropped && l.text.trim() !== '目录');
    const parsed = body.map(l => formatTocLine(l.text.trim()));
    const width = parsed.reduce((w, p) => Math.max(w, p.label.length), 0);
    blocks.push({ type: 'toc-heading', y: lines[0].y });
    for (const l of lines) if (l.dropped || l.text.trim() === '目录') continue;
    for (const p of parsed) blocks.push({ type: 'toc', label: p.label, dots: p.dots, page: p.page, width, y: lines[0].y });
    return blocks;
  }

  // Grid membership: lines whose text items sit inside table cells are cell
  // content, never headings. A real heading (multi-part number, 「一、」, or a
  // short 「核心目标:」 subhead) wins even if an over-extended grid covers it;
  // those overlaid prose grids are flattened into a paragraph at render time.
  const tableForLine = line => {
    for (const t of tables) {
      if (line.y > t.top + 3 || line.y < t.bottom - 3) continue;
      const cols = [...t.colEdges].sort((a, b) => a - b);
      const centers = line.items.map(it => it.transform[4] + (it.width || 0) / 2);
      const inCells = centers.filter(x => cols.some((edge, i) =>
        i < cols.length - 1 && x >= edge - 4 && x <= cols[i + 1] - 4)).length;
      if (inCells >= Math.max(2, Math.ceil(centers.length * 0.4))) return t;
    }
    return undefined;
  };

  const contentMinX = pageContentMinX(lines);
  for (const line of lines) {
    if (line.dropped) continue;
    const text = normalizePunctuation(line.text.trim().replace(/\s+/g, ' '));
    if (!text) continue;
    const semantic = classify(text, line.x, line.right, contentMinX);
    // Strong headings (multi-part numbers, 「一、」, short colon subheads) win
    // over grids. A lone single number is ambiguous — check the grid first, so
    // table rows like "1. 接入协议" stay cells while real prose headings live.
    const strongHeading = semantic === 'heading' &&
      (CN_HEADING.test(text) || COLON_HEADING.test(text) || PAREN_HEADING.test(text) ||
       /^\d+\.\d+/.test(text));
    const table = strongHeading ? undefined : tableForLine(line);
    const kind = table ? 'text' : semantic;
    blocks.push({
      type: kind === 'toc-heading' ? 'heading' : kind === 'toc' ? 'toc' : kind === 'heading' ? 'heading' : 'text',
      text, kind, y: line.y, items: line.items, table,
      level: kind === 'heading' ? headingLevel(text) : undefined,
    });
  }
  return blocks;
}

/** Split one physical line into table cells by grid columns; chars unchanged. */
function cellsForLine(block) {
  const cols = block.table.cols;
  const cells = Array.from({ length: cols.length - 1 }, () => []);
  for (const it of block.items) {
    const cx = it.transform[4] + (it.width || 0) / 2;
    let ci = cols.findIndex((edge, i) => i < cols.length - 1 && cx >= edge - 2 && cx < cols[i + 1] - 2);
    if (ci < 0) {
      let best = Infinity;
      for (let i = 0; i < cols.length - 1; i++) {
        const d = Math.min(Math.abs(cx - cols[i]), Math.abs(cx - cols[i + 1]));
        if (d < best) { best = d; ci = i; }
      }
    }
    cells[ci].push(it.str);
  }
  return cells.map(part => normalizePunctuation(part.join('').replace(/\s+/g, ' ').trim()));
}

function isNumericLine(block) {
  if (block.type !== 'text') return false;
  const t = block.text.split(/\s+/).filter(Boolean);
  return t.length >= 6 && t.filter(x => NUM_ROW.test(x)).length >= t.length - 1;
}

function renderDocument(pages, tablesEnabled) {
  // Markdown tables need contiguous header/delimiter/data lines.  Buffer a run
  // of table rows, then emit it with the first non-empty row as header; repeated
  // headers on continuation pages are dropped so the cross-page table reads as
  // one logical table.  Non-table blocks keep the original blank-line spacing.
  const parts = [];
  const push = (text, isTableRow = false) => parts.push({ text, isTableRow });
  let tocHeadingEmitted = false;
  let pending = [];
  let flattenNextTable = false;

  const escapeCell = s => String(s ?? '').replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim();
  const isFragment = r => {
    const filled = r.filter(c => String(c).trim());
    return filled.length === 1 && /[，。、：:；;]$/.test(filled[0].trim()) === false &&
      filled[0].trim().length <= 18 && !/^\d+([.,]\d+)*$/.test(filled[0].trim());
  };
  const pipeRow = cells => '| ' + cells.map(escapeCell).join(' | ') + ' |';
  const flush = () => {
    if (!pending.length) return;
    const all = pending.filter(row => row.cells.some(c => String(c).trim()));
    pending = [];
    // "核心目标:" style subheads are prose, not tables: PDF draws a grid over
    // the paragraph, so join the physical lines in reading order into one
    // paragraph instead of emitting a chopped 3-column table.
    if (flattenNextTable) {
      flattenNextTable = false;
      const text = all.map(row => row.reading).join('').trim();
      if (text) push(normalizePunctuation(text));
      return;
    }
    const rows = all.map(row => row.cells);
    if (rows.length < 2) return;
    const width = Math.max(...rows.map(r => r.length));
    const norm = rows.map(r => { const o = r.slice(0, width); while (o.length < width) o.push(''); return o; });
    const header = norm[0];
    let body = norm.slice(1).filter(r => r.join('\u0000') !== header.join('\u0000'));
    if (!body.length) return;
    push(pipeRow(header), true);
    push('| ' + Array(width).fill('---').join(' | ') + ' |', true);
    for (const r of body) push(pipeRow(r), true);
  };

  for (const page of pages) {
    const blocks = page.blocks;
    let imgCursor = 0;

    for (let i = 0; i < blocks.length; i++) {
      const b = blocks[i];

      // Vector grid table: wrap this line's cells, keep char order and grouping.
      if (tablesEnabled && b.table && b.type === 'text') {
        const parts = cellsForLine(b);
        pending.push({ cells: parts, reading: parts.filter(Boolean).join('') });
        continue;
      }

      // Borderless numeric run: consecutive numeric lines become one table.
      if (tablesEnabled && isNumericLine(b)) {
        let j = i;
        while (j + 1 < blocks.length && isNumericLine(blocks[j + 1])) j++;
        for (const r of blocks.slice(i, j + 1)) {
          const cells = r.text.split(/\s+/).filter(Boolean);
          pending.push({ cells, reading: cells.join('') });
        }
        i = j;
        continue;
      }

      flush();
      if (b.type === 'toc-heading') {
        if (!tocHeadingEmitted) { push('## 目录'); tocHeadingEmitted = true; }
        continue;
      }
      if (b.type === 'toc' && b.label !== undefined) {
        push(`- ${b.label.padEnd(b.width)}${b.dots}${b.page ? ' ' + b.page : ''}`);
        continue;
      }
      if (b.type === 'heading') {
        push(`${'#'.repeat(b.level || 2)} ${b.text}`);
        flattenNextTable = /^(核心目标|功能目标|技术要求)\s*:/.test(b.text);
        continue;
      }
      if (/^图 \d+[:：]/.test(b.text) && imgCursor < page.images.length) {
        const img = page.images[imgCursor++];
        push(b.text); push(`![${img.name}](images/p${img.page}-${img.name}.png)`);
        continue;
      }
      push(b.text);
    }
  }
  flush();
  let markdown = '';
  for (let i = 0; i < parts.length; i++) {
    if (i) markdown += parts[i].isTableRow && parts[i - 1].isTableRow ? '\n' : '\n\n';
    markdown += parts[i].text;
  }
  return { markdown: markdown + '\n', stitchLog: [] };
}

export { evaluateBoundaryRow, foldContinuationHeadRows } from './table-continuation.js';
export { itemsToLines };
export { VERSION, version } from './version.js';
export { createZip, createMarkdownZip };
export default convert;
