import * as THREE from "three";
import { GLTFExporter } from "three/examples/jsm/exporters/GLTFExporter.js";
import { supportedOrganSurface, type OrganSurface } from "./organSurface";

export const ORGAN_BAKE_SCHEMA = "viscera.organ-mesh-bake/v1" as const;

const ORGAN_FALLBACK_MAP: Readonly<Record<string, string>> = Object.freeze({
  liver_peritoneum: "liver",
  pancreas_mesentery: "pancreas",
  gastric_mucosa: "stomach",
  intestinal_mucosa: "small_bowel",
  colonic_mucosa: "large_bowel",
  peritoneum: "mesentery",
  fascia: "mesentery",
});

/** Resolve a tissue material or learned tile family to its corresponding 3D atlas organ. */
export function resolveBakeOrgan(organOrFamily: string | undefined): string | undefined {
  if (!organOrFamily) return undefined;
  if (supportedOrganSurface(organOrFamily)) return organOrFamily;
  const mapped = ORGAN_FALLBACK_MAP[organOrFamily];
  return mapped && supportedOrganSurface(mapped) ? mapped : undefined;
}

export interface RgbaImage {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

export interface OrganBakeOptions {
  /** Atlas output resolution in pixels (e.g. 256, 512, 1024). */
  atlasResolution?: number;
  /** Physical tile scale in millimetres across the 3D organ surface (10–250 mm). */
  tileScaleMm?: number;
  /** Triplanar normal blend exponent (2–12). */
  blendSharpness?: number;
  /** Restore AC contrast across triplanar overlap zones using L2 weight normalization. */
  variancePreserving?: boolean;
  /** Optional layer superposition weights matching active TissueControls. */
  vessels?: number;
  fascia?: number;
  adipose?: number;
  wetness?: number;
}

export interface OrganChartBounds {
  chartIndex: number;
  label: "+X" | "-X" | "+Y" | "-Y" | "+Z" | "-Z";
  uMin: number;
  vMin: number;
  uMax: number;
  vMax: number;
  triangleCount: number;
}

export interface UnwrappedOrganMesh {
  geometry: THREE.BufferGeometry;
  charts: readonly OrganChartBounds[];
  chartOfTriangle: Uint8Array;
  vertexCount: number;
  triangleCount: number;
  crossChartSeamEdges: ReadonlyArray<readonly [number, number]>;
}

export interface OrganMeshBakeMetrics {
  schema: typeof ORGAN_BAKE_SCHEMA;
  organ: string;
  atlasResolution: number;
  tileScaleMm: number;
  blendSharpness: number;
  variancePreserving: boolean;
  chartCount: number;
  vertexCount: number;
  triangleCount: number;
  coverageFraction: number;
  seamContinuity: number;
  crossChartEdgeCount: number;
  meanColorLinear: readonly [number, number, number];
  meanColorSrgb: readonly [number, number, number];
}

export interface OrganMeshBakeResult {
  organ: string;
  unwrapped: UnwrappedOrganMesh;
  seamlessTile: RgbaImage;
  seamlessNormal: RgbaImage;
  seamlessRoughness: RgbaImage;
  seamlessTileTexture: THREE.DataTexture;
  seamlessNormalTexture: THREE.DataTexture;
  seamlessRoughnessTexture: THREE.DataTexture;
  albedoAtlas: RgbaImage;
  normalAtlas: RgbaImage;
  roughnessAtlas: RgbaImage;
  metrics: OrganMeshBakeMetrics;
  dispose: () => void;
}

export interface OrganBakeSourceMaps {
  substrate: RgbaImage;
  normal?: RgbaImage;
  roughness?: RgbaImage;
  vessels?: RgbaImage;
  fascia?: RgbaImage;
  adipose?: RgbaImage;
  wetFilm?: RgbaImage;
}

const CHART_LABELS: readonly ("+X" | "-X" | "+Y" | "-Y" | "+Z" | "-Z")[] = ["+X", "-X", "+Y", "-Y", "+Z", "-Z"];

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

function wrap01(value: number): number {
  const f = value - Math.floor(value);
  return f < 0 ? f + 1 : f;
}

/** Sample an RGBA image with periodic wrap and bilinear filtering in [0, 1]. */
export function samplePeriodicBilinear(img: RgbaImage, u: number, v: number, out = [0, 0, 0, 1]): [number, number, number, number] {
  const w = img.width, h = img.height, data = img.data;
  const x = wrap01(u) * w - 0.5;
  const y = wrap01(1 - v) * h - 0.5;
  const x0 = ((Math.floor(x) % w) + w) % w;
  const y0 = ((Math.floor(y) % h) + h) % h;
  const x1 = (x0 + 1) % w;
  const y1 = (y0 + 1) % h;
  const fx = x - Math.floor(x);
  const fy = y - Math.floor(y);
  const w00 = (1 - fx) * (1 - fy);
  const w10 = fx * (1 - fy);
  const w01 = (1 - fx) * fy;
  const w11 = fx * fy;
  const i00 = (y0 * w + x0) * 4;
  const i10 = (y0 * w + x1) * 4;
  const i01 = (y1 * w + x0) * 4;
  const i11 = (y1 * w + x1) * 4;
  out[0] = (data[i00]! * w00 + data[i10]! * w10 + data[i01]! * w01 + data[i11]! * w11) / 255;
  out[1] = (data[i00 + 1]! * w00 + data[i10 + 1]! * w10 + data[i01 + 1]! * w01 + data[i11 + 1]! * w11) / 255;
  out[2] = (data[i00 + 2]! * w00 + data[i10 + 2]! * w10 + data[i01 + 2]! * w01 + data[i11 + 2]! * w11) / 255;
  out[3] = (data[i00 + 3]! * w00 + data[i10 + 3]! * w10 + data[i01 + 3]! * w01 + data[i11 + 3]! * w11) / 255;
  return out as [number, number, number, number];
}

export function computeImageMeanRgb(img: RgbaImage): [number, number, number] {
  const data = img.data;
  const count = Math.max(1, img.width * img.height);
  let r = 0, g = 0, b = 0;
  for (let i = 0; i < data.length; i += 4) {
    r += data[i]!;
    g += data[i + 1]!;
    b += data[i + 2]!;
  }
  return [r / (count * 255), g / (count * 255), b / (count * 255)];
}

function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** Fast O(N) periodic separable box blur (2 passes approximate a smooth periodic Gaussian). */
function periodicBlurRgb(rgb: Float32Array, w: number, h: number, radius: number, passes = 2): Float32Array {
  if (radius < 1) return new Float32Array(rgb);
  let src = new Float32Array(rgb);
  let tmp = new Float32Array(rgb.length);
  const diam = 2 * radius + 1;
  const inv = 1 / diam;

  for (let pass = 0; pass < passes; pass++) {
    // Horizontal periodic pass
    for (let y = 0; y < h; y++) {
      const row = y * w;
      let sr = 0, sg = 0, sb = 0;
      for (let k = -radius; k <= radius; k++) {
        const xk = ((k % w) + w) % w;
        const idx = (row + xk) * 3;
        sr += src[idx]!; sg += src[idx + 1]!; sb += src[idx + 2]!;
      }
      for (let x = 0; x < w; x++) {
        const outIdx = (row + x) * 3;
        tmp[outIdx] = sr * inv;
        tmp[outIdx + 1] = sg * inv;
        tmp[outIdx + 2] = sb * inv;
        const xRem = (((x - radius) % w) + w) % w;
        const xAdd = (((x + radius + 1) % w) + w) % w;
        const iRem = (row + xRem) * 3, iAdd = (row + xAdd) * 3;
        sr += src[iAdd]! - src[iRem]!;
        sg += src[iAdd + 1]! - src[iRem + 1]!;
        sb += src[iAdd + 2]! - src[iRem + 2]!;
      }
    }
    // Vertical periodic pass
    for (let x = 0; x < w; x++) {
      let sr = 0, sg = 0, sb = 0;
      for (let k = -radius; k <= radius; k++) {
        const yk = ((k % h) + h) % h;
        const idx = (yk * w + x) * 3;
        sr += tmp[idx]!; sg += tmp[idx + 1]!; sb += tmp[idx + 2]!;
      }
      for (let y = 0; y < h; y++) {
        const outIdx = (y * w + x) * 3;
        src[outIdx] = sr * inv;
        src[outIdx + 1] = sg * inv;
        src[outIdx + 2] = sb * inv;
        const yRem = (((y - radius) % h) + h) % h;
        const yAdd = (((y + radius + 1) % h) + h) % h;
        const iRem = (yRem * w + x) * 3, iAdd = (yAdd * w + x) * 3;
        sr += tmp[iAdd]! - tmp[iRem]!;
        sg += tmp[iAdd + 1]! - tmp[iRem + 1]!;
        sb += tmp[iAdd + 2]! - tmp[iRem + 2]!;
      }
    }
  }
  return src;
}

/**
 * Synthesize an intrinsic, edge-seamless, macro-shadow-free organ tile + matching micro-relief
 * normal and roughness maps.
 *
 * 1. Suppresses localized purple/cyan VAE glint spots and specular white highlights.
 * 2. Decomposes the tile into macro-illumination/folds (wavelength > W/8) vs. intrinsic
 *    micro-vascular/parenchymal structure, flattening deep diagonal shadow trenches that
 *    would otherwise repeat as stripes/chevrons across the 3D organ mesh.
 * 3. Harmonizes tile boundaries with a C2 cosine cross-blend so periodic wrapping has
 *    zero step discontinuity.
 * 4. Derives clean micro-relief normals and roughness from the homogenized tissue grain so
 *    macro-craters never dent the 3D organ geometry.
 */
export function synthesizeSeamlessOrganTile(
  source: RgbaImage,
  options: {
    vessels?: number | undefined;
    fascia?: number | undefined;
    adipose?: number | undefined;
    wetness?: number | undefined;
    vesselsMap?: RgbaImage | undefined;
    fasciaMap?: RgbaImage | undefined;
    adiposeMap?: RgbaImage | undefined;
  } = {},
): {
  image: RgbaImage;
  normal: RgbaImage;
  roughness: RgbaImage;
  meanSrgb: [number, number, number];
  meanLinear: [number, number, number];
} {
  const { width: w, height: h, data: src } = source;
  if (w < 4 || h < 4) throw new RangeError("Tile dimensions must be at least 4×4");
  const total = w * h;

  // Step 0: Compute robust chrominance mean (excluding top/bottom 10% luma extremes)
  let rMean = 0, gMean = 0, bMean = 0, validCount = 0;
  const rawMean = computeImageMeanRgb(source);
  const rawLuma = 0.299 * rawMean[0] + 0.587 * rawMean[1] + 0.114 * rawMean[2];

  for (let i = 0; i < src.length; i += 4) {
    const r = src[i]! / 255, g = src[i + 1]! / 255, b = src[i + 2]! / 255;
    const luma = 0.299 * r + 0.587 * g + 0.114 * b;
    const purpleExcess = b - Math.max(r * 0.85, g * 1.15);
    if (luma > rawLuma * 0.55 && luma < rawLuma * 1.45 && purpleExcess < 0.04) {
      rMean += r; gMean += g; bMean += b; validCount++;
    }
  }
  if (validCount > total * 0.1) {
    rMean /= validCount; gMean /= validCount; bMean /= validCount;
  } else {
    [rMean, gMean, bMean] = rawMean;
  }

  // Step 1: Chromaticity coherence & luminance outlier clamping
  // Eliminates purple/cyan/greenish VAE latent spikes (e.g. cyan dip where R drops without G/B)
  // and clamps deep shadow clefts or specular white glints before spatial filtering.
  const cleanRgb = new Float32Array(total * 3);
  const invR = 1 / Math.max(rMean, 0.05);
  const invG = 1 / Math.max(gMean, 0.05);
  const invB = 1 / Math.max(bMean, 0.05);
  for (let i = 0, p3 = 0; i < src.length; i += 4, p3 += 3) {
    const r = src[i]! / 255, g = src[i + 1]! / 255, b = src[i + 2]! / 255;
    // Coherent relative brightness along the tissue's natural RGB palette
    const relR = r * invR, relG = g * invG, relB = b * invB;
    const rawScale = 0.50 * relR + 0.35 * relG + 0.15 * relB;
    const scale = 1.0 + 0.145 * Math.tanh((rawScale - 1.0) / 0.145);

    // Chromatic residual relative to coherent tissue color (rMean*scale, gMean*scale, bMean*scale)
    let dr = r - rMean * scale;
    let dg = g - gMean * scale;
    let db = b - bMean * scale;

    // Suppress cyan anomalies (negative red dip relative to green) & purple spikes (positive blue excess)
    // while preserving natural hemoglobin R > G vascular contrast
    if (dr < dg - 0.004) dr = dg - 0.004 + 0.004 * Math.tanh((dr - (dg - 0.004)) / 0.004);
    if (db > dg + 0.003) db = dg + 0.003 + 0.003 * Math.tanh((db - (dg + 0.003)) / 0.003);

    dr = 0.028 * Math.tanh(dr / 0.028);
    dg = 0.018 * Math.tanh(dg / 0.018);
    db = 0.014 * Math.tanh(db / 0.014);

    cleanRgb[p3] = clamp01(rMean * scale + dr);
    cleanRgb[p3 + 1] = clamp01(gMean * scale + dg);
    cleanRgb[p3 + 2] = clamp01(bMean * scale + db);
  }

  // Step 2: Multi-band stationary intrinsic detail extraction + subserosal hemoglobin enhancement
  // Removes macroscopic clefts/shadows (wavelength > midRadius) while preserving both fine capillary
  // grain and meso-scale parenchymal lobules, equalizing local RMS so trench walls cannot repeat as stripes.
  const fineRadius = Math.max(1, Math.min(4, Math.floor(Math.min(w, h) / 108)));
  const midRadius = Math.max(2, Math.min(12, Math.floor(Math.min(w, h) / 40)));
  const fineLow = periodicBlurRgb(cleanRgb, w, h, fineRadius, 2);
  const midLow = periodicBlurRgb(cleanRgb, w, h, midRadius, 2);

  const rawDetail = new Float32Array(total * 3);
  const energyRgb = new Float32Array(total * 3);
  for (let p3 = 0; p3 < rawDetail.length; p3 += 3) {
    const r = cleanRgb[p3]!, g = cleanRgb[p3 + 1]!, b = cleanRgb[p3 + 2]!;
    const fr = fineLow[p3]!, fg = fineLow[p3 + 1]!, fb = fineLow[p3 + 2]!;
    const mr = midLow[p3]!, mg = midLow[p3 + 1]!, mb = midLow[p3 + 2]!;

    let dR = 1.32 * (r - fr) + 0.72 * (fr - mr);
    let dG = 1.32 * (g - fg) + 0.72 * (fg - mg);
    let dB = 1.32 * (b - fb) + 0.72 * (fb - mb);

    // Physiological subserosal hemoglobin absorption filament enhancement (where R-G exceeds mean)
    const hemoSignal = Math.max(0, dR - dG);
    dR += hemoSignal * 0.22;
    dG -= hemoSignal * 0.26;
    dB -= hemoSignal * 0.20;

    rawDetail[p3] = dR;
    rawDetail[p3 + 1] = dG;
    rawDetail[p3 + 2] = dB;
    const e = dR * dR + dG * dG + dB * dB;
    energyRgb[p3] = e;
    energyRgb[p3 + 1] = e;
    energyRgb[p3 + 2] = e;
  }

  const eqRadius = Math.max(2, Math.min(10, Math.floor(Math.min(w, h) / 48)));
  const localEnergy = periodicBlurRgb(energyRgb, w, h, eqRadius, 2);
  let meanRms = 0;
  for (let p3 = 0; p3 < localEnergy.length; p3 += 3) {
    meanRms += Math.sqrt(Math.max(0, localEnergy[p3]!) + 1e-7);
  }
  meanRms /= total;

  const intrinsicRgb = new Float32Array(total * 3);
  for (let p3 = 0; p3 < intrinsicRgb.length; p3 += 3) {
    const localRms = Math.sqrt(Math.max(0, localEnergy[p3]!) + 1e-7);
    // Softly equalize high-energy trench walls while boosting natural parenchymal/vascular micro-contrast
    const gain = (meanRms * 1.28) / Math.max(localRms, meanRms * 0.68);
    intrinsicRgb[p3] = clamp01(rMean + rawDetail[p3]! * gain);
    intrinsicRgb[p3 + 1] = clamp01(gMean + rawDetail[p3 + 1]! * gain);
    intrinsicRgb[p3 + 2] = clamp01(bMean + rawDetail[p3 + 2]! * gain);
  }

  // Step 3: Full-domain C-infinity Toroidal Hann synthesis with 4-way isotropy
  // Weights w00 = sin^2(pi*u)*sin^2(pi*v), w10 = cos^2(pi*u)*sin^2(pi*v),
  // w01 = sin^2(pi*u)*cos^2(pi*v), w11 = cos^2(pi*u)*cos^2(pi*v) vanish identically
  // (with zero derivative) along every tap's wrap locus, guaranteeing zero seams everywhere.
  const out = new Uint8ClampedArray(total * 4);
  const heightField = new Float32Array(total);
  const roughData = new Uint8ClampedArray(total * 4);
  const vesselWeight = clamp01(options.vessels ?? 0);
  const fasciaWeight = clamp01(options.fascia ?? 0);
  const adiposeWeight = clamp01(options.adipose ?? 0);
  const isSquare = w === h;
  const halfW = Math.floor(w / 2);
  const halfH = Math.floor(h / 2);

  let sumR = 0, sumG = 0, sumB = 0;
  let linR = 0, linG = 0, linB = 0;

  for (let y = 0; y < h; y++) {
    const v = (y + 0.5) / h;
    const sy = Math.sin(Math.PI * v) ** 2;
    const cy = 1 - sy;
    const yOpp = (y + halfH) % h;
    for (let x = 0; x < w; x++) {
      const u = (x + 0.5) / w;
      const sx = Math.sin(Math.PI * u) ** 2;
      const cx = 1 - sx;
      const xOpp = (x + halfW) % w;

      const idx = y * w + x;
      // 4 rotated taps for square tiles (0, 90, 180, 270 deg) to eliminate directional anisotropy
      const p00 = (y * w + x) * 3;
      const p10 = isSquare ? ((w - 1 - xOpp) * w + y) * 3 : (y * w + xOpp) * 3;
      const p01 = isSquare ? ((h - 1 - yOpp) * w + (w - 1 - x)) * 3 : (yOpp * w + x) * 3;
      const p11 = isSquare ? (xOpp * w + (h - 1 - yOpp)) * 3 : (yOpp * w + xOpp) * 3;

      const w00 = sx * sy;
      const w10 = cx * sy;
      const w01 = sx * cy;
      const w11 = cx * cy;
      const wNorm = Math.hypot(w00, w10, w01, w11) || 1;

      const br = intrinsicRgb[p00]! * w00 + intrinsicRgb[p10]! * w10 + intrinsicRgb[p01]! * w01 + intrinsicRgb[p11]! * w11;
      const bg = intrinsicRgb[p00 + 1]! * w00 + intrinsicRgb[p10 + 1]! * w10 + intrinsicRgb[p01 + 1]! * w01 + intrinsicRgb[p11 + 1]! * w11;
      const bb = intrinsicRgb[p00 + 2]! * w00 + intrinsicRgb[p10 + 2]! * w10 + intrinsicRgb[p01 + 2]! * w01 + intrinsicRgb[p11 + 2]! * w11;

      let r = clamp01(rMean + (br - rMean) / wNorm);
      let g = clamp01(gMean + (bg - gMean) / wNorm);
      let b = clamp01(bMean + (bb - bMean) / wNorm);

      const i4 = idx * 4;
      if (options.vesselsMap && vesselWeight > 0) {
        const va = (options.vesselsMap.data[i4 + 3]! / 255) * vesselWeight;
        r = r * (1 - va) + (options.vesselsMap.data[i4]! / 255) * va;
        g = g * (1 - va) + (options.vesselsMap.data[i4 + 1]! / 255) * va;
        b = b * (1 - va) + (options.vesselsMap.data[i4 + 2]! / 255) * va;
      }
      if (options.adiposeMap && adiposeWeight > 0) {
        const aa = (options.adiposeMap.data[i4 + 3]! / 255) * adiposeWeight;
        r = r * (1 - aa) + (options.adiposeMap.data[i4]! / 255) * aa;
        g = g * (1 - aa) + (options.adiposeMap.data[i4 + 1]! / 255) * aa;
        b = b * (1 - aa) + (options.adiposeMap.data[i4 + 2]! / 255) * aa;
      }
      if (options.fasciaMap && fasciaWeight > 0) {
        const fa = (options.fasciaMap.data[i4 + 3]! / 255) * fasciaWeight;
        r = r * (1 - fa) + (options.fasciaMap.data[i4]! / 255) * fa;
        g = g * (1 - fa) + (options.fasciaMap.data[i4 + 1]! / 255) * fa;
        b = b * (1 - fa) + (options.fasciaMap.data[i4 + 2]! / 255) * fa;
      }

      out[i4] = Math.round(r * 255);
      out[i4 + 1] = Math.round(g * 255);
      out[i4 + 2] = Math.round(b * 255);
      out[i4 + 3] = 255;

      // Micro-height from fine parenchymal lobule domes and subserosal capillary sulci (zero macro craters!)
      const lumaDiff = 0.299 * (r - rMean) + 0.587 * (g - gMean) + 0.114 * (b - bMean);
      const vesselSulcus = Math.max(0, (r - g) - (rMean - gMean));
      heightField[idx] = lumaDiff * 1.18 - vesselSulcus * 0.42;

      const dryRough = clamp01(0.31 - lumaDiff * 0.65 + vesselSulcus * 0.28);
      const rByte = Math.round(dryRough * 255);
      roughData[i4] = rByte;
      roughData[i4 + 1] = rByte;
      roughData[i4 + 2] = rByte;
      roughData[i4 + 3] = 255;

      sumR += out[i4]! / 255;
      sumG += out[i4 + 1]! / 255;
      sumB += out[i4 + 2]! / 255;
      linR += srgbToLinear(out[i4]! / 255);
      linG += srgbToLinear(out[i4 + 1]! / 255);
      linB += srgbToLinear(out[i4 + 2]! / 255);
    }
  }

  // Step 4: Derive periodic micro-relief normal map from heightField
  const normData = new Uint8ClampedArray(total * 4);
  const slopeGain = 3.05;
  for (let y = 0; y < h; y++) {
    const yPrev = (y - 1 + h) % h;
    const yNext = (y + 1) % h;
    for (let x = 0; x < w; x++) {
      const xPrev = (x - 1 + w) % w;
      const xNext = (x + 1) % w;
      const dhdx = (heightField[y * w + xNext]! - heightField[y * w + xPrev]!) * 0.5 * slopeGain;
      const dhdy = (heightField[yPrev * w + x]! - heightField[yNext * w + x]!) * 0.5 * slopeGain;
      let nx = -dhdx, ny = -dhdy, nz = 1.0;
      const len = Math.hypot(nx, ny, nz) || 1;
      nx /= len; ny /= len; nz /= len;
      const i4 = (y * w + x) * 4;
      normData[i4] = Math.round((nx * 0.5 + 0.5) * 255);
      normData[i4 + 1] = Math.round((ny * 0.5 + 0.5) * 255);
      normData[i4 + 2] = Math.round((nz * 0.5 + 0.5) * 255);
      normData[i4 + 3] = 255;
    }
  }

  return {
    image: { width: w, height: h, data: out },
    normal: { width: w, height: h, data: normData },
    roughness: { width: w, height: h, data: roughData },
    meanSrgb: [sumR / total, sumG / total, sumB / total],
    meanLinear: [linR / total, linG / total, linB / total],
  };
}

function dominantChartIndex(nx: number, ny: number, nz: number): number {
  const ax = Math.abs(nx), ay = Math.abs(ny), az = Math.abs(nz);
  if (ax >= ay && ax >= az) return nx >= 0 ? 0 : 1;
  if (ay >= ax && ay >= az) return ny >= 0 ? 2 : 3;
  return nz >= 0 ? 4 : 5;
}

function chartAxes(chart: number): { uAxis: [number, number, number]; vAxis: [number, number, number] } {
  switch (chart) {
    case 0: return { uAxis: [0, 0, -1], vAxis: [0, 1, 0] }; // +X
    case 1: return { uAxis: [0, 0, 1], vAxis: [0, 1, 0] };  // -X
    case 2: return { uAxis: [1, 0, 0], vAxis: [0, 0, -1] }; // +Y
    case 3: return { uAxis: [1, 0, 0], vAxis: [0, 0, 1] };  // -Y
    case 4: return { uAxis: [1, 0, 0], vAxis: [0, 1, 0] };  // +Z
    default: return { uAxis: [-1, 0, 0], vAxis: [0, 1, 0] }; // -Z
  }
}

/**
 * Weld coincident 3D vertices and apply topological Laplacian normal fairing so split-vertex
 * mesh seams (e.g. colon/pancreas seam edges) and CT marching-cubes staircase terraces (e.g. liver
 * lobe rings) are completely eliminated while keeping 3D vertex positions 100% unchanged.
 */
export function computeSeamlessSmoothOrganNormals(
  geometry: THREE.BufferGeometry,
  iterations = 16,
  fairPositions = false,
): void {
  const posAttr = geometry.getAttribute("position");
  if (!posAttr || posAttr.count < 3) return;
  const vCount = posAttr.count;
  const indexAttr = geometry.getIndex();
  const triCount = indexAttr ? Math.floor(indexAttr.count / 3) : Math.floor(vCount / 3);
  if (triCount < 1) return;

  // 1. Weld coincident 3D positions within 0.02 mm tolerance to close meshopt split seams
  // without collapsing closely spaced haustral fold vertices on dense meshes like the colon.
  const posMap = new Map<string, number>();
  const vertToWelded = new Int32Array(vCount);
  const wPosSum: number[] = [];
  const wPosCount: number[] = [];
  let wCount = 0;
  for (let i = 0; i < vCount; i++) {
    const px = posAttr.getX(i), py = posAttr.getY(i), pz = posAttr.getZ(i);
    const qx = Math.round(px * 50);
    const qy = Math.round(py * 50);
    const qz = Math.round(pz * 50);
    const key = `${qx},${qy},${qz}`;
    let wIdx = posMap.get(key);
    if (wIdx === undefined) {
      wIdx = wCount++;
      posMap.set(key, wIdx);
      wPosSum.push(px, py, pz);
      wPosCount.push(1);
    } else {
      const w3 = wIdx * 3;
      wPosSum[w3]! += px;
      wPosSum[w3 + 1]! += py;
      wPosSum[w3 + 2]! += pz;
      wPosCount[wIdx]! += 1;
    }
    vertToWelded[i] = wIdx;
  }

  let wPos = new Float32Array(wCount * 3);
  for (let w = 0; w < wCount; w++) {
    const c = wPosCount[w]! || 1;
    const w3 = w * 3;
    wPos[w3] = wPosSum[w3]! / c;
    wPos[w3 + 1] = wPosSum[w3 + 1]! / c;
    wPos[w3 + 2] = wPosSum[w3 + 2]! / c;
  }

  // 2. Build CSR adjacency on welded vertices
  const adjSets: number[][] = Array.from({ length: wCount }, () => []);
  const getIdx = (k: number) => (indexAttr ? indexAttr.getX(k) : k);

  const addEdge = (a: number, b: number) => {
    if (a === b) return;
    const listA = adjSets[a]!;
    if (!listA.includes(b)) listA.push(b);
    const listB = adjSets[b]!;
    if (!listB.includes(a)) listB.push(a);
  };

  for (let t = 0; t < triCount; t++) {
    const i0 = getIdx(t * 3), i1 = getIdx(t * 3 + 1), i2 = getIdx(t * 3 + 2);
    const w0 = vertToWelded[i0]!, w1 = vertToWelded[i1]!, w2 = vertToWelded[i2]!;
    addEdge(w0, w1);
    addEdge(w1, w2);
    addEdge(w2, w0);
  }

  const offsets = new Int32Array(wCount + 1);
  let totalEdges = 0;
  for (let w = 0; w < wCount; w++) {
    offsets[w] = totalEdges;
    totalEdges += adjSets[w]!.length;
  }
  offsets[wCount] = totalEdges;
  const neighbors = new Int32Array(totalEdges);
  for (let w = 0; w < wCount; w++) {
    const list = adjSets[w]!;
    let ptr = offsets[w]!;
    for (let k = 0; k < list.length; k++) neighbors[ptr++] = list[k]!;
  }

  // 2b. Connected components on welded CSR graph to detect multi-component organs (small-intestine, colon)
  const comp = new Int32Array(wCount).fill(-1);
  const compSizes: number[] = [];
  let cId = 0;
  let maxCompSize = 0;
  const bfsQueue = new Int32Array(wCount);
  for (let i = 0; i < wCount; i++) {
    if (comp[i] !== -1) continue;
    let head = 0, tail = 0;
    bfsQueue[tail++] = i;
    comp[i] = cId;
    while (head < tail) {
      const u = bfsQueue[head++]!;
      const start = offsets[u]!, end = offsets[u + 1]!;
      for (let ptr = start; ptr < end; ptr++) {
        const v = neighbors[ptr]!;
        if (comp[v] === -1) {
          comp[v] = cId;
          bfsQueue[tail++] = v;
        }
      }
    }
    compSizes.push(tail);
    if (tail > maxCompSize) maxCompSize = tail;
    cId++;
  }

  const isMultiCompOrgan = cId > 1 && maxCompSize >= 50;
  const origNormAttr = geometry.getAttribute("normal");

  // 2c. For multi-component organs, classify buried/mating-wall vertices (ringDist 0..3) before position fairing
  // so internal end-caps (small-intestine) and partition walls (colon) never pull dents or twist normals.
  const ringDist = new Uint8Array(wCount).fill(3);
  const connectedComp = new Uint8Array(cId * cId);
  const sArea = new Float32Array(wCount);
  const wCoherence = new Float32Array(wCount);
  if (isMultiCompOrgan) {
    const rawNorm = new Float32Array(wCount * 3);
    for (let t = 0; t < triCount; t++) {
      const i0 = getIdx(t * 3), i1 = getIdx(t * 3 + 1), i2 = getIdx(t * 3 + 2);
      const w0 = vertToWelded[i0]!, w1 = vertToWelded[i1]!, w2 = vertToWelded[i2]!;
      const ax = wPos[w0 * 3]!, ay = wPos[w0 * 3 + 1]!, az = wPos[w0 * 3 + 2]!;
      const e1x = wPos[w1 * 3]! - ax, e1y = wPos[w1 * 3 + 1]! - ay, e1z = wPos[w1 * 3 + 2]! - az;
      const e2x = wPos[w2 * 3]! - ax, e2y = wPos[w2 * 3 + 1]! - ay, e2z = wPos[w2 * 3 + 2]! - az;
      let fnx = e1y * e2z - e1z * e2y;
      let fny = e1z * e2x - e1x * e2z;
      let fnz = e1x * e2y - e1y * e2x;
      if (origNormAttr) {
        const onx = origNormAttr.getX(i0) + origNormAttr.getX(i1) + origNormAttr.getX(i2);
        const ony = origNormAttr.getY(i0) + origNormAttr.getY(i1) + origNormAttr.getY(i2);
        const onz = origNormAttr.getZ(i0) + origNormAttr.getZ(i1) + origNormAttr.getZ(i2);
        if (fnx * onx + fny * ony + fnz * onz < 0) {
          fnx = -fnx; fny = -fny; fnz = -fnz;
        }
      }
      const a2 = Math.hypot(fnx, fny, fnz);
      for (const w of [w0, w1, w2]) {
        rawNorm[w * 3]! += fnx;
        rawNorm[w * 3 + 1]! += fny;
        rawNorm[w * 3 + 2]! += fnz;
        sArea[w]! += a2;
      }
    }
    for (let w = 0; w < wCount; w++) {
      const l = Math.hypot(rawNorm[w * 3]!, rawNorm[w * 3 + 1]!, rawNorm[w * 3 + 2]!) || 1;
      wCoherence[w] = sArea[w]! > 1e-8 ? Math.min(1, l / sArea[w]!) : 1;
      rawNorm[w * 3]! /= l;
      rawNorm[w * 3 + 1]! /= l;
      rawNorm[w * 3 + 2]! /= l;
    }

    // Identify which component pairs share a continuous anatomical wall (aligned outer rim normals within 3.5 mm)
    // vs separate bowel coils that merely touch externally from opposite sides.
    const pairAligned = new Int32Array(cId * cId);
    const cellAlign = 4.5;
    const alignGrid = new Map<string, number[]>();
    for (let w = 0; w < wCount; w++) {
      if (compSizes[comp[w]!]! < 40) continue;
      const gx = Math.floor(wPos[w * 3]! / cellAlign);
      const gy = Math.floor(wPos[w * 3 + 1]! / cellAlign);
      const gz = Math.floor(wPos[w * 3 + 2]! / cellAlign);
      const k = `${gx},${gy},${gz}`;
      let list = alignGrid.get(k);
      if (!list) {
        list = [];
        alignGrid.set(k, list);
      }
      list.push(w);
    }
    for (let w = 0; w < wCount; w++) {
      const cA = comp[w]!;
      if (compSizes[cA]! < 40) continue;
      const wx = wPos[w * 3]!, wy = wPos[w * 3 + 1]!, wz = wPos[w * 3 + 2]!;
      const nwx = rawNorm[w * 3]!, nwy = rawNorm[w * 3 + 1]!, nwz = rawNorm[w * 3 + 2]!;
      const gx = Math.floor(wx / cellAlign), gy = Math.floor(wy / cellAlign), gz = Math.floor(wz / cellAlign);
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          for (let dz = -1; dz <= 1; dz++) {
            const list = alignGrid.get(`${gx + dx},${gy + dy},${gz + dz}`);
            if (!list) continue;
            for (let k = 0; k < list.length; k++) {
              const u = list[k]!;
              if (u <= w) continue;
              const cB = comp[u]!;
              if (cA === cB) continue;
              const rx = wx - wPos[u * 3]!, ry = wy - wPos[u * 3 + 1]!, rz = wz - wPos[u * 3 + 2]!;
              if (rx * rx + ry * ry + rz * rz > 12.25) continue;
              const dot = nwx * rawNorm[u * 3]! + nwy * rawNorm[u * 3 + 1]! + nwz * rawNorm[u * 3 + 2]!;
              if (dot > 0.5) {
                pairAligned[cA * cId + cB]! += 1;
                pairAligned[cB * cId + cA]! += 1;
              }
            }
          }
        }
      }
    }
    for (let a = 0; a < cId; a++) {
      connectedComp[a * cId + a] = 1;
      for (let b = a + 1; b < cId; b++) {
        if (pairAligned[a * cId + b]! >= 4) {
          connectedComp[a * cId + b] = 1;
          connectedComp[b * cId + a] = 1;
        }
      }
    }

    const cellYZ = 4.0;
    const globalYzGrid = new Map<string, number[]>();
    for (let t = 0; t < triCount; t++) {
      const w0 = vertToWelded[getIdx(t * 3)]!;
      if (compSizes[comp[w0]!]! < 40) continue;
      const w1 = vertToWelded[getIdx(t * 3 + 1)]!;
      const w2 = vertToWelded[getIdx(t * 3 + 2)]!;
      const y0 = wPos[w0 * 3 + 1]!, y1 = wPos[w1 * 3 + 1]!, y2 = wPos[w2 * 3 + 1]!;
      const z0 = wPos[w0 * 3 + 2]!, z1 = wPos[w1 * 3 + 2]!, z2 = wPos[w2 * 3 + 2]!;
      const gy0 = Math.floor(Math.min(y0, y1, y2) / cellYZ);
      const gy1 = Math.floor(Math.max(y0, y1, y2) / cellYZ);
      const gz0 = Math.floor(Math.min(z0, z1, z2) / cellYZ);
      const gz1 = Math.floor(Math.max(z0, z1, z2) / cellYZ);
      for (let gy = gy0; gy <= gy1; gy++) {
        for (let gz = gz0; gz <= gz1; gz++) {
          const k = `${gy},${gz}`;
          let list = globalYzGrid.get(k);
          if (!list) {
            list = [];
            globalYzGrid.set(k, list);
          }
          list.push(t);
        }
      }
    }

    const parity = new Uint8Array(cId);
    const touched: number[] = [];
    const isPointInsideOther = (px: number, py: number, pz: number, cSelf: number): boolean => {
      const qy = py + 1.37e-4, qz = pz + 2.91e-4;
      const list = globalYzGrid.get(`${Math.floor(qy / cellYZ)},${Math.floor(qz / cellYZ)}`);
      if (!list) return false;
      const selfRow = cSelf * cId;
      for (let k = 0; k < list.length; k++) {
        const t = list[k]!;
        const w0 = vertToWelded[getIdx(t * 3)]!;
        const cTri = comp[w0]!;
        if (cTri === cSelf || !connectedComp[selfRow + cTri]) continue;
        const w1 = vertToWelded[getIdx(t * 3 + 1)]!;
        const w2 = vertToWelded[getIdx(t * 3 + 2)]!;
        const y0 = wPos[w0 * 3 + 1]!, z0 = wPos[w0 * 3 + 2]!;
        const d00 = wPos[w1 * 3 + 1]! - y0, d01 = wPos[w1 * 3 + 2]! - z0;
        const d10 = wPos[w2 * 3 + 1]! - y0, d11 = wPos[w2 * 3 + 2]! - z0;
        const det = d00 * d11 - d01 * d10;
        if (Math.abs(det) < 1e-10) continue;
        const invDet = 1 / det;
        const ry = qy - y0, rz = qz - z0;
        const u = (ry * d11 - rz * d10) * invDet;
        if (u < 0 || u > 1) continue;
        const v = (d00 * rz - d01 * ry) * invDet;
        if (v < 0 || u + v > 1) continue;
        const xHit = wPos[w0 * 3]! + u * (wPos[w1 * 3]! - wPos[w0 * 3]!) + v * (wPos[w2 * 3]! - wPos[w0 * 3]!);
        if (xHit > px) {
          if (parity[cTri] === 0) touched.push(cTri);
          parity[cTri]! ^= 1;
        }
      }
      let hit = false;
      for (let k = 0; k < touched.length; k++) {
        const c = touched[k]!;
        if (parity[c] === 1) hit = true;
        parity[c] = 0;
      }
      touched.length = 0;
      return hit;
    };

    const isFacingConnectedWall = (w: number): boolean => {
      const cA = comp[w]!;
      const selfRow = cA * cId;
      const wx = wPos[w * 3]!, wy = wPos[w * 3 + 1]!, wz = wPos[w * 3 + 2]!;
      const nwx = rawNorm[w * 3]!, nwy = rawNorm[w * 3 + 1]!, nwz = rawNorm[w * 3 + 2]!;
      const gx = Math.floor(wx / cellAlign), gy = Math.floor(wy / cellAlign), gz = Math.floor(wz / cellAlign);
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          for (let dz = -1; dz <= 1; dz++) {
            const list = alignGrid.get(`${gx + dx},${gy + dy},${gz + dz}`);
            if (!list) continue;
            for (let k = 0; k < list.length; k++) {
              const u = list[k]!;
              const cB = comp[u]!;
              if (!connectedComp[selfRow + cB]) continue;
              const rx = wPos[u * 3]! - wx, ry = wPos[u * 3 + 1]! - wy, rz = wPos[u * 3 + 2]! - wz;
              const d2 = rx * rx + ry * ry + rz * rz;
              if (d2 < 0.04 || d2 > 20.25) continue;
              const dotNorm = nwx * rawNorm[u * 3]! + nwy * rawNorm[u * 3 + 1]! + nwz * rawNorm[u * 3 + 2]!;
              const projW = rx * nwx + ry * nwy + rz * nwz;
              const projU = -rx * rawNorm[u * 3]! - ry * rawNorm[u * 3 + 1]! - rz * rawNorm[u * 3 + 2]!;
              if (cA !== cB && projW > 0.4 && dotNorm < 0.25) return true;
              if (dotNorm < -0.15 && projU > 0.3 && sArea[u]! > sArea[w]! * 1.5) return true;
            }
          }
        }
      }
      return false;
    };

    for (let w = 0; w < wCount; w++) {
      const cSelf = comp[w]!;
      if (compSizes[cSelf]! < 40) {
        ringDist[w] = 0;
        continue;
      }
      const px = wPos[w * 3]!, py = wPos[w * 3 + 1]!, pz = wPos[w * 3 + 2]!;
      const nx = rawNorm[w * 3]!, ny = rawNorm[w * 3 + 1]!, nz = rawNorm[w * 3 + 2]!;
      if (
        isPointInsideOther(px, py, pz, cSelf) ||
        isPointInsideOther(px + 1.2 * nx, py + 1.2 * ny, pz + 1.2 * nz, cSelf) ||
        isFacingConnectedWall(w)
      ) {
        ringDist[w] = 0;
      }
    }
    for (let r = 1; r <= 2; r++) {
      for (let w = 0; w < wCount; w++) {
        if (ringDist[w]! <= r) continue;
        const start = offsets[w]!, end = offsets[w + 1]!;
        for (let ptr = start; ptr < end; ptr++) {
          if (ringDist[neighbors[ptr]!] === r - 1) {
            ringDist[w] = r;
            break;
          }
        }
      }
    }
  }

  // Optional volume-preserving Taubin lambda/mu position fairing to remove sharp mesh creases
  if (fairPositions) {
    let tmpPos = new Float32Array(wCount * 3);
    const lambdas = [0.33, -0.342, 0.33, -0.342, 0.33, -0.342];
    for (const stepWeight of lambdas) {
      for (let w = 0; w < wCount; w++) {
        const start = offsets[w]!, end = offsets[w + 1]!;
        const w3 = w * 3;
        let sx = 0, sy = 0, sz = 0, deg = 0;
        for (let ptr = start; ptr < end; ptr++) {
          const nb = neighbors[ptr]!;
          if (isMultiCompOrgan && ringDist[nb]! < ringDist[w]!) continue;
          const nb3 = nb * 3;
          sx += wPos[nb3]!;
          sy += wPos[nb3 + 1]!;
          sz += wPos[nb3 + 2]!;
          deg++;
        }
        if (deg < 2) {
          tmpPos[w3] = wPos[w3]!;
          tmpPos[w3 + 1] = wPos[w3 + 1]!;
          tmpPos[w3 + 2] = wPos[w3 + 2]!;
          continue;
        }
        const invDeg = 1 / deg;
        tmpPos[w3] = wPos[w3]! + stepWeight * (sx * invDeg - wPos[w3]!);
        tmpPos[w3 + 1] = wPos[w3 + 1]! + stepWeight * (sy * invDeg - wPos[w3 + 1]!);
        tmpPos[w3 + 2] = wPos[w3 + 2]! + stepWeight * (sz * invDeg - wPos[w3 + 2]!);
      }
      const swap = wPos;
      wPos = tmpPos;
      tmpPos = swap;
    }
    const outPositions = new Float32Array(vCount * 3);
    for (let i = 0; i < vCount; i++) {
      const w3 = vertToWelded[i]! * 3;
      const i3 = i * 3;
      outPositions[i3] = wPos[w3]!;
      outPositions[i3 + 1] = wPos[w3 + 1]!;
      outPositions[i3 + 2] = wPos[w3 + 2]!;
    }
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(outPositions, 3));
  }

  let curr = new Float32Array(wCount * 3);
  if (isMultiCompOrgan) {
    // Multi-component organ path: weight face normals by exterior crown distance, diffuse crown normals
    // into buried end-caps/partitions, then evaluate a single-valued Wendland C2 3D normal field.
    const wNormals = new Float32Array(wCount * 3);
    const triRingWt = [1e-4, 0.02, 0.25, 1.0] as const;
    for (let t = 0; t < triCount; t++) {
      const i0 = getIdx(t * 3), i1 = getIdx(t * 3 + 1), i2 = getIdx(t * 3 + 2);
      const w0 = vertToWelded[i0]!, w1 = vertToWelded[i1]!, w2 = vertToWelded[i2]!;
      const minR = Math.min(ringDist[w0]!, ringDist[w1]!, ringDist[w2]!);
      const wt = triRingWt[minR]!;
      const p0x = wPos[w0 * 3]!, p0y = wPos[w0 * 3 + 1]!, p0z = wPos[w0 * 3 + 2]!;
      const e1x = wPos[w1 * 3]! - p0x, e1y = wPos[w1 * 3 + 1]! - p0y, e1z = wPos[w1 * 3 + 2]! - p0z;
      const e2x = wPos[w2 * 3]! - p0x, e2y = wPos[w2 * 3 + 1]! - p0y, e2z = wPos[w2 * 3 + 2]! - p0z;
      let fnx = e1y * e2z - e1z * e2y;
      let fny = e1z * e2x - e1x * e2z;
      let fnz = e1x * e2y - e1y * e2x;
      if (origNormAttr) {
        const onx = origNormAttr.getX(i0) + origNormAttr.getX(i1) + origNormAttr.getX(i2);
        const ony = origNormAttr.getY(i0) + origNormAttr.getY(i1) + origNormAttr.getY(i2);
        const onz = origNormAttr.getZ(i0) + origNormAttr.getZ(i1) + origNormAttr.getZ(i2);
        if (fnx * onx + fny * ony + fnz * onz < 0) {
          fnx = -fnx; fny = -fny; fnz = -fnz;
        }
      }
      for (const w of [w0, w1, w2]) {
        const w3 = w * 3;
        wNormals[w3]! += fnx * wt;
        wNormals[w3 + 1]! += fny * wt;
        wNormals[w3 + 2]! += fnz * wt;
      }
    }
    for (let w = 0; w < wCount; w++) {
      const w3 = w * 3;
      const l = Math.hypot(wNormals[w3]!, wNormals[w3 + 1]!, wNormals[w3 + 2]!) || 1;
      curr[w3] = wNormals[w3]! / l;
      curr[w3 + 1] = wNormals[w3 + 1]! / l;
      curr[w3 + 2] = wNormals[w3 + 2]! / l;
    }

    const crownWt = [1e-4, 0.03, 0.35, 1.0] as const;
    let next = new Float32Array(wCount * 3);
    for (let iter = 0; iter < 14; iter++) {
      for (let w = 0; w < wCount; w++) {
        const w3 = w * 3;
        const selfW = crownWt[ringDist[w]!]! * 0.35;
        let sx = curr[w3]! * selfW, sy = curr[w3 + 1]! * selfW, sz = curr[w3 + 2]! * selfW;
        const start = offsets[w]!, end = offsets[w + 1]!;
        for (let ptr = start; ptr < end; ptr++) {
          const nb = neighbors[ptr]!;
          const nw = crownWt[ringDist[nb]!]!;
          sx += curr[nb * 3]! * nw;
          sy += curr[nb * 3 + 1]! * nw;
          sz += curr[nb * 3 + 2]! * nw;
        }
        const l = Math.hypot(sx, sy, sz) || 1;
        next[w3] = sx / l;
        next[w3 + 1] = sy / l;
        next[w3 + 2] = sz / l;
      }
      const swap = curr;
      curr = next;
      next = swap;
    }

    // Evaluate 1-pass connected-component Wendland C2 kernel (R = 9.0 mm) over exterior crown vertices
    // so consecutive capsules and colon sub-meshes fuse seamlessly while separate touching coils never bleed.
    const R = 9.0, R2 = R * R;
    const extGrid = new Map<string, number[]>();
    for (let u = 0; u < wCount; u++) {
      if (ringDist[u] === 0) continue;
      const gx = Math.floor(wPos[u * 3]! / R);
      const gy = Math.floor(wPos[u * 3 + 1]! / R);
      const gz = Math.floor(wPos[u * 3 + 2]! / R);
      const k = `${gx},${gy},${gz}`;
      let list = extGrid.get(k);
      if (!list) {
        list = [];
        extGrid.set(k, list);
      }
      list.push(u);
    }

    for (let w = 0; w < wCount; w++) {
      const w3 = w * 3;
      const wx = wPos[w3]!, wy = wPos[w3 + 1]!, wz = wPos[w3 + 2]!;
      const cSelf = comp[w]!;
      const selfRow = cSelf * cId;
      const isTinySelf = compSizes[cSelf]! < 40;
      const gx = Math.floor(wx / R), gy = Math.floor(wy / R), gz = Math.floor(wz / R);
      let sx = 0, sy = 0, sz = 0;
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          for (let dz = -1; dz <= 1; dz++) {
            const list = extGrid.get(`${gx + dx},${gy + dy},${gz + dz}`);
            if (!list) continue;
            for (let k = 0; k < list.length; k++) {
              const u = list[k]!;
              if (!isTinySelf && !connectedComp[selfRow + comp[u]!]) continue;
              const u3 = u * 3;
              const rx = wx - wPos[u3]!, ry = wy - wPos[u3 + 1]!, rz = wz - wPos[u3 + 2]!;
              const d2 = rx * rx + ry * ry + rz * rz;
              if (d2 >= R2) continue;
              const t = 1 - d2 / R2;
              const areaWt = Math.sqrt(Math.max(1e-4, sArea[u]!)) * (wCoherence[u]! ** 4);
              const wt = (t * t * t) * crownWt[ringDist[u]!]! * areaWt;
              sx += curr[u3]! * wt;
              sy += curr[u3 + 1]! * wt;
              sz += curr[u3 + 2]! * wt;
            }
          }
        }
      }
      const l = Math.hypot(sx, sy, sz);
      if (l > 1e-8) {
        next[w3] = sx / l;
        next[w3 + 1] = sy / l;
        next[w3 + 2] = sz / l;
      } else {
        next[w3] = curr[w3]!;
        next[w3 + 1] = curr[w3 + 1]!;
        next[w3 + 2] = curr[w3 + 2]!;
      }
    }
    const swap = curr;
    curr = next;
    next = swap;
  } else {
    // 3. Single-component organ path: area-coherence weighting + 4 mm spatial + Laplacian fairing
    const wNormals = new Float32Array(wCount * 3);
    const wScalarArea = new Float32Array(wCount);
    for (let t = 0; t < triCount; t++) {
      const i0 = getIdx(t * 3), i1 = getIdx(t * 3 + 1), i2 = getIdx(t * 3 + 2);
      const w0 = vertToWelded[i0]!, w1 = vertToWelded[i1]!, w2 = vertToWelded[i2]!;
      const p0x = wPos[w0 * 3]!, p0y = wPos[w0 * 3 + 1]!, p0z = wPos[w0 * 3 + 2]!;
      const e1x = wPos[w1 * 3]! - p0x, e1y = wPos[w1 * 3 + 1]! - p0y, e1z = wPos[w1 * 3 + 2]! - p0z;
      const e2x = wPos[w2 * 3]! - p0x, e2y = wPos[w2 * 3 + 1]! - p0y, e2z = wPos[w2 * 3 + 2]! - p0z;
      let fnx = e1y * e2z - e1z * e2y;
      let fny = e1z * e2x - e1x * e2z;
      let fnz = e1x * e2y - e1y * e2x;
      if (origNormAttr) {
        const onx = origNormAttr.getX(i0) + origNormAttr.getX(i1) + origNormAttr.getX(i2);
        const ony = origNormAttr.getY(i0) + origNormAttr.getY(i1) + origNormAttr.getY(i2);
        const onz = origNormAttr.getZ(i0) + origNormAttr.getZ(i1) + origNormAttr.getZ(i2);
        if (fnx * onx + fny * ony + fnz * onz < 0) {
          fnx = -fnx; fny = -fny; fnz = -fnz;
        }
      }
      const area2 = Math.hypot(fnx, fny, fnz);

      for (const w of [w0, w1, w2]) {
        const w3 = w * 3;
        wNormals[w3]! += fnx;
        wNormals[w3 + 1]! += fny;
        wNormals[w3 + 2]! += fnz;
        wScalarArea[w]! += area2;
      }
    }

    const wWeight = new Float32Array(wCount);
    const wCoherence = new Float32Array(wCount);
    for (let w = 0; w < wCount; w++) {
      const w3 = w * 3;
      const vecLen = Math.hypot(wNormals[w3]!, wNormals[w3 + 1]!, wNormals[w3 + 2]!);
      const coh = wScalarArea[w]! > 1e-8 ? Math.min(1, vecLen / wScalarArea[w]!) : 1;
      wCoherence[w] = coh;
      wWeight[w] = Math.max(1e-5, vecLen * (coh ** 6));
      const inv = vecLen > 1e-8 ? 1 / vecLen : 1;
      wNormals[w3]! *= inv;
      wNormals[w3 + 1]! *= inv;
      wNormals[w3 + 2]! *= inv;
    }

    const cellMm = 4.0;
    const spatialCells = new Map<string, [number, number, number]>();
    for (let w = 0; w < wCount; w++) {
      const w3 = w * 3;
      const gx = Math.floor(wPos[w3]! / cellMm);
      const gy = Math.floor(wPos[w3 + 1]! / cellMm);
      const gz = Math.floor(wPos[w3 + 2]! / cellMm);
      const key = `${gx},${gy},${gz}`;
      const wt = wWeight[w]!;
      let cell = spatialCells.get(key);
      if (!cell) {
        cell = [0, 0, 0];
        spatialCells.set(key, cell);
      }
      cell[0] += wNormals[w3]! * wt;
      cell[1] += wNormals[w3 + 1]! * wt;
      cell[2] += wNormals[w3 + 2]! * wt;
    }

    for (let w = 0; w < wCount; w++) {
      const w3 = w * 3;
      const ux = wNormals[w3]!, uy = wNormals[w3 + 1]!, uz = wNormals[w3 + 2]!;
      const gx = Math.floor(wPos[w3]! / cellMm);
      const gy = Math.floor(wPos[w3 + 1]! / cellMm);
      const gz = Math.floor(wPos[w3 + 2]! / cellMm);
      let sx = 0, sy = 0, sz = 0;
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          for (let dz = -1; dz <= 1; dz++) {
            const cell = spatialCells.get(`${gx + dx},${gy + dy},${gz + dz}`);
            if (!cell) continue;
            const clen = Math.hypot(cell[0], cell[1], cell[2]);
            if (clen < 1e-8) continue;
            const dot = (ux * cell[0] + uy * cell[1] + uz * cell[2]) / clen;
            if (dot > 0.05 || wCoherence[w]! < 0.82) {
              const kernel = dx === 0 && dy === 0 && dz === 0 ? 1.0 : 0.5;
              sx += cell[0] * kernel;
              sy += cell[1] * kernel;
              sz += cell[2] * kernel;
            }
          }
        }
      }
      const sLen = Math.hypot(sx, sy, sz);
      if (sLen > 1e-8) {
        const spatialAlpha = wCoherence[w]! < 0.88 ? 0.92 : 0.45;
        const nx = (1 - spatialAlpha) * ux + spatialAlpha * (sx / sLen);
        const ny = (1 - spatialAlpha) * uy + spatialAlpha * (sy / sLen);
        const nz = (1 - spatialAlpha) * uz + spatialAlpha * (sz / sLen);
        const len = Math.hypot(nx, ny, nz) || 1;
        curr[w3] = nx / len;
        curr[w3 + 1] = ny / len;
        curr[w3 + 2] = nz / len;
      } else {
        curr[w3] = ux;
        curr[w3 + 1] = uy;
        curr[w3 + 2] = uz;
      }
    }

    let next = new Float32Array(wCount * 3);
    for (let iter = 0; iter < iterations; iter++) {
      for (let w = 0; w < wCount; w++) {
        const start = offsets[w]!, end = offsets[w + 1]!;
        const deg = end - start;
        const w3 = w * 3;
        if (deg === 0) {
          next[w3] = curr[w3]!;
          next[w3 + 1] = curr[w3 + 1]!;
          next[w3 + 2] = curr[w3 + 2]!;
          continue;
        }
        let sx = 0, sy = 0, sz = 0, wSum = 0;
        for (let ptr = start; ptr < end; ptr++) {
          const nb = neighbors[ptr]!;
          const nb3 = nb * 3;
          const nw = Math.sqrt(wWeight[nb]!);
          sx += curr[nb3]! * nw;
          sy += curr[nb3 + 1]! * nw;
          sz += curr[nb3 + 2]! * nw;
          wSum += nw;
        }
        const invW = wSum > 1e-8 ? 0.70 / wSum : 0;
        let nx = 0.30 * curr[w3]! + sx * invW;
        let ny = 0.30 * curr[w3 + 1]! + sy * invW;
        let nz = 0.30 * curr[w3 + 2]! + sz * invW;
        const len = Math.hypot(nx, ny, nz) || 1;
        next[w3] = nx / len;
        next[w3 + 1] = ny / len;
        next[w3 + 2] = nz / len;
      }
      const swap = curr;
      curr = next;
      next = swap;
    }
  }

  // 4. Write welded & smoothed normals back to all mesh vertices
  const outNormals = new Float32Array(vCount * 3);
  for (let i = 0; i < vCount; i++) {
    const w3 = vertToWelded[i]! * 3;
    const i3 = i * 3;
    outNormals[i3] = curr[w3]!;
    outNormals[i3 + 1] = curr[w3 + 1]!;
    outNormals[i3 + 2] = curr[w3 + 2]!;
  }
  geometry.setAttribute("normal", new THREE.Float32BufferAttribute(outNormals, 3));
}

/**
 * Refine coarse 3D organ meshes (< 8,000 vertices, such as spleen, stomach, pancreas, small_bowel)
 * using 1 pass of crack-free Curved Phong / PN-Triangle 1-to-4 subdivision followed by welded
 * Taubin + Laplacian normal fairing, eliminating polygonal silhouettes and facet highlights.
 */
export function refineCoarseOrganGeometry(
  sourceGeometry: THREE.BufferGeometry,
  maxVerticesForSubdivision = 8000,
): THREE.BufferGeometry {
  const posAttr = sourceGeometry.getAttribute("position");
  if (!posAttr || posAttr.count < 3) return sourceGeometry.clone();

  const base = sourceGeometry.clone();
  if (posAttr.count >= maxVerticesForSubdivision) {
    computeSeamlessSmoothOrganNormals(base, 24, true);
    return base;
  }

  // First compute welded smooth normals on the base mesh for Phong midpoint lifting
  computeSeamlessSmoothOrganNormals(base, 10, false);
  const bPos = base.getAttribute("position");
  const bNorm = base.getAttribute("normal");
  const indexAttr = base.getIndex();
  const triCount = indexAttr ? Math.floor(indexAttr.count / 3) : Math.floor(bPos.count / 3);
  const getIdx = (k: number) => (indexAttr ? indexAttr.getX(k) : k);

  // Map vertices to 0.02 mm welded keys so shared edges across UV/material seams share the exact midpoint
  const weldMap = new Map<string, number>();
  const vertWeldId = new Int32Array(bPos.count);
  let nextWeldId = 0;
  for (let i = 0; i < bPos.count; i++) {
    const key = `${Math.round(bPos.getX(i) * 50)},${Math.round(bPos.getY(i) * 50)},${Math.round(bPos.getZ(i) * 50)}`;
    let wid = weldMap.get(key);
    if (wid === undefined) {
      wid = nextWeldId++;
      weldMap.set(key, wid);
    }
    vertWeldId[i] = wid;
  }

  const outPositions: number[] = [];
  for (let i = 0; i < bPos.count; i++) {
    outPositions.push(bPos.getX(i), bPos.getY(i), bPos.getZ(i));
  }

  const edgeMidpointMap = new Map<string, number>();
  const getCurvedMidpoint = (iA: number, iB: number): number => {
    const wA = vertWeldId[iA]!, wB = vertWeldId[iB]!;
    const eKey = wA < wB ? `${wA}:${wB}` : `${wB}:${wA}`;
    const existing = edgeMidpointMap.get(eKey);
    if (existing !== undefined) return existing;

    const ax = bPos.getX(iA), ay = bPos.getY(iA), az = bPos.getZ(iA);
    const bx = bPos.getX(iB), by = bPos.getY(iB), bz = bPos.getZ(iB);
    const nax = bNorm.getX(iA), nay = bNorm.getY(iA), naz = bNorm.getZ(iA);
    const nbx = bNorm.getX(iB), nby = bNorm.getY(iB), nbz = bNorm.getZ(iB);

    const dx = bx - ax, dy = by - ay, dz = bz - az;
    const dotA = dx * nax + dy * nay + dz * naz;
    const dotB = -dx * nbx - dy * nby - dz * nbz;

    // Phong tessellation lift (~0.11 factor keeps curved silhouettes smooth and overshoot-free)
    const mx = 0.5 * (ax + bx) - 0.11 * (dotA * nax + dotB * nbx);
    const my = 0.5 * (ay + by) - 0.11 * (dotA * nay + dotB * nby);
    const mz = 0.5 * (az + bz) - 0.11 * (dotA * naz + dotB * nbz);

    const midIdx = outPositions.length / 3;
    outPositions.push(mx, my, mz);
    edgeMidpointMap.set(eKey, midIdx);
    return midIdx;
  };

  const outIndices = new Uint32Array(triCount * 12);
  let ptr = 0;
  for (let t = 0; t < triCount; t++) {
    const i0 = getIdx(t * 3), i1 = getIdx(t * 3 + 1), i2 = getIdx(t * 3 + 2);
    const m01 = getCurvedMidpoint(i0, i1);
    const m12 = getCurvedMidpoint(i1, i2);
    const m20 = getCurvedMidpoint(i2, i0);

    outIndices[ptr++] = i0;  outIndices[ptr++] = m01; outIndices[ptr++] = m20;
    outIndices[ptr++] = i1;  outIndices[ptr++] = m12; outIndices[ptr++] = m01;
    outIndices[ptr++] = i2;  outIndices[ptr++] = m20; outIndices[ptr++] = m12;
    outIndices[ptr++] = m01; outIndices[ptr++] = m12; outIndices[ptr++] = m20;
  }

  base.dispose();
  const refined = new THREE.BufferGeometry();
  refined.setAttribute("position", new THREE.Float32BufferAttribute(outPositions, 3));
  refined.setAttribute("uv", new THREE.Float32BufferAttribute(new Float32Array((outPositions.length / 3) * 2), 2));
  refined.setIndex(new THREE.BufferAttribute(outIndices, 1));
  computeSeamlessSmoothOrganNormals(refined, 14, true);
  refined.computeBoundingSphere();
  refined.computeBoundingBox();
  return refined;
}

/**
 * Unwrap a 3D organ mesh into a non-overlapping 6-chart dominant-normal UV atlas
 * arranged in a 3×2 grid with padded gutters. Seam vertices between charts are
 * split in UV space while retaining identical 3D positions and smooth normals.
 */
export function unwrapOrganMeshToAtlas(sourceGeometry: THREE.BufferGeometry, gutterMargin = 0.06): UnwrappedOrganMesh {
  const posAttr = sourceGeometry.getAttribute("position");
  if (!posAttr || posAttr.count < 3) throw new Error("Organ mesh has no valid triangles");
  const smoothed = sourceGeometry.clone();
  computeSeamlessSmoothOrganNormals(smoothed, 10);
  const normAttr = smoothed.getAttribute("normal");

  const indexAttr = sourceGeometry.getIndex();
  const triCount = indexAttr ? Math.floor(indexAttr.count / 3) : Math.floor(posAttr.count / 3);
  if (triCount < 1) throw new Error("Organ mesh contains zero triangles");

  const chartOfTriangle = new Uint8Array(triCount);
  const chartTriCounts = new Uint32Array(6);

  const minU = new Float64Array(6).fill(Infinity);
  const maxU = new Float64Array(6).fill(-Infinity);
  const minV = new Float64Array(6).fill(Infinity);
  const maxV = new Float64Array(6).fill(-Infinity);

  const getIndex = (i: number) => (indexAttr ? indexAttr.getX(i) : i);

  for (let t = 0; t < triCount; t++) {
    const i0 = getIndex(t * 3), i1 = getIndex(t * 3 + 1), i2 = getIndex(t * 3 + 2);
    const nx = normAttr.getX(i0) + normAttr.getX(i1) + normAttr.getX(i2);
    const ny = normAttr.getY(i0) + normAttr.getY(i1) + normAttr.getY(i2);
    const nz = normAttr.getZ(i0) + normAttr.getZ(i1) + normAttr.getZ(i2);
    const c = dominantChartIndex(nx, ny, nz);
    chartOfTriangle[t] = c;
    chartTriCounts[c]! += 1;

    const { uAxis, vAxis } = chartAxes(c);
    for (const vIdx of [i0, i1, i2]) {
      const px = posAttr.getX(vIdx), py = posAttr.getY(vIdx), pz = posAttr.getZ(vIdx);
      const u = px * uAxis[0] + py * uAxis[1] + pz * uAxis[2];
      const v = px * vAxis[0] + py * vAxis[1] + pz * vAxis[2];
      if (u < minU[c]!) minU[c] = u;
      if (u > maxU[c]!) maxU[c] = u;
      if (v < minV[c]!) minV[c] = v;
      if (v > maxV[c]!) maxV[c] = v;
    }
  }

  const pairToNewIndex = new Map<number, number>();
  const outPositions: number[] = [];
  const outNormals: number[] = [];
  const outTangents: number[] = [];
  const outUvs: number[] = [];
  const outIndices = new Uint32Array(triCount * 3);

  const cellW = 1 / 3;
  const cellH = 1 / 2;
  const padU = cellW * gutterMargin;
  const padV = cellH * gutterMargin;
  const innerW = cellW - 2 * padU;
  const innerH = cellH - 2 * padV;

  const charts: OrganChartBounds[] = [];
  for (let c = 0; c < 6; c++) {
    const col = c % 3, row = Math.floor(c / 3);
    const u0 = col * cellW + padU;
    const v0 = row * cellH + padV;
    charts.push({
      chartIndex: c,
      label: CHART_LABELS[c]!,
      uMin: u0,
      vMin: v0,
      uMax: u0 + innerW,
      vMax: v0 + innerH,
      triangleCount: chartTriCounts[c]!,
    });
  }

  const origVertexToSplitVertices = new Map<number, number[]>();

  for (let t = 0; t < triCount; t++) {
    const c = chartOfTriangle[t]!;
    const { uAxis, vAxis } = chartAxes(c);
    const col = c % 3, row = Math.floor(c / 3);
    const u0 = col * cellW + padU;
    const v0 = row * cellH + padV;
    const spanU = Math.max(1e-5, maxU[c]! - minU[c]!);
    const spanV = Math.max(1e-5, maxV[c]! - minV[c]!);

    for (let k = 0; k < 3; k++) {
      const origIdx = getIndex(t * 3 + k);
      const key = origIdx * 8 + c;
      let newIdx = pairToNewIndex.get(key);
      if (newIdx === undefined) {
        newIdx = outPositions.length / 3;
        pairToNewIndex.set(key, newIdx);

        const px = posAttr.getX(origIdx), py = posAttr.getY(origIdx), pz = posAttr.getZ(origIdx);
        const nx = normAttr.getX(origIdx), ny = normAttr.getY(origIdx), nz = normAttr.getZ(origIdx);
        outPositions.push(px, py, pz);
        outNormals.push(nx, ny, nz);

        const dotUN = uAxis[0] * nx + uAxis[1] * ny + uAxis[2] * nz;
        let tx = uAxis[0] - dotUN * nx;
        let ty = uAxis[1] - dotUN * ny;
        let tz = uAxis[2] - dotUN * nz;
        const tLen = Math.hypot(tx, ty, tz) || 1;
        tx /= tLen; ty /= tLen; tz /= tLen;
        outTangents.push(tx, ty, tz, 1);

        const rawU = px * uAxis[0] + py * uAxis[1] + pz * uAxis[2];
        const rawV = px * vAxis[0] + py * vAxis[1] + pz * vAxis[2];
        const normU = (rawU - minU[c]!) / spanU;
        const normV = (rawV - minV[c]!) / spanV;
        outUvs.push(u0 + normU * innerW, v0 + normV * innerH);

        let splits = origVertexToSplitVertices.get(origIdx);
        if (!splits) {
          splits = [];
          origVertexToSplitVertices.set(origIdx, splits);
        }
        splits.push(newIdx);
      }
      outIndices[t * 3 + k] = newIdx;
    }
  }

  const crossChartSeamEdges: [number, number][] = [];
  for (const splits of origVertexToSplitVertices.values()) {
    if (splits.length > 1) {
      for (let i = 1; i < splits.length; i++) {
        crossChartSeamEdges.push([splits[0]!, splits[i]!]);
      }
    }
  }

  smoothed.dispose();
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(outPositions, 3));
  geometry.setAttribute("normal", new THREE.Float32BufferAttribute(outNormals, 3));
  geometry.setAttribute("tangent", new THREE.Float32BufferAttribute(outTangents, 4));
  geometry.setAttribute("uv", new THREE.Float32BufferAttribute(outUvs, 2));
  geometry.setIndex(new THREE.BufferAttribute(outIndices, 1));
  geometry.computeBoundingSphere();
  geometry.computeBoundingBox();

  return {
    geometry,
    charts,
    chartOfTriangle,
    vertexCount: outPositions.length / 3,
    triangleCount: triCount,
    crossChartSeamEdges,
  };
}

/**
 * Evaluate the seamless, sign-free, multi-octave rotated 3D surface appearance, normal,
 * and roughness at a 3D rest-space point (px, py, pz) mm and smooth outward normal (nx, ny, nz).
 * Uses continuous coordinates (no discontinuous normal-sign flips) and 2 incommensurate
 * rotated octaves per projection axis so there are zero seams and zero lattice repetitions.
 */
export function evaluateSeamlessOrganPoint(
  px: number,
  py: number,
  pz: number,
  nx: number,
  ny: number,
  nz: number,
  tile: RgbaImage,
  tileMeanSrgb: readonly [number, number, number],
  options: {
    tileScaleMm: number;
    blendSharpness: number;
    variancePreserving: boolean;
    normalMap?: RgbaImage;
    roughnessMap?: RgbaImage;
    wetness?: number;
  },
): {
  rgb: [number, number, number];
  worldNormal: [number, number, number];
  roughness: number;
} {
  const nLen = Math.hypot(nx, ny, nz) || 1;
  const ux = nx / nLen, uy = ny / nLen, uz = nz / nLen;
  const p = Math.max(1, Math.min(16, options.blendSharpness));
  const wxRaw = Math.abs(ux) ** p;
  const wyRaw = Math.abs(uy) ** p;
  const wzRaw = Math.abs(uz) ** p;
  const wSum = Math.max(1e-8, wxRaw + wyRaw + wzRaw);
  const wx = wxRaw / wSum, wy = wyRaw / wSum, wz = wzRaw / wSum;
  const wNorm = options.variancePreserving ? Math.max(0.58, Math.hypot(wx, wy, wz)) : 1;

  const scale = Math.max(5, options.tileScaleMm);
  const x = px / scale, y = py / scale, z = pz / scale;

  // Continuous, sign-free rotated planar coordinates (no step(0, n) mirror seam!)
  // Plane X (YZ), Plane Y (XZ), Plane Z (XY) with incommensurate angles and golden-ratio offsets
  const uvX1_u = 0.9659258 * z - 0.2588190 * y + 0.173;
  const uvX1_v = 0.2588190 * z + 0.9659258 * y + 0.618;
  const uvX2_u = (0.5000000 * z + 0.8660254 * y) * 0.618034 + 0.419;
  const uvX2_v = (-0.8660254 * z + 0.5000000 * y) * 0.618034 + 0.831;

  const uvY1_u = 0.8660254 * x + 0.5000000 * z + 0.382;
  const uvY1_v = -0.5000000 * x + 0.8660254 * z + 0.236;
  const uvY2_u = (0.2588190 * x - 0.9659258 * z) * 0.618034 + 0.712;
  const uvY2_v = (0.9659258 * x + 0.2588190 * z) * 0.618034 + 0.194;

  const uvZ1_u = 0.9396926 * x - 0.3420201 * y + 0.754;
  const uvZ1_v = 0.3420201 * x + 0.9396926 * y + 0.569;
  const uvZ2_u = (0.3420201 * x + 0.9396926 * y) * 0.618034 + 0.291;
  const uvZ2_v = (-0.9396926 * x + 0.3420201 * y) * 0.618034 + 0.647;

  const sampleAperiodic = (img: RgbaImage, u1: number, v1: number, u2: number, v2: number, mean: readonly [number, number, number]) => {
    const s1 = samplePeriodicBilinear(img, u1, v1);
    const s2 = samplePeriodicBilinear(img, u2, v2);
    // Blend 70% primary + 30% rotated secondary octave with L2 variance preservation (sqrt(0.7^2 + 0.3^2) = 0.761577)
    const invOctaveNorm = 1 / 0.7615773;
    return [
      mean[0] + (0.7 * (s1[0] - mean[0]) + 0.3 * (s2[0] - mean[0])) * invOctaveNorm,
      mean[1] + (0.7 * (s1[1] - mean[1]) + 0.3 * (s2[1] - mean[1])) * invOctaveNorm,
      mean[2] + (0.7 * (s1[2] - mean[2]) + 0.3 * (s2[2] - mean[2])) * invOctaveNorm,
    ] as [number, number, number];
  };

  const cX = sampleAperiodic(tile, uvX1_u, uvX1_v, uvX2_u, uvX2_v, tileMeanSrgb);
  const cY = sampleAperiodic(tile, uvY1_u, uvY1_v, uvY2_u, uvY2_v, tileMeanSrgb);
  const cZ = sampleAperiodic(tile, uvZ1_u, uvZ1_v, uvZ2_u, uvZ2_v, tileMeanSrgb);

  const blendR = wx * cX[0] + wy * cY[0] + wz * cZ[0];
  const blendG = wx * cX[1] + wy * cY[1] + wz * cZ[1];
  const blendB = wx * cX[2] + wy * cY[2] + wz * cZ[2];

  const r = clamp01(tileMeanSrgb[0] + (blendR - tileMeanSrgb[0]) / wNorm);
  const g = clamp01(tileMeanSrgb[1] + (blendG - tileMeanSrgb[1]) / wNorm);
  const b = clamp01(tileMeanSrgb[2] + (blendB - tileMeanSrgb[2]) / wNorm);

  let wnx = ux, wny = uy, wnz = uz;
  if (options.normalMap) {
    const nX = samplePeriodicBilinear(options.normalMap, uvX1_u, uvX1_v);
    const nY = samplePeriodicBilinear(options.normalMap, uvY1_u, uvY1_v);
    const nZ = samplePeriodicBilinear(options.normalMap, uvZ1_u, uvZ1_v);
    const ax = nX[0] * 2 - 1, ay = nX[1] * 2 - 1, az = Math.max(0.1, nX[2] * 2 - 1);
    const bx = nY[0] * 2 - 1, by = nY[1] * 2 - 1, bz = Math.max(0.1, nY[2] * 2 - 1);
    const cx = nZ[0] * 2 - 1, cy = nZ[1] * 2 - 1, cz = Math.max(0.1, nZ[2] * 2 - 1);

    const gx = (wy / bz) * bx + (wz / cz) * cx;
    const gy = (wx / az) * ay + (wz / cz) * cy;
    const gz = (wx / az) * ax + (wy / bz) * by;
    const dotNG = ux * gx + uy * gy + uz * gz;
    const gain = 0.55 / wNorm;
    wnx = ux + gain * (gx - ux * dotNG);
    wny = uy + gain * (gy - uy * dotNG);
    wnz = uz + gain * (gz - uz * dotNG);
    const wnLen = Math.hypot(wnx, wny, wnz) || 1;
    wnx /= wnLen; wny /= wnLen; wnz /= wnLen;
  }

  let roughness = 0.34;
  if (options.roughnessMap) {
    const rX = samplePeriodicBilinear(options.roughnessMap, uvX1_u, uvX1_v)[0];
    const rY = samplePeriodicBilinear(options.roughnessMap, uvY1_u, uvY1_v)[0];
    const rZ = samplePeriodicBilinear(options.roughnessMap, uvZ1_u, uvZ1_v)[0];
    roughness = wx * rX + wy * rY + wz * rZ;
  }
  const wet = clamp01(options.wetness ?? 0.6);
  roughness = Math.max(0.075, Math.min(0.85, roughness * (1 - 0.52 * wet)));

  return {
    rgb: [r, g, b],
    worldNormal: [wnx, wny, wnz],
    roughness,
  };
}

function dilateAtlasGutters(
  albedo: Uint8ClampedArray,
  normal: Uint8ClampedArray,
  roughness: Uint8ClampedArray,
  occupied: Uint8Array,
  size: number,
  passes = 6,
  fallbackRgb: readonly [number, number, number] = [0.55, 0.32, 0.30],
  fallbackRoughness = 0.28,
) {
  const nextOccupied = new Uint8Array(occupied);
  const dirs = [
    [-1, 0], [1, 0], [0, -1], [0, 1],
    [-1, -1], [1, -1], [-1, 1], [1, 1],
  ] as const;

  for (let pass = 0; pass < passes; pass++) {
    const newlyFilled: number[] = [];
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const idx = y * size + x;
        if (occupied[idx]) continue;
        let rSum = 0, gSum = 0, bSum = 0;
        let nxSum = 0, nySum = 0, nzSum = 0;
        let roughSum = 0, count = 0;
        for (const [dx, dy] of dirs) {
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || nx >= size || ny < 0 || ny >= size) continue;
          const nIdx = ny * size + nx;
          if (!occupied[nIdx]) continue;
          const p4 = nIdx * 4;
          rSum += albedo[p4]!;
          gSum += albedo[p4 + 1]!;
          bSum += albedo[p4 + 2]!;
          nxSum += normal[p4]!;
          nySum += normal[p4 + 1]!;
          nzSum += normal[p4 + 2]!;
          roughSum += roughness[p4 + 1]!;
          count++;
        }
        if (count > 0) {
          const out4 = idx * 4;
          albedo[out4] = Math.round(rSum / count);
          albedo[out4 + 1] = Math.round(gSum / count);
          albedo[out4 + 2] = Math.round(bSum / count);
          albedo[out4 + 3] = 255;

          normal[out4] = Math.round(nxSum / count);
          normal[out4 + 1] = Math.round(nySum / count);
          normal[out4 + 2] = Math.round(nzSum / count);
          normal[out4 + 3] = 255;

          const rByte = Math.round(roughSum / count);
          roughness[out4] = 255;
          roughness[out4 + 1] = rByte;
          roughness[out4 + 2] = 0;
          roughness[out4 + 3] = 255;

          nextOccupied[idx] = 1;
          newlyFilled.push(idx);
        }
      }
    }
    if (!newlyFilled.length) break;
    for (const idx of newlyFilled) occupied[idx] = nextOccupied[idx]!;
  }

  const fr = Math.round(clamp01(fallbackRgb[0]) * 255);
  const fg = Math.round(clamp01(fallbackRgb[1]) * 255);
  const fb = Math.round(clamp01(fallbackRgb[2]) * 255);
  const fRough = Math.round(clamp01(fallbackRoughness) * 255);

  for (let i = 0; i < size * size; i++) {
    if (occupied[i]) continue;
    const p4 = i * 4;
    albedo[p4] = fr;
    albedo[p4 + 1] = fg;
    albedo[p4 + 2] = fb;
    albedo[p4 + 3] = 255;

    normal[p4] = 128;
    normal[p4 + 1] = 128;
    normal[p4 + 2] = 255;
    normal[p4 + 3] = 255;

    roughness[p4] = 255;
    roughness[p4 + 1] = fRough;
    roughness[p4 + 2] = 0;
    roughness[p4 + 3] = 255;
  }
}

function makeRepeatDataTexture(img: RgbaImage, colorSpace: THREE.ColorSpace): THREE.DataTexture {
  const tw = img.width, th = img.height;
  const flip = new Uint8Array(tw * th * 4);
  for (let y = 0; y < th; y++) {
    const srcRow = y * tw * 4;
    const dstRow = (th - 1 - y) * tw * 4;
    flip.set(img.data.subarray(srcRow, srcRow + tw * 4), dstRow);
  }
  const tex = new THREE.DataTexture(flip, tw, th, THREE.RGBAFormat);
  tex.colorSpace = colorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  return tex;
}

/**
 * Unwrap a 3D organ mesh and bake a learned tile seamlessly onto the 3D organ surface,
 * producing both GPU-ready homogenized seamless textures (albedo, normal, roughness)
 * and a 6-chart UV-unwrapped atlas with Voronoi gutter dilation.
 */
export function bakeOrganMeshTextures(
  organ: string,
  surface: Pick<OrganSurface, "geometry">,
  sources: OrganBakeSourceMaps,
  options: OrganBakeOptions = {},
): OrganMeshBakeResult {
  const atlasResolution = options.atlasResolution ?? 256;
  if (!Number.isInteger(atlasResolution) || atlasResolution < 64 || atlasResolution > 2048) {
    throw new RangeError("Atlas resolution must be an integer between 64 and 2048");
  }
  const tileScaleMm = options.tileScaleMm ?? 51.2;
  if (!Number.isFinite(tileScaleMm) || tileScaleMm < 10 || tileScaleMm > 300) {
    throw new RangeError("Tile scale must be between 10 and 300 mm");
  }
  const blendSharpness = options.blendSharpness ?? 6;
  if (!Number.isFinite(blendSharpness) || blendSharpness < 1 || blendSharpness > 16) {
    throw new RangeError("Blend sharpness must be between 1 and 16");
  }
  const variancePreserving = options.variancePreserving ?? true;

  // 1. Synthesize intrinsic, macro-trench-free seamless tile + micro-relief normal & roughness
  const {
    image: seamlessTile,
    normal: seamlessNormal,
    roughness: seamlessRoughness,
    meanSrgb,
    meanLinear,
  } = synthesizeSeamlessOrganTile(sources.substrate, {
    vessels: options.vessels,
    fascia: options.fascia,
    adipose: options.adipose,
    wetness: options.wetness,
    vesselsMap: sources.vessels,
    fasciaMap: sources.fascia,
    adiposeMap: sources.adipose,
  });

  // 2. Unwrap 3D organ mesh into 6-chart non-overlapping UV atlas
  const unwrapped = unwrapOrganMeshToAtlas(surface.geometry);
  const posAttr = unwrapped.geometry.getAttribute("position");
  const normAttr = unwrapped.geometry.getAttribute("normal");
  const uvAttr = unwrapped.geometry.getAttribute("uv");
  const indexAttr = unwrapped.geometry.getIndex()!;

  const size = atlasResolution;
  const albedoData = new Uint8ClampedArray(size * size * 4);
  const normalData = new Uint8ClampedArray(size * size * 4);
  const roughnessData = new Uint8ClampedArray(size * size * 4);
  const occupied = new Uint8Array(size * size);

  const writeTexel = (
    tx: number,
    ty: number,
    px: number,
    py: number,
    pz: number,
    nx: number,
    ny: number,
    nz: number,
    chart: number,
  ) => {
    if (tx < 0 || tx >= size || ty < 0 || ty >= size) return;
    const idx = ty * size + tx;
    if (occupied[idx]) return;
    occupied[idx] = 1;

    const sample = evaluateSeamlessOrganPoint(px, py, pz, nx, ny, nz, seamlessTile, meanSrgb, {
      tileScaleMm,
      blendSharpness,
      variancePreserving,
      normalMap: seamlessNormal,
      roughnessMap: seamlessRoughness,
      ...(options.wetness !== undefined ? { wetness: options.wetness } : {}),
    });

    const p4 = idx * 4;
    albedoData[p4] = Math.round(sample.rgb[0] * 255);
    albedoData[p4 + 1] = Math.round(sample.rgb[1] * 255);
    albedoData[p4 + 2] = Math.round(sample.rgb[2] * 255);
    albedoData[p4 + 3] = 255;

    const { uAxis, vAxis } = chartAxes(chart);
    const [wnx, wny, wnz] = sample.worldNormal;
    const nLen = Math.hypot(nx, ny, nz) || 1;
    const snx = nx / nLen, sny = ny / nLen, snz = nz / nLen;
    const tU = wnx * uAxis[0] + wny * uAxis[1] + wnz * uAxis[2];
    const tV = wnx * vAxis[0] + wny * vAxis[1] + wnz * vAxis[2];
    const tN = Math.max(0.1, wnx * snx + wny * sny + wnz * snz);
    const tLen = Math.hypot(tU, tV, tN) || 1;

    normalData[p4] = Math.round(((tU / tLen) * 0.5 + 0.5) * 255);
    normalData[p4 + 1] = Math.round(((tV / tLen) * 0.5 + 0.5) * 255);
    normalData[p4 + 2] = Math.round(((tN / tLen) * 0.5 + 0.5) * 255);
    normalData[p4 + 3] = 255;

    const rByte = Math.round(sample.roughness * 255);
    roughnessData[p4] = 255;
    roughnessData[p4 + 1] = rByte;
    roughnessData[p4 + 2] = 0;
    roughnessData[p4 + 3] = 255;
  };

  for (let t = 0; t < unwrapped.triangleCount; t++) {
    const i0 = indexAttr.getX(t * 3);
    const i1 = indexAttr.getX(t * 3 + 1);
    const i2 = indexAttr.getX(t * 3 + 2);
    const chart = unwrapped.chartOfTriangle[t]!;

    const u0 = uvAttr.getX(i0) * size - 0.5, v0 = (1 - uvAttr.getY(i0)) * size - 0.5;
    const u1 = uvAttr.getX(i1) * size - 0.5, v1 = (1 - uvAttr.getY(i1)) * size - 0.5;
    const u2 = uvAttr.getX(i2) * size - 0.5, v2 = (1 - uvAttr.getY(i2)) * size - 0.5;

    const p0x = posAttr.getX(i0), p0y = posAttr.getY(i0), p0z = posAttr.getZ(i0);
    const p1x = posAttr.getX(i1), p1y = posAttr.getY(i1), p1z = posAttr.getZ(i1);
    const p2x = posAttr.getX(i2), p2y = posAttr.getY(i2), p2z = posAttr.getZ(i2);

    const n0x = normAttr.getX(i0), n0y = normAttr.getY(i0), n0z = normAttr.getZ(i0);
    const n1x = normAttr.getX(i1), n1y = normAttr.getY(i1), n1z = normAttr.getZ(i1);
    const n2x = normAttr.getX(i2), n2y = normAttr.getY(i2), n2z = normAttr.getZ(i2);

    writeTexel(Math.round(u0), Math.round(v0), p0x, p0y, p0z, n0x, n0y, n0z, chart);
    writeTexel(Math.round(u1), Math.round(v1), p1x, p1y, p1z, n1x, n1y, n1z, chart);
    writeTexel(Math.round(u2), Math.round(v2), p2x, p2y, p2z, n2x, n2y, n2z, chart);
    writeTexel(
      Math.round((u0 + u1 + u2) / 3),
      Math.round((v0 + v1 + v2) / 3),
      (p0x + p1x + p2x) / 3,
      (p0y + p1y + p2y) / 3,
      (p0z + p1z + p2z) / 3,
      (n0x + n1x + n2x) / 3,
      (n0y + n1y + n2y) / 3,
      (n0z + n1z + n2z) / 3,
      chart,
    );

    const minX = Math.max(0, Math.floor(Math.min(u0, u1, u2)));
    const maxX = Math.min(size - 1, Math.ceil(Math.max(u0, u1, u2)));
    const minY = Math.max(0, Math.floor(Math.min(v0, v1, v2)));
    const maxY = Math.min(size - 1, Math.ceil(Math.max(v0, v1, v2)));

    const denom = (v1 - v2) * (u0 - u2) + (u2 - u1) * (v0 - v2);
    if (Math.abs(denom) < 1e-6) continue;
    const invDenom = 1 / denom;

    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        if (occupied[y * size + x]) continue;
        const w0 = ((v1 - v2) * (x - u2) + (u2 - u1) * (y - v2)) * invDenom;
        const w1 = ((v2 - v0) * (x - u2) + (u0 - u2) * (y - v2)) * invDenom;
        const w2 = 1 - w0 - w1;
        if (w0 < -0.05 || w1 < -0.05 || w2 < -0.05) continue;
        const cw0 = Math.max(0, w0), cw1 = Math.max(0, w1), cw2 = Math.max(0, w2);
        const wSum = cw0 + cw1 + cw2 || 1;
        const b0 = cw0 / wSum, b1 = cw1 / wSum, b2 = cw2 / wSum;

        writeTexel(
          x,
          y,
          b0 * p0x + b1 * p1x + b2 * p2x,
          b0 * p0y + b1 * p1y + b2 * p2y,
          b0 * p0z + b1 * p1z + b2 * p2z,
          b0 * n0x + b1 * n1x + b2 * n2x,
          b0 * n0y + b1 * n1y + b2 * n2y,
          b0 * n0z + b1 * n1z + b2 * n2z,
          chart,
        );
      }
    }
  }

  dilateAtlasGutters(albedoData, normalData, roughnessData, occupied, size, 6, meanSrgb, 0.28);

  let coveredCount = 0;
  for (let i = 0; i < occupied.length; i++) if (occupied[i]) coveredCount++;

  let seamDiffSum = 0;
  const seamPairs = unwrapped.crossChartSeamEdges;
  const sampleLimit = Math.min(seamPairs.length, 128);
  for (let s = 0; s < sampleLimit; s++) {
    const [va, vb] = seamPairs[s]!;
    const aEval = evaluateSeamlessOrganPoint(
      posAttr.getX(va), posAttr.getY(va), posAttr.getZ(va),
      normAttr.getX(va), normAttr.getY(va), normAttr.getZ(va),
      seamlessTile, meanSrgb, { tileScaleMm, blendSharpness, variancePreserving },
    );
    const bEval = evaluateSeamlessOrganPoint(
      posAttr.getX(vb), posAttr.getY(vb), posAttr.getZ(vb),
      normAttr.getX(vb), normAttr.getY(vb), normAttr.getZ(vb),
      seamlessTile, meanSrgb, { tileScaleMm, blendSharpness, variancePreserving },
    );
    seamDiffSum += (
      Math.abs(aEval.rgb[0] - bEval.rgb[0]) +
      Math.abs(aEval.rgb[1] - bEval.rgb[1]) +
      Math.abs(aEval.rgb[2] - bEval.rgb[2])
    ) / 3;
  }
  const seamContinuity = sampleLimit > 0 ? Math.max(0, 1 - seamDiffSum / sampleLimit) : 1;

  const seamlessTileTexture = makeRepeatDataTexture(seamlessTile, THREE.SRGBColorSpace);
  const seamlessNormalTexture = makeRepeatDataTexture(seamlessNormal, THREE.NoColorSpace);
  const seamlessRoughnessTexture = makeRepeatDataTexture(seamlessRoughness, THREE.NoColorSpace);

  return {
    organ,
    unwrapped,
    seamlessTile,
    seamlessNormal,
    seamlessRoughness,
    seamlessTileTexture,
    seamlessNormalTexture,
    seamlessRoughnessTexture,
    albedoAtlas: { width: size, height: size, data: albedoData },
    normalAtlas: { width: size, height: size, data: normalData },
    roughnessAtlas: { width: size, height: size, data: roughnessData },
    metrics: {
      schema: ORGAN_BAKE_SCHEMA,
      organ,
      atlasResolution: size,
      tileScaleMm,
      blendSharpness,
      variancePreserving,
      chartCount: 6,
      vertexCount: unwrapped.vertexCount,
      triangleCount: unwrapped.triangleCount,
      coverageFraction: Number((coveredCount / (size * size)).toFixed(4)),
      seamContinuity: Number(seamContinuity.toFixed(6)),
      crossChartEdgeCount: seamPairs.length,
      meanColorLinear: [
        Number(meanLinear[0].toFixed(4)),
        Number(meanLinear[1].toFixed(4)),
        Number(meanLinear[2].toFixed(4)),
      ],
      meanColorSrgb: [
        Number(meanSrgb[0].toFixed(4)),
        Number(meanSrgb[1].toFixed(4)),
        Number(meanSrgb[2].toFixed(4)),
      ],
    },
    dispose: () => {
      unwrapped.geometry.dispose();
      seamlessTileTexture.dispose();
      seamlessNormalTexture.dispose();
      seamlessRoughnessTexture.dispose();
    },
  };
}

function rgbaImageToCanvas(img: RgbaImage): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = img.width;
  canvas.height = img.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2D canvas context unavailable");
  const clamped = new Uint8ClampedArray(img.data.length);
  clamped.set(img.data);
  ctx.putImageData(new ImageData(clamped, img.width, img.height), 0, 0);
  return canvas;
}

/** Convert an RgbaImage to a PNG data URL in the browser. */
export function rgbaImageToDataUrl(img: RgbaImage): string {
  return rgbaImageToCanvas(img).toDataURL("image/png");
}

/** Extract an RgbaImage from a loaded HTMLImageElement, HTMLCanvasElement, or ImageBitmap. */
export function extractRgbaFromTexture(texture: THREE.Texture, maxSide = 512): RgbaImage {
  if (texture instanceof THREE.DataTexture && texture.image?.data) {
    const w = texture.image.width, h = texture.image.height;
    const raw = texture.image.data as Uint8Array | Uint8ClampedArray;
    const out = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) {
      const srcRow = (h - 1 - y) * w * 4;
      const dstRow = y * w * 4;
      for (let i = 0; i < w * 4; i++) out[dstRow + i] = raw[srcRow + i]!;
    }
    return { width: w, height: h, data: out };
  }
  const source = texture.image as (HTMLImageElement | HTMLCanvasElement | ImageBitmap | undefined);
  if (!source || typeof document === "undefined") {
    const fallback = new Uint8ClampedArray(16 * 16 * 4);
    for (let i = 0; i < fallback.length; i += 4) {
      fallback[i] = 148; fallback[i + 1] = 74; fallback[i + 2] = 68; fallback[i + 3] = 255;
    }
    return { width: 16, height: 16, data: fallback };
  }
  const srcW = ("naturalWidth" in source && source.naturalWidth) ? source.naturalWidth : source.width;
  const srcH = ("naturalHeight" in source && source.naturalHeight) ? source.naturalHeight : source.height;
  const w = Math.min(maxSide, Math.max(4, srcW || 256));
  const h = Math.min(maxSide, Math.max(4, srcH || 256));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2D canvas context unavailable");
  ctx.drawImage(source, 0, 0, w, h);
  const imageData = ctx.getImageData(0, 0, w, h);
  return { width: w, height: h, data: imageData.data };
}

/**
 * Export the UV-unwrapped 3D organ mesh with embedded baked PBR textures (baseColor, normal,
 * metallicRoughness) as a standard binary glTF 2.0 (.glb) ArrayBuffer.
 */
export async function exportBakedOrganGlb(bake: OrganMeshBakeResult): Promise<ArrayBuffer> {
  if (typeof globalThis.FileReader === "undefined") {
    (globalThis as Record<string, unknown>).FileReader = class {
      result: ArrayBuffer | string | null = null;
      onloadend: (() => void) | null = null;
      onload: (() => void) | null = null;
      readAsArrayBuffer(blob: Blob) {
        void blob.arrayBuffer().then(ab => {
          this.result = ab;
          this.onload?.();
          this.onloadend?.();
        });
      }
    };
  }
  const geometry = bake.unwrapped.geometry.clone();
  geometry.scale(0.001, 0.001, 0.001);

  let mapTexture: THREE.Texture | undefined;
  let normalTexture: THREE.Texture | undefined;
  let roughnessTexture: THREE.Texture | undefined;

  if (typeof document !== "undefined") {
    mapTexture = new THREE.CanvasTexture(rgbaImageToCanvas(bake.albedoAtlas));
    mapTexture.colorSpace = THREE.SRGBColorSpace;
    mapTexture.flipY = false;

    normalTexture = new THREE.CanvasTexture(rgbaImageToCanvas(bake.normalAtlas));
    normalTexture.colorSpace = THREE.NoColorSpace;
    normalTexture.flipY = false;

    roughnessTexture = new THREE.CanvasTexture(rgbaImageToCanvas(bake.roughnessAtlas));
    roughnessTexture.colorSpace = THREE.NoColorSpace;
    roughnessTexture.flipY = false;
  }

  const material = new THREE.MeshStandardMaterial({
    name: `${bake.organ}_baked_learned_tile`,
    ...(mapTexture && normalTexture && roughnessTexture
      ? { map: mapTexture, normalMap: normalTexture, roughnessMap: roughnessTexture }
      : {}),
    roughness: 1,
    metalness: 0,
  });

  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = `${bake.organ}_baked_organ`;
  mesh.userData = {
    schema: ORGAN_BAKE_SCHEMA,
    organ: bake.organ,
    units: "metres",
    metrics: bake.metrics,
    note: "UV-unwrapped 3D organ mesh with seamless variance-preserving baked learned tile textures.",
  };

  try {
    const exported = await new GLTFExporter().parseAsync(mesh, { binary: true });
    if (!(exported instanceof ArrayBuffer)) {
      throw new Error("Expected binary GLB ArrayBuffer from GLTFExporter");
    }
    return exported;
  } finally {
    geometry.dispose();
    material.dispose();
    mapTexture?.dispose();
    normalTexture?.dispose();
    roughnessTexture?.dispose();
  }
}

export const UNITY_ORGAN_PACKAGE_SCHEMA = "viscera.unity-organ-package/v1" as const;

/**
 * Convert a glTF roughness RgbaImage (roughness in G) into a Unity URP/HDRP/Standard
 * MetallicSmoothness map: R = Metallic (0), G = Occlusion (255), B = Detail (0), A = Smoothness (255 - Roughness).
 */
export function createUnityMetallicSmoothnessImage(roughnessImg: RgbaImage): RgbaImage {
  const { width, height, data } = roughnessImg;
  const out = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < data.length; i += 4) {
    const rough = data[i + 1]!;
    out[i] = 0;                       // Metallic = 0 (dielectric biological tissue)
    out[i + 1] = 255;                 // Ambient Occlusion = 1.0
    out[i + 2] = 0;                   // Detail mask = 0
    out[i + 3] = Math.max(0, Math.min(255, 255 - rough)); // Smoothness = 1 - Roughness
  }
  return { width, height, data: out };
}

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array, initial = 0xffffffff): number {
  let c = initial >>> 0;
  for (let i = 0; i < bytes.length; i++) {
    c = CRC32_TABLE[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

/** Deterministic, zero-dependency RGBA PNG encoder that works identically in Browser and Node/Vitest. */
export function encodeRgbaToPng(img: RgbaImage): Uint8Array {
  const { width: w, height: h, data } = img;
  const rowSize = w * 4 + 1;
  const rawLen = rowSize * h;
  const raw = new Uint8Array(rawLen);
  for (let y = 0; y < h; y++) {
    const dstOff = y * rowSize;
    raw[dstOff] = 0; // Filter type 0 (None)
    const srcOff = y * w * 4;
    raw.set(data.subarray(srcOff, srcOff + w * 4), dstOff + 1);
  }

  // Zlib store blocks (max 65535 bytes per block) + Adler-32 checksum
  const maxBlock = 65535;
  const numBlocks = Math.max(1, Math.ceil(rawLen / maxBlock));
  const zlibLen = 2 + numBlocks * 5 + rawLen + 4;
  const zlib = new Uint8Array(zlibLen);
  zlib[0] = 0x78; zlib[1] = 0x01; // Zlib header (CM=8, CINFO=7, no preset dict)
  let zPtr = 2;
  for (let b = 0; b < numBlocks; b++) {
    const start = b * maxBlock;
    const end = Math.min(rawLen, start + maxBlock);
    const len = end - start;
    const isFinal = b === numBlocks - 1 ? 1 : 0;
    zlib[zPtr++] = isFinal;
    zlib[zPtr++] = len & 0xff;
    zlib[zPtr++] = (len >>> 8) & 0xff;
    const nlen = (~len) & 0xffff;
    zlib[zPtr++] = nlen & 0xff;
    zlib[zPtr++] = (nlen >>> 8) & 0xff;
    zlib.set(raw.subarray(start, end), zPtr);
    zPtr += len;
  }

  let s1 = 1, s2 = 0;
  for (let i = 0; i < rawLen; i++) {
    s1 = (s1 + raw[i]!) % 65521;
    s2 = (s2 + s1) % 65521;
  }
  const adler = ((s2 << 16) | s1) >>> 0;
  zlib[zPtr++] = (adler >>> 24) & 0xff;
  zlib[zPtr++] = (adler >>> 16) & 0xff;
  zlib[zPtr++] = (adler >>> 8) & 0xff;
  zlib[zPtr++] = adler & 0xff;

  const writeU32BE = (buf: Uint8Array, off: number, val: number) => {
    buf[off] = (val >>> 24) & 0xff;
    buf[off + 1] = (val >>> 16) & 0xff;
    buf[off + 2] = (val >>> 8) & 0xff;
    buf[off + 3] = val & 0xff;
  };

  const makeChunk = (type: string, payload: Uint8Array): Uint8Array => {
    const chunk = new Uint8Array(12 + payload.length);
    writeU32BE(chunk, 0, payload.length);
    for (let i = 0; i < 4; i++) chunk[4 + i] = type.charCodeAt(i);
    chunk.set(payload, 8);
    const crc = crc32(chunk.subarray(4, 8 + payload.length));
    writeU32BE(chunk, 8 + payload.length, crc);
    return chunk;
  };

  const ihdr = new Uint8Array(13);
  writeU32BE(ihdr, 0, w);
  writeU32BE(ihdr, 4, h);
  ihdr[8] = 8;  // 8 bits per channel
  ihdr[9] = 6;  // Color type 6 = RGBA
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

  const cIhdr = makeChunk("IHDR", ihdr);
  const cIdat = makeChunk("IDAT", zlib);
  const cIend = makeChunk("IEND", new Uint8Array(0));

  const out = new Uint8Array(8 + cIhdr.length + cIdat.length + cIend.length);
  out.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  out.set(cIhdr, 8);
  out.set(cIdat, 8 + cIhdr.length);
  out.set(cIend, 8 + cIhdr.length + cIdat.length);
  return out;
}

/** Build a standard PK\x03\x04 ZIP archive from in-memory file entries. */
export function createZipArchive(entries: ReadonlyArray<{ path: string; data: Uint8Array }>): Uint8Array {
  const encoder = new TextEncoder();
  const prepared = entries.map(entry => ({
    nameBytes: encoder.encode(entry.path),
    data: entry.data,
    crc: crc32(entry.data),
    offset: 0,
  }));

  let localSize = 0;
  let centralSize = 0;
  for (const item of prepared) {
    item.offset = localSize;
    localSize += 30 + item.nameBytes.length + item.data.length;
    centralSize += 46 + item.nameBytes.length;
  }

  const totalSize = localSize + centralSize + 22;
  const out = new Uint8Array(totalSize);
  const view = new DataView(out.buffer);

  let ptr = 0;
  for (const item of prepared) {
    view.setUint32(ptr, 0x04034b50, true); // Local file header signature (PK\x03\x04)
    view.setUint16(ptr + 4, 20, true);     // Version needed to extract (2.0)
    view.setUint16(ptr + 6, 0x0800, true); // UTF-8 filename flag
    view.setUint16(ptr + 8, 0, true);      // Compression method 0 (Store)
    view.setUint16(ptr + 10, 0, true);     // Last mod file time
    view.setUint16(ptr + 12, 0x554b, true);// Last mod file date
    view.setUint32(ptr + 14, item.crc, true);
    view.setUint32(ptr + 18, item.data.length, true);
    view.setUint32(ptr + 22, item.data.length, true);
    view.setUint16(ptr + 26, item.nameBytes.length, true);
    view.setUint16(ptr + 28, 0, true);
    out.set(item.nameBytes, ptr + 30);
    out.set(item.data, ptr + 30 + item.nameBytes.length);
    ptr += 30 + item.nameBytes.length + item.data.length;
  }

  const centralStart = ptr;
  for (const item of prepared) {
    view.setUint32(ptr, 0x02014b50, true); // Central directory file header signature (PK\x01\x02)
    view.setUint16(ptr + 4, 20, true);     // Version made by
    view.setUint16(ptr + 6, 20, true);     // Version needed
    view.setUint16(ptr + 8, 0x0800, true); // UTF-8 flag
    view.setUint16(ptr + 10, 0, true);     // Store
    view.setUint16(ptr + 12, 0, true);
    view.setUint16(ptr + 14, 0x554b, true);
    view.setUint32(ptr + 16, item.crc, true);
    view.setUint32(ptr + 20, item.data.length, true);
    view.setUint32(ptr + 24, item.data.length, true);
    view.setUint16(ptr + 28, item.nameBytes.length, true);
    view.setUint16(ptr + 30, 0, true);
    view.setUint16(ptr + 32, 0, true);
    view.setUint16(ptr + 34, 0, true);
    view.setUint16(ptr + 36, 0, true);
    view.setUint32(ptr + 38, 0, true);
    view.setUint32(ptr + 42, item.offset, true);
    out.set(item.nameBytes, ptr + 46);
    ptr += 46 + item.nameBytes.length;
  }

  view.setUint32(ptr, 0x06054b50, true);   // End of central directory signature (PK\x05\x06)
  view.setUint16(ptr + 4, 0, true);
  view.setUint16(ptr + 6, 0, true);
  view.setUint16(ptr + 8, prepared.length, true);
  view.setUint16(ptr + 10, prepared.length, true);
  view.setUint32(ptr + 12, centralSize, true);
  view.setUint32(ptr + 16, centralStart, true);
  view.setUint16(ptr + 20, 0, true);

  return out;
}

/**
 * Export a ready-to-import Unity URP / HDRP / Built-in PBR ZIP package (`PK\x03\x04`) containing:
 * - UV-unwrapped 3D organ `.glb` in metres
 * - Baked UV atlases (`_BaseMap.png`, `_NormalMap.png`, `_MetallicSmoothness.png` with Smoothness in Alpha)
 * - Homogenized $C^\infty$ seamless repeatable tile + micro-relief normal map (`_SeamlessTile_*.png`)
 * - Unity URP/HDRP ClearCoat material configuration JSON + automatic Unity C# `AssetPostprocessor` script
 */
export async function exportBakedOrganUnityZip(bake: OrganMeshBakeResult): Promise<Uint8Array> {
  const glbBuffer = await exportBakedOrganGlb(bake);
  const organId = bake.organ;
  const pascalOrgan = organId
    .split("_")
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
  const baseDir = `Assets/Viscera/${pascalOrgan}`;
  const encoder = new TextEncoder();

  const metallicSmoothness = createUnityMetallicSmoothnessImage(bake.roughnessAtlas);

  const unityMatDescriptor = {
    schema: UNITY_ORGAN_PACKAGE_SCHEMA,
    organ: organId,
    unityPipelines: ["URP (Universal Render Pipeline/Lit)", "HDRP (HDRP/Lit)", "Built-in (Standard)"],
    meshAsset: `${baseDir}/${organId}_baked_organ.glb`,
    textures: {
      _BaseMap: `${baseDir}/Textures/${organId}_BaseMap.png`,
      _BumpMap: `${baseDir}/Textures/${organId}_NormalMap.png`,
      _MetallicGlossMap: `${baseDir}/Textures/${organId}_MetallicSmoothness.png`,
      seamlessTileBaseMap: `${baseDir}/Textures/${organId}_SeamlessTile_BaseMap.png`,
      seamlessTileNormalMap: `${baseDir}/Textures/${organId}_SeamlessTile_NormalMap.png`,
    },
    shaderProperties: {
      _Metallic: 0.0,
      _Smoothness: 0.82,
      _SmoothnessTextureChannel: "AlbedoAlpha_Or_MetallicAlpha",
      _BumpScale: 0.75,
      _ClearCoatMask: 0.85,
      _ClearCoatSmoothness: 0.88,
      _TileScaleMm: bake.metrics.tileScaleMm,
      _TriplanarBlendSharpness: bake.metrics.blendSharpness,
    },
    metrics: bake.metrics,
  };

  const csScript = `// Auto-generated by VISCERA Tissue Lab (${UNITY_ORGAN_PACKAGE_SCHEMA})
#if UNITY_EDITOR
using UnityEditor;
using UnityEngine;

namespace Viscera.Editor
{
    public sealed class Viscera${pascalOrgan}Importer : AssetPostprocessor
    {
        void OnPreprocessTexture()
        {
            if (!assetPath.Contains("Assets/Viscera/${pascalOrgan}/Textures/")) return;
            var importer = (TextureImporter)assetImporter;
            importer.mipmapEnabled = true;
            importer.anisoLevel = 8;
            if (assetPath.EndsWith("_NormalMap.png"))
            {
                importer.textureType = TextureImporterType.NormalMap;
                importer.sRGBTexture = false;
            }
            else if (assetPath.EndsWith("_MetallicSmoothness.png"))
            {
                importer.sRGBTexture = false;
                importer.alphaSource = TextureImporterAlphaSource.FromInput;
            }
            else
            {
                importer.sRGBTexture = true;
            }
        }
    }
}
#endif
`;

  const readme = `# VISCERA Unity 3D Organ PBR Package — ${pascalOrgan}

This package was generated in **VISCERA Tissue Lab** (\`${UNITY_ORGAN_PACKAGE_SCHEMA}\`) with $C^\\infty$ toroidal Hann tile synthesis and 2-octave aperiodic L2 variance-preserving 3D projection.

## Included Files
- \`${baseDir}/${organId}_baked_organ.glb\` — UV-unwrapped 3D organ mesh (${bake.metrics.triangleCount.toLocaleString()} tris, metres) with embedded PBR maps
- \`${baseDir}/Textures/${organId}_BaseMap.png\` — Baked 6-chart sRGB BaseMap (${bake.metrics.atlasResolution}×${bake.metrics.atlasResolution}, ${(bake.metrics.seamContinuity * 100).toFixed(1)}% seam continuity)
- \`${baseDir}/Textures/${organId}_NormalMap.png\` — Baked tangent-space OpenGL NormalMap
- \`${baseDir}/Textures/${organId}_MetallicSmoothness.png\` — Unity Metallic (R=0) + Smoothness (A = 1 - Roughness)
- \`${baseDir}/Textures/${organId}_SeamlessTile_BaseMap.png\` & \`_NormalMap.png\` — Homogenized $C^\\infty$ repeatable tile for Unity Triplanar Shader Graph
- \`${baseDir}/Editor/Viscera${pascalOrgan}Importer.cs\` — Automatic Unity Editor normal/sRGB/smoothness texture configuration
- \`${baseDir}/Materials/${organId}_VisceraURP.mat.json\` — URP / HDRP ClearCoat material parameters

## Quick Import into Unity (URP / HDRP / Built-in)
1. Unzip this archive into your Unity project root (so \`Assets/Viscera/${pascalOrgan}/\` merges into \`Assets/\`).
2. Unity will automatically run \`Viscera${pascalOrgan}Importer.cs\` to mark \`_NormalMap.png\` as a Normal Map and \`_MetallicSmoothness.png\` as Linear with Alpha Smoothness.
3. Drag \`${organId}_baked_organ.glb\` into your Scene and assign \`_BaseMap\`, \`_NormalMap\`, and \`_MetallicSmoothness\` to a **Universal Render Pipeline/Lit** (or **HDRP/Lit**) material with **Clear Coat** enabled (\`Mask = 0.85\`, \`Smoothness = 0.88\`).
`;

  return createZipArchive([
    { path: `${baseDir}/${organId}_baked_organ.glb`, data: new Uint8Array(glbBuffer) },
    { path: `${baseDir}/Textures/${organId}_BaseMap.png`, data: encodeRgbaToPng(bake.albedoAtlas) },
    { path: `${baseDir}/Textures/${organId}_NormalMap.png`, data: encodeRgbaToPng(bake.normalAtlas) },
    { path: `${baseDir}/Textures/${organId}_MetallicSmoothness.png`, data: encodeRgbaToPng(metallicSmoothness) },
    { path: `${baseDir}/Textures/${organId}_SeamlessTile_BaseMap.png`, data: encodeRgbaToPng(bake.seamlessTile) },
    { path: `${baseDir}/Textures/${organId}_SeamlessTile_NormalMap.png`, data: encodeRgbaToPng(bake.seamlessNormal) },
    { path: `${baseDir}/Materials/${organId}_VisceraURP.mat.json`, data: encoder.encode(JSON.stringify(unityMatDescriptor, null, 2)) },
    { path: `${baseDir}/Editor/Viscera${pascalOrgan}Importer.cs`, data: encoder.encode(csScript) },
    { path: `${baseDir}/README_UNITY.md`, data: encoder.encode(readme) },
  ]);
}
