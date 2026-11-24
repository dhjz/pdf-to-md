/**
 * Build the distributable from our own pdftomd source ("不管 pdf.js"):
 *   dist/pdftomd.umd.min.js — UMD/IIFE for browsers & script tags; exposes
 *                             global `PdfToMd`, reads pdfjs from `pdfjsLib`.
 *
 * ESM 打包暂时用不到，已在下方注释，需要时取消注释即可恢复。
 *
 * Only our converter code is bundled; pdf.js itself is never embedded.
 */
import { build } from 'esbuild';
import { rename, readFile } from 'node:fs/promises';

// Guard against the runtime version drifting from package.json.
const pkgVersion = JSON.parse(await readFile(new URL('./package.json', import.meta.url), 'utf8')).version;
const srcVersion = /VERSION\s*=\s*['"]([^'"]+)['"]/.exec(
  await readFile(new URL('./src/version.js', import.meta.url), 'utf8')
)?.[1];
if (!srcVersion || srcVersion !== pkgVersion) {
  throw new Error(`Version mismatch: src/version.js (${srcVersion}) vs package.json (${pkgVersion})`);
}

const common = {
  entryPoints: ['src/index.js'],
  bundle: true,
  minify: true,
  sourcemap: false,
  logLevel: 'info',
};

// --- ESM: real external imports, resolved by Node or a bundler at runtime ---
// 暂时不需要 ESM 打包产物，先注释保留，需要时取消注释即可恢复。
// await build({
//   ...common,
//   format: 'esm',
//   platform: 'node',
//   target: ['node18'],
//   outfile: 'dist/pdftomd.esm.min.js.tmp',
//   external: ['node:*', 'fs', 'zlib', 'path', 'buffer', 'pdfjs-dist', 'pdfjs-dist/*'],
// });
// await rename('dist/pdftomd.esm.min.js.tmp', 'dist/pdftomd.esm.min.js');

// --- UMD/IIFE: src/ is already platform-neutral -----------------------------
// pdf.js is read from globalThis.pdfjsLib (browser) or dynamically imported
// from pdfjs-dist (Node/bundlers) at convert() time. No node:* imports remain,
// so there is nothing to rewrite at build time.
await build({
  ...common,
  format: 'iife',
  globalName: 'PdfToMd',
  outfile: 'dist/pdftomd.umd.min.js.tmp',
  footer: { js: '\nif(typeof module==="object"&&module.exports)module.exports=PdfToMd;\nif(typeof globalThis!=="undefined")globalThis.PdfToMd=PdfToMd;' },
});
await rename('dist/pdftomd.umd.min.js.tmp', 'dist/pdftomd.umd.min.js');

console.log('Built dist/pdftomd.umd.min.js');
