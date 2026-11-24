/**
 * Cross-page table continuation heuristics, ported from mineru_ext.py.
 *
 * The original operates on MinerU middle.json; here we operate on Markdown
 * table rows extracted from adjacent pages. The scoring model is preserved:
 * strong separator / CJK boundary / blank-column signals, with vetoes for
 * evidence that the next row is an independent record.
 */

const TERMINAL = new Set('。！？!?…');
const CLOSING = new Set('）)]】》〉」”’"\'');
const SEPARATOR = new Set('，、；：,;:—-–/·|（(【[《〈“"\'');
const CONT_HEAD = new Set('）)]】》〉」”’"\'，、；：。！？,;:.!?');
const PUNCT = new Set([...TERMINAL, ...CLOSING, ...SEPARATOR]);
const SENTENCE_END = new Set([...TERMINAL, ...'）)]】》〉」']);
const ROW_START = ['负责','提供','支持','实现','当前','目前','结合','根据','通过','采用','包括','主要','本','该','其','这','那','我','你','他','它','由','从'];
const NEW_RECORD_PREFIX = ['注','备注','说明','合计','总计','小计','单位','续表'];
const CJK_RANGES = [[0x3040,0x30ff],[0x3400,0x4dbf],[0x4e00,0x9fff],[0xac00,0xd7af],[0xf900,0xfaff]];
const FULLWIDTH = { '０':'0','１':'1','２':'2','３':'3','４':'4','５':'5','６':'6','７':'7','８':'8','９':'9' };

const isCjk = ch => CJK_RANGES.some(([a, b]) => { const c = ch.codePointAt(0); return c >= a && c <= b; });
const ends = (s, set) => !!s && set.has([...s].pop());
const starts = (s, set) => !!s && set.has([...s][0]);
const endsTerminal = s => ends(s, SENTENCE_END);
const endsSep = s => ends(s, SEPARATOR);
const startsCont = s => starts(s, CONT_HEAD);
const endsPunct = s => ends(s, PUNCT);
const endsLatin = s => !!s && /[A-Za-z]$/.test(s);
const startsLatin = s => !!s && /^[A-Za-z]/.test(s);
const endsCjk = s => !!s && isCjk([...s].pop());
const startsCjk = s => !!s && isCjk([...s][0]);
const isNumeric = s => { const t = s.replace(/[０-９]/g, c => FULLWIDTH[c]).trim(); return /\d/.test(t) && /^[\s\d,，.．%‰+\-－—–()（）¥$€£元万亿千百十/]+$/.test(t); };
const normalizeTemplate = s => s.replace(/\s+/g, '').replace(/[０-９]/g, c => FULLWIDTH[c]).replace(/\d+/g, '#');
const sharedPrefix = (a, b) => { let i = 0; while (i < Math.min(a.length, b.length) && a[i] === b[i]) i++; return i; };
function startsRowPhrase(s) {
  for (const token of ROW_START) {
    if (!s.startsWith(token)) continue;
    const rest = s.slice(token.length).trim();
    return !(rest && PUNCT.has(rest[0]) || CONT_HEAD.has(rest[0]));
  }
  return false;
}
function secondaryEndPunct(prev) {
  const tail = prev.slice(1);
  return tail.length > 0 && tail.every(c => endsPunct(c.trim()));
}
const splitRow = line => line.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split(/(?<!\\)\|/).map(c => c.trim());

/**
 * Evaluate whether prevRow (last data row of previous page) and nextRow
 * (first row of continued table) are halves of one logical row.
 * Returns { merge, score, reason, cells }.
 */
export function evaluateBoundaryRow(prevRow, nextRow, { strict = false } = {}) {
  const prev = splitRow(prevRow);
  const next = splitRow(nextRow);
  if (prev.length !== next.length) return { merge: false, score: 0, reason: '列数不一致', cells: [] };
  if (secondaryEndPunct(prev)) return { merge: false, score: 0, reason: '上页末行除首列外均以标点结尾', cells: [] };

  let score = 0, strong = false, cjkPairs = 0, comparable = 0, blank = 0;
  const reasons = [];
  for (let i = 0; i < prev.length; i++) {
    const p = prev[i], n = next[i];
    const pHas = !!p, nHas = !!n;
    if (pHas && !nHas) { blank++; continue; }
    if (!pHas || !nHas) continue;
    comparable++;
    if (p === n) return { merge: false, score: 0, reason: '同列文本完全重复', cells: [] };
    if (normalizeTemplate(p) === normalizeTemplate(n)) return { merge: false, score: 0, reason: '同列模板相同', cells: [] };
    if (sharedPrefix(p, n) >= 2 && Math.min(p.length, n.length) >= 4) return { merge: false, score: 0, reason: '同列共享前缀', cells: [] };
    if (endsTerminal(p)) return { merge: false, score: 0, reason: '上侧句末/闭合符结尾', cells: [] };
    if (startsRowPhrase(n) && !endsSep(p)) return { merge: false, score: 0, reason: `下侧独立行首短语 ${n.slice(0, 2)}`, cells: [] };
    // Short CJK fragments that split a word mid-token are exactly what we want
    // to catch (e.g. 所属板/块). Veto only when neither side looks like a fragment.
    const bothShort = p.length <= 6 && n.length <= 6;
    const cjkWordSplit = endsCjk(p) && startsCjk(n) && p.length >= 2 && n.length >= 1;
    const latinWordSplit = endsLatin(p) && startsLatin(n);
    if (bothShort && !cjkWordSplit && !latinWordSplit) return { merge: false, score: 0, reason: '同列上下都过短', cells: [] };
    if (isNumeric(p) && isNumeric(n)) return { merge: false, score: 0, reason: '同列上下都是纯数字', cells: [] };
    if (endsSep(p) || startsCont(n)) { strong = true; }
    if (endsLatin(p) && startsLatin(n)) strong = true;
    if (endsCjk(p) && startsCjk(n)) cjkPairs++;
  }
  if (comparable === 0) return { merge: false, score: 0, reason: '无可比较非空列', cells: [] };
  if (strong) { score += 2; reasons.push('强截断标记'); }
  score += Math.min(cjkPairs, 2);
  if (cjkPairs) reasons.push(`CJK字符边界 ${cjkPairs} 列`);
  if (blank) {
    if (blank >= prev.length - 1) { score += 2; reasons.push('下页仅剩一列有数据'); }
    else if (prev.length > 2 && blank >= 2) { score += 1; reasons.push(`下页多列缺失 ${blank} 列`); }
    else { score += 1; reasons.push('下页整列缺失'); }
  }
  score += 1;
  reasons.push('无明显独立记录证据');
  const threshold = strict ? 3 : 2;
  if (strict && !strong) return { merge: false, score, reason: '严格模式且无强证据', cells: [] };
  if (score < threshold) return { merge: false, score, reason: `分数不足 ${reasons.join('+')}`, cells: [] };
  const cells = prev.map((p, i) => p + next[i]);
  return { merge: true, score, reason: reasons.join('+'), cells };
}

/** Continuation head-row folding: next table's first row with only one filled
 *  cell continuing prev row's same column is folded back (mineru_ext.py). */
export function foldContinuationHeadRows(prevRows, nextRows, { debug = false } = {}) {
  if (!prevRows.length || nextRows.length < 2) return { rows: nextRows, folded: 0 };
  const log = [];
  const cur = splitRow(nextRows[0]);
  const nxt = splitRow(nextRows[1]);
  const filled = cur.map((c, i) => c ? i : -1).filter(i => i >= 0);
  if (filled.length !== 1 || cur.length !== nxt.length) return { rows: nextRows, folded: 0, log };
  const col = filled[0];
  if (NEW_RECORD_PREFIX.some(p => cur[col].startsWith(p))) return { rows: nextRows, folded: 0, log };
  if (nxt[col] && !endsPunct(nxt[col]) && startsRowPhrase(cur[col])) return { rows: nextRows, folded: 0, log };
  const target = splitRow(prevRows[prevRows.length - 1]);
  if (!target[col] || endsPunct(target[col])) return { rows: nextRows, folded: 0, log };
  target[col] += cur[col];
  const mergedPrev = [...prevRows];
  mergedPrev[mergedPrev.length - 1] = '| ' + target.join(' | ') + ' |';
  const rows = [nextRows[1], ...nextRows.slice(2)];
  log.push(`续表首行折行并入上一页 (col ${col})`);
  return { rows, prevRows: mergedPrev, folded: 1, log };
}
