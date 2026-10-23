import * as THREE from "three";
import { createLumenPath, LUMEN_LENGTH_MM, LUMEN_SPEED_MM_PER_SECOND, periodic, seededUnit, type LumenFrame, orientLumenCamera } from "./lumenPath";

const TAU = Math.PI * 2;
const AROUND = 128, ALONG = 800;
export type LumenProfile = "colon" | "small-bowel" | "gastric";
export interface LumenWalkthrough {
  geometry: THREE.BufferGeometry;
  lengthMm: number;
  sample: (distanceMm: number) => LumenFrame & { radiusMm: number };
  surfaceRadius: (distanceMm: number, angle: number) => number;
  sampleCamera: (timeSeconds: number, speedMmPerSecond?: number, direction?: { yawDeg?: number; pitchDeg?: number }) => { position: THREE.Vector3; target: THREE.Vector3; up: THREE.Vector3 };
  metadata: { id: "curved-lumen-phantom-v3"; profile: LumenProfile; closed: true; units: "mm"; lengthMm: number; speedMmPerSecond: number; loopPeriodSeconds: number; around: number; along: number; tileSizeMm: number; nominalCircumferenceMm: number };
}
interface Fold { center: number; angle: number; width: number; depth: number; tilt: number; extent: number }

/** Compact support with zero first and second derivatives at the boundary. */
function smoothFold(value: number) { const q = Math.max(0, 1 - value * value); return q * q * q; }

/**
 * Authored connected lumen with an intentionally closed navigation loop, not patient anatomy.
 * Colonic geometry uses staggered partial semilunar folds in three rows, rather than rings:
 * https://pmc.ncbi.nlm.nih.gov/articles/PMC3281971/
 * https://journals.physiology.org/doi/full/10.1152/ajpgi.00063.2021
 * Dimensions and fold variation are explicit authored parameters, not fitted measurements.
 */
export function createLumenWalkthrough(seed: number, options: { profile?: LumenProfile; tileSizeMm?: number } = {}): LumenWalkthrough {
  const profile = options.profile ?? "colon", tileSizeMm = options.tileSizeMm ?? 80;
  if (!["colon", "small-bowel", "gastric"].includes(profile)) throw new Error("Unknown lumen profile");
  if (!Number.isFinite(tileSizeMm) || tileSizeMm < 10 || tileSizeMm > 500) throw new Error("Lumen tile size must be 10–500 mm");
  // Preserve physical axial texel scale for every valid recipe while closing the UV seam.
  const loopLengthMm = Math.ceil(LUMEN_LENGTH_MM / tileSizeMm) * tileSizeMm;
  const path = createLumenPath(seed, loopLengthMm), phase = seededUnit(seed, 21) * TAU, folds: Fold[] = [];
  const rows = profile === "small-bowel" ? 1 : 3, count = profile === "small-bowel" ? 87 : 23;
  for (let row = 0; row < rows; row++) {
    // A positive, normalized renewal sequence closes exactly without evenly spaced rings.
    const gaps = Array.from({ length: count }, (_, i) => .55 + 1.0 * seededUnit(seed, 100 + row * count + i));
    const total = gaps.reduce((sum, value) => sum + value, 0);
    let distance = row * path.lengthMm / count * .43;
    for (let i = 0; i < count; i++) {
      const index = row * count + i;
      folds.push({
        center: periodic(distance, path.lengthMm),
        angle: row * TAU / 3 + phase + (profile === "small-bowel" ? i * 2.39996 : 0) + .8 * (seededUnit(seed, 300 + index) - .5),
        width: profile === "small-bowel" ? 5.5 + 4 * seededUnit(seed, 500 + index) : 19 + 10 * seededUnit(seed, 500 + index),
        depth: profile === "small-bowel" ? 1.1 + 2.1 * seededUnit(seed, 700 + index) : 3.5 + 3.7 * seededUnit(seed, 700 + index),
        tilt: (profile === "small-bowel" ? 4 : 12) * (seededUnit(seed, 900 + index) - .5),
        extent: profile === "small-bowel" ? 1.9 + seededUnit(seed, 1200 + index) : 1.5 + .65 * seededUnit(seed, 1200 + index),
      });
      distance += gaps[i]! / total * path.lengthMm;
    }
  }
  const nearbyFolds = (s: number) => folds.filter(fold => Math.abs(periodic(s - fold.center + path.lengthMm / 2, path.lengthMm) - path.lengthMm / 2) <= fold.width + Math.abs(fold.tilt));
  const radius = (s: number, angle: number, nearby: Fold[]) => {
    const t = s / path.lengthMm * TAU;
    const base = profile === "small-bowel" ? 18.5 : profile === "gastric" ? 31 : 25;
    const twist = .65 * Math.sin(2 * t + phase) + .25 * Math.cos(5 * t - phase);
    let value = base + 3.1 * Math.sin(3 * t + phase) + 1.7 * Math.cos(5 * t - phase)
      + (1.8 + .7 * Math.sin(7 * t + phase)) * Math.cos(2 * angle + twist)
      + (profile === "colon" ? 1.6 : .5) * Math.cos(3 * angle - phase + .45 * Math.sin(3 * t));
    if (profile === "gastric") {
      // Broad irregular longitudinal ridges remain an authored lumen, not a stomach chamber.
      const ridgePhase = 7 * angle + 1.1 * Math.sin(5 * t + phase) + .45 * Math.sin(3 * angle - 2 * t);
      value += 2.8 * Math.sin(t + phase) - (2.0 + 1.2 * Math.sin(3 * t + phase) ** 2) * Math.pow(.5 + .5 * Math.cos(ridgePhase), 3);
    } else for (const fold of nearby) {
      const deltaAngle = periodic(angle - fold.angle - .24 * Math.sin(2 * t + phase) + Math.PI, TAU) - Math.PI;
      const delta = periodic(s - fold.center + path.lengthMm / 2, path.lengthMm) - path.lengthMm / 2 - fold.tilt * Math.sin(deltaAngle);
      const angular = smoothFold(deltaAngle / fold.extent);
      // Small-bowel folds can partly surround the cavity; a shallow basal component
      // preserves this distinction while avoiding identical, deep closed rings.
      const cover = profile === "small-bowel" ? .15 + .85 * angular : angular;
      value -= fold.depth * smoothFold(delta / fold.width) * cover;
    }
    const minimumRadius = profile === "small-bowel" ? 10.5 : profile === "gastric" ? 20 : 13;
    return minimumRadius + Math.log1p(Math.exp(value - minimumRadius));
  };
  const surfaceRadius = (distanceMm: number, angle: number) => {
    if (!Number.isFinite(distanceMm) || !Number.isFinite(angle)) throw new Error("Lumen surface coordinates must be finite");
    const s = periodic(distanceMm, path.lengthMm); return radius(s, angle, nearbyFolds(s));
  };
  const geometry = new THREE.BufferGeometry(), positions: number[] = [], uv: number[] = [], indices: number[] = [];
  const minimumRadii: number[] = [];
  // Integral circumferential repeats close the chart. The nominal 160 mm circumference
  // is a reference scale; variable-radius folds necessarily stretch this UV chart.
  const circumferenceRepeats = Math.max(1, Math.round(160 / tileSizeMm));
  for (let j = 0; j <= ALONG; j++) {
    const s = j / ALONG * path.lengthMm, frame = path.sample(s), nearby = nearbyFolds(periodic(s, path.lengthMm));
    let minimum = Infinity;
    for (let i = 0; i <= AROUND; i++) {
      const angle = i === AROUND ? 0 : i / AROUND * TAU, r = radius(periodic(s, path.lengthMm), angle, nearby);
      minimum = Math.min(minimum, r);
      const position = frame.position.clone().addScaledVector(frame.normal, Math.cos(angle) * r).addScaledVector(frame.binormal, Math.sin(angle) * r);
      positions.push(position.x, position.y, position.z); uv.push(i / AROUND * circumferenceRepeats, s / tileSizeMm);
      if (j < ALONG && i < AROUND) {
        const p = j * (AROUND + 1) + i, q = p + AROUND + 1;
        indices.push(p, q, p + 1, p + 1, q, q + 1);
      }
    }
    minimumRadii.push(minimum);
  }
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  geometry.setIndex(indices); geometry.computeVertexNormals();
  const normals = geometry.getAttribute("normal");
  const reconcile = (a: number, b: number) => {
    const value = new THREE.Vector3(normals.getX(a) + normals.getX(b), normals.getY(a) + normals.getY(b), normals.getZ(a) + normals.getZ(b)).normalize();
    normals.setXYZ(a, value.x, value.y, value.z); normals.setXYZ(b, value.x, value.y, value.z);
  };
  for (let j = 0; j <= ALONG; j++) reconcile(j * (AROUND + 1), j * (AROUND + 1) + AROUND);
  for (let i = 0; i <= AROUND; i++) reconcile(i, ALONG * (AROUND + 1) + i);
  const corners = [0, AROUND, ALONG * (AROUND + 1), ALONG * (AROUND + 1) + AROUND], cornerNormal = new THREE.Vector3();
  for (const index of corners) cornerNormal.add(new THREE.Vector3().fromBufferAttribute(normals, index));
  cornerNormal.normalize(); for (const index of corners) normals.setXYZ(index, cornerNormal.x, cornerNormal.y, cornerNormal.z);
  geometry.computeBoundingSphere(); geometry.computeBoundingBox();
  const sample = (distanceMm: number) => {
    const frame = path.sample(distanceMm), index = periodic(distanceMm, path.lengthMm) / path.lengthMm * ALONG, low = Math.floor(index), fraction = index - low;
    return { ...frame, radiusMm: THREE.MathUtils.lerp(minimumRadii[low]!, minimumRadii[low + 1]!, fraction) };
  };
  return {
    geometry, lengthMm: path.lengthMm, sample, surfaceRadius,
    sampleCamera(timeSeconds, speedMmPerSecond = LUMEN_SPEED_MM_PER_SECOND, direction = {}) {
      if (!Number.isFinite(timeSeconds) || !Number.isFinite(speedMmPerSecond) || speedMmPerSecond <= 0) throw new Error("Camera time and positive speed must be finite");
      const s = periodic(timeSeconds * speedMmPerSecond, path.lengthMm), frame = path.sample(s), t = s / path.lengthMm * TAU;
      const excursion = profile === "small-bowel" ? .4 : 1;
      const position = frame.position.clone().addScaledVector(frame.normal, excursion * 3.4 * Math.sin(11 * t + phase)).addScaledVector(frame.binormal, excursion * 2.3 * Math.cos(7 * t));
      const ahead = path.sample(s + 24);
      const target = ahead.position.addScaledVector(ahead.normal, 14 * Math.sin(7 * t + phase * .7)).addScaledVector(ahead.binormal, 10 * Math.cos(9 * t + phase));
      return orientLumenCamera({ position, target, up: frame.normal }, direction.yawDeg ?? 0, direction.pitchDeg ?? 0);
    },
    metadata: { id: "curved-lumen-phantom-v3", profile, closed: true, units: "mm", lengthMm: path.lengthMm, speedMmPerSecond: LUMEN_SPEED_MM_PER_SECOND, loopPeriodSeconds: path.lengthMm / LUMEN_SPEED_MM_PER_SECOND, around: AROUND, along: ALONG, tileSizeMm, nominalCircumferenceMm: circumferenceRepeats * tileSizeMm },
  };
}

/** Compatibility export; traversal must use createLumenWalkthrough's matching path. */
export function lumenGeometry(seed: number): THREE.BufferGeometry { return createLumenWalkthrough(seed).geometry; }

export function surfaceGeometry(): THREE.BufferGeometry {
  const geometry = new THREE.PlaneGeometry(80, 80, 128, 128), positions = geometry.getAttribute("position");
  for (let i = 0; i < positions.count; i++) {
    const x = positions.getX(i), y = positions.getY(i);
    positions.setZ(i, 5 * Math.cos(x / 40) * Math.cos(y / 40) + .6 * Math.sin(y / 9));
  }
  geometry.computeVertexNormals(); return geometry;
}
