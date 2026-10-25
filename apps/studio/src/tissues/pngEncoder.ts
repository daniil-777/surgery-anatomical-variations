const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    c = CRC_TABLE[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function adler32(bytes: Uint8Array): number {
  let a = 1;
  let b = 0;
  const MOD = 65521;
  for (let i = 0; i < bytes.length; i++) {
    a = (a + bytes[i]!) % MOD;
    b = (b + a) % MOD;
  }
  return ((b << 16) | a) >>> 0;
}

function makeChunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length, false);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  const crc = crc32(out.subarray(4, 8 + data.length));
  view.setUint32(8 + data.length, crc, false);
  return out;
}

/** Deterministic, dependency-free PNG encoder using zlib stored blocks. */
export function encodePng(width: number, height: number, channels: 1 | 3 | 4, pixels: Uint8Array): Uint8Array {
  const rowBytes = width * channels;
  const rawLen = height * (1 + rowBytes);
  const raw = new Uint8Array(rawLen);
  for (let y = 0; y < height; y++) {
    const rowStart = y * (1 + rowBytes);
    raw[rowStart] = 0; // filter type 0 (None)
    raw.set(pixels.subarray(y * rowBytes, (y + 1) * rowBytes), rowStart + 1);
  }

  const maxBlock = 65535;
  const numBlocks = Math.max(1, Math.ceil(raw.length / maxBlock));
  const zlibData = new Uint8Array(2 + raw.length + numBlocks * 5 + 4);
  zlibData[0] = 0x78;
  zlibData[1] = 0x01;
  let offset = 2;
  for (let b = 0; b < numBlocks; b++) {
    const start = b * maxBlock;
    const end = Math.min(raw.length, start + maxBlock);
    const len = end - start;
    const isLast = b === numBlocks - 1 ? 1 : 0;
    zlibData[offset++] = isLast;
    zlibData[offset++] = len & 0xff;
    zlibData[offset++] = (len >>> 8) & 0xff;
    const nlen = (~len) & 0xffff;
    zlibData[offset++] = nlen & 0xff;
    zlibData[offset++] = (nlen >>> 8) & 0xff;
    zlibData.set(raw.subarray(start, end), offset);
    offset += len;
  }
  const adler = adler32(raw);
  const adlerView = new DataView(zlibData.buffer, offset, 4);
  adlerView.setUint32(0, adler, false);

  const ihdr = new Uint8Array(13);
  const ihdrView = new DataView(ihdr.buffer);
  ihdrView.setUint32(0, width, false);
  ihdrView.setUint32(4, height, false);
  ihdr[8] = 8; // bit depth
  ihdr[9] = channels === 1 ? 0 : channels === 3 ? 2 : 6; // grayscale, RGB, or RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const signature = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdrChunk = makeChunk("IHDR", ihdr);
  const idatChunk = makeChunk("IDAT", zlibData);
  const iendChunk = makeChunk("IEND", new Uint8Array(0));

  const png = new Uint8Array(signature.length + ihdrChunk.length + idatChunk.length + iendChunk.length);
  let pos = 0;
  png.set(signature, pos); pos += signature.length;
  png.set(ihdrChunk, pos); pos += ihdrChunk.length;
  png.set(idatChunk, pos); pos += idatChunk.length;
  png.set(iendChunk, pos);
  return png;
}
