/**
 * WGSL for the blood pool model. Structure follows jeantimex/webgpu-water
 * (MIT): heightfield update → normals → caustics from refracted-area ratios →
 * ray-traced surface with Fresnel reflection/refraction. Differences:
 *  - compute shaders on FP32 storage buffers instead of RGBA texture ping-pong;
 *  - SI scene (metres) and the dimensioned update of model.ts;
 *  - volume-exact deposit and instrument displacement;
 *  - blood optics from the shared spectral slab LUT (no tile/sky textures).
 */
import { POOL_OPTICS_WGSL } from "./optics";

export const STEP_UNIFORM_STRIDE = 256;

export const SIM_WGSL = /* wgsl */`
struct Step {
  n: u32, moving: u32, pad0: u32, pad1: u32,
  c2: f32, damp: f32, depth: f32, dx: f32,
  moveFrom: vec4f,
  moveTo: vec4f,
}
struct Deposit { n: u32, count: u32, dx: f32, pad: f32 }
struct Surface { n: u32, pad0: u32, depth: f32, dx: f32 }

@group(0) @binding(0) var<uniform> P: Step;
@group(0) @binding(1) var<storage, read> src: array<vec2f>;
@group(0) @binding(2) var<storage, read_write> dst: array<vec2f>;

fn centre(i: u32, n: u32, dx: f32) -> f32 { return (f32(i) + 0.5 - f32(n) * 0.5) * dx; }
fn chordAt(rho: f32, cy: f32, r: f32, depth: f32) -> f32 {
  if (rho >= r) { return 0.0; }
  let half = sqrt(r * r - rho * rho);
  return max(0.0, min(depth, cy + half) - max(0.0, cy - half));
}
// 2×2 supersampled submerged chord (model.ts cellChordM).
fn cellChord(i: u32, j: u32, c: vec4f) -> f32 {
  var s = 0.0;
  for (var a = 0u; a < 4u; a++) {
    let o = vec2f(select(-0.25, 0.25, (a & 1u) == 1u), select(-0.25, 0.25, (a & 2u) == 2u)) * P.dx;
    let d = vec2f(centre(i, P.n, P.dx) + o.x - c.x, centre(j, P.n, P.dx) + o.y - c.z);
    s += chordAt(length(d), c.y, c.w, P.depth);
  }
  return s * 0.25;
}

// Upstream update in nondimensional form: w += C²(Σ − 4h); w *= e^{−λΔt}; h += w.
@compute @workgroup_size(8, 8)
fn advance(@builtin(global_invocation_id) g: vec3u) {
  let n = P.n;
  if (g.x >= n || g.y >= n) { return; }
  let i = g.y * n + g.x;
  let s = src[i];
  let xm = src[g.y * n + max(g.x, 1u) - 1u].x;
  let xp = src[g.y * n + min(g.x + 1u, n - 1u)].x;
  let ym = src[(max(g.y, 1u) - 1u) * n + g.x].x;
  let yp = src[min(g.y + 1u, n - 1u) * n + g.x].x;
  let lap = (((xm + xp) + ym) + yp) - 4.0 * s.x;
  let w = (s.y + P.c2 * lap) * P.damp;
  var h = s.x + w;
  if (P.moving == 1u) { h += (cellChord(g.x, g.y, P.moveTo) - cellChord(g.x, g.y, P.moveFrom)) / P.depth; }
  dst[i] = vec2f(h, w);
}
`;

export const DEPOSIT_WGSL = /* wgsl */`
struct Deposit { n: u32, count: u32, dx: f32, pad: f32 }
@group(0) @binding(0) var<uniform> D: Deposit;
@group(0) @binding(1) var<storage, read> deposits: array<vec4f>;   // x, z, radius, h-amplitude
@group(0) @binding(2) var<storage, read_write> state: array<vec2f>;
@compute @workgroup_size(8, 8)
fn deposit(@builtin(global_invocation_id) g: vec3u) {
  if (g.x >= D.n || g.y >= D.n) { return; }
  let p = vec2f((f32(g.x) + 0.5 - f32(D.n) * 0.5) * D.dx, (f32(g.y) + 0.5 - f32(D.n) * 0.5) * D.dx);
  var add = 0.0;
  for (var k = 0u; k < D.count; k++) {
    let e = deposits[k];
    let t = max(0.0, 1.0 - length(p - e.xy) / e.z);
    add += e.w * (0.5 - 0.5 * cos(t * 3.14159265358979));
  }
  let i = g.y * D.n + g.x;
  state[i].x += add;
}
`;

export const SURFACE_WGSL = /* wgsl */`
struct Surface { n: u32, pad0: u32, depth: f32, dx: f32 }
@group(0) @binding(0) var<uniform> S: Surface;
@group(0) @binding(1) var<storage, read> state: array<vec2f>;
@group(0) @binding(2) var<storage, read_write> surf: array<vec4f>;    // world y, normal xyz
@compute @workgroup_size(8, 8)
fn surface(@builtin(global_invocation_id) g: vec3u) {
  let n = S.n;
  if (g.x >= n || g.y >= n) { return; }
  let x0 = max(g.x, 1u) - 1u; let x1 = min(g.x + 1u, n - 1u);
  let y0 = max(g.y, 1u) - 1u; let y1 = min(g.y + 1u, n - 1u);
  let dhdx = (state[g.y * n + x1].x - state[g.y * n + x0].x) * S.depth / (f32(x1 - x0) * S.dx);
  let dhdz = (state[y1 * n + g.x].x - state[y0 * n + g.x].x) * S.depth / (f32(y1 - y0) * S.dx);
  let i = g.y * n + g.x;
  surf[i] = vec4f(S.depth * (1.0 + state[i].x), normalize(vec3f(-dhdx, 1.0, -dhdz)));
}
`;

const VIEW_WGSL = /* wgsl */`
struct View {
  viewProj: mat4x4f,
  eye: vec4f,         // eye position (m)
  light: vec4f,       // unit direction towards lamp, w = lamp irradiance
  tray: vec4f,        // length L, rest depth H, rim height, grid n
  instrument: vec4f,  // centre (m), radius (0 = parked/hidden)
  optics: vec4f,      // whole-blood fraction, exposure multiplier, IOR, ambient irradiance
  misc: vec4f,        // dx, substrate albedo, shaft radius factor, shaft length factor
}
@group(0) @binding(0) var<uniform> V: View;
@group(0) @binding(1) var<storage, read> surf: array<vec4f>;

fn gridCoord(i: u32) -> f32 {
  // Render vertices span wall to wall; simulation cells are cell-centred.
  let n = V.tray.w;
  return (f32(i) / (n - 1.0) - 0.5) * V.tray.x;
}
fn surfaceY(xz: vec2f) -> f32 {
  let n = u32(V.tray.w);
  let u = clamp((xz / V.tray.x + 0.5) * (V.tray.w - 1.0), vec2f(0.0), vec2f(V.tray.w - 1.0));
  let i0 = vec2u(floor(u)); let i1 = min(i0 + 1u, vec2u(n - 1u)); let f = fract(u);
  let a = mix(surf[i0.y * n + i0.x].x, surf[i0.y * n + i1.x].x, f.x);
  let b = mix(surf[i1.y * n + i0.x].x, surf[i1.y * n + i1.x].x, f.x);
  return mix(a, b, f.y);
}
`;

const SCENE_WGSL = /* wgsl */`
fn envRadiance(d: vec3f, rough: f32) -> vec3f {
  // Operating-room environment: dark theatre ceiling so flat whole blood stays
  // deep crimson, one overhead multi-pod surgical lamp (V.light.xyz), and subtle
  // concentric surgical-dome louvres that catch wet glints on wave slopes.
  let up = d.y;
  var c = mix(vec3f(0.022, 0.025, 0.030), vec3f(0.065, 0.070, 0.078), smoothstep(-0.25, 0.25, up));
  c = mix(c, vec3f(0.032, 0.036, 0.042), smoothstep(0.35, 0.95, up));
  let lampCos = 0.9936; // 6.5° half-angle
  let lampRadiance = V.light.w / (6.2831853 * (1.0 - lampCos));
  let widen = 0.004 + rough * 0.08;
  let lamp = smoothstep(lampCos - widen, lampCos + widen * 0.3, dot(d, V.light.xyz));
  c += vec3f(1.0, 0.97, 0.92) * lampRadiance * lamp / (1.0 + rough * 30.0);
  let lu = normalize(cross(V.light.xyz, vec3f(0.0, 0.0, 1.0)));
  let lv = cross(V.light.xyz, lu);
  for (var p = 0; p < 6; p++) {
    let ang = f32(p) * 1.04719755;
    let podDir = normalize(V.light.xyz + (lu * cos(ang) + lv * sin(ang)) * 0.22);
    let pod = smoothstep(0.9968 - widen, 0.9988, dot(d, podDir));
    c += vec3f(0.98, 0.96, 0.94) * (lampRadiance * 0.28) * pod / (1.0 + rough * 24.0);
  }
  for (var k = 0; k < 2; k++) {
    let centre = normalize(select(vec3f(0.55, 1.0, -0.35), vec3f(-0.55, 0.85, 0.40), k == 1));
    let t = cross(centre, vec3f(0.0, 0.0, 1.0));
    let q = vec2f(dot(d, normalize(t)), dot(d, normalize(cross(t, centre))));
    let inside = (1.0 - smoothstep(0.14, 0.14 + widen * 4.0, abs(q.x))) * (1.0 - smoothstep(0.26, 0.26 + widen * 4.0, abs(q.y)));
    c += vec3f(0.88, 0.92, 1.0) * 1.8 * inside * step(0.0, dot(d, centre)) / (1.0 + rough * 12.0);
  }
  return c;
}
fn intersectSphere(o: vec3f, d: vec3f, c: vec3f, r: f32) -> f32 {
  if (r <= 0.0) { return -1.0; }
  let oc = o - c; let b = dot(oc, d); let cc = dot(oc, oc) - r * r; let h = b * b - cc;
  if (h < 0.0) { return -1.0; }
  let s = sqrt(h); let t0 = -b - s;
  if (t0 > 1e-6) { return t0; }
  let t1 = -b + s;
  return select(-1.0, t1, t1 > 1e-6);
}
fn intersectBoxExit(o: vec3f, d: vec3f, lo: vec3f, hi: vec3f) -> f32 {
  let a = (lo - o) / d; let b = (hi - o) / d;
  let far = max(a, b);
  return min(min(far.x, far.y), far.z);
}
fn instrumentShadow(p: vec3f, dir: vec3f) -> f32 {
  let r = V.instrument.w;
  if (r <= 0.0) { return 1.0; }
  let c = V.instrument.xyz - p; let t = dot(c, dir);
  if (t <= 0.0) { return 1.0; }
  let ball = smoothstep(r * 0.8, r * 1.35, length(c - dir * t));
  // Shaft: a vertical capsule above the ball.
  let shaftR = r * V.misc.z; let top = V.instrument.xyz + vec3f(0.0, r * V.misc.w, 0.0);
  let w = top - V.instrument.xyz; let w0 = p - V.instrument.xyz;
  let b = dot(dir, w); let dd = dot(w, w); let e = dot(dir, w0); let f = dot(w, w0);
  let den = max(dd - b * b, 1e-12);
  let s = clamp((f - b * e) / den, 0.0, 1.0); let tt = max(b * s - e, 0.0);
  let shaft = smoothstep(shaftR * 0.7, shaftR * 1.6, length(w0 + dir * tt - w * s));
  return min(ball, shaft);
}
fn steelColour(p: vec3f, n: vec3f, view: vec3f, albedo: f32, metal: f32, rough: f32) -> vec3f {
  let l = V.light.xyz;
  let shadow = instrumentShadow(p, l);
  let direct = V.light.w * max(dot(n, l), 0.0) * shadow;
  let cosv = clamp(dot(n, -view), 0.0, 1.0);
  let F = metal + (1.0 - metal) * pow(1.0 - cosv, 5.0);
  let spec = envRadiance(reflect(view, n), rough) * select(1.0, shadow, rough > 0.2);
  return albedo * (1.0 - F) * (direct + V.optics.w) / 3.14159265 * 2.0 + F * spec;
}
fn toneMap(c: vec3f) -> vec3f {
  let x = c * V.optics.y;
  let a = (x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14); // ACES (Narkowicz fit)
  let v = clamp(a, vec3f(0.0), vec3f(1.0));
  return select(1.055 * pow(v, vec3f(1.0 / 2.4)) - 0.055, v * 12.92, v <= vec3f(0.0031308));
}
`;

export const CAUSTIC_WGSL = /* wgsl */`
${VIEW_WGSL}
struct CausticOut { @builtin(position) clip: vec4f, @location(0) oldPos: vec3f, @location(1) newPos: vec3f }
@vertex fn vs(@builtin(vertex_index) vi: u32) -> CausticOut {
  let n = u32(V.tray.w); let s = surf[vi];
  let x = gridCoord(vi % n); let z = gridCoord(vi / n); let H = V.tray.y; let ior = V.optics.z;
  let flatRay = refract(-V.light.xyz, vec3f(0.0, 1.0, 0.0), 1.0 / ior);
  let ray = refract(-V.light.xyz, normalize(s.yzw), 1.0 / ior);
  let shift = flatRay.xz * (H / max(-flatRay.y, 1e-3));
  var out: CausticOut;
  out.oldPos = vec3f(x, H, z) + flatRay * (H / max(-flatRay.y, 1e-3));
  out.newPos = vec3f(x, s.x, z) + ray * (s.x / max(-ray.y, 1e-3));
  out.clip = vec4f((out.newPos.x - shift.x) / (0.5 * V.tray.x), -(out.newPos.z - shift.y) / (0.5 * V.tray.x), 0.0, 1.0);
  return out;
}
// Light converges where refracted triangles shrink (upstream area-ratio method).
@fragment fn fs(in: CausticOut) -> @location(0) vec4f {
  let oldArea = length(dpdx(in.oldPos)) * length(dpdy(in.oldPos));
  let newArea = length(dpdx(in.newPos)) * length(dpdy(in.newPos));
  return vec4f(oldArea / max(newArea, 1e-14), 0.0, 0.0, 1.0);
}
`;

const SCENE_BINDINGS = /* wgsl */`
@group(0) @binding(2) var opticsLut: texture_2d<f32>;
@group(0) @binding(3) var causticTex: texture_2d<f32>;
@group(0) @binding(4) var linearSampler: sampler;
${POOL_OPTICS_WGSL}
fn caustic(xz: vec2f) -> f32 {
  let uv = xz / V.tray.x + 0.5;
  let edge = smoothstep(0.0, 0.03, min(min(uv.x, 1.0 - uv.x), min(uv.y, 1.0 - uv.y)));
  return mix(1.0, textureSampleLevel(causticTex, linearSampler, uv, 0.0).r, edge);
}
// Diffuse blood slab over the lit stainless substrate. Caustic focus and the
// instrument shadow modulate only the substrate irradiance, not slab backscatter.
fn bodyColour(hit: vec3f, thicknessM: f32, eTop: f32, substrate: vec3f, causticWeight: f32) -> vec3f {
  let ior = V.optics.z;
  let lr = refract(-V.light.xyz, vec3f(0.0, 1.0, 0.0), 1.0 / ior);
  let cosr = max(-lr.y, 0.0);
  let lit = V.light.w * cosr;
  let cFocus = mix(1.0, caustic(hit.xz), causticWeight);
  let factor = (lit * cFocus * instrumentShadow(hit, -lr) + V.optics.w) / max(lit + V.optics.w, 1e-4);
  return eTop * slabOverSubstrate(thicknessM * V.optics.x, substrate, vec3f(factor)) / 3.14159265 * 2.0;
}
fn traceAbove(o: vec3f, d: vec3f) -> vec3f {
  let r = V.instrument.w;
  let ts = intersectSphere(o, d, V.instrument.xyz, r);
  let half = 0.5 * V.tray.x; let rim = V.tray.z;
  let tw = intersectBoxExit(o, d, vec3f(-half, -1.0, -half), vec3f(half, 10.0, half));
  if (ts > 0.0 && (ts < tw || d.y >= 0.0)) {
    let p = o + d * ts; let n = normalize(p - V.instrument.xyz);
    return steelColour(p, n, d, 0.25, 0.56, 0.05);
  }
  let p = o + d * tw;
  if (p.y < rim) {
    var n = vec3f(0.0, 0.0, -sign(p.z));
    if (abs(p.x) > abs(p.z)) { n = vec3f(-sign(p.x), 0.0, 0.0); }
    return steelColour(p, n, d, V.misc.y, 0.35, 0.35);
  }
  return envRadiance(d, 0.0);
}
fn traceBelow(o: vec3f, d: vec3f, eTop: f32) -> vec3f {
  let r = V.instrument.w; let half = 0.5 * V.tray.x;
  let ts = intersectSphere(o, d, V.instrument.xyz, r);
  let tb = intersectBoxExit(o, d, vec3f(-half, 0.0, -half), vec3f(half, 10.0, half));
  if (ts > 0.0 && ts < tb) {
    let p = o + d * ts;
    return bodyColour(p, max(surfaceY(p.xz) - p.y, 0.0), eTop, vec3f(0.6), 0.5);
  }
  let p = o + d * tb;
  let floorHit = step(p.y, 1e-4);
  let wallThickness = max(surfaceY(p.xz) - p.y, 0.65 * V.tray.y) + 0.5 * tb;
  let pathM = select(wallThickness, max(surfaceY(p.xz) - p.y, 0.0), floorHit > 0.5);
  let sub = vec3f(V.misc.y * mix(0.45, 1.0, floorHit));
  return bodyColour(p, pathM, eTop, sub, floorHit);
}
`;

export const SURFACE_RENDER_WGSL = /* wgsl */`
${VIEW_WGSL}
${SCENE_WGSL}
${SCENE_BINDINGS}
struct SurfOut { @builtin(position) clip: vec4f, @location(0) world: vec3f, @location(1) normal: vec3f }
@vertex fn vs(@builtin(vertex_index) vi: u32) -> SurfOut {
  let n = u32(V.tray.w); let s = surf[vi];
  var out: SurfOut;
  out.world = vec3f(gridCoord(vi % n), s.x, gridCoord(vi / n));
  out.normal = s.yzw;
  out.clip = V.viewProj * vec4f(out.world, 1.0);
  return out;
}
@fragment fn fs(in: SurfOut) -> @location(0) vec4f {
  let n = normalize(in.normal);
  let nShade = normalize(vec3f(n.x * 4.5, n.y, n.z * 4.5));
  let v = normalize(in.world - V.eye.xyz);
  let ior = V.optics.z;
  let cosi = clamp(dot(-v, n), 0.0, 1.0);
  let f0 = pow((ior - 1.0) / (ior + 1.0), 2.0);
  let F = f0 + (1.0 - f0) * pow(1.0 - cosi, 5.0);
  let shadow = instrumentShadow(in.world, V.light.xyz);
  let raking = normalize(vec3f(-0.55, 0.48, -0.68));
  let waveRelief = 1.0 + 0.65 * clamp(dot(nShade, raking) - dot(vec3f(0.0, 1.0, 0.0), raking), -0.42, 0.42);
  let eTop = (V.light.w * max(dot(nShade, V.light.xyz), 0.0) * shadow + V.optics.w) * waveRelief;
  let h1 = normalize(raking - v);
  let h2 = normalize(V.light.xyz - v);
  let slopeGate = smoothstep(0.004, 0.035, length(n.xz)) * shadow;
  let wetSpec = vec3f(1.0, 0.95, 0.90) * (1.6 * pow(clamp(dot(nShade, h1), 0.0, 1.0), 110.0) + 1.4 * pow(clamp(dot(nShade, h2), 0.0, 1.0), 90.0)) * slopeGate;
  let reflected = min(traceAbove(in.world, reflect(v, n)), vec3f(5.0));
  let body = traceBelow(in.world, refract(v, n, 1.0 / ior), eTop);
  return vec4f(toneMap(mix(body, reflected, F) + wetSpec * 0.14), 1.0);
}
`;

/** Tray, drape, instrument and falling drops share one instanced pipeline.
 *  material: 0 tray steel, 1 drape, 2 instrument steel, 3 airborne blood drop. */
export const SOLID_WGSL = /* wgsl */`
${VIEW_WGSL}
${SCENE_WGSL}
${SCENE_BINDINGS}
struct SolidOut { @builtin(position) clip: vec4f, @location(0) world: vec3f, @location(1) normal: vec3f,
  @location(2) @interpolate(flat) material: u32, @location(3) radius: f32 }
@vertex fn vs(@location(0) position: vec3f, @location(1) normal: vec3f, @location(2) material: f32,
  @location(3) instance: vec4f) -> SolidOut {
  var out: SolidOut;
  out.world = instance.xyz + position * instance.w;
  out.normal = normal; out.material = u32(material + 0.5); out.radius = instance.w;
  out.clip = V.viewProj * vec4f(out.world, 1.0);
  return out;
}
@fragment fn fs(in: SolidOut) -> @location(0) vec4f {
  let n = normalize(in.normal); let v = normalize(in.world - V.eye.xyz);
  var c: vec3f;
  if (in.material == 1u) {
    let lit = V.light.w * max(dot(n, V.light.xyz), 0.0) * instrumentShadow(in.world, V.light.xyz) + V.optics.w;
    c = vec3f(0.045, 0.16, 0.16) * lit / 3.14159265 * 2.0;
  } else if (in.material == 2u) {
    c = steelColour(in.world, n, v, 0.25, 0.56, 0.05);
  } else if (in.material == 3u) {
    let cosi = clamp(dot(-v, n), 0.0, 1.0); let f0 = pow((V.optics.z - 1.0) / (V.optics.z + 1.0), 2.0);
    let F = f0 + (1.0 - f0) * pow(1.0 - cosi, 5.0);
    let eTop = V.light.w * max(dot(n, V.light.xyz), 0.0) + V.optics.w;
    let body = eTop * slabOverSubstrate(2.0 * in.radius * V.optics.x, vec3f(0.0), vec3f(0.0)) / 3.14159265 * 2.0;
    c = mix(body, envRadiance(reflect(v, n), 0.0), F);
  } else {
    c = steelColour(in.world, n, v, V.misc.y, 0.35, 0.35);
  }
  return vec4f(toneMap(c), 1.0);
}
`;
