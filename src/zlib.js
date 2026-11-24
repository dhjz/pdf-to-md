/**
 * Minimal, dependency-free zlib writer for PNG IDAT chunks.
 *
 * It emits a valid zlib stream with stored (uncompressed) DEFLATE blocks, so
 * the very same code runs in Node, browsers and workers without `node:zlib`.
 * The PNG gets larger than with level-6 compression, but stays viewable.
 */

const MAX_STORED_BLOCK = 0xffff;

function adler32(data) {
  let a = 1;
  let b = 0;
  for (let i = 0; i < data.length; i++) {
    a = (a + data[i]) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

/**
 * zlib header 0x78 0x01 = DEFLATE, 32K window, no preset dictionary,
 * fastest/no-compression hint. Each stored block is: BFINAL, LEN, NLEN, raw.
 */
export function deflateZlibStored(input) {
  const data = input instanceof Uint8Array
    ? input
    : new Uint8Array(input || []);
  const blocks = Math.max(1, Math.ceil(data.length / MAX_STORED_BLOCK));
  const out = new Uint8Array(2 + blocks * 5 + data.length + 4);
  let o = 0;
  out[o++] = 0x78;
  out[o++] = 0x01;
  let pos = 0;
  do {
    const len = Math.min(MAX_STORED_BLOCK, data.length - pos);
    const final = pos + len >= data.length ? 1 : 0;
    out[o++] = final;
    out[o++] = len & 0xff;
    out[o++] = (len >>> 8) & 0xff;
    out[o++] = (~len) & 0xff;
    out[o++] = ((~len) >>> 8) & 0xff;
    out.set(data.subarray(pos, pos + len), o);
    o += len;
    pos += len;
  } while (pos < data.length);
  const adler = adler32(data);
  out[o++] = (adler >>> 24) & 0xff;
  out[o++] = (adler >>> 16) & 0xff;
  out[o++] = (adler >>> 8) & 0xff;
  out[o++] = adler & 0xff;
  return out.subarray(0, o);
}
