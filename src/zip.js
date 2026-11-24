/**
 * Minimal ZIP writer (stored entries, no compression) for shipping a Markdown
 * file together with its extracted images. No third-party dependency and no
 * Node built-ins, so the very same code runs in the browser UMD build.
 */
const ENCODER = new TextEncoder();

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function concat(parts) {
  const size = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) { out.set(part, offset); offset += part.length; }
  return out;
}

function toBytes(data) {
  if (typeof data === 'string') return ENCODER.encode(data);
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (data?.buffer instanceof ArrayBuffer) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  return ENCODER.encode(String(data ?? ''));
}

/** Deterministic DOS timestamp: 2020-01-01 00:00:00. */
const DOS_TIME = 0;
const DOS_DATE = ((2020 - 1980) << 9) | (1 << 5) | 1;
const UTF8_FLAG = 0x0800;

/**
 * Build a ZIP archive from `[{ name, data }]`.
 * `data` may be a string, Uint8Array or ArrayBuffer. Names are UTF-8 encoded.
 */
export function createZip(files) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const file of files) {
    const name = ENCODER.encode(String(file.name).replace(/\\/g, '/'));
    const data = toBytes(file.data);
    const crc = crc32(data);
    const local = new Uint8Array(30 + name.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, UTF8_FLAG, true);
    lv.setUint16(8, 0, true);           // stored
    lv.setUint16(10, DOS_TIME, true);
    lv.setUint16(12, DOS_DATE, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, data.length, true);
    lv.setUint32(22, data.length, true);
    lv.setUint16(26, name.length, true);
    lv.setUint16(28, 0, true);
    local.set(name, 30);
    locals.push(local, data);

    const dir = new Uint8Array(46 + name.length);
    const dv = new DataView(dir.buffer);
    dv.setUint32(0, 0x02014b50, true);
    dv.setUint16(4, 20, true);
    dv.setUint16(6, 20, true);
    dv.setUint16(8, UTF8_FLAG, true);
    dv.setUint16(10, 0, true);
    dv.setUint16(12, DOS_TIME, true);
    dv.setUint16(14, DOS_DATE, true);
    dv.setUint32(16, crc, true);
    dv.setUint32(20, data.length, true);
    dv.setUint32(24, data.length, true);
    dv.setUint16(28, name.length, true);
    dv.setUint32(42, offset, true);
    dir.set(name, 46);
    central.push(dir);

    offset += local.length + data.length;
  }
  const centralSize = central.reduce((n, p) => n + p.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, files.length, true);
  ev.setUint16(10, files.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);
  return concat([...locals, ...central, end]);
}

/**
 * Pack a `convert()` result into a portable ZIP:
 * `<name>.md` at the root plus every image under `images/` using exactly the
 * paths the Markdown references, so the archive opens flawlessly offline.
 */
export function createMarkdownZip(converted, options = {}) {
  if (!converted || typeof converted.markdown !== 'string') {
    throw new TypeError('createMarkdownZip() 需要 convert() 的返回结果');
  }
  const base = String(options.fileName || 'document').replace(/\.(md|pdf)$/i, '').replace(/[\\/]/g, '_');
  const md = converted.markdown;
  const files = [{ name: `${base}.md`, data: md }];
  const manifest = converted.imageManifest || [];
  const entries = []; // { bytes, aliases[] }
  manifest.forEach((item, i) => {
    const bytes = converted.images?.[i]?.bytes;
    if (!bytes || !bytes.length) return;
    const ext = item.contentType === 'image/jpeg' ? 'jpg' : 'png';
    const aliases = [
      item.placeholder,
      item.fileName ? `images/${item.fileName}` : null,
      `images/p${item.page || 1}-${i + 1}.${ext}`,
      // legacy 渲染器输出过不带序号的占位符，保留兼容。
      item.name ? `images/p${item.page || 1}-${item.name}.${ext}` : null,
      item.name ? `images/p${item.page || 1}-${item.name}.png` : null,
    ].filter(Boolean);
    entries.push({ bytes, aliases });
    files.push({ name: aliases[0], data: bytes });
  });
  // 兜底：Markdown 里出现但尚未收录的图片引用（如 legacy 占位符）按别名补一份，
  // 保证解压后每个 ![](images/...) 都能落到真实文件。
  const present = new Set(files.map(f => f.name));
  for (const match of md.matchAll(/!\[[^\]]*\]\((images\/[^)\s]+\.(?:png|jpg|jpeg))\)/gi)) {
    const ref = match[1];
    if (present.has(ref)) continue;
    const hit = entries.find(e => e.aliases.includes(ref));
    if (hit) { files.push({ name: ref, data: hit.bytes }); present.add(ref); }
  }
  return createZip(files);
}
