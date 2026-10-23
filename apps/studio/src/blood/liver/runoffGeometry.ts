import { Vector3 } from "three";
import { closedTriangleVolumeM3 } from "../experiments/breakupGeometry";
import { tankSurfaceData, validateTankGeometry, type GeometryData } from "../experiments/geometry";
import type { DryCollectorSnapshot } from "./dryCollector";
import type { RunoffAttachedGeometry } from "./runoff";

// Round-to-nearest Float32 maps a nonnegative value at or below this half
// subnormal quantum to zero. Optical depth is uploaded in metres; local
// position is uploaded in millimetres. Neither may be replaced by a minimum.
export const ATTACHED_FLOAT32_ZERO_HEIGHT_M = 2 ** -150;

/** Closed, indexed local-mm representation of the solver's cylinder+cap.
 * No volume correction moves the physical radius, height, anchor or contact
 * plane. The returned measured polyhedral error is a tessellation error.
 */
export function attachedRunoffGeometry(shape: RunoffAttachedGeometry, segments = 64, bands = 32) {
  const a = shape.contactRadiusM, length = shape.neckLengthM, height = shape.capHeightM;
  if (![a, length, height, shape.volumeM3].every(Number.isFinite) || a <= 0 || length < 0 || height < 0 ||
      shape.volumeM3 <= 0 || !Number.isSafeInteger(segments) || segments < 8 || segments > 256 ||
      !Number.isSafeInteger(bands) || bands < 4 || bands > 128)
    throw new RangeError("Invalid attached runoff geometry");
  const analyticVolumeM3 = Math.PI * a * a * length + Math.PI * height * (3 * a * a + height * height) / 6;
  if (!Number.isFinite(analyticVolumeM3) || Math.abs(analyticVolumeM3 / shape.volumeM3 - 1) > 1e-10)
    throw new RangeError("Attached shape does not represent its accepted inventory");
  const physicalAxialThicknessM = length + height;
  if (!Number.isFinite(physicalAxialThicknessM) || !Number.isFinite(Math.fround(a * 1000)))
    throw new RangeError("Attached shape exceeds finite Float32 geometry");
  if (physicalAxialThicknessM > 0 && Math.fround(physicalAxialThicknessM) === 0) {
    // This is a representability result, not a visibility threshold. Retain
    // accepted inventory separately and render no geometry/optical coverage.
    // For L+H <= q: V = pi*a²*L + pi*H*(3a²+H²)/6 <= pi*a²*q+pi*q³/6.
    const q = ATTACHED_FLOAT32_ZERO_HEIGHT_M;
    const unresolvedVolumeBoundM3 = Math.PI * a * a * q + Math.PI * q ** 3 / 6;
    if (physicalAxialThicknessM > q || analyticVolumeM3 > unresolvedVolumeBoundM3 * (1 + 1e-12))
      throw new RangeError("Attached Float32 underflow exceeds its representation bound");
    return { positions: new Float32Array(0), normals: new Float32Array(0), indices: new Uint32Array(0),
      resolved: false, physicalAxialThicknessM, axialOpticalThicknessM: 0, analyticVolumeM3,
      reconstructedVolumeM3: 0, relativeVolumeError: 1, unresolvedVolumeM3: shape.volumeM3,
      unresolvedVolumeBoundM3, segments, bands };
  }
  const positions: number[] = [], normals: number[] = [], indices: number[] = [];
  const vertex = (x: number, y: number, z: number, nx: number, ny: number, nz: number) => {
    const index = positions.length / 3;
    positions.push(x * 1000, y * 1000, z * 1000); normals.push(nx, ny, nz); return index;
  };
  const ring = (radius: number, y: number, radialNormal: number, normalY: number) => {
    const start = positions.length / 3;
    for (let i = 0; i < segments; i++) {
      const angle = 2 * Math.PI * i / segments, x = Math.cos(angle), z = Math.sin(angle);
      vertex(radius * x, y, radius * z, radialNormal * x, normalY, radialNormal * z);
    }
    return start;
  };
  const connect = (lower: number, upper: number) => {
    for (let i = 0; i < segments; i++) {
      const next = (i + 1) % segments;
      indices.push(lower + i, upper + i, lower + next, lower + next, upper + i, upper + next);
    }
  };
  const bottom = vertex(0, 0, 0, 0, -1, 0), bottomRing = ring(a, 0, 0, -1);
  for (let i = 0; i < segments; i++) indices.push(bottom, bottomRing + i, bottomRing + (i + 1) % segments);
  if (length > 0) connect(ring(a, 0, 1, 0), ring(a, length, 1, 0));
  if (height > 0) {
    const radius = (a * a + height * height) / (2 * height), angle = 2 * Math.atan(height / a);
    let previous = -1;
    for (let j = 0; j < bands; j++) {
      const theta = angle * (1 - j / bands);
      // Stable even for a very shallow cap; no R-R*cos(theta) cancellation.
      const y = j === 0 ? length : length + height - 2 * radius * Math.sin(theta / 2) ** 2;
      const radial = j === 0 ? a : radius * Math.sin(theta);
      const current = ring(radial, y, Math.sin(theta), Math.cos(theta));
      if (previous >= 0) connect(previous, current);
      previous = current;
    }
    const apex = vertex(0, length + height, 0, 0, 1, 0);
    for (let i = 0; i < segments; i++) indices.push(previous + i, apex, previous + (i + 1) % segments);
  } else {
    const top = vertex(0, length, 0, 0, 1, 0), topRing = ring(a, length, 0, 1);
    for (let i = 0; i < segments; i++) indices.push(top, topRing + (i + 1) % segments, topRing + i);
  }
  const data = { positions: Float32Array.from(positions), normals: Float32Array.from(normals),
    indices: Uint32Array.from(indices), axialOpticalThicknessM: physicalAxialThicknessM,
    physicalAxialThicknessM, analyticVolumeM3 };
  if (!data.positions.every(Number.isFinite) || !data.normals.every(Number.isFinite))
    throw new RangeError("Attached runoff tessellation contains nonfinite attributes");
  const reconstructedVolumeM3 = closedTriangleVolumeM3(data.positions, data.indices);
  const relativeVolumeError = Math.abs(reconstructedVolumeM3 - analyticVolumeM3) / analyticVolumeM3;
  if (!Number.isFinite(relativeVolumeError) || reconstructedVolumeM3 <= 0)
    throw new RangeError("Attached runoff tessellation is nonfinite or inverted");
  return { ...data, resolved: true, reconstructedVolumeM3, relativeVolumeError,
    unresolvedVolumeM3: 0, unresolvedVolumeBoundM3: 0, segments, bands };
}

/** Same conservative cell-to-corner/fan reconstruction as physical contact.
 * Physical h includes all fluid; exactly dry vertices retain h=0.
 */
function validateCollectorDisplay(state: DryCollectorSnapshot) {
  const domain = state.domain, { widthM, depthM, nx, nz, originXM, originZM, collectionPlaneYM } = domain;
  validateTankGeometry({ widthM, depthM, nx, nz, heightM: 2 });
  if (![originXM, originZM, collectionPlaneYM, state.filmVolumeM3].every(Number.isFinite) ||
      state.filmVolumeM3 < 0 || state.initialFilmVolumeM3 !== 0)
    throw new RangeError("Collector requires a finite true-dry physical inventory");
  if (state.heightM.length !== nx * nz) throw new RangeError("Collector height field has the wrong dimensions");
  let physicalVolumeM3 = 0, exactlyDry = state.filmVolumeM3 === 0;
  for (const h of state.heightM) {
    if (!Number.isFinite(h) || h < 0 || h > 2) throw new RangeError("Invalid collector height");
    if (h !== 0) exactlyDry = false;
    physicalVolumeM3 += h * widthM * depthM / (nx * nz);
  }
  if (Math.abs(physicalVolumeM3 - state.filmVolumeM3) > Math.max(1e-20, state.filmVolumeM3 * 1e-10))
    throw new RangeError("Collector height and accepted inventory disagree");
  return exactlyDry;
}

function buildCollectorGeometry(state: DryCollectorSnapshot, reuse?: GeometryData) {
  const { widthM, depthM, nx, nz, originXM, originZM, collectionPlaneYM } = state.domain;
  const data = tankSurfaceData({ widthM, depthM, nx, nz, heightM: 2 }, state.heightM, reuse, .75,
    [0, 0, 0], true);
  let reconstructedVolumeM3 = 0;
  for (let i = 0; i < data.indices.length; i += 3) {
    const a = data.indices[i]! * 3, b = data.indices[i + 1]! * 3, c = data.indices[i + 2]! * 3;
    const areaMm2 = Math.abs((data.positions[b]! - data.positions[a]!) * (data.positions[c + 2]! - data.positions[a + 2]!) -
      (data.positions[b + 2]! - data.positions[a + 2]!) * (data.positions[c]! - data.positions[a]!)) / 2;
    reconstructedVolumeM3 += areaMm2 * (data.positions[a + 1]! + data.positions[b + 1]! + data.positions[c + 1]!) / 3e9;
  }
  if (Math.abs(reconstructedVolumeM3 - state.filmVolumeM3) > Math.max(1e-20, state.filmVolumeM3 * 5e-7))
    throw new RangeError("Displayed collector fan differs from accepted inventory");
  return { data, reconstructedVolumeM3, positionMm: new Vector3(
    (originXM + widthM / 2) * 1000, collectionPlaneYM * 1000, (originZM + depthM / 2) * 1000) };
}

export function dryCollectorGeometry(state: DryCollectorSnapshot, reuse?: GeometryData) {
  validateCollectorDisplay(state);
  return buildCollectorGeometry(state, reuse);
}

/** Product display preparation. An independently validated exact-zero field
 * has no wet geometry; its authoritative domain still positions the dry tray.
 * Any positive height retains the original conservative reconstruction.
 */
export function prepareDryCollectorDisplay(state: DryCollectorSnapshot) {
  if (!validateCollectorDisplay(state)) return buildCollectorGeometry(state);
  const { widthM, depthM, originXM, originZM, collectionPlaneYM } = state.domain;
  return { data: null, reconstructedVolumeM3: 0, positionMm: new Vector3(
    (originXM + widthM / 2) * 1000, collectionPlaneYM * 1000, (originZM + depthM / 2) * 1000) };
}
