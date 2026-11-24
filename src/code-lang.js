/**
 * Guess a fenced code block's language from its lines.
 *
 * Conservative by design: the block only gets a language label when it reads
 * as code — ASCII letters/digits/code punctuation. Chinese is allowed inside
 * comments (line/block, per language) and inside string literals ('...',
 * "..." and `...`), since quoted text is code too. A bare non-ASCII char
 * outside of those keeps the fence as plain `txt`.
 */

// line: single-line comment marker (null = none).  block: [open, close].
// wordLine: true when the line marker only counts at line start (batch REM).
const LANGS = {
  javascript: {
    line: '//', block: ['/*', '*/'],
    signals: [
      /=>/, /\bfunction\s+[\w$]+\s*\(/, /\bconsole\.\w+\(/,
      /\b(?:const|let|var)\s+[\w$]+\s*=/, /\b(?:import|export)\b.*\bfrom\b/,
      /\brequire\(/, /\bmodule\.exports\b/, /\bclass\s+\w+/,
    ],
  },
  typescript: {
    line: '//', block: ['/*', '*/'],
    signals: [
      /\b(?:interface|enum|namespace|declare)\s+\w+/, /\btype\s+\w+\s*=/,
      /:\s*(?:string|number|boolean|any|unknown|never|void)\b/, /\b(?:string|number|boolean)\s*\|\s*/,
      /<\w+>\s*\(/, /\b(?:public|private|protected|readonly)\s+\w+\s*:/,
    ],
  },
  java: {
    line: '//', block: ['/*', '*/'],
    signals: [
      /\bSystem\.out\b/, /String\[\]/, /\bpublic\s+(?:static\s+)?(?:class|void|int|String)\b/,
      /\b(?:class|interface|enum)\s+\w+/, /\bstatic\s+void\s+\w+\s*\(/,
    ],
  },
  csharp: {
    line: '//', block: ['/*', '*/'],
    signals: [
      /\bConsole\.Write/, /\busing\s+System\b/, /\bnamespace\s+[\w.]+/,
      /\b(?:public|private|static)\s+(?:class|void|int|string|var)\b/, /\bvar\s+\w+\s*=/,
    ],
  },
  cpp: {
    line: '//', block: ['/*', '*/'],
    signals: [
      /#include\s*<\w+>/, /\bstd::\w+/, /\bcout\b|\bcin\b/, /\bvector\s*</,
      /\btemplate\s*</, /\b(?:class|struct)\s+\w+\s*\{/,
    ],
  },
  c: {
    line: '//', block: ['/*', '*/'],
    signals: [
      /#include\s*<\w+\.h>/, /\bprintf\s*\(/, /\bscanf\s*\(/,
      /\b(?:struct|typedef)\s+\w+/, /\b(?:int|char|float|double|void)\s+\w+\s*\(/,
    ],
  },
  go: {
    line: '//', block: ['/*', '*/'],
    signals: [
      /\bfunc\s+[\w(]/, /:=|\bmake\(|\bdefer\s+/, /\bpackage\s+\w+/,
      /\bgo\s+func\b/, /<-/, /\bmap\[[^\]]+\]/, /\btype\s+\w+\s+struct\s*\{/,
    ],
  },
  rust: {
    line: '//', block: ['/*', '*/'],
    signals: [
      /\bfn\s+\w+\s*\(/, /\blet\s+(?:mut\s+)?\w+/, /->/, /\bimpl\s+\w+/,
      /\bpub\s+(?:fn|struct|enum)\b/, /\buse\s+std::/,
    ],
  },
  python: {
    line: '#',
    signals: [
      /\bdef\s+\w+\s*\(/, /^\s*(?:import|from)\s+\w/m, /\bprint\s*\(/,
      /\bself\.\w+/, /\b__name__\b/, /^\s*#(?!\!)/m, /\b(?:True|False|None)\b/,
    ],
  },
  sql: {
    line: '--', block: ['/*', '*/'],
    signals: [
      /\b(?:SELECT|INSERT\s+INTO|UPDATE|DELETE\s+FROM|CREATE\s+TABLE|ALTER\s+TABLE|DROP\s+TABLE)\b/,
      /\b(?:FROM|WHERE|JOIN|GROUP\s+BY|ORDER\s+BY|PRIMARY\s+KEY)\b/,
    ],
  },
  yaml: {
    line: '#',
    signals: [/^\s*[\w.-]+\s*:\s*\S/m, /^\s*-\s+\S/m],
  },
  ini: {
    line: ';',
    signals: [/^\s*\[[^\]\n]+\]\s*$/m, /^\s*[\w.-]+\s*=\s*\S/m],
  },
  bash: {
    line: '#',
    rawSignals: [/^#!\/bin\/(?:ba)?sh/],
    signals: [
      /\becho\b/, /\bexport\s+\w+=/, /\$\{?\w+\}?/,
      /^\s*(?:if|for|while|case)\b.*\b(?:then|do|fi|done|esac)\s*$/m,
    ],
  },
  shell: {
    line: '#',
    rawSignals: [/^#!\/(?:usr\/)?bin\/(?:zsh|ksh|sh)\b/],
    signals: [/\b(?:curl|wget)\b[\s-]/, /\s-F\s|\s-X\s/],
  },
  bat: {
    line: 'REM', wordLine: true,
    signals: [/^\s*@echo\s+(?:on|off)\b/im, /^\s*REM\b/im, /%\w+%|%%\w/, /^\s*set\s+\w+=/im],
  },
  json: {
    signals: [],
  },
  html: {
    block: ['<!--', '-->'],
    signals: [
      /<\/?(?:a|abbr|article|aside|b|body|br|button|code|div|em|footer|form|h[1-6]|head|header|hr|html|i|img|input|label|li|link|main|meta|nav|ol|p|pre|script|section|select|span|strong|style|table|tbody|td|th|thead|title|tr|ul)\b[^<>]*>/i,
      /<!DOCTYPE\s+html>/i,
    ],
  },
  css: {
    line: '//', block: ['/*', '*/'],
    signals: [/[.#]?[\w-]+\s*,\s*[\w-]+\s*\{/, /\b[\w-]+\s*:\s*[^;{}]+;/],
  },
};

// Check first: strict formats (json/html) and languages with distinctive
// syntax. C-family goes last so a generic `{ ... }` block does not get
// mislabeled as C before Go/JS/Rust keywords get a chance.
const PRIORITY = [
  'json', 'html', 'bat', 'sql', 'go', 'rust',
  'typescript', 'java', 'csharp', 'cpp', 'c', 'javascript',
  'python', 'yaml', 'ini', 'css', 'shell', 'bash',
];

function matchesAt(line, i, marker) {
  if (marker === 'REM') return /^REM\b/.test(line.slice(i));
  return line.startsWith(marker, i);
}

// A quote only starts a string literal if it has a matching close later on
// this line (skipping \ escapes). Shared by comment stripping and the ASCII
// gate so an unmatched apostrophe — e.g. a Rust lifetime `'a` — cannot hide
// the rest of the line.
function hasClosingQuote(text, start, q) {
  for (let j = start + 1; j < text.length; j++) {
    if (text[j] === '\\') { j++; continue; }
    if (text[j] === q) return true;
  }
  return false;
}

/** Return each line with comments removed, tracking multi-line block comments. */
function codePortions(lines, lang) {
  const def = LANGS[lang];
  const open = def.block?.[0];
  const close = def.block?.[1];
  const lineMarker = def.line;
  let inBlock = false;
  return lines.map(raw => {
    const line = String(raw);
    if (def.wordLine && lineMarker && new RegExp('^\\s*' + lineMarker + '\\b', 'i').test(line)) return '';
    let out = '';
    let i = 0;
    let quote = null; // comments inside string literals are code, not comments
    while (i < line.length) {
      if (inBlock) {
        const end = line.indexOf(close, i);
        if (end < 0) break;
        inBlock = false;
        i = end + close.length;
        continue;
      }
      if (quote) {
        const ch = line[i++];
        out += ch;
        if (ch === '\\') { if (i < line.length) out += line[i++]; }
        else if (ch === quote) quote = null;
        continue;
      }
      const ch = line[i];
      if ((ch === "'" || ch === '"' || ch === '`') && hasClosingQuote(line, i, ch)) {
        quote = ch; out += ch; i++; continue;
      }
      if (open && line.startsWith(open, i)) {
        inBlock = true;
        i += open.length;
        continue;
      }
      if (lineMarker && matchesAt(line, i, lineMarker)) break;
      out += ch;
      i++;
    }
    return out;
  });
}

/**
 * Blank the inside of single-, double- and backtick-quoted literals so their
 * content (even Chinese) does not fail the ASCII gate. The quotes themselves
 * are kept. Only a quote with a matching close on the same line counts, so a
 * stray apostrophe (e.g. "it's") cannot hide bare prose. Backslash escapes are
 * honored. Scoring still reads the original text, so detection is unaffected.
 */
function blankStringContents(portions) {
  return portions.map(p => {
    let out = '';
    let quote = null;
    for (let i = 0; i < p.length; i++) {
      const ch = p[i];
      if (quote) {
        out += ' ';
        if (ch === '\\') { out += ' '; i++; }
        else if (ch === quote) { out += ch; quote = null; }
        continue;
      }
      if (ch === "'" || ch === '"' || ch === '`') {
        if (hasClosingQuote(p, i, ch)) { quote = ch; out += ch; }
        else out += ch; // unmatched quote: treat as an ordinary character
        continue;
      }
      out += ch;
    }
    return out;
  });
}

function passesGate(portions) {
  return blankStringContents(portions).every(p => !/[^\x00-\x7F]/.test(p));
}

function score(portions, lang, rawLines) {
  const text = portions.join('\n');
  for (const re of LANGS[lang].rawSignals || []) if (rawLines.some(l => re.test(l))) return 10;
  if (lang === 'json') {
    const t = text.trim();
    if (!/^[{[]/.test(t)) return 0;
    try { JSON.parse(t); return 10; } catch { return 0; }
  }
  // `#include <x>` is a preprocessor directive, not an HTML tag.
  if (lang === 'html' && /#include\s*</.test(text)) return 0;
  // key/value configs are too generic for one line: `result = 1` is not ini.
  if (lang === 'yaml') {
    return portions.filter(l => /^\s*(?:[\w.-]+\s*:|-\s)/.test(l)).length >= 2 ? 3 : 0;
  }
  if (lang === 'ini') {
    return portions.filter(l => /^\s*(?:\[[^\]]+\]\s*$|[\w.-]+\s*=)/.test(l)).length >= 2 ? 3 : 0;
  }
  let n = 0;
  for (const re of LANGS[lang].signals) if (re.test(text)) n++;
  return n;
}

/** Return a lowercase language label, or '' to keep the fence as plain txt. */
export function detectCodeLanguage(lines) {
  const code = (Array.isArray(lines) ? lines : [lines]).map(l => String(l));
  if (!code.length || !code.some(l => l.trim())) return '';
  let best = '';
  let bestScore = 0;
  for (const lang of PRIORITY) {
    const portions = codePortions(code, lang);
    if (!passesGate(portions)) continue;
    const s = score(portions, lang, code);
    if (s > bestScore) { best = lang; bestScore = s; }
  }
  return best;
}
