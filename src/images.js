/**
 * Image extraction without OCR: decode pdf.js image XObjects and emit real,
 * viewable files. pdf.js hands back raw decoded pixels (RGB/RGBA/gray), so we
 * wrap them in a PNG container; JPEG/JPX sources keep their native bytes.
 */
import { deflateSync } from 'node:zlib';
import { OPS } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { mul as mulMatrix, apply as applyMatrix } from './geom.js';

const JPEG = new Set([OPS.paintJpegXObject]);
const IMAGE = new Set([
  OPS.paintImageXObject, OPS.paintImageXObjectRepeat,
  OPS.paintInlineImageXObject, OPS.paintInlineImageXObjectGroup,
  OPS.paintImageMaskXObject, OPS.paintImageMaskXObjectGroup,
  OPS.paintXObject,
]);

// pdf.js ImageKind: 1 = GRAYSCALE_1BPP, 2 = RGB_24BPP, 3 = RGBA_32BPP
const GRAY_1BPP = 1, RGB_24BPP = 2, RGBA_32BPP = 3;

/** Extract images referenced by a page's operator list. */
export async function extractPageImages(page, opList) {
  const out = [];
  const seen = new Set();
  for (let i = 0; i < opList.fnArray.length; i++) {
    const fn = opList.fnArray[i];
    if (!IMAGE.has(fn) && !JPEG.has(fn)) continue;
    const name = opList.argsArray[i][0];
    if (seen.has(name)) continue;
    seen.add(name);
    try {
      // pdf.js resolves image XObjects asynchronously; retry briefly.
      let img;
      for (let attempt = 0; attempt < 20; attempt++) {
        try { img = await page.objs.get(name); break; }
        catch { await new Promise(r => setTimeout(r, 25)); }
      }
      if (!img || (!img.data && !img.bitmap)) continue;
      const bytes = await toViewableBytes(img, fn);
      const ctm = findCtm(opList, i);
      // Position in the same coordinate space pdf.js reports text baselines
      // in, so the renderer can interleave the image placeholder with text.
      const box = imageBox(opList, i);
      out.push({
        name,
        width: img.width,
        height: img.height,
        kind: img.kind,
        bytes,
        contentType: contentType(img, fn),
        placement: ctm,
        top: box ? box.top : null,
        left: box ? box.left : null,
      });
    } catch { /* an unavailable image must not break conversion */ }
  }
  return out;
}

function contentType(img, fn) {
  if (JPEG.has(fn)) return 'image/jpeg';
  if (img.kind === 'jpeg') return 'image/jpeg';
  return 'image/png'; // pixels are wrapped in a PNG container below
}

async function toViewableBytes(img, fn) {
  // Browser pdf.js resolves image XObjects to ImageBitmap (no raw `data`);
  // draw it on a canvas to get a real PNG. Node builds expose raw pixels.
  if (img.bitmap && !img.data && typeof document !== 'undefined') {
    const canvas = document.createElement('canvas');
    canvas.width = img.width; canvas.height = img.height;
    const ctx = canvas.getContext('2d');
    if (ctx) {
      ctx.drawImage(img.bitmap, 0, 0);
      const blob = await new Promise(res => canvas.toBlob(res, 'image/png'));
      if (blob) return new Uint8Array(await blob.arrayBuffer());
    }
  }
  const data = img.data instanceof Uint8Array ? img.data
    : img.data instanceof ArrayBuffer ? new Uint8Array(img.data)
    : new Uint8Array(img.data || []);
  if (!data.length) return new Uint8Array();
  // Native JPEG bytes: pass through untouched.
  if (JPEG.has(fn) || img.kind === 'jpeg') return data;
  if (img.kind === RGB_24BPP) return encodePng(img.width, img.height, data, 2);
  if (img.kind === RGBA_32BPP) return encodePng(img.width, img.height, data, 6);
  if (img.kind === GRAY_1BPP || img.kind === 'gray') {
    return encodePng(img.width, img.height, expandGray1(data, img.width, img.height), 0);
  }
  // Unknown kind: assume one byte per pixel gray if sizes line up, else RGB.
  if (data.length === img.width * img.height) return encodePng(img.width, img.height, data, 0);
  if (data.length === img.width * img.height * 3) return encodePng(img.width, img.height, data, 2);
  if (data.length === img.width * img.height * 4) return encodePng(img.width, img.height, data, 6);
  return data;
}

/** pdf.js packs 1-bit gray as rows of ceil(width/8) bytes; expand to 8-bit. */
function expandGray1(data, width, height) {
  const rowBytes = Math.ceil(width / 8);
  const out = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const byte = data[y * rowBytes + (x >> 3)] || 0;
      const bit = (byte >> (7 - (x & 7))) & 1;
      out[y * width + x] = bit ? 255 : 0;
    }
  }
  return out;
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();
const TEXT_ENCODER = new TextEncoder();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function concatBytes(...parts) {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}
function pngChunk(type, data) {
  const typeBytes = TEXT_ENCODER.encode(type);
  const len = new Uint8Array(4);
  new DataView(len.buffer).setUint32(0, data.length);
  const crc = new Uint8Array(4);
  new DataView(crc.buffer).setUint32(0, crc32(concatBytes(typeBytes, data)));
  return concatBytes(len, typeBytes, data, crc);
}
/**
 * colorType: 0 = gray(1 byte/px), 2 = RGB, 6 = RGBA.
 * Adds a filter byte (0) before each scanline as PNG requires.
 */
function encodePng(width, height, pixels, colorType) {
  const channels = colorType === 0 ? 1 : colorType === 2 ? 3 : 4;
  const stride = width * channels;
  const raw = new Uint8Array((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    raw.set(pixels.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  }
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, width); dv.setUint32(4, height);
  ihdr[8] = 8;          // bit depth
  ihdr[9] = colorType;  // color type
  return concatBytes(
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw, { level: 6 })),
    pngChunk('IEND', new Uint8Array()),
  );
}

/**
 * Image unit-square bounding box in the coordinate space pdf.js uses for text
 * items. Accumulates every transform/save/restore before the paint operator,
 * including the page-level flip, so `top` is directly comparable to a text
 * line's `y`. Returns null when the transform chain is unusable.
 */
function imageBox(opList, paintIdx) {
  let ctm = [1, 0, 0, 1, 0, 0];
  const stack = [];
  for (let i = 0; i <= paintIdx && i < opList.fnArray.length; i++) {
    const fn = opList.fnArray[i];
    const a = opList.argsArray[i];
    if (fn === OPS.save) stack.push(ctm.slice());
    else if (fn === OPS.restore) ctm = stack.pop() || [1, 0, 0, 1, 0, 0];
    else if (fn === OPS.transform && Array.isArray(a) && a.length === 6) {
      ctm = mulMatrix(ctm, a);
    }
  }
  const pt = (u, v) => applyMatrix(ctm, u, v);
  const corners = [pt(0, 0), pt(1, 0), pt(0, 1), pt(1, 1)];
  if (!corners.every(([x, y]) => Number.isFinite(x) && Number.isFinite(y))) return null;
  const xs = corners.map(c => c[0]);
  const ys = corners.map(c => c[1]);
  return {
    left: Math.min(...xs),
    right: Math.max(...xs),
    top: Math.max(...ys),
    bottom: Math.min(...ys),
  };
}

function findCtm(opList, paintIdx) {
  for (let i = paintIdx - 1; i >= Math.max(0, paintIdx - 12); i--) {
    const a = opList.argsArray[i];
    if (Array.isArray(a) && a.length === 6 && a.every(n => typeof n === 'number')) return a;
  }
  return null;
}
