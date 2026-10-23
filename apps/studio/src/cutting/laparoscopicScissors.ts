import * as THREE from "three";

/** Generic research instrument, not manufacturer CAD or a validated device.
 * Millimetres; hinge at the origin, jaws along +Z, shaft along -Z. The jaws
 * articulate about local X and separate along local Y. Opening is the total
 * aperture; each jaw rotates by half that angle. */
export const LAPAROSCOPIC_SCISSORS_DIMENSIONS = Object.freeze({
  jawLengthMm: 18,
  activeStartMm: 2.5,
  bladeThicknessMm: .6,
  bladeCenterOffsetMm: .34,
  maximumOpeningRadians: 44 * Math.PI / 180,
  shaftDiameterMm: 5,
  shaftLengthMm: 95,
  shaftFrontZMm: -6,
});

/** Median of the two facing cutting edges. The actual shear faces are at
 * X=+/-0.04 mm. Sweeping these radial edges through closure makes a finite
 * sector, not a rectangle-capped infinite wedge: Y²+Z² <= jawLengthMm².
 * A cut engine must also enforce activeStartMm and explicit user activation.
 * Merely animating this renderer never modifies tissue. */
export const LAPAROSCOPIC_SCISSORS_CUTTING_EDGE = Object.freeze({
  startMm: Object.freeze([0, 0, LAPAROSCOPIC_SCISSORS_DIMENSIONS.activeStartMm] as const),
  endMm: Object.freeze([0, 0, LAPAROSCOPIC_SCISSORS_DIMENSIONS.jawLengthMm] as const),
  normalLocal: Object.freeze([1, 0, 0] as const),
  shape: "radial-edge-closure-sector" as const,
});

export interface LaparoscopicScissors {
  readonly group: THREE.Group;
  setPose(positionMm: readonly [number, number, number], quaternion: readonly [number, number, number, number]): void;
  /** 0 is closed, 1 is the full declared aperture. Finite values are clamped. */
  setOpening(fraction: number): void;
  /** Only the proximal grip is hidden. Shaft, pivot and both blades remain. */
  setHandleVisible(visible: boolean): void;
  dispose(): void;
}

/** Closed, tapered steel blade with a curved spine and a straight cutting edge.
 * The bevel is part of the same watertight mesh, not an overlapping decal. */
function bladeGeometry(): THREE.BufferGeometry {
  const half = LAPAROSCOPIC_SCISSORS_DIMENSIONS.bladeThicknessMm / 2;
  const stations: readonly (readonly [number, number])[] = [[0, 1.3], [1.2, 1.65], [2.5, 1.95], [4, 2.1], [6, 2.15], [9, 2.1], [12, 1.9], [14.5, 1.55], [16, 1.15], [17.2, .65], [17.7, .34]];
  const rings = stations.map(([z, width]) => [
    new THREE.Vector3(-half, 0, z),
    new THREE.Vector3(half, Math.min(.45, width * .4), z),
    new THREE.Vector3(half, width, z),
    new THREE.Vector3(-half, width, z),
  ]);
  const triangles: number[][] = [[], []];
  const face = (points: THREE.Vector3[], polished: boolean) => {
    const buffer = triangles[polished ? 1 : 0]!;
    for (let i = 1; i < points.length - 1; i++) for (const point of [points[0]!, points[i]!, points[i + 1]!]) buffer.push(point.x, point.y, point.z);
  };
  face([...rings[0]!].reverse(), false);
  for (let station = 0; station < rings.length - 1; station++) for (let edge = 0; edge < 4; edge++) {
    const next = (edge + 1) % 4;
    face([rings[station]![edge]!, rings[station]![next]!, rings[station + 1]![next]!, rings[station + 1]![edge]!], edge === 0 && stations[station]![0]! >= LAPAROSCOPIC_SCISSORS_DIMENSIONS.activeStartMm);
  }
  const tip = new THREE.Vector3(-half, 0, LAPAROSCOPIC_SCISSORS_DIMENSIONS.jawLengthMm), last = rings.at(-1)!;
  for (let edge = 0; edge < 4; edge++) face([last[edge]!, last[(edge + 1) % 4]!, tip], edge === 0);
  const geometry = new THREE.BufferGeometry(), steelCount = triangles[0]!.length / 3;
  geometry.setAttribute("position", new THREE.Float32BufferAttribute([...triangles[0]!, ...triangles[1]!], 3));
  geometry.addGroup(0, steelCount, 0); geometry.addGroup(steelCount, triangles[1]!.length / 3, 1);
  geometry.computeVertexNormals(); geometry.computeBoundingBox(); geometry.computeBoundingSphere();
  return geometry;
}

export function createLaparoscopicScissors(): LaparoscopicScissors {
  const dimensions = LAPAROSCOPIC_SCISSORS_DIMENSIONS;
  const group = new THREE.Group(); group.name = "laparoscopic-scissors";
  group.userData = { units: "mm", dimensions: { ...dimensions }, hingeLocalMm: [0, 0, 0], shaftAxisLocal: [0, 0, -1],
    openingFraction: 0, openingRadians: 0, handleVisible: true, cuttingEdge: LAPAROSCOPIC_SCISSORS_CUTTING_EDGE,
    scope: "Articulated visual instrument; tissue modification belongs to the explicit cut engine.", manufacturerCad: false };
  const geometries = new Set<THREE.BufferGeometry>(), materials = new Set<THREE.Material>();
  const finish = (parameters: THREE.MeshPhysicalMaterialParameters) => { const material = new THREE.MeshPhysicalMaterial(parameters); materials.add(material); return material; };
  const steel = finish({ name: "scissors-satin-steel", color: "#b8c8d2", metalness: .94, roughness: .25, clearcoat: .15, envMapIntensity: 1.25 });
  const polish = finish({ name: "scissors-polished-cutting-edge", color: "#eef4f6", metalness: .98, roughness: .12, envMapIntensity: 1.5 });
  const darkSteel = finish({ name: "scissors-machined-recess", color: "#3c4c57", metalness: .88, roughness: .33, envMapIntensity: 1.1 });
  const insulation = finish({ name: "scissors-shaft-insulation", color: "#182831", metalness: .16, roughness: .38, clearcoat: .22, clearcoatRoughness: .3 });
  const grip = finish({ name: "scissors-charcoal-grip", color: "#29434f", metalness: .08, roughness: .47, clearcoat: .12 });
  const accent = finish({ name: "scissors-identification-band", color: "#639b9f", metalness: .45, roughness: .3 });
  const mesh = (parent: THREE.Object3D, geometry: THREE.BufferGeometry, material: THREE.Material | THREE.Material[], name: string) => {
    geometries.add(geometry); const object = new THREE.Mesh(geometry, material); object.name = name; object.castShadow = true; object.receiveShadow = true; parent.add(object); return object;
  };
  const cylinder = (parent: THREE.Object3D, radius: number, length: number, z: number, material: THREE.Material, name: string) => {
    const object = mesh(parent, new THREE.CylinderGeometry(radius, radius, length, 24), material, name); object.rotation.x = Math.PI / 2; object.position.z = z; return object;
  };
  const box = (parent: THREE.Object3D, size: [number, number, number], position: [number, number, number], material: THREE.Material, name: string) => {
    const object = mesh(parent, new THREE.BoxGeometry(...size), material, name); object.position.set(...position); return object;
  };
  const segment = (parent: THREE.Object3D, a: THREE.Vector3, b: THREE.Vector3, radius: number, material: THREE.Material, name: string) => {
    const object = mesh(parent, new THREE.CylinderGeometry(radius, radius, a.distanceTo(b), 16), material, name);
    object.position.copy(a).add(b).multiplyScalar(.5); object.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize()); return object;
  };
  const ring = (parent: THREE.Object3D, radius: number, thickness: number, z: number, material: THREE.Material, name: string) => {
    const object = mesh(parent, new THREE.TorusGeometry(radius, thickness, 8, 28), material, name); object.position.z = z; return object;
  };

  const shaft = new THREE.Group(); shaft.name = "scissors-shaft-and-pivot"; group.add(shaft);
  const rear = dimensions.shaftFrontZMm - dimensions.shaftLengthMm;
  cylinder(shaft, 2.43, dimensions.shaftLengthMm, (rear + dimensions.shaftFrontZMm) / 2, steel, "continuous-steel-shaft");
  cylinder(shaft, 2.5, 25, dimensions.shaftFrontZMm - 12.5, steel, "five-mm-distal-shaft");
  cylinder(shaft, 2.5, 70, rear + 35, insulation, "five-mm-insulated-shaft");
  cylinder(shaft, 2.55, 5.2, -4.2, steel, "distal-ferrule");
  for (const z of [-31, rear + 1]) ring(shaft, 2.48, .09, z, darkSteel, "insulation-end-seam");
  for (const z of [-12, -17, -22]) ring(shaft, 2.46, .055, z, darkSteel, "distal-depth-mark");
  for (const side of [-1, 1]) box(shaft, [.65, 3.7, 6.8], [side * 1.9, 0, -1.7], steel, "clevis-fork");
  const pivot = mesh(shaft, new THREE.CylinderGeometry(1.45, 1.45, 4.9, 24), polish, "scissors-hinge-pin"); pivot.rotation.z = Math.PI / 2;
  for (const side of [-1, 1]) {
    const pinCap = mesh(shaft, new THREE.CylinderGeometry(1.05, 1.05, .12, 20), darkSteel, "hinge-pin-cap"); pinCap.rotation.z = Math.PI / 2; pinCap.position.x = side * 2.51;
    const slot = box(shaft, [.025, .18, 1.05], [side * 2.58, 0, 0], steel, "hinge-pin-drive-slot"); slot.rotation.x = Math.PI / 5;
  }

  const blade = bladeGeometry(), hub = new THREE.CylinderGeometry(1.75, 1.75, .62, 24);
  const jaws: { pivot: THREE.Group; side: number }[] = [];
  for (const side of [1, -1]) {
    const jaw = new THREE.Group(); jaw.name = side > 0 ? "upper-scissors-jaw" : "lower-scissors-jaw"; jaw.position.x = side * dimensions.bladeCenterOffsetMm; group.add(jaw);
    const bladeMesh = mesh(jaw, blade, [steel, polish], "finite-scissors-blade"); bladeMesh.scale.set(side, side, 1);
    const jawHub = mesh(jaw, hub, steel, "articulated-blade-hub"); jawHub.rotation.z = Math.PI / 2;
    jaw.userData = { side, cuttingEdgeStartLocalMm: [-side * dimensions.bladeThicknessMm / 2, 0, dimensions.activeStartMm],
      cuttingEdgeEndLocalMm: [-side * dimensions.bladeThicknessMm / 2, 0, dimensions.jawLengthMm] };
    jaws.push({ pivot: jaw, side });
  }

  const handle = new THREE.Group(); handle.name = "scissors-proximal-handle"; handle.position.z = rear; group.add(handle);
  cylinder(handle, 4.8, 9, -4.5, grip, "rotation-collar");
  ring(handle, 4.85, .18, -4.5, accent, "rotation-collar-band");
  for (let i = 0; i < 12; i++) { const angle = i * Math.PI / 6; const rib = box(handle, [.55, .9, 6], [4.65 * Math.cos(angle), 4.65 * Math.sin(angle), -4.5], insulation, "rotation-collar-knurl"); rib.rotation.z = angle; }
  const housing = mesh(handle, new THREE.CapsuleGeometry(4.7, 11, 5, 16), grip, "grip-pivot-housing"); housing.rotation.x = Math.PI / 2; housing.position.z = -15;
  segment(handle, new THREE.Vector3(0, -1, -13), new THREE.Vector3(0, -18, -23), 3.1, grip, "fixed-palm-stem");
  const palmLoop = mesh(handle, new THREE.TorusGeometry(8.2, 1.9, 10, 32), grip, "fixed-finger-loop"); palmLoop.rotation.y = Math.PI / 2; palmLoop.position.set(0, -24, -25); palmLoop.scale.set(1, 1.15, 1);
  const trigger = new THREE.Group(); trigger.name = "articulated-scissors-trigger"; trigger.position.z = -10; handle.add(trigger);
  segment(trigger, new THREE.Vector3(0, -1, 0), new THREE.Vector3(0, -17, 9), 2.5, grip, "moving-trigger-stem");
  const triggerLoop = mesh(trigger, new THREE.TorusGeometry(7.8, 1.8, 10, 32), grip, "moving-finger-loop"); triggerLoop.rotation.y = Math.PI / 2; triggerLoop.position.set(0, -23, 10); triggerLoop.scale.set(1, 1.1, 1);
  const handlePin = mesh(handle, new THREE.CylinderGeometry(2.4, 2.4, 10.2, 20), steel, "handle-pivot-pin"); handlePin.rotation.z = Math.PI / 2; handlePin.position.z = -10;

  let disposed = false;
  const live = () => { if (disposed) throw new Error("Scissors renderer has been disposed"); };
  const setOpening = (fraction: number) => {
    live(); if (!Number.isFinite(fraction)) throw new Error("Scissors opening must be finite");
    const value = THREE.MathUtils.clamp(fraction, 0, 1), halfAngle = value * dimensions.maximumOpeningRadians / 2;
    for (const jaw of jaws) jaw.pivot.rotation.x = -jaw.side * halfAngle;
    trigger.rotation.x = .12 - value * .28; group.userData.openingFraction = value; group.userData.openingRadians = 2 * halfAngle;
  };
  setOpening(1);
  return {
    group,
    setPose(positionMm, quaternion) {
      live();
      if (positionMm.length !== 3 || quaternion.length !== 4 || ![...positionMm, ...quaternion].every(Number.isFinite)) throw new Error("Scissors pose must contain a finite position and quaternion");
      const norm = Math.hypot(...quaternion); if (!Number.isFinite(norm) || norm < 1e-12) throw new Error("Scissors orientation must be a nonzero finite quaternion");
      group.position.set(...positionMm); group.quaternion.set(quaternion[0] / norm, quaternion[1] / norm, quaternion[2] / norm, quaternion[3] / norm);
    },
    setOpening,
    setHandleVisible(visible) { live(); if (typeof visible !== "boolean") throw new Error("Scissors handle visibility must be boolean"); handle.visible = visible; group.userData.handleVisible = visible; },
    dispose() { if (disposed) return; disposed = true; group.removeFromParent(); for (const geometry of geometries) geometry.dispose(); for (const material of materials) material.dispose(); group.clear(); },
  };
}
