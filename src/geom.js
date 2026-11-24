/**
 * Shared 2D affine-geometry helpers for the pdf.js operator streams.
 * PDF matrices are 6-element [a,b,c,d,e,f] column-vector conventions;
 * `mul(m, n)` means "apply m, then n" so callers accumulate CTM as mul(ctm, a).
 * Keeping one copy prevents the multiplication order from drifting between
 * the table/grid/background detectors.
 */

/** 6-element PDF matrix multiply: m followed by n. */
export function mul(m, n) {
  return [
    m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5],
  ];
}

/** Apply a matrix to a point, returning [x, y]. */
export const apply = (m, x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];

/** Cluster numbers within `tol`; averages each group. `desc` sorts descending. */
export function cluster(values, tol, { desc = false } = {}) {
  const sorted = [...values].sort((a, b) => a - b);
  const groups = [];
  for (const v of sorted) {
    const last = groups[groups.length - 1];
    if (last && v - last[last.length - 1] <= tol) last.push(v);
    else groups.push([v]);
  }
  const out = groups.map(g => g.reduce((a, b) => a + b, 0) / g.length);
  return desc ? out.sort((a, b) => b - a) : out;
}
