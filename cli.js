#!/usr/bin/env node
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve, basename, extname } from 'node:path';
import { convert, createMarkdownZip, VERSION } from './src/index.js';

const args = process.argv.slice(2);
if (args.includes('-V') || args.includes('--version')) {
  console.log(VERSION);
  process.exit(0);
}
if (!args.length || args.includes('-h') || args.includes('--help')) {
  console.log(`用法: pdf-to-md <input.pdf> [options]
  -V, --version         输出版本号
  -o, --output <file>   输出 Markdown 文件（默认 stdout）
      --json <file>     输出 JSON（markdown + 图片清单 + base64 二进制列表）
      --images <dir>    将图片二进制写入目录
      --zip <file>      导出 Markdown + images/ 图片为可直接打开的 ZIP
      --no-tables       关闭自动表格重建（默认开启）
      --strict          跨页表格仅在强证据下合并
      --no-cross-page   关闭跨页表格续接
      --debug           打印逐页转换诊断日志到 stderr`);
  process.exit(0);
}
const input = args.find(a => !a.startsWith('-'));
const opt = (name, fallback) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fallback; };
const result = await convert(readFileSync(input), {
  debug: args.includes('--debug'),
  tables: !args.includes('--no-tables'),
  strict: args.includes('--strict'),
  crossPageTables: !args.includes('--no-cross-page'),
});
console.error(`[pdf-to-md] 转换完成: 页数=${result.stats.pageCount}, 文本行=${result.stats.textItems}, 表格=${result.stats.tableCount}, 图片=${result.stats.imageCount}`);
if (result.diagnostics.reason) console.error(`[pdf-to-md] 未识别到文字: ${result.diagnostics.reason}`);
if (args.includes('--images')) {
  const dir = resolve(opt('--images', 'images'));
  mkdirSync(dir, { recursive: true });
  result.images.forEach((img, i) => {
    const ext = img.contentType === 'image/jpeg' ? 'jpg' : img.contentType === 'image/png' ? 'png' : 'bin';
    const file = resolve(dir, `p${img.page}-${i + 1}-${img.name}.${ext}`);
    writeFileSync(file, img.bytes);
  });
  console.error(`已导出 ${result.images.length} 张图片到 ${dir}`);
}
if (args.includes('--json')) {
  const out = resolve(opt('--json', basename(input, extname(input)) + '.json'));
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify({
    markdown: result.markdown,
    imageManifest: result.imageManifest,
    images: result.images.map((img, i) => ({
      index: i + 1, page: img.page, name: img.name, width: img.width, height: img.height,
      contentType: img.contentType, bytesLength: img.bytes.length,
      base64: Buffer.from(img.bytes).toString('base64'),
    })),
    pages: result.pages.map(p => ({ pageNumber: p.pageNumber, blocks: p.blocks.map(b => ({ type: b.type, text: b.text })) })),
    stitchLog: result.stitchLog,
  }, null, 2));
  console.error(`已写出 ${out}`);
}
if (args.includes('--zip')) {
  const out = resolve(opt('--zip', basename(input, extname(input)) + '.zip'));
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, createMarkdownZip(result, { fileName: basename(input, extname(input)) }));
  console.error(`已写出 ${out}（含 ${result.images.length} 张图片）`);
}
if (args.includes('-o') || args.includes('--output')) {
  const out = resolve(opt('--output', opt('-o', basename(input, extname(input)) + '.md')));
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, result.markdown);
  console.error(`已写出 ${out}`);
} else process.stdout.write(result.markdown);
