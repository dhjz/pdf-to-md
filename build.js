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

// --- UMD/IIFE: externals become lazy reads from browser globals -------------
// pdfjs-dist -> globalThis.pdfjsLib; node:fs -> pdfToMdFs; node:zlib -> pdfToMdZlib
const EXTERNALS = {
  'pdfjs-dist': 'pdfjsLib',
  'pdfjs-dist/legacy/build/pdf.mjs': 'pdfjsLib',
  'node:fs': 'pdfToMdFs',
  'fs': 'pdfToMdFs',
  'node:zlib': 'pdfToMdZlib',
  'zlib': 'pdfToMdZlib',
};
const externalsAsGlobals = {
  name: 'externals-as-globals',
  setup(b) {
    b.onResolve({ filter: /^(node:)?(fs|zlib)$|^pdfjs-dist(\/.*)?$/ }, (args) => {
      const g = EXTERNALS[args.path];
      return g ? { path: g, namespace: 'pdftomd-globals' } : null;
    });
    b.onLoad({ filter: /.*/, namespace: 'pdftomd-globals' }, (args) => {
      const g = args.path;
      if (g === 'pdfjsLib') {
        return {
          contents:
            'export const getDocument=(...a)=>globalThis.pdfjsLib.getDocument(...a);' +
            'export const OPS=new Proxy({},{get:(_,k)=>globalThis.pdfjsLib?.OPS?.[k]});',
          loader: 'js',
        };
      }
      if (g === 'pdfToMdFs') {
        return {
          contents: 'export const readFileSync=()=>{throw new Error("UMD 产物仅供浏览器：请把 PDF 作为 Uint8Array/ArrayBuffer 传入 convert()");};',
          loader: 'js',
        };
      }
      return {
        contents: 'export const deflateSync=(data)=>globalThis.pdftomdDeflateRaw(data);',
        loader: 'js',
      };
    });
  },
};

await build({
  ...common,
  format: 'iife',
  globalName: 'PdfToMd',
  outfile: 'dist/pdftomd.umd.min.js.tmp',
  plugins: [externalsAsGlobals],
  footer: { js: '\nif(typeof module==="object"&&module.exports)module.exports=PdfToMd;\nif(typeof globalThis!=="undefined")globalThis.PdfToMd=PdfToMd;' },
});
await rename('dist/pdftomd.umd.min.js.tmp', 'dist/pdftomd.umd.min.js');

console.log('Built dist/pdftomd.umd.min.js');
