/**
 * One pdf.js accessor for Node and the browser.
 *
 * - Node / bundlers: dynamic import of `pdfjs-dist` happens on first convert().
 * - Browser: set `globalThis.pdfjsLib` before convert(), or pass
 *   `{ pdfjsLib }` in convert options. No static `pdfjs-dist` import then.
 */

const DEFAULT_SPEC = 'pdfjs-dist/legacy/build/pdf.mjs';

let cached = null;
let pending = null;

function globalPdfjs() {
  for (const lib of [globalThis.pdfjsLib, globalThis.pdfjs]) {
    if (lib && typeof lib.getDocument === 'function') return lib;
  }
  return null;
}

export async function getPdfjs(options = {}) {
  const injected = options.pdfjsLib || globalPdfjs();
  if (injected) {
    cached = injected;
    return injected;
  }
  if (cached) return cached;
  if (!pending) {
    const spec = options.pdfjsPath || DEFAULT_SPEC;
    pending = import(/* @vite-ignore */ spec)
      .then(mod => {
        const lib = mod?.default && typeof mod.default.getDocument === 'function' ? mod.default : mod;
        if (!lib || typeof lib.getDocument !== 'function') {
          throw new Error('pdf.js 模块没有提供 getDocument()');
        }
        cached = lib;
        return lib;
      })
      .catch(err => {
        throw new Error(
          '未找到 pdf.js：浏览器请先设置 globalThis.pdfjsLib（或传 options.pdfjsLib）；' +
          'Node 请安装 pdfjs-dist。原始错误：' + (err?.message || String(err))
        );
      })
      .finally(() => { pending = null; });
  }
  return pending;
}
