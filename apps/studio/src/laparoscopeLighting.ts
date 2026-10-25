import * as THREE from "three";

export const LAPAROSCOPE_LIGHT_VERSION = "offset-fiber-illumination/1";
export const LAPAROSCOPE_EMITTERS = [
  { offsetMm: [-3.4, 1.1, 1.8], fraction: .62 },
  { offsetMm: [3.4, -.8, 1.8], fraction: .38 },
] as const;
export const LAPAROSCOPE_CONE = Math.PI / 3;
export const LAPAROSCOPE_SPREAD = 2.4;

/** Relative irradiance: angular fiber spread, inverse-square distance and
 * cosine incidence. Absolute source power/response remain authored pending
 * checkerboard photometric calibration of a particular laparoscope. */
export function laparoscopeIrradiance(distanceMm: number, emissionCosine = 1, incidenceCosine = 1, intensity = 1): number {
  if (![distanceMm, emissionCosine, incidenceCosine, intensity].every(Number.isFinite) || distanceMm <= 0 || intensity < 0) return 0;
  return intensity * (emissionCosine > 0 ? Math.exp(-LAPAROSCOPE_SPREAD * (1 - Math.min(1, emissionCosine))) : 0) * Math.max(0, Math.min(1, incidenceCosine)) / distanceMm ** 2;
}

function fiberSpreadTexture(): THREE.DataTexture {
  const side = 128, bytes = new Uint8Array(side * side * 4), tangent = Math.tan(LAPAROSCOPE_CONE);
  for (let y = 0; y < side; y++) for (let x = 0; x < side; x++) {
    const u = 2 * (x + .5) / side - 1, v = 2 * (y + .5) / side - 1;
    const cosine = 1 / Math.sqrt(1 + (u * u + v * v) * tangent * tangent);
    const value = Math.round(255 * Math.exp(-LAPAROSCOPE_SPREAD * (1 - cosine)));
    bytes.set([value, value, value, 255], (y * side + x) * 4);
  }
  const texture = new THREE.DataTexture(bytes, side, side);
  texture.magFilter = texture.minFilter = THREE.LinearFilter; texture.needsUpdate = true;
  return texture;
}

/** Two finite-offset fibers approximate the distal illumination aperture. They
 * remain attached to the camera, including roll. Both cast real scene shadows;
 * partial occlusion produces a softer penumbra instead of an image-space stain. */
export class LaparoscopeLighting {
  readonly lights: THREE.SpotLight[];
  private readonly spread = fiberSpreadTexture();
  private readonly position = new THREE.Vector3();
  private readonly forward = new THREE.Vector3();
  private readonly orientation = new THREE.Quaternion();
  private totalIntensity = 0;
  constructor(private scene: THREE.Scene, primary: THREE.SpotLight) {
    this.lights = [primary, new THREE.SpotLight()];
    for (const light of this.lights) {
      light.color.set(0xfffaf6); light.intensity = 0; light.decay = 2;
      light.distance = 0; light.angle = LAPAROSCOPE_CONE; light.penumbra = .12;
      light.map = this.spread; light.castShadow = true;
      light.shadow.mapSize.set(2048, 2048); light.shadow.camera.near = .5; light.shadow.camera.far = 1400;
      light.shadow.bias = -.000015; light.shadow.normalBias = .035; light.shadow.radius = 1.65;
      scene.add(light, light.target);
    }
  }
  update(camera: THREE.Camera, intensity: number): boolean {
    camera.updateMatrixWorld(); camera.getWorldQuaternion(this.orientation); camera.getWorldDirection(this.forward);
    let changed = intensity !== this.totalIntensity; this.totalIntensity = intensity;
    this.lights.forEach((light, i) => {
      const emitter = LAPAROSCOPE_EMITTERS[i]!;
      this.position.fromArray(emitter.offsetMm).applyQuaternion(this.orientation).add(camera.position);
      changed ||= !light.position.equals(this.position);
      light.position.copy(this.position); light.target.position.copy(this.position).addScaledVector(this.forward, 200);
      light.intensity = Math.max(0, intensity) * emitter.fraction;
      light.angle = LAPAROSCOPE_CONE;
    });
    // A rotation about a fixed position changes the shadow projections too.
    const direction = this.lights[0]!.userData.direction as THREE.Vector3 | undefined;
    changed ||= !direction?.equals(this.forward);
    this.lights[0]!.userData.direction = this.forward.clone();
    return changed;
  }
  snapshot() {
    return { version: LAPAROSCOPE_LIGHT_VERSION, calibration: "authored relative photometry; device calibration pending", inverseSquare: true, angularSpread: LAPAROSCOPE_SPREAD, totalIntensity: this.totalIntensity,
      emitters: this.lights.map((light, i) => ({ offsetMm: LAPAROSCOPE_EMITTERS[i]!.offsetMm, fraction: LAPAROSCOPE_EMITTERS[i]!.fraction, positionMm: light.position.toArray(), targetMm: light.target.position.toArray(), intensity: light.intensity, castsShadow: light.castShadow })) };
  }
  dispose() { this.spread.dispose(); for (const light of this.lights) { light.map = null; light.shadow.dispose(); this.scene.remove(light, light.target); } }
}
