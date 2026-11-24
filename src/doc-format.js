/**
 * TOC formatting: keep the PDF's long dot leaders, align labels into columns.
 */
export function formatTocLine(text) {
  const m = String(text).trim().match(/^(.*?)\s*(\.{3,}|·{3,}|…{3,})\s*(\d*)\s*$/);
  if (!m) return { label: String(text).trim(), dots: ' ...... ', page: '' };
  return { label: m[1].trim(), dots: ' ' + m[2].replace(/[·…]/g, '.') + ' ', page: m[3] || '' };
}
