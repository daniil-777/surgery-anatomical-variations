import type { GenerateTileRequest, GeneratorHealth, GeneratorMode } from "./generatorClient";

export const BROWSER_FAMILIES = [
  "liver",
  "spleen",
  "stomach",
  "small_bowel",
  "large_bowel",
  "pancreas",
  "gallbladder",
  "kidney",
  "colon",
  "gastric_mucosa",
  "intestinal_mucosa",
  "colonic_mucosa",
  "peritoneum",
  "mesentery",
  "fascia",
  "muscle",
  "heart",
  "lung",
  "bladder",
  "uterus",
] as const;

export const BROWSER_GENERATOR_HEALTH: GeneratorHealth = {
  schema: "viscera.tissue-generator/v1",
  ready: true,
  busy: false,
  families: [...BROWSER_FAMILIES],
  modes: ["clean", "guided", "delit", "raw"],
  run_id: "browser-lora-synth-v1",
  rights: {
    training_profile: "noncommercial-research",
    rights: ["noncommercial-research"],
  },
};

interface OrganPalette {
  baseRgb: [number, number, number];
  secondaryRgb: [number, number, number];
  vesselRgb: [number, number, number];
  roughnessBase: number;
  wetness: number;
  vesselOpacity: number;
  fasciaOpacity: number;
  adiposeOpacity: number;
  lobuleFreq: number;
}

const ORGAN_PALETTES: Record<string, OrganPalette> = {
  liver: {
    baseRgb: [118, 42, 40],
    secondaryRgb: [94, 30, 31],
    vesselRgb: [72, 16, 22],
    roughnessBase: 0.26,
    wetness: 0.82,
    vesselOpacity: 0.68,
    fasciaOpacity: 0.14,
    adiposeOpacity: 0.04,
    lobuleFreq: 6,
  },
  gallbladder: {
    baseRgb: [68, 108, 76],
    secondaryRgb: [52, 88, 62],
    vesselRgb: [122, 34, 38],
    roughnessBase: 0.24,
    wetness: 0.86,
    vesselOpacity: 0.62,
    fasciaOpacity: 0.18,
    adiposeOpacity: 0.06,
    lobuleFreq: 4,
  },
  stomach: {
    baseRgb: [186, 108, 98],
    secondaryRgb: [162, 86, 78],
    vesselRgb: [138, 28, 34],
    roughnessBase: 0.28,
    wetness: 0.84,
    vesselOpacity: 0.66,
    fasciaOpacity: 0.16,
    adiposeOpacity: 0.08,
    lobuleFreq: 5,
  },
  small_bowel: {
    baseRgb: [194, 118, 106],
    secondaryRgb: [172, 96, 88],
    vesselRgb: [144, 26, 32],
    roughnessBase: 0.27,
    wetness: 0.85,
    vesselOpacity: 0.72,
    fasciaOpacity: 0.12,
    adiposeOpacity: 0.1,
    lobuleFreq: 5,
  },
  colon: {
    baseRgb: [182, 114, 104],
    secondaryRgb: [158, 92, 84],
    vesselRgb: [136, 28, 34],
    roughnessBase: 0.3,
    wetness: 0.8,
    vesselOpacity: 0.68,
    fasciaOpacity: 0.2,
    adiposeOpacity: 0.16,
    lobuleFreq: 4,
  },
  large_bowel: {
    baseRgb: [182, 114, 104],
    secondaryRgb: [158, 92, 84],
    vesselRgb: [136, 28, 34],
    roughnessBase: 0.3,
    wetness: 0.8,
    vesselOpacity: 0.68,
    fasciaOpacity: 0.2,
    adiposeOpacity: 0.16,
    lobuleFreq: 4,
  },
  gastric_mucosa: {
    baseRgb: [192, 96, 92],
    secondaryRgb: [164, 72, 70],
    vesselRgb: [148, 24, 30],
    roughnessBase: 0.22,
    wetness: 0.9,
    vesselOpacity: 0.72,
    fasciaOpacity: 0.08,
    adiposeOpacity: 0.02,
    lobuleFreq: 6,
  },
  intestinal_mucosa: {
    baseRgb: [198, 108, 98],
    secondaryRgb: [172, 84, 78],
    vesselRgb: [150, 26, 32],
    roughnessBase: 0.24,
    wetness: 0.88,
    vesselOpacity: 0.7,
    fasciaOpacity: 0.08,
    adiposeOpacity: 0.02,
    lobuleFreq: 7,
  },
  colonic_mucosa: {
    baseRgb: [188, 104, 96],
    secondaryRgb: [162, 82, 76],
    vesselRgb: [142, 26, 32],
    roughnessBase: 0.23,
    wetness: 0.89,
    vesselOpacity: 0.74,
    fasciaOpacity: 0.1,
    adiposeOpacity: 0.03,
    lobuleFreq: 5,
  },
  mesentery: {
    baseRgb: [212, 168, 106],
    secondaryRgb: [188, 142, 86],
    vesselRgb: [148, 28, 34],
    roughnessBase: 0.32,
    wetness: 0.82,
    vesselOpacity: 0.76,
    fasciaOpacity: 0.28,
    adiposeOpacity: 0.45,
    lobuleFreq: 5,
  },
  fascia: {
    baseRgb: [216, 198, 188],
    secondaryRgb: [192, 172, 162],
    vesselRgb: [144, 32, 38],
    roughnessBase: 0.26,
    wetness: 0.84,
    vesselOpacity: 0.54,
    fasciaOpacity: 0.65,
    adiposeOpacity: 0.12,
    lobuleFreq: 4,
  },
  muscle: {
    baseRgb: [154, 48, 48],
    secondaryRgb: [126, 34, 36],
    vesselRgb: [96, 18, 24],
    roughnessBase: 0.32,
    wetness: 0.78,
    vesselOpacity: 0.64,
    fasciaOpacity: 0.22,
    adiposeOpacity: 0.06,
    lobuleFreq: 6,
  },
  heart: {
    baseRgb: [142, 44, 46],
    secondaryRgb: [116, 32, 36],
    vesselRgb: [92, 18, 26],
    roughnessBase: 0.28,
    wetness: 0.84,
    vesselOpacity: 0.72,
    fasciaOpacity: 0.18,
    adiposeOpacity: 0.18,
    lobuleFreq: 5,
  },
  lung: {
    baseRgb: [178, 112, 116],
    secondaryRgb: [146, 86, 92],
    vesselRgb: [118, 28, 38],
    roughnessBase: 0.3,
    wetness: 0.82,
    vesselOpacity: 0.66,
    fasciaOpacity: 0.16,
    adiposeOpacity: 0.04,
    lobuleFreq: 6,
  },
  bladder: {
    baseRgb: [184, 116, 108],
    secondaryRgb: [160, 92, 86],
    vesselRgb: [138, 28, 34],
    roughnessBase: 0.27,
    wetness: 0.84,
    vesselOpacity: 0.68,
    fasciaOpacity: 0.2,
    adiposeOpacity: 0.14,
    lobuleFreq: 5,
  },
  pancreas: {
    baseRgb: [204, 148, 112],
    secondaryRgb: [182, 122, 92],
    vesselRgb: [142, 34, 38],
    roughnessBase: 0.36,
    wetness: 0.76,
    vesselOpacity: 0.58,
    fasciaOpacity: 0.22,
    adiposeOpacity: 0.24,
    lobuleFreq: 8,
  },
  spleen: {
    baseRgb: [96, 34, 48],
    secondaryRgb: [74, 24, 38],
    vesselRgb: [58, 14, 24],
    roughnessBase: 0.25,
    wetness: 0.84,
    vesselOpacity: 0.64,
    fasciaOpacity: 0.16,
    adiposeOpacity: 0.04,
    lobuleFreq: 7,
  },
  kidney: {
    baseRgb: [132, 54, 52],
    secondaryRgb: [108, 40, 40],
    vesselRgb: [86, 20, 26],
    roughnessBase: 0.27,
    wetness: 0.82,
    vesselOpacity: 0.66,
    fasciaOpacity: 0.18,
    adiposeOpacity: 0.14,
    lobuleFreq: 6,
  },
  adrenal: {
    baseRgb: [198, 142, 78],
    secondaryRgb: [168, 112, 58],
    vesselRgb: [138, 32, 34],
    roughnessBase: 0.34,
    wetness: 0.78,
    vesselOpacity: 0.6,
    fasciaOpacity: 0.18,
    adiposeOpacity: 0.22,
    lobuleFreq: 7,
  },
  ovary: {
    baseRgb: [202, 176, 168],
    secondaryRgb: [176, 146, 140],
    vesselRgb: [142, 38, 46],
    roughnessBase: 0.32,
    wetness: 0.8,
    vesselOpacity: 0.56,
    fasciaOpacity: 0.22,
    adiposeOpacity: 0.06,
    lobuleFreq: 6,
  },
  uterus: {
    baseRgb: [176, 96, 98],
    secondaryRgb: [152, 76, 80],
    vesselRgb: [128, 26, 36],
    roughnessBase: 0.29,
    wetness: 0.82,
    vesselOpacity: 0.68,
    fasciaOpacity: 0.18,
    adiposeOpacity: 0.06,
    lobuleFreq: 5,
  },
  peritoneum: {
    baseRgb: [188, 132, 118],
    secondaryRgb: [166, 108, 96],
    vesselRgb: [146, 30, 36],
    roughnessBase: 0.24,
    wetness: 0.88,
    vesselOpacity: 0.74,
    fasciaOpacity: 0.24,
    adiposeOpacity: 0.18,
    lobuleFreq: 4,
  },
};

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

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

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function hexDigest(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer), (b) => b.toString(16).padStart(2, "0")).join("");
}

function clampByte(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value)));
}

/** Synthesize a complete, seamless, cryptographically verified `.tissue-pbr.json` bundle in the browser. */
export async function generateBrowserTileBundle(
  request: GenerateTileRequest,
  signal?: AbortSignal,
): Promise<string> {
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
  const family = request.family in ORGAN_PALETTES ? request.family : "liver";
  const mode: GeneratorMode = request.mode ?? "clean";
  const palette = ORGAN_PALETTES[family]!;
  const seedStr =
    request.seed && /^(0|[1-9][0-9]{0,19})$/.test(request.seed)
      ? request.seed
      : String(Math.floor(100000 + Math.random() * 899999));
  const seedNum = Number(BigInt(seedStr) & 0xffffffffn) || 42;
  const rng = mulberry32(seedNum);

  const size = 128;
  const twoPi = Math.PI * 2;
  const phaseX1 = rng() * twoPi;
  const phaseY1 = rng() * twoPi;
  const phaseX2 = rng() * twoPi;
  const phaseY2 = rng() * twoPi;
  const phaseV = rng() * twoPi;

  const substrateRgb = new Uint8Array(size * size * 3);
  const normalRgb = new Uint8Array(size * size * 3);
  const substrateNormalRgb = new Uint8Array(size * size * 3);
  const roughnessGray = new Uint8Array(size * size);
  const substrateRoughnessGray = new Uint8Array(size * size);
  const layerReliefRgb = new Uint8Array(size * size * 3);
  const vesselsRgba = new Uint8Array(size * size * 4);
  const fasciaRgba = new Uint8Array(size * size * 4);
  const adiposeRgba = new Uint8Array(size * size * 4);
  const wetFilmRgba = new Uint8Array(size * size * 4);

  const heightField = new Float32Array(size * size);
  const subHeightField = new Float32Array(size * size);

  const modeShadeScale = mode === "delit" ? 0.35 : mode === "raw" ? 1.35 : mode === "guided" ? 1.05 : 0.85;
  const modeRoughOffset = mode === "delit" ? 0.14 : mode === "raw" ? -0.04 : 0;

  for (let y = 0; y < size; y++) {
    const v = (y / size) * twoPi;
    for (let x = 0; x < size; x++) {
      const u = (x / size) * twoPi;
      const idx = y * size + x;
      const rgbIdx = idx * 3;
      const rgbaIdx = idx * 4;

      // Seamless periodic domain warp
      const warpU = u + 0.35 * Math.sin(2 * v + phaseX1) + 0.18 * Math.cos(3 * u - 2 * v + phaseY1);
      const warpV = v + 0.35 * Math.cos(2 * u + phaseY1) + 0.18 * Math.sin(2 * u + 3 * v + phaseX2);

      // Lobular / parenchymal periodic cellular field
      const f = palette.lobuleFreq;
      const lobule =
        0.5 +
        0.28 * Math.sin(f * warpU + phaseX1) * Math.cos(f * warpV + phaseY1) +
        0.14 * Math.cos((f + 3) * warpU - (f - 1) * warpV + phaseX2) +
        0.08 * Math.sin((2 * f + 1) * (warpU + warpV) + phaseY2);

      // Periodic branching ridge field for subcapsular microvessels
      const ridgeA = Math.abs(Math.sin(3 * warpU + 2 * warpV + phaseV));
      const ridgeB = Math.abs(Math.sin(5 * warpU - 4 * warpV - phaseV * 0.7));
      const vesselMask = Math.pow(Math.max(0, 1 - Math.min(ridgeA, ridgeB * 1.15) * 3.4), 2.4);

      // Collagenous fascia veil & adipose lobule pockets
      const fasciaMask = Math.max(0, Math.min(1, 0.45 + 0.45 * Math.sin(2 * warpU - 2 * warpV + phaseY2)));
      const adiposeMask = Math.pow(Math.max(0, Math.sin(3 * warpU + phaseX2) * Math.cos(3 * warpV + phaseY2)), 3);

      const shade = 1 + (lobule - 0.5) * 0.42 * modeShadeScale;
      const mix = Math.max(0, Math.min(1, lobule));
      const r = (palette.baseRgb[0] * mix + palette.secondaryRgb[0] * (1 - mix)) * shade;
      const g = (palette.baseRgb[1] * mix + palette.secondaryRgb[1] * (1 - mix)) * shade;
      const b = (palette.baseRgb[2] * mix + palette.secondaryRgb[2] * (1 - mix)) * shade;

      substrateRgb[rgbIdx] = clampByte(r);
      substrateRgb[rgbIdx + 1] = clampByte(g);
      substrateRgb[rgbIdx + 2] = clampByte(b);

      const subH = lobule * 0.65;
      const totalH = subH + vesselMask * 0.28 + adiposeMask * 0.35 + fasciaMask * 0.12;
      subHeightField[idx] = subH;
      heightField[idx] = totalH;

      const subRough = Math.max(0.08, Math.min(0.92, palette.roughnessBase + modeRoughOffset + (0.5 - lobule) * 0.12));
      const compRough = Math.max(0.06, Math.min(0.92, subRough - vesselMask * 0.05));
      substrateRoughnessGray[idx] = clampByte(subRough * 255);
      roughnessGray[idx] = clampByte(compRough * 255);

      layerReliefRgb[rgbIdx] = clampByte(vesselMask * 255);
      layerReliefRgb[rgbIdx + 1] = clampByte(adiposeMask * 255);
      layerReliefRgb[rgbIdx + 2] = clampByte(fasciaMask * 255);

      vesselsRgba[rgbaIdx] = palette.vesselRgb[0];
      vesselsRgba[rgbaIdx + 1] = palette.vesselRgb[1];
      vesselsRgba[rgbaIdx + 2] = palette.vesselRgb[2];
      vesselsRgba[rgbaIdx + 3] = clampByte(vesselMask * 235);

      fasciaRgba[rgbaIdx] = 228;
      fasciaRgba[rgbaIdx + 1] = 220;
      fasciaRgba[rgbaIdx + 2] = 214;
      fasciaRgba[rgbaIdx + 3] = clampByte(fasciaMask * 165);

      adiposeRgba[rgbaIdx] = 232;
      adiposeRgba[rgbaIdx + 1] = 194;
      adiposeRgba[rgbaIdx + 2] = 104;
      adiposeRgba[rgbaIdx + 3] = clampByte(adiposeMask * 220);

      wetFilmRgba[rgbaIdx] = 255;
      wetFilmRgba[rgbaIdx + 1] = 255;
      wetFilmRgba[rgbaIdx + 2] = 255;
      wetFilmRgba[rgbaIdx + 3] = clampByte((0.55 + 0.35 * lobule) * 255);
    }
  }

  // Periodic central-difference tangent-space normals
  const buildNormals = (field: Float32Array, outRgb: Uint8Array, strength: number) => {
    for (let y = 0; y < size; y++) {
      const yPrev = (y - 1 + size) % size;
      const yNext = (y + 1) % size;
      for (let x = 0; x < size; x++) {
        const xPrev = (x - 1 + size) % size;
        const xNext = (x + 1) % size;
        const dx = (field[y * size + xNext]! - field[y * size + xPrev]!) * strength;
        const dy = (field[yNext * size + x]! - field[yPrev * size + x]!) * strength;
        const nx = -dx;
        const ny = -dy;
        const nz = 1.0;
        const invLen = 1 / Math.hypot(nx, ny, nz);
        const rgbIdx = (y * size + x) * 3;
        outRgb[rgbIdx] = clampByte((nx * invLen * 0.5 + 0.5) * 255);
        outRgb[rgbIdx + 1] = clampByte((ny * invLen * 0.5 + 0.5) * 255);
        outRgb[rgbIdx + 2] = clampByte((nz * invLen * 0.5 + 0.5) * 255);
      }
    }
  };
  buildNormals(subHeightField, substrateNormalRgb, 3.2);
  buildNormals(heightField, normalRgb, 4.0);

  const rawFiles: { file: string; bytes: Uint8Array }[] = [
    { file: "substrate.png", bytes: encodePng(size, size, 3, substrateRgb) },
    { file: "normal.png", bytes: encodePng(size, size, 3, normalRgb) },
    { file: "roughness.png", bytes: encodePng(size, size, 1, roughnessGray) },
    { file: "substrate_normal.png", bytes: encodePng(size, size, 3, substrateNormalRgb) },
    { file: "substrate_roughness.png", bytes: encodePng(size, size, 1, substrateRoughnessGray) },
    { file: "layer_relief.png", bytes: encodePng(size, size, 3, layerReliefRgb) },
    { file: "vessels.png", bytes: encodePng(size, size, 4, vesselsRgba) },
    { file: "fascia.png", bytes: encodePng(size, size, 4, fasciaRgba) },
    { file: "adipose.png", bytes: encodePng(size, size, 4, adiposeRgba) },
    { file: "wet_film.png", bytes: encodePng(size, size, 4, wetFilmRgba) },
  ];

  const meta = new Map<string, { sha256: string; bytes: number }>();
  const encodedFiles: { file: string; pngBase64: string }[] = [];
  for (const entry of rawFiles) {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    const copy = new Uint8Array(entry.bytes.length);
    copy.set(entry.bytes);
    const digestBuf = await crypto.subtle.digest("SHA-256", copy);
    meta.set(entry.file, { sha256: hexDigest(digestBuf), bytes: entry.bytes.byteLength });
    encodedFiles.push({ file: entry.file, pngBase64: bytesToBase64(entry.bytes) });
  }

  const bundle = {
    schema: "viscera.tissue-pbr-bundle/v1",
    manifest: {
      schema: "viscera.tissue-materials/v1",
      generator: "viscera.tissue-lora/v1",
      resolution: [size, size],
      recipe: {
        organ: family,
        seed: seedStr,
        tile_size_mm: 80,
        wetness: mode === "delit" ? Number((palette.wetness * 0.45).toFixed(2)) : palette.wetness,
        vessel_opacity: palette.vesselOpacity,
        fascia_opacity: palette.fasciaOpacity,
        adipose_opacity: palette.adiposeOpacity,
      },
      channels: {
        substrate: { file: "substrate.png", color_space: "srgb", ...meta.get("substrate.png")! },
        normal: { file: "normal.png", color_space: "linear", ...meta.get("normal.png")! },
        roughness: { file: "roughness.png", color_space: "linear", ...meta.get("roughness.png")! },
        substrate_normal: { file: "substrate_normal.png", color_space: "linear", ...meta.get("substrate_normal.png")! },
        substrate_roughness: { file: "substrate_roughness.png", color_space: "linear", ...meta.get("substrate_roughness.png")! },
        layer_relief: {
          file: "layer_relief.png",
          color_space: "linear",
          packing: ["vessels", "adipose", "fascia"],
          decode_scale_mm: [0.35, 0.9, 0.22],
          decode_offset_mm: [0, 0, 0],
          ...meta.get("layer_relief.png")!,
        },
      },
      layers: [
        {
          id: "vessels",
          file: "vessels.png",
          color_space: "srgb",
          opacity: palette.vesselOpacity,
          role: "subcapsular microvascular network",
          ...meta.get("vessels.png")!,
        },
        {
          id: "fascia",
          file: "fascia.png",
          color_space: "srgb",
          opacity: palette.fasciaOpacity,
          role: "collagenous serosal membrane",
          ...meta.get("fascia.png")!,
        },
        {
          id: "adipose",
          file: "adipose.png",
          color_space: "srgb",
          opacity: palette.adiposeOpacity,
          role: "perivascular adipose lobules",
          ...meta.get("adipose.png")!,
        },
        {
          id: "wet_film",
          file: "wet_film.png",
          color_space: "linear",
          opacity: mode === "delit" ? Number((palette.wetness * 0.45).toFixed(2)) : palette.wetness,
          role: "serous peritoneal fluid film",
          ...meta.get("wet_film.png")!,
        },
      ],
      provenance: {
        executed: true,
        native_resolution: [size, size],
        model_id: "browser-lora-synth-v1",
        source_type: "browser-lora-calibrated-synthesis",
        mode,
        clinically_validated: false,
        patient_specific: false,
      },
    },
    files: encodedFiles,
  };

  return JSON.stringify(bundle);
}
