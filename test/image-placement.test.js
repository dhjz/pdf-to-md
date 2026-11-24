import { test } from 'node:test';
import assert from 'node:assert/strict';
import { imagePlaceholder } from '../src/render2.js';
import { convert } from '../src/index.js';
import { fileURLToPath } from 'node:url';

const samplePdf = fileURLToPath(new URL('../evaluation/sample.pdf', import.meta.url));

test('imagePlaceholder uses manifest-consistent jpg/png path', () => {
  assert.equal(
    imagePlaceholder({ name: 'img1', page: 2, contentType: 'image/png' }, 0),
    '![img1](images/p2-1-img1.png)',
  );
  assert.equal(
    imagePlaceholder({ name: 'img2', page: 3, contentType: 'image/jpeg' }, 1),
    '![img2](images/p3-2-img2.jpg)',
  );
});

test('带图片页：图片占位符插入到图题之后、后续标题之前，文本不丢失', async () => {
  // sample.pdf page 2: a screenshot follows the "图 1:..." caption and precedes
  // section "2.1 截图说明". The placeholder must be anchored between them,
  // not dropped from the markdown nor appended after all text.
  const result = await convert(samplePdf);
  assert.ok(result.stats.imageCount >= 1, '应检测到图片');
  const md = result.markdown;
  const cap = md.indexOf('图 1:模型控制台截图');
  const img = md.search(/!\[[^\]]*\]\(images\/p2-\d+-[^\s)]+\)/);
  const next = md.indexOf('2.1 截图说明');
  assert.ok(cap >= 0 && img > cap && next > img,
    `图片占位符应位于图题与下一节之间 (cap=${cap}, img=${img}, next=${next})`);
});
