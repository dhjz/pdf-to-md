/**
 * Generate real automatic conversion artifacts for the bundled evaluation PDFs.
 * No visual/manual input: every *_auto.md / *_auto.json comes from src/index.js.
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { convert } from '../src/index.js';

const dir = resolve(new URL('..', import.meta.url).pathname, 'evaluation');
const files = readdirSync(dir).filter(f => f.toLowerCase().endsWith('.pdf')).sort();
if (!files.length) throw new Error('evaluation 目录里没有 PDF');

for (const file of files) {
  const base = file.replace(/\.pdf$/i, '');
  const input = resolve(dir, file);
  const t0 = performance.now();
  const result = await convert(readFileSync(input), { tables: true, crossPageTables: true });
  const ms = Math.round(performance.now() - t0);
  writeFileSync(resolve(dir, `${base}_auto.md`), result.markdown);
  writeFileSync(resolve(dir, `${base}_auto.json`), JSON.stringify({
    source: file,
    generatedBy: 'src/index.js convert()',
    generatedAt: new Date().toISOString(),
    durationMs: ms,
    markdown: result.markdown,
    stats: {
      chars: result.markdown.length,
      nonWhitespaceChars: result.markdown.replace(/\s/g, '').length,
      bytes: Buffer.byteLength(result.markdown),
      pages: result.pages.length,
      images: result.images.length,
      imageBytes: result.images.reduce((n, img) => n + img.bytes.length, 0),
      tableBlocks: result.pages.reduce((n, p) => n + (p.tables?.length || 0), 0),
    },
    imageManifest: result.imageManifest,
    images: result.images.map((img, i) => ({
      index: i + 1,
      page: img.page,
      name: img.name,
      width: img.width,
      height: img.height,
      contentType: img.contentType,
      bytesLength: img.bytes.length,
      base64: Buffer.from(img.bytes).toString('base64'),
    })),
    pages: result.pages.map(p => ({
      pageNumber: p.pageNumber,
      blocks: p.blocks.map(b => ({ type: b.type, text: b.text, level: b.level, kind: b.kind })),
      tableCount: p.tables?.length || 0,
    })),
    stitchLog: result.stitchLog,
  }, null, 2));
  console.log(`${base}: md/json 已生成，${result.pages.length} 页，${result.images.length} 张图，${ms}ms`);
}
