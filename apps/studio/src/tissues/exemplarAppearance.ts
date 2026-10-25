/** Nonparametric appearance synthesis; source RGB retains photographic illumination. */
export const EXEMPLAR_SCHEMA = "viscera.tissue-exemplar/v1";
interface ExemplarArtifact {
  schema: string; model_type: string;
  architecture: { latent_dim: number; condition_labels: string[]; condition_regions: string[]; condition_species: string[]; native_resolution: number[]; exemplar_count: number; gaussian_range: number };
  statistics: { mean: number[]; basis: number[][]; quantiles: number[][] };
  weights: { encoding: string; sha256: string; byte_length: number; data_base64: string };
  output: { kind: string; color_space: string; binding: string; pbr_ground_truth: boolean; clinically_validated: boolean };
  provenance: Record<string, unknown>; seed_algorithm: string;
}
export interface ExemplarAppearanceModel { kind: "exemplar"; artifact: ExemplarArtifact; pixels: Uint8Array; modelId: string }
const fail = (message: string): never => { throw new Error(`Tissue exemplar: ${message}`); };
const finite = (v: unknown, n: number, bound = 4): v is number[] => Array.isArray(v) && v.length === n && v.every(x => typeof x === "number" && Number.isFinite(x) && Math.abs(x) <= bound);
export async function parseExemplarModel(raw: unknown, source: string, hash: (bytes: Uint8Array) => Promise<string>): Promise<ExemplarAppearanceModel> {
  const a = raw as ExemplarArtifact, arch = a.architecture, w = a.weights, s = a.statistics;
  if (a.schema !== EXEMPLAR_SCHEMA || a.model_type !== "pca-histogram-preserving-exemplar" || !arch
    || arch.latent_dim !== 16 || JSON.stringify(arch.native_resolution) !== '[512,512]'
    || arch.exemplar_count !== 4 || arch.gaussian_range !== 3.5 || a.seed_algorithm !== "sha256-box-muller-f32-v1"
    || ![arch.condition_labels, arch.condition_regions, arch.condition_species].every(v => Array.isArray(v) && v.length === 1 && typeof v[0] === "string" && v[0].length > 0 && v[0].length <= 256)) fail("unsupported architecture");
  if (!s || !finite(s.mean, 3, 1) || !Array.isArray(s.basis) || s.basis.length !== 3 || !s.basis.every(row => finite(row, 3, 1))
    || !Array.isArray(s.quantiles) || s.quantiles.length !== 3 || !s.quantiles.every(row => finite(row, 1025) && row.every((x, i) => i === 0 || x >= row[i - 1]!))) fail("invalid fitted statistics");
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
    const dot = s.basis[i]!.reduce((sum, v, k) => sum + v * s.basis[j]![k]!, 0);
    if (Math.abs(dot - (i === j ? 1 : 0)) > 1e-5) fail("invalid color basis");
  }
  if (!a.output || a.output.kind !== "observed_rgb_appearance" || a.output.color_space !== "srgb" || a.output.binding !== "fixed-rest-uv"
    || a.output.pbr_ground_truth !== false || a.output.clinically_validated !== false
    || a.provenance?.training_status !== "exemplar_fitted" || a.provenance?.qualification !== "engineering_unqualified"
    || !Array.isArray(a.provenance.sources) || a.provenance.sources.length !== 4
    || !a.provenance.sources.every(s => s && typeof s === "object" && /^[a-f0-9]{64}$/.test(String(s.sha256)))) fail("missing appearance provenance");
  const length = 4 * 512 * 512 * 3;
  if (!w || w.encoding !== "base64-u8" || w.byte_length !== length || !/^[a-f0-9]{64}$/.test(w.sha256)
    || typeof w.data_base64 !== "string" || w.data_base64.length !== Math.ceil(length / 3) * 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(w.data_base64)) fail("invalid exemplar payload");
  const pixels = Uint8Array.from(atob(w.data_base64), c => c.charCodeAt(0));
  if (pixels.length !== length || await hash(pixels) !== w.sha256) fail("exemplar checksum mismatch");
  return { kind: "exemplar", artifact: a, pixels, modelId: await hash(new TextEncoder().encode(source)) };
}
/** Standard-normal CDF; maximum approximation error below 8e-8. */
function cdf(x: number) {
  const z = Math.abs(x), t = 1 / (1 + .2316419 * z);
  const tail = .3989422804014327 * Math.exp(-z * z / 2) * t * (.319381530 + t * (-.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return x >= 0 ? 1 - tail : tail;
}
const fract = (x: number) => x - Math.floor(x);
const srgb = (x: number) => { x = Math.max(0, Math.min(1, x)); return x <= .0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - .055; };
export function createExemplarSampler(model: ExemplarAppearanceModel, latent: ArrayLike<number>, condition: number) {
  if (condition !== 0 || latent.length !== 16 || !Array.from(latent).every(Number.isFinite)) fail("invalid condition or latent");
  const uniforms = Array.from(latent, cdf), primary = Math.min(3, Math.floor(uniforms[0]! * 4));
  const secondary = (primary + 1 + Math.min(2, Math.floor(uniforms[1]! * 3))) % 4;
  // A dominant source preserves morphology; L2 normalization prevents faded blends.
  const w = .10 + uniforms[2]! * .22, norm = Math.hypot(1-w, w);
  const transform = (index: number, u: number, v: number) => {
    const k = 3 + index * 4, rotation = Math.min(7, Math.floor(uniforms[k]! * 8));
    const x = rotation & 1 ? v : u, y = rotation & 1 ? u : v;
    return [fract((rotation & 2 ? -x : x) + uniforms[k+1]!), fract((rotation & 4 ? -y : y) + uniforms[k+2]!)] as const;
  };
  const sample = (tile: number, u: number, v: number, channel: number) => {
    const x = u * 512 - .5, y = v * 512 - .5, ix = Math.floor(x), iy = Math.floor(y), fx = x-ix, fy = y-iy;
    const pixel = (dx: number, dy: number) => model.pixels[((tile * 512 + ((iy + dy) & 511)) * 512 + ((ix + dx) & 511)) * 3 + channel]!;
    return ((pixel(0,0)*(1-fx)+pixel(1,0)*fx)*(1-fy)+(pixel(0,1)*(1-fx)+pixel(1,1)*fx)*fy) / 255 * 7 - 3.5;
  };
  const out = new Float32Array(3), projected = new Float64Array(3), { mean, basis, quantiles } = model.artifact.statistics;
  return (u: number, v: number) => {
    if (!Number.isFinite(u) || !Number.isFinite(v) || Math.abs(u) > 2 || Math.abs(v) > 2) fail("invalid UV");
    const tu = u + .008 * Math.sin(2*Math.PI*v + uniforms[12]!*6.28318530718);
    const tv = v + .008 * Math.sin(2*Math.PI*u + uniforms[13]!*6.28318530718);
    const p = transform(0,tu,tv), q = transform(1,tu,tv);
    for (let c = 0; c < 3; c++) {
      const z = ((1-w)*sample(primary,p[0],p[1],c)+w*sample(secondary,q[0],q[1],c))/norm;
      const at = Math.min(1024, Math.max(0, cdf(z)*1024)), lo = Math.floor(at), f = at-lo;
      projected[c] = quantiles[c]![lo]!*(1-f) + quantiles[c]![Math.min(1024,lo+1)]!*f;
    }
    for (let c = 0; c < 3; c++) out[c] = srgb(mean[c]! + projected[0]!*basis[0]![c]! + projected[1]!*basis[1]![c]! + projected[2]!*basis[2]![c]!);
    return out;
  };
}
