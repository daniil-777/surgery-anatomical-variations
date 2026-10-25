import * as THREE from "three";

export const ABDOMINAL_CAVITY_VERSION = "insufflated-peritoneal-enclosure/1";

/** Authored upper-abdominal working space, in the video's assumed millimetres.
 * This is an enclosing parietal surface, not recovered patient anatomy and not
 * a pressure-calibrated pneumoperitoneum simulation. The anterior dome creates
 * scope clearance while the posterior wall remains close to the organ bed.
 * See docs/research/virtamed/abdominal-cavity.md for evidence and limitations. */
export const VIDEO_CAVITY = {
  center: [0, -6, 38] as const,
  transverseRadiusMm: 255,
  superiorInferiorRadiusMm: 215,
  meanDepthRadiusMm: 222,
  anteriorLiftMm: 60,
} as const;

const gaussian = (x: number, width: number) => Math.exp(-((x / width) ** 2));

function cavityPoint(x: number, y: number, z: number): [number, number, number] {
  // Insufflation raises the anterior wall more than the supported posterior
  // plane. Broad shoulders avoid a spherical room and narrow superiorly.
  const width = VIDEO_CAVITY.transverseRadiusMm * (1 - .055 * y + .025 * z);
  const px = x * width;
  const py = VIDEO_CAVITY.center[1] + y * VIDEO_CAVITY.superiorInferiorRadiusMm;
  let pz = VIDEO_CAVITY.center[2] + z * (VIDEO_CAVITY.meanDepthRadiusMm + VIDEO_CAVITY.anteriorLiftMm * z);
  const posterior = THREE.MathUtils.smoothstep(-z, .05, .8);
  // Broad posterior support and shallow lateral reflection ridges. These are
  // regional shape cues rather than periodic corrugation over the entire dome.
  const lumbar = (gaussian(x - .31, .22) + gaussian(x + .34, .24)) * gaussian(y + .08, .72);
  const leftReflection = gaussian(x + .64 + .06 * Math.sin(y * 3), .055);
  const rightReflection = gaussian(x - .61 + .05 * Math.sin(y * 2 + .7), .065);
  const reflections = (leftReflection + rightReflection) * gaussian(y + .05, .85);
  pz += posterior * (5.2 * lumbar + 2.1 * reflections);
  // Sub-millimetre mesoscopic relief is strongest on the supported posterior
  // lining. Fine serosal relief and vessels belong in the material, not here.
  pz += posterior * .55 * Math.sin(px / 13 + Math.sin(py / 31)) * Math.sin(py / 17 + px / 53);
  return [px, py, pz];
}

/** Closed, welded manifold with inward-facing triangles and normals.
 * FrontSide rendering exposes the lining inside and gives a cutaway inspection
 * from outside. There is no duplicated longitude seam or degenerate pole fan. */
export function createAbdominalCavityGeometry(segments = 128, rings = 80) {
  if (!Number.isInteger(segments) || !Number.isInteger(rings) || segments < 16 || rings < 12 || segments > 512 || rings > 256) {
    throw new Error("Invalid abdominal cavity tessellation");
  }
  const points: number[] = [], indices: number[] = [];
  points.push(...cavityPoint(0, 1, 0));
  for (let row = 1; row < rings; row++) {
    const theta = Math.PI * row / rings, sine = Math.sin(theta), y = Math.cos(theta);
    for (let column = 0; column < segments; column++) {
      const phi = 2 * Math.PI * column / segments;
      points.push(...cavityPoint(sine * Math.cos(phi), y, sine * Math.sin(phi)));
    }
  }
  const bottom = points.length / 3;
  points.push(...cavityPoint(0, -1, 0));
  const vertex = (row: number, column: number) => 1 + row * segments + column % segments;
  for (let column = 0; column < segments; column++) {
    indices.push(0, vertex(0, column), vertex(0, column + 1));
    for (let row = 0; row < rings - 2; row++) {
      const a = vertex(row, column), b = vertex(row + 1, column), c = vertex(row, column + 1), d = vertex(row + 1, column + 1);
      indices.push(a, b, c, c, b, d);
    }
    indices.push(bottom, vertex(rings - 2, column + 1), vertex(rings - 2, column));
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(points, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  geometry.userData = {
    cavityVersion: ABDOMINAL_CAVITY_VERSION,
    orientation: "inward",
    enclosure: "closed parietal lining; anterior insufflation dome; posterior support",
    geometryEvidence: "authored inferred upper-abdominal enclosure; no patient segmentation or pressure calibration",
  };
  return geometry;
}
