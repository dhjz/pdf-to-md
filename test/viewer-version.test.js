import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const viewer = readFileSync(new URL('../../pdf-viewer/index.html', import.meta.url), 'utf8');

test('viewer 顶部展示内核版本号', () => {
  assert.match(viewer, /class="version-badge">v\{\{ coreVersion \}\}</);
  assert.match(viewer, /globalThis\.PdfToMd\?\.version \|\| globalThis\.PdfToMd\?\.VERSION/);
});

test('viewer 在 UMD 内核加载后刷新版本号', () => {
  assert.match(viewer, /await import\('\.\/static\/pdftomd\.umd\.min\.js'\);\s*window\.dispatchEvent\(new Event\('pdftomd-ready'\)\)/);
  assert.match(viewer, /window\.addEventListener\('pdftomd-ready', updateCoreVersion\)/);
  assert.match(viewer, /window\.removeEventListener\('pdftomd-ready', updateCoreVersion\)/);
});

test('viewer 提供导出 MD + 图片 ZIP 的入口', () => {
  assert.match(viewer, /导出 MD \+ 图片 ZIP/);
  assert.match(viewer, /PdfToMd\.createMarkdownZip\(/);
  assert.match(viewer, /type: 'application\/zip'/);
});
