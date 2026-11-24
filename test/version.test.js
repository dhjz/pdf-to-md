import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { VERSION, version, default as convert } from '../src/index.js';

const root = new URL('../', import.meta.url);
const pkg = JSON.parse(readFileSync(new URL('package.json', root), 'utf8'));
const EXPECTED = pkg.version; // always tracks package.json — no hardcoded drift

test('源模块导出版本，且与 package.json 一致', () => {
  assert.equal(VERSION, EXPECTED);
  assert.equal(version, VERSION);
  assert.equal(VERSION, pkg.version);
  assert.equal(typeof convert, 'function', '默认导出仍是 convert，未被破坏');
});

test('UMD 产物把 version 挂到全局对象（new Function 模拟浏览器 script）', () => {
  const code = readFileSync(fileURLToPath(new URL('dist/pdftomd.umd.min.js', root)), 'utf8');
  const sandbox = {};
  // The UMD footer writes to globalThis; run in an isolated function scope.
  new Function('globalThis', 'module', code).call(sandbox, sandbox, undefined);
  assert.ok(sandbox.PdfToMd, '全局对象 PdfToMd 应存在');
  assert.equal(sandbox.PdfToMd.version, EXPECTED);
  assert.equal(sandbox.PdfToMd.VERSION, EXPECTED);
  assert.equal(typeof sandbox.PdfToMd.convert, 'function');
});
