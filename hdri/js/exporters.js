/* File writers. All formats are generated client side from the stitched
   Float32Array RGBA equirect buffer (row 0 = top of panorama, linear light).

   - Radiance HDR: uncompressed RGBE scanlines.
   - OpenEXR: version 2, half float, no compression, channels B/G/R.
   - TIFF: 16-bit, sRGB-encoded (display referred), uncompressed.
   - JPEG: ACES tone-mapped preview. */

/* ---------------- shared pixel helpers ---------------- */

export function floatToRgbe(r, g, b, out, o) {
  const m = Math.max(r, g, b);
  if (m < 1e-32) { out[o] = out[o + 1] = out[o + 2] = out[o + 3] = 0; return; }
  let e = Math.ceil(Math.log2(m));
  if (Math.pow(2, e) <= m) e += 1; // ensure mantissas fall below 256
  const s = Math.pow(2, 8 - e);
  out[o] = Math.min(255, r * s) | 0;
  out[o + 1] = Math.min(255, g * s) | 0;
  out[o + 2] = Math.min(255, b * s) | 0;
  out[o + 3] = e + 128;
}

export function rgbeToFloat(bytes, o, out, oo) {
  const e = bytes[o + 3];
  if (e === 0) { out[oo] = out[oo + 1] = out[oo + 2] = 0; return; }
  const s = Math.pow(2, e - 136); // 2^(e-128) / 256
  out[oo] = bytes[o] * s;
  out[oo + 1] = bytes[o + 1] * s;
  out[oo + 2] = bytes[o + 2] * s;
}

export function floatToHalf(v) {
  if (Number.isNaN(v)) return 0x7e00;
  if (v <= 0) return 0; // negatives clamp to 0 for radiance data
  if (v < 6.103515625e-5) return Math.round(v / 5.960464477539063e-8); // subnormal
  if (v > 65504) return 0x7bff;
  const f = new Float32Array(1); const i = new Uint32Array(f.buffer);
  f[0] = v;
  const bits = i[0];
  const exp = ((bits >> 23) & 0xff) - 127 + 15;
  let mant = (bits >> 13) & 0x3ff;
  if (bits & 0x1000) mant += 1; // round to nearest
  if (mant === 0x400) return ((exp + 1) << 10) & 0x7fff;
  return ((exp << 10) | mant) & 0x7fff;
}

function srgbEncode(x) {
  return x <= 0.0031308 ? 12.92 * x : 1.055 * Math.pow(x, 1 / 2.4) - 0.055;
}

function acesTonemap(x) {
  return Math.min(1, Math.max(0, (x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14)));
}

/* ---------------- Radiance .hdr ---------------- */

export function exportHDR({ width, height, data }) {
  const header = `#?RADIANCE\nFORMAT=32-bit_rle_rgbe\nSOFTWARE=TZHDRI ThriceZed HDRI Capture\n\n-Y ${height} +X ${width}\n`;
  const head = new TextEncoder().encode(header);
  const body = new Uint8Array(width * height * 4);
  for (let p = 0, n = width * height; p < n; p++) {
    floatToRgbe(data[p * 4], data[p * 4 + 1], data[p * 4 + 2], body, p * 4);
  }
  return new Blob([head, body], { type: 'image/vnd.radiance' });
}

/* ---------------- OpenEXR .exr ---------------- */

export function exportEXR({ width, height, data }) {
  const enc = new TextEncoder();
  const parts = [];
  let size = 0;
  const push = (buf) => { parts.push(buf); size += buf.byteLength; };
  const u8 = (...vals) => push(new Uint8Array(vals));
  const str = (s) => push(enc.encode(s + '\0'));
  const i32 = (...vals) => { const b = new Int32Array(vals); push(new Uint8Array(b.buffer)); };
  const f32 = (...vals) => { const b = new Float32Array(vals); push(new Uint8Array(b.buffer)); };

  u8(0x76, 0x2f, 0x31, 0x01);       // magic
  i32(2);                            // version

  // channels (alphabetical: B, G, R), pixelType 1 = HALF
  const chlistSize = 3 * (2 + 4 + 4 + 4 + 4) + 1;
  str('channels'); str('chlist'); i32(chlistSize);
  for (const name of ['B', 'G', 'R']) {
    str(name); i32(1); u8(0, 0, 0, 0); i32(1); i32(1);
  }
  u8(0);

  str('compression'); str('compression'); i32(1); u8(0); // NO_COMPRESSION
  str('dataWindow'); str('box2i'); i32(16); i32(0, 0, width - 1, height - 1);
  str('displayWindow'); str('box2i'); i32(16); i32(0, 0, width - 1, height - 1);
  str('lineOrder'); str('lineOrder'); i32(1); u8(0);     // INCREASING_Y
  str('pixelAspectRatio'); str('float'); i32(4); f32(1);
  str('screenWindowCenter'); str('v2f'); i32(8); f32(0, 0);
  str('screenWindowWidth'); str('float'); i32(4); f32(1);
  u8(0);                             // end of header

  const headerSize = size;
  const chunkSize = 8 + width * 3 * 2;
  const tableSize = height * 8;

  // scanline offset table (uint64 little endian; sizes stay well under 2^32)
  const table = new ArrayBuffer(tableSize);
  const tv = new DataView(table);
  for (let y = 0; y < height; y++) {
    tv.setUint32(y * 8, headerSize + tableSize + y * chunkSize, true);
    tv.setUint32(y * 8 + 4, 0, true);
  }
  push(new Uint8Array(table));

  // scanline chunks: int y, int dataSize, then B row, G row, R row as halfs
  const body = new ArrayBuffer(height * chunkSize);
  const bv = new DataView(body);
  const halves = new Uint16Array(body); // little-endian platforms; DataView for header ints
  for (let y = 0; y < height; y++) {
    const base = y * chunkSize;
    bv.setInt32(base, y, true);
    bv.setInt32(base + 4, width * 6, true);
    const row = y * width * 4;
    const hb = (base + 8) / 2;
    for (let x = 0; x < width; x++) {
      halves[hb + x] = floatToHalf(data[row + x * 4 + 2]);              // B
      halves[hb + width + x] = floatToHalf(data[row + x * 4 + 1]);      // G
      halves[hb + width * 2 + x] = floatToHalf(data[row + x * 4]);      // R
    }
  }
  push(new Uint8Array(body));

  return new Blob(parts, { type: 'image/x-exr' });
}

/* ---------------- 16-bit TIFF ---------------- */

export function exportTIFF16({ width, height, data }) {
  const pixBytes = width * height * 6;
  const dataOffset = 8;
  const ifdOffset = dataOffset + pixBytes;
  const entryCount = 12;
  const extraOffset = ifdOffset + 2 + entryCount * 12 + 4;
  const totalSize = extraOffset + 6 + 16; // bits array + two rationals
  const buf = new ArrayBuffer(totalSize);
  const dv = new DataView(buf);

  dv.setUint16(0, 0x4949);           // II little endian
  dv.setUint16(2, 42, true);
  dv.setUint32(4, ifdOffset, true);

  const px = new Uint16Array(buf, dataOffset, width * height * 3);
  // Encode a small sRGB LUT-free loop; tone is display referred (clipped)
  for (let p = 0, n = width * height; p < n; p++) {
    px[p * 3] = Math.round(srgbEncode(Math.min(1, Math.max(0, data[p * 4]))) * 65535);
    px[p * 3 + 1] = Math.round(srgbEncode(Math.min(1, Math.max(0, data[p * 4 + 1]))) * 65535);
    px[p * 3 + 2] = Math.round(srgbEncode(Math.min(1, Math.max(0, data[p * 4 + 2]))) * 65535);
  }

  let e = ifdOffset;
  dv.setUint16(e, entryCount, true); e += 2;
  const entry = (tag, type, count, value) => {
    dv.setUint16(e, tag, true);
    dv.setUint16(e + 2, type, true);
    dv.setUint32(e + 4, count, true);
    dv.setUint32(e + 8, value, true);
    e += 12;
  };
  const bitsOffset = extraOffset;
  const xresOffset = extraOffset + 6;
  const yresOffset = extraOffset + 14;

  entry(256, 3, 1, width);           // ImageWidth
  entry(257, 3, 1, height);          // ImageLength
  entry(258, 3, 3, bitsOffset);      // BitsPerSample [16,16,16]
  entry(259, 3, 1, 1);               // Compression: none
  entry(262, 3, 1, 2);               // Photometric: RGB
  entry(273, 4, 1, dataOffset);      // StripOffsets
  entry(277, 3, 1, 3);               // SamplesPerPixel
  entry(278, 3, 1, height);          // RowsPerStrip
  entry(279, 4, 1, pixBytes);        // StripByteCounts
  entry(282, 5, 1, xresOffset);      // XResolution
  entry(283, 5, 1, yresOffset);      // YResolution
  entry(296, 3, 1, 2);               // ResolutionUnit: inch
  dv.setUint32(e, 0, true);          // next IFD: none

  dv.setUint16(bitsOffset, 16, true);
  dv.setUint16(bitsOffset + 2, 16, true);
  dv.setUint16(bitsOffset + 4, 16, true);
  dv.setUint32(xresOffset, 72, true); dv.setUint32(xresOffset + 4, 1, true);
  dv.setUint32(yresOffset, 72, true); dv.setUint32(yresOffset + 4, 1, true);

  return new Blob([buf], { type: 'image/tiff' });
}

/* ---------------- JPEG preview ---------------- */

export async function exportJPEG({ width, height, data }, quality = 0.9) {
  const canvas = document.createElement('canvas');
  canvas.width = width; canvas.height = height;
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(width, height);
  for (let p = 0, n = width * height; p < n; p++) {
    img.data[p * 4] = Math.round(srgbEncode(acesTonemap(data[p * 4])) * 255);
    img.data[p * 4 + 1] = Math.round(srgbEncode(acesTonemap(data[p * 4 + 1])) * 255);
    img.data[p * 4 + 2] = Math.round(srgbEncode(acesTonemap(data[p * 4 + 2])) * 255);
    img.data[p * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return new Promise(r => canvas.toBlob(r, 'image/jpeg', quality));
}

/* ---------------- misc ---------------- */

export function estimateSizes(width, height) {
  const n = width * height;
  return {
    hdr: n * 4 + 90,
    exr: n * 6 + height * 16 + 400,
    tiff: n * 6 + 200,
    jpg: n * 0.32,
  };
}

export function formatBytes(b) {
  if (b >= 1e9) return (b / 1e9).toFixed(2) + ' GB';
  if (b >= 1e6) return (b / 1e6).toFixed(1) + ' MB';
  return Math.round(b / 1e3) + ' KB';
}

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}
