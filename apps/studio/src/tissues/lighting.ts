import * as THREE from "three";
import { RectAreaLightUniformsLib } from "three/examples/jsm/lights/RectAreaLightUniformsLib.js";
import type { TissueControls } from "./contracts";

/** Camera-mounted finite emitters. Dimensions use the same millimetre scene units as anatomy. */
export function createScopeLighting(scene: THREE.Scene) {
  RectAreaLightUniformsLib.init();
  const spot = new THREE.SpotLight(0xfff5ee, 6500, 250, 1.35, .85, 2);
  spot.castShadow = true; spot.shadow.mapSize.set(2048, 2048);
  spot.shadow.normalBias = .08; spot.shadow.bias = -.00015;
  spot.shadow.camera.near = .5; spot.shadow.camera.far = 250;
  const emitters = [new THREE.RectAreaLight(0xfff9f2, 85, 3.2, 4.5), new THREE.RectAreaLight(0xfff9f2, 55, 2.6, 3.6)];
  const fill = new THREE.HemisphereLight(0xffded3, 0x5e2220, .18);
  // A bounded, constant irradiance approximation for unresolved cavity interreflection.
  // This is not subsurface scattering, a measured BSSRDF, or ambient occlusion.
  const cavityFill = new THREE.AmbientLight(0xffded3, 0);
  scene.add(spot, spot.target, fill, cavityFill, ...emitters);
  const local = new THREE.Vector3(), forward = new THREE.Vector3();
  return {
    update(camera: THREE.PerspectiveCamera, controls: TissueControls, target: THREE.Vector3) {
      const inside = controls.view === "walkthrough", organ = controls.view === "organ", grazing = controls.view === "surface" && controls.lighting === "grazing";
      const dist = organ ? camera.position.distanceTo(target) : 0;
      const organDistanceScale = organ && Number.isFinite(dist) && dist > 10 ? Math.max(1, (dist / 230) ** 2) : 1;
      fill.intensity = inside ? 0 : organ ? .22 : .25;
      cavityFill.intensity = inside ? .50 : organ ? .36 : 0;
      spot.castShadow = !organ;
      spot.intensity = inside ? 2200 : organ ? 85000 * organDistanceScale : 8000;
      spot.distance = inside ? 250 : 0; spot.shadow.camera.far = inside ? 250 : 500; spot.shadow.camera.updateProjectionMatrix();
      if (grazing) spot.position.set(-55, 0, 16);
      else spot.position.copy(camera.position).add(local.set(2.5, 1.5, -.5).applyQuaternion(camera.quaternion));
      spot.target.position.copy(inside ? forward.copy(camera.position).add(camera.getWorldDirection(local).multiplyScalar(55)) : target);
      for (let i = 0; i < emitters.length; i++) {
        const emitter = emitters[i]!;
        emitter.position.copy(camera.position).add(local.set(i ? -3.4 : 3.4, i ? -.8 : 1.2, -1).applyQuaternion(camera.quaternion));
        emitter.quaternion.copy(camera.quaternion);
        emitter.intensity = inside ? (i ? 20 : 35) : (i ? 90 : 140);
        if (grazing) { emitter.position.set(-55, i ? -3 : 3, 16); emitter.lookAt(target); }
      }
    },
    dispose() { scene.remove(spot, spot.target, fill, cavityFill, ...emitters); spot.shadow.dispose(); },
  };
}
