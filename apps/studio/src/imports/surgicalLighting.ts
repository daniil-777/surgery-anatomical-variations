import { HemisphereLight, PCFSoftShadowMap, SpotLight, Vector3, type PerspectiveCamera, type Scene, type WebGLRenderer } from "three";

/** Camera-attached scope illumination. Intensity is normalized to the viewing
 * distance because imported units are arbitrary; this is not radiometric calibration. */
export function createSurgicalLighting(scene: Scene, renderer: WebGLRenderer, camera: PerspectiveCamera) {
  const ambient = new HemisphereLight(0xffeee7, 0x35212a, .68);
  const scope = new SpotLight(0xfff1e6, 1, 0, Math.PI / 3, .85, 2);
  scope.castShadow = true;
  scope.shadow.mapSize.set(2048, 2048);
  scope.shadow.bias = -.00008;
  scope.shadow.normalBias = .02;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = PCFSoftShadowMap;
  scene.add(ambient, scope, scope.target);
  const right = new Vector3(), up = new Vector3();
  let internal = false;
  return {
    setInternal(value: boolean) { internal = value; ambient.intensity = value ? .12 : .68; },
    update(target: Vector3, radius: number, workingDistance?: number) {
      const distance = workingDistance ?? camera.position.distanceTo(target);
      right.setFromMatrixColumn(camera.matrixWorld, 0); up.setFromMatrixColumn(camera.matrixWorld, 1);
      scope.position.copy(camera.position).addScaledVector(right, (internal ? distance * .015 : radius * .035)).addScaledVector(up, (internal ? distance * .01 : radius * .02));
      scope.target.position.copy(target);
      scope.intensity = distance * distance * (internal ? 3.4 : 4.0);
      scope.angle = Math.min(1.1, Math.atan(Math.tan(camera.fov * Math.PI / 360) * Math.max(1,camera.aspect)) * 1.35);
      scope.shadow.camera.near = Math.max(radius * (internal ? .0005 : .005), .000001);
      scope.shadow.camera.far = Math.max(distance + radius * 5, radius * 10);
      scope.shadow.normalBias = radius * (internal ? .0001 : .0008);
      scope.shadow.camera.updateProjectionMatrix();
    },
    dispose() { scene.remove(ambient,scope,scope.target); scope.shadow.dispose(); },
  };
}
