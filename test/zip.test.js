import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createZip, createMarkdownZip } from '../src/zip.js';

/** Minimal ZIP reader: enough to assert our archive is complete and portable. */
function readZip(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= 0; i--) {
    if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  assert.ok(eocd >= 0, '应找到 EOCD');
  const count = view.getUint16(eocd + 10, true);
  const centralOffset = view.getUint32(eocd + 16, true);
  assert.equal(count, view.getUint16(eocd + 8, true), '磁盘条目数与总数一致');
  const entries = [];
  let p = centralOffset;
  for (let i = 0; i < count; i++) {
    assert.equal(view.getUint32(p, true), 0x02014b50, '中央目录签名');
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const name = new TextDecoder().decode(bytes.subarray(p + 46, p + 46 + nameLen));
    const localOffset = view.getUint32(p + 42, true);
    assert.equal(view.getUint32(localOffset, true), 0x04034b50, '本地文件头签名');
    const localNameLen = view.getUint16(localOffset + 26, true);
    const localExtraLen = view.getUint16(localOffset + 28, true);
    const size = view.getUint32(localOffset + 18, true);
    const data = bytes.subarray(localOffset + 30 + localNameLen + localExtraLen, localOffset + 30 + localNameLen + localExtraLen + size);
    entries.push({ name, data: new TextDecoder().decode(data), size });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

test('createZip 生成可解析的 ZIP，中文路径 UTF-8 标记正确', () => {
  const bytes = createZip([
    { name: 'doc.md', data: '# 你好\n' },
    { name: 'images/图 1.png', data: new Uint8Array([0x89, 0x50, 0x4e, 0x47]) },
  ]);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // 第一个本地头的通用标志位应置 UTF-8（0x0800）
  assert.equal(view.getUint16(6, true) & 0x0800, 0x0800);
  const entries = readZip(bytes);
  assert.deepEqual(entries.map(e => e.name), ['doc.md', 'images/图 1.png']);
  assert.equal(entries[0].data, '# 你好\n');
  assert.equal(entries[1].size, 4);
});

test('createMarkdownZip 的 .md 与图片路径和 Markdown 占位符一一对应', () => {
  const converted = {
    markdown: '# 标题\n\n![a](images/p1-1-a.png)\n\n![b](images/p2-2-b.jpg)\n',
    images: [{ bytes: new Uint8Array([1, 2, 3]) }, { bytes: new Uint8Array([4, 5]) }],
    imageManifest: [
      { name: 'a', page: 1, placeholder: 'images/p1-1-a.png', contentType: 'image/png' },
      { name: 'b', page: 2, placeholder: 'images/p2-2-b.jpg', contentType: 'image/jpeg' },
    ],
  };
  const entries = readZip(createMarkdownZip(converted, { fileName: '报告.pdf' }));
  assert.deepEqual(entries.map(e => e.name), ['报告.md', 'images/p1-1-a.png', 'images/p2-2-b.jpg']);
  assert.match(entries[0].data, /!\[a\]\(images\/p1-1-a\.png\)/);
  assert.match(entries[0].data, /!\[b\]\(images\/p2-2-b\.jpg\)/);
  assert.equal(entries[1].size, 3);
  assert.equal(entries[2].size, 2);
});


test('legacy 风格的图片占位符也会被补进 ZIP', () => {
  const converted = {
    markdown: '![图 1](images/p2-img_p1_1.png)\n',
    images: [{ bytes: new Uint8Array([1, 2, 3, 4]) }],
    imageManifest: [{ name: 'img_p1_1', page: 2, placeholder: 'images/p2-1-img_p1_1.png', contentType: 'image/png' }],
  };
  const entries = readZip(createMarkdownZip(converted, { fileName: 'doc' }));
  assert.deepEqual(entries.map(e => e.name), ['doc.md', 'images/p2-1-img_p1_1.png', 'images/p2-img_p1_1.png']);
  assert.equal(entries[2].size, 4);
});

test('createZip 接受原生 ArrayBuffer，不把它当字符串', () => {
  const source = new TextEncoder().encode('二进制内容');
  const buffer = source.buffer.slice(source.byteOffset, source.byteOffset + source.byteLength);
  const bytes = createZip([{ name: 'data.bin', data: buffer }]);
  const entries = readZip(bytes);
  assert.equal(entries[0].size, source.length);
  assert.equal(entries[0].data, '二进制内容');
});
