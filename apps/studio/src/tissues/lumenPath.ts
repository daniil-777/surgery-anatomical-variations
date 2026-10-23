import * as THREE from "three";

const TAU = Math.PI * 2;
export const LUMEN_LENGTH_MM = 1600;
export const LUMEN_SPEED_MM_PER_SECOND = 18;
const PATH_STEPS = 1600;

export interface LumenFrame {
  position: THREE.Vector3;
  tangent: THREE.Vector3;
  normal: THREE.Vector3;
  binormal: THREE.Vector3;
}
export interface LumenPath {
  lengthMm: number;
  sample: (distanceMm: number) => LumenFrame;
}

/** Independent streams avoid adjacent-seed correlation and order-dependent random state. */
export function seededUnit(seed: number, stream: number): number {
  let value = (seed ^ Math.imul(stream + 1, 0x9e3779b9)) >>> 0;
  value = Math.imul(value ^ (value >>> 16), 0x21f0aaad);
  value = Math.imul(value ^ (value >>> 15), 0x735a2d97);
  return ((value ^ (value >>> 15)) >>> 0) / 4294967296;
}
export function periodic(value: number, period: number): number {
  return ((value % period) + period) % period;
}

/**
 * Closed authored centerline, uniformly sampled in millimetres. This is a repeatable
 * navigation phantom, not the topology or centerline of a human colon.
 * Double-reflection transport follows Wang et al., ACM TOG 2008:
 * https://www.cs.hku.hk/data/techreps/document/TR-2007-07.pdf
 * The small residual loop twist is distributed by arc length; endpoint frames agree.
 */
export function createLumenPath(seed: number, lengthMm = LUMEN_LENGTH_MM): LumenPath {
  if (!Number.isFinite(lengthMm) || lengthMm < 800 || lengthMm > 6400) throw new Error("Lumen path length must be 800–6400 mm");
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) throw new Error("Lumen seed must be a uint32");
  const phase = seededUnit(seed, 0) * TAU, phase2 = seededUnit(seed, 1) * TAU;
  const center = (u: number) => {
    const angle = u * TAU;
    return new THREE.Vector3(
      220 * Math.cos(angle) + 20 * Math.cos(3 * angle + phase),
      180 * Math.sin(angle) + 17 * Math.sin(2 * angle + phase2),
      28 * Math.sin(2 * angle + phase) + 11 * Math.sin(3 * angle + phase2),
    );
  };
  const derivative = (u: number) => {
    const angle = u * TAU;
    return new THREE.Vector3(
      -220 * Math.sin(angle) - 60 * Math.sin(3 * angle + phase),
      180 * Math.cos(angle) + 34 * Math.cos(2 * angle + phase2),
      56 * Math.cos(2 * angle + phase) + 33 * Math.cos(3 * angle + phase2),
    ).normalize();
  };
  const sourceSteps = 8192, arc = [0]; let previous = center(0);
  for (let i = 1; i <= sourceSteps; i++) {
    const next = center(i / sourceSteps);
    arc.push(arc[i - 1]! + next.distanceTo(previous)); previous = next;
  }
  const sourceLength = arc[sourceSteps]!, scale = lengthMm / sourceLength;
  const points: THREE.Vector3[] = [], tangents: THREE.Vector3[] = [], normals: THREE.Vector3[] = [], binormals: THREE.Vector3[] = [];
  let cursor = 0;
  for (let i = 0; i <= PATH_STEPS; i++) {
    const target = i / PATH_STEPS * sourceLength;
    while (cursor < sourceSteps - 1 && arc[cursor + 1]! < target) cursor++;
    const fraction = (target - arc[cursor]!) / (arc[cursor + 1]! - arc[cursor]!);
    const u = (cursor + fraction) / sourceSteps;
    points.push(center(u).multiplyScalar(scale)); tangents.push(derivative(u));
  }
  points[PATH_STEPS] = points[0]!.clone(); tangents[PATH_STEPS] = tangents[0]!.clone();
  const initialUp = Math.abs(tangents[0]!.y) < .9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(0, 0, 1);
  normals.push(initialUp.addScaledVector(tangents[0]!, -initialUp.dot(tangents[0]!)).normalize());
  for (let i = 1; i <= PATH_STEPS; i++) {
    const chord = points[i]!.clone().sub(points[i - 1]!), chordSquared = chord.lengthSq();
    const reflectedNormal = normals[i - 1]!.clone().addScaledVector(chord, -2 * chord.dot(normals[i - 1]!) / chordSquared);
    const reflectedTangent = tangents[i - 1]!.clone().addScaledVector(chord, -2 * chord.dot(tangents[i - 1]!) / chordSquared);
    const second = tangents[i]!.clone().sub(reflectedTangent), secondSquared = second.lengthSq();
    if (secondSquared > 1e-16) reflectedNormal.addScaledVector(second, -2 * second.dot(reflectedNormal) / secondSquared);
    normals.push(reflectedNormal.addScaledVector(tangents[i]!, -reflectedNormal.dot(tangents[i]!)).normalize());
  }
  const residual = Math.atan2(tangents[0]!.dot(normals[PATH_STEPS]!.clone().cross(normals[0]!)), normals[PATH_STEPS]!.dot(normals[0]!));
  for (let i = 0; i <= PATH_STEPS; i++) {
    normals[i]!.applyAxisAngle(tangents[i]!, residual * i / PATH_STEPS);
    binormals.push(tangents[i]!.clone().cross(normals[i]!).normalize());
  }
  normals[PATH_STEPS] = normals[0]!.clone(); binormals[PATH_STEPS] = binormals[0]!.clone();
  const step = lengthMm / PATH_STEPS;
  return {
    lengthMm,
    sample(distanceMm) {
      if (!Number.isFinite(distanceMm)) throw new Error("Lumen distance must be finite");
      const index = periodic(distanceMm, lengthMm) / step;
      const low = Math.min(PATH_STEPS - 1, Math.floor(index)), f = index - low, f2 = f * f, f3 = f2 * f;
      const position = points[low]!.clone().multiplyScalar(2 * f3 - 3 * f2 + 1)
        .addScaledVector(tangents[low]!, step * (f3 - 2 * f2 + f))
        .addScaledVector(points[low + 1]!, -2 * f3 + 3 * f2)
        .addScaledVector(tangents[low + 1]!, step * (f3 - f2));
      const tangent = points[low]!.clone().multiplyScalar(6 * f2 - 6 * f)
        .addScaledVector(tangents[low]!, step * (3 * f2 - 4 * f + 1))
        .addScaledVector(points[low + 1]!, -6 * f2 + 6 * f)
        .addScaledVector(tangents[low + 1]!, step * (3 * f2 - 2 * f)).normalize();
      const normal = normals[low]!.clone().lerp(normals[low + 1]!, f);
      normal.addScaledVector(tangent, -normal.dot(tangent)).normalize();
      return { position, tangent, normal, binormal: tangent.clone().cross(normal).normalize() };
    },
  };
}


export interface LumenCameraPose { position: THREE.Vector3; target: THREE.Vector3; up: THREE.Vector3 }
/** Inspect every direction without translating the camera out of its cleared path.
 * Quaternion composition and a rotated up vector remain well-defined at ±90° pitch.
 */
export function orientLumenCamera(pose: LumenCameraPose, yawDeg = 0, pitchDeg = 0): LumenCameraPose {
  if (!Number.isFinite(yawDeg) || !Number.isFinite(pitchDeg) || Math.abs(yawDeg) > 180 || Math.abs(pitchDeg) > 90) throw new Error("Inspection angles must be finite: yaw ±180°, pitch ±90°");
  if (yawDeg === 0 && pitchDeg === 0) return { position: pose.position.clone(), target: pose.target.clone(), up: pose.up.clone() };
  const distance = pose.position.distanceTo(pose.target);
  const base = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().lookAt(pose.position, pose.target, pose.up));
  const local = new THREE.Quaternion().setFromEuler(new THREE.Euler(THREE.MathUtils.degToRad(pitchDeg), THREE.MathUtils.degToRad(yawDeg), 0, "YXZ"));
  const orientation = base.multiply(local);
  return { position: pose.position.clone(), target: new THREE.Vector3(0, 0, -distance).applyQuaternion(orientation).add(pose.position), up: new THREE.Vector3(0, 1, 0).applyQuaternion(orientation) };
}
