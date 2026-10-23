/** Deterministic gross white-adipose specimens. Geometry is in millimetres.
 *
 * This is a procedural appearance model, not a patient segmentation or a
 * histological reconstruction. Positive radial / sectional fields preserve a
 * connected, closed surface; folds, lobules and shallow septal valleys resolve
 * at separate scales. No isolated spheres are assembled into the specimen.
 */
export type FatPreset = "subcutaneous" | "visceral" | "omental";
export type FatDimensions = readonly [number, number, number];
export const FAT_GENERATOR_VERSION = "viscera-fat-geometry-v3";

export interface FatGeometryConfig {
  preset: FatPreset;
  shapeSeed: number;
  /** Full xyz extents for pads/chunks. For omentum, xz sets the footprint;
   * legacy y scales the default local thickness, not the folded height. */
  dimensionsMm?: FatDimensions;
  /** Surface sampling bands; longitude count is twice this value. Omental
   * radial rings round half this count upward, including for odd values. */
  detail?: number;
  lobulation?: number;
  densityKgM3?: number;
  /** Omental nominal local thickness, before regional variation; 4 mm at default preset dimensions.
   * Other presets retain their dimensioned shape and ignore this sheet control. */
  thicknessMm?: number;
  /** Omental middle-sheet peak-to-trough fold height; 32 mm at default preset dimensions. */
  drapeMm?: number;
}

export interface FatGeometryStats {
  generatorVersion: typeof FAT_GENERATOR_VERSION;
  preset: FatPreset;
  shapeSeed: number;
  /** Actual measured bounds, including sheet drape. */
  dimensionsMm: [number, number, number];
  requestedDimensionsMm: [number, number, number];
  /** Authored controls, not measured anatomy. Null for non-sheet presets. */
  resolvedThicknessMm: number | null;
  resolvedDrapeMm: number;
  thicknessDefinition: "normal-projected-column" | "vertical-column" | "opposite-ray-chord";
  volumeMm3: number;
  surfaceAreaMm2: number;
  massGrams: number;
  densityKgM3: number;
  vertexCount: number;
  triangleCount: number;
  /** A topology guarantee of this construction, not an anatomical validation. */
  closed: true;
}

export interface FatGeometryData {
  positions: Float32Array;
  normals: Float32Array;
  /** Spherical coordinates. Prefer triplanar texturing to avoid polar stretch. */
  uvs: Float32Array;
  indices: Uint32Array;
  /** Shading proxy in mm. For omentum, the paired column gap projected onto
   * the middle-sheet normal; not a measured optical penetration distance.
   * For subcutaneous pads, vertical gap; for visceral chunks, opposite-ray chord. */
  thicknessMm: Float32Array;
  /** Exact paired vertical gap for patches; same as thicknessMm for chunks. */
  columnThicknessMm: Float32Array;
  stats: FatGeometryStats;
}

export const FAT_PRESET_DIMENSIONS: Record<FatPreset, FatDimensions> = {
  subcutaneous: [110, 28, 82],
  visceral: [92, 58, 76],
  omental: [150, 12, 114],
};

function hash(x: number, y: number, z: number, seed: number): number {
  let h = Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ Math.imul(z, 2147483647) ^ seed;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
const smooth = (t: number) => t * t * (3 - 2 * t);
const mix = (a: number, b: number, t: number) => a + (b - a) * t;

function noise(x: number, y: number, z: number, seed: number): number {
  const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z);
  const tx = smooth(x - ix), ty = smooth(y - iy), tz = smooth(z - iz);
  return mix(
    mix(mix(hash(ix, iy, iz, seed), hash(ix + 1, iy, iz, seed), tx), mix(hash(ix, iy + 1, iz, seed), hash(ix + 1, iy + 1, iz, seed), tx), ty),
    mix(mix(hash(ix, iy, iz + 1, seed), hash(ix + 1, iy, iz + 1, seed), tx), mix(hash(ix, iy + 1, iz + 1, seed), hash(ix + 1, iy + 1, iz + 1, seed), tx), ty), tz,
  );
}

/**
 * A sum of compact C² kernels forms rounded connected lobules. Using nearest
 * distance directly creates a conical tip at every centre; subtracting F2−F1
 * produces sharp creases wherever the nearest feature changes. These kernels
 * instead have zero slope at their centres and two continuous derivatives at
 * their support boundary. Overlapping lobules share softly rounded valleys.
 *
 * Every support radius is <= 1.05 lattice units. Features omitted by this 3³
 * neighbourhood are at least 1.15 units away, so entering/leaving the search
 * window cannot cause a field discontinuity.
 */
function lobuleField(x: number, y: number, z: number, seed: number): number {
  const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z);
  let field = 0;
  for (let dz = -1; dz <= 1; dz++) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    const cx = ix + dx, cy = iy + dy, cz = iz + dz;
    const px = cx + .15 + .7 * hash(cx, cy, cz, seed) - x;
    const py = cy + .15 + .7 * hash(cx, cy, cz, seed ^ 0x3f7a17) - y;
    const pz = cz + .15 + .7 * hash(cx, cy, cz, seed ^ 0x1bc93e) - z;
    const support = .93 + .12 * hash(cx, cy, cz, seed ^ 0x713fde);
    const q = Math.max(0, 1 - (px * px + py * py + pz * pz) / (support * support));
    field += q * q * q * (.85 + .3 * hash(cx, cy, cz, seed ^ 0x2b71a3));
  }
  return .9 * Math.tanh(field * 1.1 - .65);
}

function validate(config: FatGeometryConfig): void {
  if (!Object.hasOwn(FAT_PRESET_DIMENSIONS, config.preset)) throw new RangeError("Unknown fat preset");
  if (!Number.isSafeInteger(config.shapeSeed)) throw new RangeError("shapeSeed must be a safe integer");
  if (config.detail !== undefined && (!Number.isInteger(config.detail) || config.detail < 12 || config.detail > 192)) throw new RangeError("detail must be an integer from 12 to 192");
  if (config.lobulation !== undefined && (!Number.isFinite(config.lobulation) || config.lobulation < 0 || config.lobulation > 1.5)) throw new RangeError("lobulation must be from 0 to 1.5");
  if (config.densityKgM3 !== undefined && (!Number.isFinite(config.densityKgM3) || config.densityKgM3 <= 0 || config.densityKgM3 > 2000)) throw new RangeError("densityKgM3 must be positive and no greater than 2000");
  if (config.thicknessMm !== undefined && (!Number.isFinite(config.thicknessMm) || config.thicknessMm < .1 || config.thicknessMm > 1000)) throw new RangeError("thicknessMm must be from 0.1 to 1000 mm");
  if (config.drapeMm !== undefined && (!Number.isFinite(config.drapeMm) || config.drapeMm < 0 || config.drapeMm > 1000)) throw new RangeError("drapeMm must be from 0 to 1000 mm");
  if (config.dimensionsMm && (config.dimensionsMm.length !== 3 || config.dimensionsMm.some((value) => !Number.isFinite(value) || value < 1 || value > 1000))) throw new RangeError("dimensionsMm must contain three values from 1 to 1000 mm");
}

export function generateFatGeometry(config: FatGeometryConfig): FatGeometryData {
  validate(config);
  const dimensions = config.dimensionsMm ?? FAT_PRESET_DIMENSIONS[config.preset];
  if (config.preset === "omental") return generateOmentalSheet(config, dimensions);
  const latitudes = config.detail ?? 72, longitudes = latitudes * 2;
  const lobulation = config.lobulation ?? 1, seed = config.shapeSeed | 0;
  const count = 2 + (latitudes - 1) * longitudes;
  const positions = new Float32Array(count * 3), normals = new Float32Array(count * 3), uvs = new Float32Array(count * 2);
  const indices = new Uint32Array(6 * longitudes * (latitudes - 1));
  const minimum = [Infinity, Infinity, Infinity], maximum = [-Infinity, -Infinity, -Infinity];
  const phase = hash(seed, 0, 0, 7831) * Math.PI * 2;
  const tilt = hash(seed, 0, 0, 9323) * Math.PI * 2;
  const ca = Math.cos(phase), sa = Math.sin(phase), cb = Math.cos(tilt), sb = Math.sin(tilt);
  const lobuleSizeMm = Math.max(...dimensions) / 10.4;
  const patchLobuleSizeMm = Math.max(dimensions[0], dimensions[2]) / 17.6;
  // A few overlapping broad pads establish asymmetric gross shape; the smaller
  // field then supplies lobules within those pads. Compact smooth kernels keep
  // shared valleys rounded rather than making detached balls or angular seams.
  const padCount = 4 + Math.floor(hash(seed, 4, 0, 4513) * 3);
  const grossPads = Array.from({ length: padCount }, (_, i) => {
    const y = -1 + 2 * (i + .5) / padCount;
    const angle = i * 2.399963229728653 + phase;
    const r = Math.sqrt(1 - y * y);
    const x = r * Math.cos(angle), z = r * Math.sin(angle);
    return { x: ca * x - sa * z, y: cb * y - sb * (sa * x + ca * z), z: sb * y + cb * (sa * x + ca * z),
      width: .8 + .3 * hash(seed, i, 1, 7129), height: .18 + .2 * hash(seed, i, 2, 7919) };
  });

  function vertex(index: number, theta: number, phi: number, u: number, v: number): void {
    const s = Math.sin(theta), nx = s * Math.cos(phi), ny = Math.cos(theta), nz = s * Math.sin(phi);
    const macro = noise(nx * 1.7 + 9, ny * 1.7 + 7, nz * 1.7 + 5, seed) - .5;
    // Sample in specimen space before a seed-dependent rotation. Sampling an
    // unrotated unit sphere stretches every lobule with the ellipsoid and
    // makes lattice planes show up as horizontal shelves on flattened pads.
    const px = nx * dimensions[0] * .5 / lobuleSizeMm, py = ny * dimensions[1] * .5 / lobuleSizeMm, pz = nz * dimensions[2] * .5 / lobuleSizeMm;
    const lx = ca * px - sa * pz, rz = sa * px + ca * pz, ly = cb * py - sb * rz, lz = sb * py + cb * rz;
    const middle = config.preset === "visceral" ? lobuleField(lx + 12, ly + 5, lz + 9, seed ^ 7919) : 0;
    const secondary = config.preset === "visceral" ? lobuleField(lx * 2 + 31, ly * 2 + 47, lz * 2 + 19, seed ^ 31847) : 0;
    const fine = noise(lx * 4.5 + 30, ly * 4.5 + 30, lz * 4.5 + 30, seed ^ 17389) - .5;
    // A bounded positive radial graph cannot detach lobules or self-intersect.
    // A weaker, independent second scale restores small fat lobules beneath
    // larger shared mounds without sharpening their peaks or septal valleys.
    let broadPads = 0;
    if (config.preset === "visceral") for (const pad of grossPads) {
      const q = Math.max(0, 1 - ((nx - pad.x) ** 2 + (ny - pad.y) ** 2 + (nz - pad.z) ** 2) / (pad.width * pad.width));
      broadPads += pad.height * q * q * q;
    }
    const radius = config.preset === "visceral"
      ? .88 + broadPads + .2 * macro + lobulation * (.13 * middle + .024 * secondary + .01 * fine)
      : 1 + .32 * macro;
    const values = [nx * dimensions[0] * radius * .5, ny * dimensions[1] * radius * .5, nz * dimensions[2] * radius * .5];
    if (config.preset !== "visceral") {
      // Thin specimens need relief through their thickness, rather than an
      // ellipsoid's radial ripples (which become terraced, folded-over rims).
      // One positive boundary radius per azimuth gives a star-shaped disk;
      // positive upper/lower thickness graphs meet only at its perimeter.
      const boundaryNoise = noise(Math.cos(phi) * 2 + 9, 7, Math.sin(phi) * 2 + 5, seed) - .5;
      const outline = 1 + .16 * boundaryNoise + .045 * Math.sin(3 * phi + phase);
      const ux = nx * dimensions[0] * .5 / patchLobuleSizeMm, uz = nz * dimensions[2] * .5 / patchLobuleSizeMm;
      const qx = ca * ux - sa * uz, qz = sa * ux + ca * uz;
      const patchLobule = lobuleField(qx + 12, ny * .45 + 5, qz + 9, seed ^ 7919);
      const patchSecondary = lobuleField(qx * 2 + 31, ny * .7 + 47, qz * 2 + 19, seed ^ 31847);
      const thickness = Math.max(.28, 1 + .24 * macro + lobulation * (.48 * patchLobule + .12 * patchSecondary + .035 * fine));
      values[0] = nx * dimensions[0] * outline * .5;
      values[2] = nz * dimensions[2] * outline * .5;
      values[1] = ny * dimensions[1] * thickness * .5;
    }
    for (let axis = 0; axis < 3; axis++) {
      positions[index * 3 + axis] = values[axis]!;
      // Normalize the coordinates actually stored in Float32, not their
      // unrounded intermediates; otherwise large specimens retain a tiny
      // translation and dimension error after the final bounds transform.
      const stored = positions[index * 3 + axis]!;
      minimum[axis] = Math.min(minimum[axis]!, stored);
      maximum[axis] = Math.max(maximum[axis]!, stored);
    }
    uvs[index * 2] = u; uvs[index * 2 + 1] = v;
  }

  vertex(0, 0, 0, .5, 0);
  for (let latitude = 1; latitude < latitudes; latitude++) for (let longitude = 0; longitude < longitudes; longitude++) {
    vertex(1 + (latitude - 1) * longitudes + longitude, latitude / latitudes * Math.PI, longitude / longitudes * Math.PI * 2, longitude / longitudes, latitude / latitudes);
  }
  vertex(count - 1, Math.PI, 0, .5, 1);
  // Match measured bounds, not just the undeformed ellipsoid's nominal radius.
  for (let i = 0; i < count; i++) for (let axis = 0; axis < 3; axis++) {
    positions[i * 3 + axis] = (positions[i * 3 + axis]! - (minimum[axis]! + maximum[axis]!) * .5) * dimensions[axis]! / (maximum[axis]! - minimum[axis]!);
  }
  let cursor = 0;
  const triangle = (a: number, b: number, c: number) => { indices[cursor++] = a; indices[cursor++] = b; indices[cursor++] = c; };
  for (let longitude = 0; longitude < longitudes; longitude++) {
    const next = (longitude + 1) % longitudes;
    triangle(0, 1 + next, 1 + longitude);
    for (let latitude = 0; latitude < latitudes - 2; latitude++) {
      const a = 1 + latitude * longitudes + longitude, b = 1 + latitude * longitudes + next;
      triangle(a, b, a + longitudes); triangle(b, b + longitudes, a + longitudes);
    }
    const last = 1 + (latitudes - 2) * longitudes;
    triangle(last + longitude, last + next, count - 1);
  }

  const thicknessMm = new Float32Array(count), columnThicknessMm = new Float32Array(count);
  for (let vertex = 0; vertex < count; vertex++) {
    const latitude = vertex === 0 ? 0 : vertex === count - 1 ? latitudes : Math.floor((vertex - 1) / longitudes) + 1;
    const longitude = vertex === 0 || vertex === count - 1 ? 0 : (vertex - 1) % longitudes;
    const oppositeLongitude = config.preset === "visceral" ? (longitude + longitudes / 2) % longitudes : longitude;
    const opposite = latitude === 0 ? count - 1 : latitude === latitudes ? 0 : 1 + (latitudes - latitude - 1) * longitudes + oppositeLongitude;
    const a = vertex * 3, b = opposite * 3;
    thicknessMm[vertex] = config.preset === "visceral"
      ? Math.hypot(positions[a]! - positions[b]!, positions[a + 1]! - positions[b + 1]!, positions[a + 2]! - positions[b + 2]!)
      : Math.abs(positions[a + 1]! - positions[b + 1]!);
    columnThicknessMm[vertex] = thicknessMm[vertex]!;
  }
  return finishGeometry(config, dimensions, positions, normals, uvs, indices, thicknessMm, columnThicknessMm,
    [...dimensions], null, 0, config.preset === "visceral" ? "opposite-ray-chord" : "vertical-column");
}

/**
 * Two height graphs over exactly the same triangulated star-shaped disk.
 * They share only the perimeter, and the top height is strictly greater than
 * the bottom at every interior vertex. Barycentric interpolation preserves
 * that ordering throughout every triangle. Together with the nonoverlapping
 * projected disk triangulation, this prevents self-intersections, including
 * at extreme fold amplitudes; no independent top/bottom remeshing is used.
 *
 * The normal projection compensates vertical gaps on steep slopes without
 * offsetting x/z. Normal offsets can intersect when thickness exceeds a fold's
 * curvature radius; the graph shell does not have that failure mode. This is
 * an authored thickness proxy, not an exact nearest-surface/optical distance.
 */
function generateOmentalSheet(config: FatGeometryConfig, dimensions: FatDimensions): FatGeometryData {
  const rings = Math.ceil((config.detail ?? 72) / 2), longitudes = (config.detail ?? 72) * 2;
  const diskCount = 1 + rings * longitudes, interiorCount = 1 + (rings - 1) * longitudes;
  const count = diskCount + interiorCount;
  const positions = new Float32Array(count * 3), normals = new Float32Array(count * 3), uvs = new Float32Array(count * 2);
  const thicknessMm = new Float32Array(count), columnThicknessMm = new Float32Array(count);
  const indices = new Uint32Array(6 * longitudes * (2 * rings - 1));
  const middle = new Float64Array(diskCount), slopeCorrection = new Float64Array(diskCount), rawGap = new Float64Array(diskCount);
  const seed = config.shapeSeed | 0, lobulation = config.lobulation ?? 1;
  const scale = Math.sqrt(dimensions[0] / 150 * dimensions[2] / 114);
  const nominalThickness = config.thicknessMm ?? 4 * dimensions[1] / 12;
  const drape = config.drapeMm ?? 32 * scale;
  const phase = hash(seed, 0, 0, 7831) * Math.PI * 2;
  const phase2 = hash(seed, 1, 0, 9323) * Math.PI * 2;
  const phase3 = hash(seed, 2, 0, 7321) * Math.PI * 2;
  const ca = Math.cos(phase), sa = Math.sin(phase);
  const bounds = [[Infinity, -Infinity], [Infinity, -Infinity]];
  // A positive radial outline plus monotonic concentric radii makes each
  // projected sector a disjoint triangle fan, even for very irregular rims.
  for (let i = 0; i < diskCount; i++) {
    const ring = i === 0 ? 0 : Math.floor((i - 1) / longitudes) + 1;
    const phi = i === 0 ? 0 : (i - 1) % longitudes / longitudes * Math.PI * 2;
    const r = Math.sin(ring / rings * Math.PI * .5);
    const irregularity = noise(Math.cos(phi) * 2 + 9, 7, Math.sin(phi) * 2 + 5, seed) - .5;
    const outline = 1 + .18 * irregularity + .105 * Math.sin(3 * phi + phase) + .07 * Math.sin(5 * phi - phase2) + .055 * Math.cos(phi - phase3);
    const x = r * Math.cos(phi) * outline * dimensions[0] * .5;
    const z = r * Math.sin(phi) * outline * dimensions[2] * .5;
    positions[i * 3] = x; positions[i * 3 + 2] = z;
    for (const [axis, value] of [[0, positions[i * 3]!], [1, positions[i * 3 + 2]!]]) {
      bounds[axis!]![0] = Math.min(bounds[axis!]![0]!, value!); bounds[axis!]![1] = Math.max(bounds[axis!]![1]!, value!);
    }
  }
  // Unequal, nonparallel broad folds, with a localized secondary fold and a
  // shallow saddle. This is deliberately not a periodic curtain corrugation.
  const fold = (u: number, v: number): number => {
    const a = ca * u - sa * v, b = sa * u + ca * v;
    const localized = Math.exp(-1.6 * ((a + .28) ** 2 + (b - .33) ** 2));
    return .59 * Math.sin(2.65 * a + .65 * Math.sin(1.7 * b + phase2) + phase)
      + .28 * Math.sin(2.15 * b - .7 * a + phase3)
      + .17 * Math.sin(4.3 * (a + .2 * b) + phase2) * localized + .16 * a * b;
  };
  let middleMin = Infinity, middleMax = -Infinity;
  for (let i = 0; i < diskCount; i++) {
    positions[i * 3] = (positions[i * 3]! - (bounds[0]![0]! + bounds[0]![1]!) * .5) * dimensions[0] / (bounds[0]![1]! - bounds[0]![0]!);
    positions[i * 3 + 2] = (positions[i * 3 + 2]! - (bounds[1]![0]! + bounds[1]![1]!) * .5) * dimensions[2] / (bounds[1]![1]! - bounds[1]![0]!);
    const u = 2 * positions[i * 3]! / dimensions[0], v = 2 * positions[i * 3 + 2]! / dimensions[2];
    middle[i] = fold(u, v);
    middleMin = Math.min(middleMin, middle[i]!); middleMax = Math.max(middleMax, middle[i]!);
  }
  const foldScale = drape / (middleMax - middleMin), foldCentre = (middleMax + middleMin) * .5;
  const lobuleSizeMm = Math.max(dimensions[0], dimensions[2]) / 19;
  let yMin = Infinity, yMax = -Infinity;
  for (let i = 0; i < diskCount; i++) {
    const x = positions[i * 3]!, z = positions[i * 3 + 2]!;
    const u = 2 * x / dimensions[0], v = 2 * z / dimensions[2];
    const epsilon = .0001;
    const dx = (fold(u + epsilon, v) - fold(u - epsilon, v)) * foldScale / (epsilon * dimensions[0]);
    const dz = (fold(u, v + epsilon) - fold(u, v - epsilon)) * foldScale / (epsilon * dimensions[2]);
    const correction = Math.hypot(1, dx, dz);
    const qx = (ca * x - sa * z) / lobuleSizeMm, qz = (sa * x + ca * z) / lobuleSizeMm;
    // Regions of thinner, quieter membrane bridge connected lobulated pads.
    const region = noise(u * 1.7 + 7, 3, v * 1.7 + 11, seed ^ 0x3ac19);
    const primary = lobuleField(qx + 12, 5, qz + 9, seed ^ 7919);
    const secondary = lobuleField(qx * 2 + 31, 47, qz * 2 + 19, seed ^ 31847);
    const variation = Math.max(.3, .76 + .5 * region + lobulation * (.94 * primary + .19 * secondary) * (.45 + .75 * region));
    const ring = i === 0 ? 0 : Math.floor((i - 1) / longitudes) + 1;
    const r = Math.sin(ring / rings * Math.PI * .5);
    // A rounded narrow rim, not an ellipsoidal taper throughout the apron.
    const rimWidth = Math.min(.24, Math.max(.045, nominalThickness / Math.min(dimensions[0], dimensions[2]) * 1.3));
    const rim = Math.max(0, (r - (1 - rimWidth)) / rimWidth);
    const taper = Math.sqrt(Math.max(0, 1 - rim * rim));
    const gap = i >= interiorCount ? 0 : nominalThickness * variation * taper * correction;
    middle[i] = (middle[i]! - foldCentre) * foldScale;
    slopeCorrection[i] = correction; rawGap[i] = gap;
    const top = middle[i]! + gap * .5, bottom = middle[i]! - gap * .5;
    yMin = Math.min(yMin, bottom); yMax = Math.max(yMax, top);
    positions[i * 3 + 1] = top;
    uvs[i * 2] = u * .5 + .5; uvs[i * 2 + 1] = v * .5 + .5;
    if (i < interiorCount) {
      const other = diskCount + i;
      positions[other * 3] = x; positions[other * 3 + 1] = bottom; positions[other * 3 + 2] = z;
      uvs[other * 2] = uvs[i * 2]!; uvs[other * 2 + 1] = uvs[i * 2 + 1]!;
    }
  }
  // Translation only: drape and local thickness are never rescaled to y input.
  const yCentre = (yMin + yMax) * .5;
  for (let i = 0; i < diskCount; i++) {
    positions[i * 3 + 1] = middle[i]! + rawGap[i]! * .5 - yCentre;
    if (i < interiorCount) {
      const other = diskCount + i;
      positions[other * 3 + 1] = middle[i]! - rawGap[i]! * .5 - yCentre;
      const gap = positions[i * 3 + 1]! - positions[other * 3 + 1]!;
      columnThicknessMm[i] = gap; columnThicknessMm[other] = gap;
      thicknessMm[i] = gap / slopeCorrection[i]!; thicknessMm[other] = thicknessMm[i]!;
    }
  }
  let cursor = 0;
  const bottomIndex = (i: number) => i < interiorCount ? diskCount + i : i;
  const face = (a: number, b: number, c: number): void => {
    indices[cursor++] = a; indices[cursor++] = b; indices[cursor++] = c;
    indices[cursor++] = bottomIndex(a); indices[cursor++] = bottomIndex(c); indices[cursor++] = bottomIndex(b);
  };
  for (let longitude = 0; longitude < longitudes; longitude++) {
    const next = (longitude + 1) % longitudes;
    face(0, 1 + next, 1 + longitude);
    for (let ring = 1; ring < rings; ring++) {
      const a = 1 + (ring - 1) * longitudes + longitude, b = 1 + (ring - 1) * longitudes + next;
      face(a, b, a + longitudes); face(b, b + longitudes, a + longitudes);
    }
  }
  let measuredYMin = Infinity, measuredYMax = -Infinity;
  for (let i = 1; i < positions.length; i += 3) {
    measuredYMin = Math.min(measuredYMin, positions[i]!); measuredYMax = Math.max(measuredYMax, positions[i]!);
  }
  return finishGeometry(config, dimensions, positions, normals, uvs, indices, thicknessMm, columnThicknessMm,
    [dimensions[0], measuredYMax - measuredYMin, dimensions[2]], nominalThickness, drape, "normal-projected-column");
}

function finishGeometry(
  config: FatGeometryConfig, requestedDimensions: FatDimensions,
  positions: Float32Array, normals: Float32Array, uvs: Float32Array, indices: Uint32Array,
  thicknessMm: Float32Array, columnThicknessMm: Float32Array,
  dimensions: [number, number, number], resolvedThicknessMm: number | null, resolvedDrapeMm: number,
  thicknessDefinition: FatGeometryStats["thicknessDefinition"],
): FatGeometryData {
  let signedVolume = 0, area = 0;
  for (let i = 0; i < indices.length; i += 3) {
    const ai = indices[i]! * 3, bi = indices[i + 1]! * 3, ci = indices[i + 2]! * 3;
    const ax = positions[ai]!, ay = positions[ai + 1]!, az = positions[ai + 2]!;
    const bx = positions[bi]!, by = positions[bi + 1]!, bz = positions[bi + 2]!;
    const cx = positions[ci]!, cy = positions[ci + 1]!, cz = positions[ci + 2]!;
    const ux = bx - ax, uy = by - ay, uz = bz - az, vx = cx - ax, vy = cy - ay, vz = cz - az;
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    area += .5 * Math.hypot(nx, ny, nz);
    signedVolume += (ax * (by * cz - bz * cy) + ay * (bz * cx - bx * cz) + az * (bx * cy - by * cx)) / 6;
    for (const vi of [ai, bi, ci]) { normals[vi] = normals[vi]! + nx; normals[vi + 1] = normals[vi + 1]! + ny; normals[vi + 2] = normals[vi + 2]! + nz; }
  }
  for (let i = 0; i < normals.length; i += 3) {
    const length = Math.hypot(normals[i]!, normals[i + 1]!, normals[i + 2]!);
    normals[i] = normals[i]! / length; normals[i + 1] = normals[i + 1]! / length; normals[i + 2] = normals[i + 2]! / length;
  }
  const densityKgM3 = config.densityKgM3 ?? 920;
  return { positions, normals, uvs, indices, thicknessMm, columnThicknessMm, stats: {
    generatorVersion: FAT_GENERATOR_VERSION, preset: config.preset, shapeSeed: config.shapeSeed, dimensionsMm: [...dimensions],
    requestedDimensionsMm: [...requestedDimensions], resolvedThicknessMm, resolvedDrapeMm, thicknessDefinition,
    volumeMm3: signedVolume, surfaceAreaMm2: area, densityKgM3,
    massGrams: signedVolume * densityKgM3 * 1e-6,
    vertexCount: positions.length / 3, triangleCount: indices.length / 3, closed: true,
  } };
}
