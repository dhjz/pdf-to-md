/**
 * Cross-page table continuation with merged cells.
 *
 * Some PDFs split one logical table across a page boundary and change its
 * column layout: a leading column appears only on the continuation page (a
 * vertically merged cell whose label comes with the later rows). Matching by
 * exact column edges misses these cases and emits two broken Markdown tables.
 * Match by page-edge adjacency + horizontal overlap instead, then pad the
 * shorter rows before rendering.
 */

/** Columns count of a detected grid. */
export function gridColumns(t) {
  return Math.max(1, (t?.colEdges?.length || 2) - 1);
}

/** Grid identity loose enough for continuation pages whose merged cells
 * change the visible column boundaries, but strict enough not to merge two
 * unrelated tables that happen to sit next to each other. */
export function sameTableGrid(prev, next, options = {}) {
  if (!prev || !next) return false;
  // Page geometry: fall back to A4 only when caller does not supply dimensions.
  const prevH = Number.isFinite(options.prevPageHeight) ? options.prevPageHeight : 842;
  const nextH = Number.isFinite(options.nextPageHeight) ? options.nextPageHeight : 842;
  const aCols = gridColumns(prev), bCols = gridColumns(next);
  if (aCols === bCols) return true;
  if (Math.abs(aCols - bCols) !== 1) return false;
  // A continuation table starts at the top of its page; the seed table runs to
  // the bottom of the previous one. Unrelated tables on facing pages fail this.
  if (prev.bottom > prevH * 0.19 || next.top < nextH * 0.71) return false;
  const aLeft = Math.min(...prev.colEdges), aRight = Math.max(...prev.colEdges);
  const bLeft = Math.min(...next.colEdges), bRight = Math.max(...next.colEdges);
  const overlap = Math.min(aRight, bRight) - Math.max(aLeft, bLeft);
  const width = Math.min(aRight - aLeft, bRight - bLeft);
  return width > 100 && overlap > width * 0.7;
}

/** Pad every row to `width`, inserting empty cells after the leading column.
 * A merged label column that only appears on one page is the first column;
 * the remaining columns line up with the other page's grid. */
export function alignMergedCells(rows, width) {
  return rows.map(row => {
    const out = [...row];
    while (out.length < width) out.splice(1, 0, '');
    return out;
  });
}
