/**
 * Detect atomic visual lines from page geometry alone.
 *
 * "Standalone" lines must not be reflowed into a paragraph: shell snippets,
 * JSON, captions and the short label rows printed just above a borderless
 * table all share a layout signature. We use that signature — never the words
 * inside the line — so a new document's vocabulary needs no new regex.
 */
export function detectStandaloneLines(pages) {
  for (const page of pages) {
    const all = (page.lines || []).filter(l => !l.dropped && String(l.text || '').trim());
    for (const line of all) line.standalone = false;
    if (all.length < 2) continue;

    // 1) Universal syntax: shell, JSON, figure captions.
    for (const line of all) {
      const t = String(line.text).trim();
      if (/^[$>]\s|^\$?curl\b/i.test(t) || /^-F\b/.test(t) ||
          (/^[\{\[]/.test(t) && /[\}\]]$/.test(t)) ||
          /^图\s*\d+\s*[:：]/.test(t)) line.standalone = true;
    }

    // 2) Label rows above a borderless table. The table detector already knows
    //    its top edge; a run of same-x, evenly-spaced short lines immediately
    //    above that edge is a label block, whatever it says. Lines inside a
    //    vector grid are table cells and are excluded.
    const covered = typeof page.isTableLine === 'function' ? page.isTableLine : () => false;
    const free = all.filter(l => !covered(l));
    const tableTops = (page.tableTops || []).map(Number).filter(Number.isFinite);
    for (const top of tableTops) {
      // The borderless detector's top is its header row's baseline; labels
      // sit strictly above it.
      const above = free.filter(l => l.y > top + 2 && l.y < top + 120)
        .sort((a, b) => a.y - b.y); // closest to table first (smallest y gap)
      if (above.length < 3) continue;
      // Walk upward while lines share the first line's x and a steady step.
      const run = [above[0]];
      const step0 = above.length > 1 ? Math.abs(above[0].y - above[1].y) : 0;
      if (step0 <= 4) continue;
      for (let i = 1; i < above.length; i++) {
        const prev = run[run.length - 1], cand = above[i];
        if (Math.abs(cand.x - run[0].x) > 6) break;
        if (Math.abs(Math.abs(prev.y - cand.y) - step0) > 3) break;
        run.push(cand);
      }
      if (run.length < 3) continue;
      run.forEach(l => { l.standalone = true; });
    }
  }
}

// Code-like layout evidence that prose paragraphs rarely show. Used only as
// a second gate alongside geometry, so ordinary wrapped text is never fenced.
function hasCodeSignal(text) {
  return /^\s*[{}\[\]]/.test(text)
    || /[{}]|=>|;\s*$/.test(text)
    || /^\s*[-\]#*+]\s+\S/.test(text)
    || /^\s*\w[\w .-]*:\s*\S/.test(text)   // key: value (yaml/json/config)
    || /[├└│─]/.test(text)                       // directory tree
    || /^\s*(?:\/|@|\$|>)/.test(text)         // slash command / prompt
    || /\b(?:import|const|function|def|class|SELECT|INSERT|CREATE|public|private)\b/.test(text);
}

/** The font shared by a clear majority of lines that each use a single font,
 * together with the median line length. A dedicated code face is strong
 * evidence ("ptr *T", "len int", "bool" carry no lexical signal but are
 * unmistakably code by their font) — BUT only when the lines are actually
 * code-shaped. In a Word document the body and headings share one font; if
 * the body size happens to be the smallest on the page, those long prose
 * lines would otherwise all share that font and get fenced as code. Real
 * code lines are short, so require a short median line length as well. */
function dominantCodeFont(lines, pageLines) {
  const counts = new Map();
  for (const l of lines) {
    const fs = (l.fonts && l.fonts.length) ? l.fonts : (l.fontName ? [l.fontName] : []);
    if (fs.length !== 1) continue;
    counts.set(fs[0], (counts.get(fs[0]) || 0) + 1);
  }
  if (!counts.size) return null;
  const [font, count] = [...counts].sort((a, b) => b[1] - a[1])[0];
  if (count < Math.max(2, Math.ceil(lines.length * 0.5))) return null;
  const lens = lines.map(l => String(l.text || '').trim().length).sort((a, b) => a - b);
  const medianLen = lens[Math.floor(lens.length / 2)];
  if (medianLen > 30) return null; // long wrapped prose, never code
  // The font must be a minority on the page: if the page's prose lines are
  // (almost) all this font, it is the body face shared with headings, not a
  // dedicated code font. Compare against long lines (the prose sample).
  const long = (pageLines || []).filter(l => String(l.text || '').trim().length >= 14);
  if (long.length >= 3) {
    const proseUsing = long.filter(l => {
      const fs = (l.fonts && l.fonts.length) ? l.fonts : (l.fontName ? [l.fontName] : []);
      return fs.indexOf(font) >= 0;
    }).length;
    if (proseUsing / long.length > 0.8) return null;
  }
  return { font, count };
}

/** The line's single font, when it has exactly one. */
function fontOf(line) {
  if (line.fonts?.length === 1) return line.fonts[0];
  return line.fontName || null;
}

/** Fonts used only by short lines on a page — the dedicated code faces. */
function codeFontsOnPage(all) {
  const byFont = new Map();
  for (const l of all) {
    const f = fontOf(l);
    if (f) { if (!byFont.has(f)) byFont.set(f, []); byFont.get(f).push(l); }
  }
  const out = new Set();
  for (const [font, lines] of byFont) {
    if (dominantCodeFont(lines, all)?.font === font) out.add(font);
  }
  return out;
}

/** Pure-integer line-number gutters: number left of a wider line on the same
 * baseline. Returns the set of line objects to skip.
 * `rect` (when given) is the background rectangle of the code block; the
 * number column is often painted just OUTSIDE its left edge, so candidate
 * numbers are searched page-wide and matched against the block's lines. */
function lineNumberGutter(lines, rect = null, pageLines = null) {
  const pool = pageLines || lines;
  const nums = pool.filter(l => /^\d{1,3}$/.test(String(l.text || '').trim()));
  const gutters = new Set();
  for (const n of nums) {
    if (rect) {
      // Outside-left gutter: number sits left of (or just inside) the block's
      // left edge, on the same baseline as one of the block's real lines.
      const nearLeft = n.x >= rect.x1 - 40 && n.x <= rect.x1 + 24;
      if (!nearLeft) continue;
      if (lines.some(o => o !== n && !/^\d{1,3}$/.test(String(o.text || '').trim()) &&
          o.x >= n.x + 8 && Math.abs(o.y - n.y) <= 12)) gutters.add(n);
    } else if (lines.some(o => o !== n && !/^\d{1,3}$/.test(String(o.text || '').trim()) &&
        o.x >= n.x + 8 && Math.abs(o.y - n.y) <= 12)) {
      gutters.add(n);
    }
  }
  return gutters;
}


/** Detect a line number that pdf.js merged INTO a code line's own text/items.
 * Browser-printed code blocks often paint "1 ", "2 " in the same baseline as
 * the code (same y, so itemsToLines joins them) instead of as a separate
 * pure-number line. Returns the number, the x of the first content item, and
 * the line text with the number removed. */
function inlineLeadingNumber(line) {
  const items = (line.items || []).filter(it => String(it.str ?? '').trim() !== '');
  if (items.length >= 2 && /^\d{1,3}$/.test(String(items[0].str).trim())) {
    const gap = (items[1].transform?.[4] ?? 0) - ((items[0].transform?.[4] ?? 0) + (items[0].width || 0));
    if (gap >= 3) {
      return {
        value: Number(items[0].str.trim()),
        x: items[1].transform?.[4] ?? line.x,
        text: String(line.text || '').replace(/^\s*\d{1,3}\s*/, ''),
      };
    }
  }
  const m = String(line.text || '').match(/^\s*(\d{1,3})[ \t]+(\S.*)$/);
  if (m) return { value: Number(m[1]), x: line.x, text: m[2] };
  return null;
}

/** Resolve inline gutter numbers for a block's lines (ordered top to bottom).
 * Only trust them when the numbers form a consecutive run — section numbers
 * like "1.1 xxx" or stray leading digits in real code won't qualify. */
function resolveInlineNumbers(ordered, allowSingle = false) {
  const infos = ordered.map(line => ({ line, num: inlineLeadingNumber(line) }));
  const numbered = infos.filter(i => i.num);
  const inline = numbered.length > 0 && (allowSingle || numbered.length >= 2) &&
    numbered.every((x, k) => k === 0 || x.num.value === numbered[k - 1].num.value + 1);
  return { infos, inline };
}

/**
 * Detect code / config blocks by layout, not by vocabulary. Browser-printed
 * docs render code in a smaller font than body text (or, on code-heavy pages,
 * a dominant monospace font), on even baselines, often with a left gutter of
 * line numbers or a shared left indent. Those signals are stable across
 * languages; literal regexes (curl / JSON braces) are not.
 *
 * Table cells are excluded via isTableLine, so real grids stay untouched.
 */
export function detectCodeBlocks(pages) {
  for (const page of pages) {
    const all = (page.lines || []).filter(l => !l.dropped && String(l.text || '').trim());
    if (all.length < 3) continue;
    const covered = typeof page.isTableLine === 'function' ? page.isTableLine : () => false;
    const body = proseBodySize(all);
    const pageCodeFonts = codeFontsOnPage(all);

    // Pass 1 — background rectangles. A light filled rect behind a run of
    // text is an explicit "this is a block" signal from the PDF itself; it
    // needs no font-size or keyword guess. Shaded code, config and note
    // blocks in browser-printed docs are caught here, including ones whose
    // lines read like prose and would fail the syntax gate below. Table
    // header cells never reach here: they are tiled rects and are excluded
    // by isTableLine / figure-caption filtering.
    const bgGroups = new Map();
    for (const l of all) {
      if (l.bgBlock === undefined || l.bgBlock === null) continue;
      if (covered(l)) continue;
      if (/^图\s*\d+\s*[:：]/.test(l.text.trim())) continue;
      if (!bgGroups.has(l.bgBlock)) bgGroups.set(l.bgBlock, []);
      bgGroups.get(l.bgBlock).push(l);
    }
    for (const [id, group] of bgGroups) {
      const rect = page.bgRects?.[id];
      const gutters = lineNumberGutter(group, rect || null, rect ? all : null);
      for (const g of gutters) g.codeSkip = true;
      const content = group.filter(l => !gutters.has(l));
      // A shaded one-liner (e.g. a single "/propose ..." prompt) is a real
      // snippet, but a single wide header cell can also be one rect. Keep a
      // one-line block only when it carries a code/prompt signal; otherwise
      // drop it as a table-header false positive.
      if (content.length === 1) {
        const only = content[0];
        if (!hasCodeSignal(only.text) && !/^\s*[/@$>]\s*\S/.test(only.text.trim())) continue;
      }
      if (content.length < 1) continue;
      const ordered = [...content].sort((a, b) => b.y - a.y || a.x - b.x);
      const codeSize = dominantSize(ordered) || body || 10;
      const { infos, inline } = resolveInlineNumbers(ordered, true);
      // Indentation uses the content x, i.e. after an inline gutter number.
      const minX = inline
        ? Math.min(...infos.filter(({ num }) => num).map(({ num }) => num.x))
        : Math.min(...infos.map(({ line }) => line.x));
      // Only restore visual nesting when a line-number gutter anchors the
      // block. Otherwise x offsets include prose indents (sample.pdf's curl
      // snippet) and must not be turned into fake code indentation.
      const indentByX = gutters.size > 0 || inline;
      const blk = `p${page.pageNumber}-bg${id}`;
      for (const { line: l, num } of infos) {
        l.codeBlock = blk;
        const cx = inline && num ? num.x : l.x;
        const indent = indentByX ? Math.max(0, Math.round((cx - minX) / Math.max(codeSize, 8))) : 0;
        let text = (inline && num ? num.text : l.text.trim()).replace(/^(.{20,})\s?\d{1,2}$/, '$1');
        l.codeText = '  '.repeat(Math.min(indent, 6)) + text;
      }
    }

    // Candidate small lines: smaller than body, or the smallest font present
    // when several sizes share the page (code-heavy pages).
    const sizes = [...new Set(all.map(l => +(l.fontSize ?? l.height ?? 0).toFixed(1)).filter(h => h > 0))].sort((a, b) => a - b);
    const codeSize = sizes.find(h => h < body) ?? (sizes.length > 1 ? sizes[0] : 0);
    if (!codeSize) continue;
    const small = all.filter(l => {
      if (l.codeBlock) return false; // already claimed by a background rect
      if (covered(l)) return false;
      if (/^图\s*\d+\s*[:：]/.test(l.text.trim())) return false; // figure caption
      return Math.abs(+(l.fontSize ?? l.height ?? 0).toFixed(1) - codeSize) <= 0.2;
    });
    const hasShadedSolo = small.some(l => l.shadedSingle);
    if (small.length < 3 && !hasShadedSolo) continue;

    // Line-number gutters: small pure-integer text left of a wider same-height
    // line. Pair by y (±12pt) and x gap (>=8pt); count-independent.
    const nums = small.filter(l => /^\d{1,3}$/.test(l.text.trim()));
    const gutterSet = new Set();
    for (const n of nums) {
      if (all.some(o => o !== n && !/^\d{1,3}$/.test(o.text.trim()) &&
          o.x >= n.x + 8 && Math.abs(o.y - n.y) <= 12)) gutterSet.add(n);
    }
    for (const g of gutterSet) g.codeSkip = true;
    const content = small.filter(l => !gutterSet.has(l));
    if (content.length < 1) continue;
    if (content.length < 3 && !hasShadedSolo) continue;

    // Group by vertical step. A doubled step is a blank line inside a block;
    // a much larger gap starts a new block. The step is learned from
    // consecutive lines so prose/figure gaps split naturally.
    const sorted = [...content].sort((a, b) => b.y - a.y || a.x - b.x);
    const groups = [];
    let group = [sorted[0]];
    let step = 0;
    for (let i = 1; i < sorted.length; i++) {
      const prev = sorted[i - 1], cur = sorted[i];
      const gap = prev.y - cur.y;
      // Blank lines double the step; allow up to ~2.3x. A larger gap starts a
      // new block. Minor font-code variations inside one snippet are ignored.
      const tol = step ? Math.max(step * 2.3, 16) : Math.max(14, body * 3.4);
      if (gap <= tol) {
        group.push(cur);
        if (!step && gap > 2) step = gap;
      } else {
        groups.push(group); group = [cur]; step = 0;
      }
    }
    groups.push(group);

    groups.forEach((lines, idx) => {
      if (lines.length < 1) return;
      const ordered = [...lines].sort((a, b) => b.y - a.y || a.x - b.x);
      const hasGutter = gutterSet.size > 0 && ordered.some(l =>
        [...gutterSet].some(n => Math.abs(n.y - l.y) <= 12 && n.x < l.x));
      // Browser-printed snippets paint their line numbers on the SAME baseline
      // as the code, so pdf.js merges "1 ", "2 " into the line text/items.
      // Resolve those here as well — the background-rect pass above is not the
      // only way a code block reaches the renderer (see v2v2.pdf: no bg rect).
      const infos = ordered.map(line => ({ line, num: inlineLeadingNumber(line) }));
      const textOf = i => (i.num ? i.num.text : i.line.text.trim());
      const numbered = infos.filter(i => i.num);
      const consecutive = numbered.length > 0 &&
        numbered.every((x, k) => k === 0 || x.num.value === numbered[k - 1].num.value + 1);
      // A borderless numeric table (e.g. a rate table whose first column is
      // "age" = 18,19,20...) has a consecutive leading integer too, but it is
      // DATA, not a line-number gutter. Recognise tabular rows — many aligned
      // numeric items per baseline — and refuse the inline-number reading.
      const tabularRows = ordered.filter(l => {
        const items = (l.items || []).filter(it => String(it.str ?? '').trim() !== '');
        const nums = items.filter(it => /^[+-]?\d[\d,]*(?:\.\d+)?$/.test(String(it.str).trim()));
        return items.length >= 3 && nums.length >= items.length - 1;
      }).length;
      const isNumericTable = tabularRows >= Math.max(2, Math.ceil(ordered.length * 0.5));
      const inline = numbered.length >= 2 && consecutive && !isNumericTable;
      // A lone numbered line "1 2. Heading" is a gutter number that got glued
      // to a numbered section heading, not a code prompt: keep its number as
      // prose and do not turn it into a fake code block.
      const loneHeading = numbered.length === 1 && /^\d+(?:[.、]|$)/.test(textOf(numbered[0]));
      const lonePrompt = numbered.length === 1 && !loneHeading &&
        (/^\s*[/@$>]\s*\S/.test(textOf(numbered[0])) ||
          (/^[{[]/.test(textOf(numbered[0])) && /[}\]]\s*$/.test(textOf(numbered[0]))));
      const sigCount = infos.filter(i => hasCodeSignal(textOf(i))).length;
      // A single dedicated font across most lines is the strongest layout
      // signal: code/JSON/data declarations printed in a monospace face all
      // share it, even when their words look like prose ("len int", "bool").
      const codeFont = dominantCodeFont(ordered, all);
      // A single line on a short full-width shaded bar is a code snippet only
      // when it also uses a dedicated code font on this page. Prose callouts
      // and quote blocks sit on similar bars but use the body font, so they
      // stay untouched.
      const shadedCodeSolo = ordered.length === 1 && ordered[0].shadedSingle &&
        pageCodeFonts.has(fontOf(ordered[0]));
      const fontDriven = !!codeFont || shadedCodeSolo;
      // A group qualifies as code when it has a detached number gutter, a
      // trusted run of inline numbers, a dominant code font, or mostly
      // code-like syntax. A lone small-font prompt line ("/propose …") is a
      // snippet on its own and must not be reflowed into the surrounding prose.
      if (!hasGutter && !inline && !fontDriven && !lonePrompt &&
          sigCount < Math.max(2, Math.ceil(ordered.length * 0.5))) return;
      const id = `p${page.pageNumber}-c${idx}`;
      const guttered = gutterSet.size > 0;
      const minX = inline
        ? Math.min(...numbered.map(i => i.num.x))
        : Math.min(...ordered.map(l => l.x));
      for (const info of infos) {
        const { line: l, num } = info;
        l.codeBlock = id;
        const cx = inline && num ? num.x : l.x;
        // Indentation follows the real content x: a merged gutter number sits
        // at the far-left x and would otherwise collapse the whole block.
        const indent = (guttered || inline || fontDriven)
          ? Math.max(0, Math.round((cx - minX) / Math.max(codeSize, 8))) : 0;
        let body = textOf(info);
        // A gutter number sometimes lands inside the same text item as the
        // code line (e.g. "/propose ...细节。1"); drop that trailing orphan.
        body = body.replace(/^(.{20,})\s?\d{1,2}$/, '$1');
        l.codeText = '  '.repeat(Math.min(indent, 6)) + body;
      }
    });
  }
}

/** Body font size inferred from long lines only. On code-heavy pages the
 * monospace snippet can outnumber prose lines, so a plain majority vote picks
 * the CODE size as "body" and disables small-font detection entirely (the
 * 1.11 defer example on temp.pdf). Long wrapped lines are prose by nature. */
function proseBodySize(lines) {
  const long = lines.filter(l => String(l.text || '').trim().length >= 14);
  return dominantSize(long.length ? long : lines);
}

/** Most common non-zero font size on a page — the body size. */
function dominantSize(lines) {
  const counts = new Map();
  for (const l of lines) {
    const h = Number((l.fontSize ?? l.height ?? 0).toFixed?.(1) || 0);
    if (h > 0) counts.set(h, (counts.get(h) || 0) + 1);
  }
  if (!counts.size) return 0;
  return [...counts].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0][0];
}
