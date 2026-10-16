import * as THREE from "three";

export type LaparoscopicInstrumentKind = "grasper" | "probe";

/** Millimetres. Origin is the nominal distal contact; shaft points along +Z.
 * The probe's sphere centre is (0, 0, contactRadiusMm), not the origin.
 * Grasper jaws open along local X and articulate about local Y.
 */
export interface LaparoscopicInstrument {
  readonly kind: LaparoscopicInstrumentKind;
  readonly group: THREE.Group;
  setJawClosure(closure: number): void;
  setContactRadius(radiusMm: number): void;
  dispose(): void;
}

/** Generic visual instrument, not a manufacturer CAD model or collision mesh.
 * Design references: 5 mm insulated shafts, hollow atraumatic jaws and pistol
 * grips in https://www.karlstorz.com/us/en/product-detail-page.htm?cat=1000209314&productID=1000125035
 * and Aesculap's fenestrated graspers:
 * https://www.aesculapusa.com/content/dam/aesculap-us/us/website/aesculap-inc/healthcareprofessionals/or-soultions/pdfs/24-0046%20Laparoscopic%20Catalog.pdf
 * The working length is shortened to 240 mm for this close-up research room.
 * These articulated visuals do not add rigid tool/tissue collision constraints.
 */
export function createLaparoscopicInstrument(kind: LaparoscopicInstrumentKind): LaparoscopicInstrument {
  const group = new THREE.Group(); group.name = `laparoscopic-${kind}`;
  group.userData = { kind, units: "mm", distalContactLocal: [0, 0, 0], shaftAxisLocal: [0, 0, 1], jawClosure: 0, contactRadiusMm: kind === "probe" ? 6 : 0 };
  const geometries = new Set<THREE.BufferGeometry>();
  const materials: THREE.Material[] = [];
  const material = (options: THREE.MeshPhysicalMaterialParameters) => {
    const value = new THREE.MeshPhysicalMaterial(options); materials.push(value); return value;
  };
  const steel = material({ color: "#c7d4dc", metalness: 0.93, roughness: 0.22, clearcoat: 0.22, clearcoatRoughness: 0.18, envMapIntensity: 1.3 });
  const satin = material({ color: "#93a5b1", metalness: 0.85, roughness: 0.33, envMapIntensity: 1.1 });
  const chrome = material({ color: "#e1e8eb", metalness: 0.96, roughness: 0.13, clearcoat: 0.3, envMapIntensity: 1.35 });
  const sleeve = material({ color: "#233845", metalness: 0.24, roughness: 0.38, clearcoat: 0.18 });
  const grip = material({ color: "#315367", metalness: 0.15, roughness: 0.45, clearcoat: 0.12 });
  const inset = material({ color: "#12232d", metalness: 0.18, roughness: 0.56 });
  const accent = material({ color: "#4a9ab8", metalness: 0.4, roughness: 0.3 });
  const mesh = (parent: THREE.Object3D, geometry: THREE.BufferGeometry, finish: THREE.Material, name: string) => {
    geometries.add(geometry); const object = new THREE.Mesh(geometry, finish);
    object.name = name; object.castShadow = true; object.receiveShadow = true; parent.add(object); return object;
  };
  const cylinder = (parent: THREE.Object3D, r0: number, r1: number, length: number, z: number, finish: THREE.Material, name: string) => {
    const object = mesh(parent, new THREE.CylinderGeometry(r1, r0, length, 28), finish, name);
    object.rotation.x = Math.PI / 2; object.position.z = z; return object;
  };
  const ring = (parent: THREE.Object3D, radius: number, thickness: number, z: number, finish: THREE.Material, name: string) => {
    const object = mesh(parent, new THREE.TorusGeometry(radius, thickness, 8, 36), finish, name); object.position.z = z; return object;
  };
  const box = (parent: THREE.Object3D, dimensions: [number, number, number], position: [number, number, number], finish: THREE.Material, name: string) => {
    const object = mesh(parent, new THREE.BoxGeometry(...dimensions), finish, name); object.position.set(...position); return object;
  };
  const segment = (parent: THREE.Object3D, a: THREE.Vector3, b: THREE.Vector3, radius: number, finish: THREE.Material, name: string) => {
    const object = mesh(parent, new THREE.CylinderGeometry(radius, radius, a.distanceTo(b), 16), finish, name);
    object.position.copy(a).add(b).multiplyScalar(0.5); object.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize()); return object;
  };

  // Bare distal steel, dark insulated sleeve, and a rotation collar at the grip.
  const shaftAssembly = new THREE.Group(); shaftAssembly.name = "shaft-and-handle"; group.add(shaftAssembly);
  cylinder(shaftAssembly, 2.5, 2.5, 210, 135, steel, "five-mm-steel-shaft");
  cylinder(shaftAssembly, 2.59, 2.59, 118, 167, sleeve, "insulated-shaft-sleeve");
  for (const z of [108, 225]) ring(shaftAssembly, 2.61, 0.12, z, satin, "sleeve-edge-band");
  for (const z of [48, 58, 68, 78]) ring(shaftAssembly, 2.51, 0.075, z, inset, "machined-shaft-mark");
  cylinder(shaftAssembly, 2.5, 4.0, 8, 241, satin, "proximal-shaft-transition");
  cylinder(shaftAssembly, 5.3, 5.3, 10, 249, grip, "rotation-collar");
  for (let i = 0; i < 16; i++) {
    const angle = i * Math.PI / 8;
    const rib = box(shaftAssembly, [0.8, 1.0, 8.0], [Math.cos(angle) * 5.2, Math.sin(angle) * 5.2, 249], inset, "collar-knurl"); rib.rotation.z = angle;
  }
  for (const z of [244, 254]) ring(shaftAssembly, 4.8, 0.55, z, satin, "collar-metal-trim");
  ring(shaftAssembly, 5.45, 0.3, 249, accent, "collar-colour-band");

  const jawPivots: { object: THREE.Group; side: number }[] = [];
  let movingHandle: THREE.Group | null = null;
  let probeHead: THREE.Mesh | null = null;
  let probeNeck: THREE.Mesh | null = null;

  if (kind === "grasper") {
    cylinder(group, 2.15, 2.5, 13, 26.5, steel, "distal-clevis-tube");
    cylinder(group, 0.75, 0.75, 10, 19.5, satin, "jaw-actuator-rod");
    for (const side of [-1, 1]) {
      box(group, [1.0, 3.7, 7.0], [side * 2.0, 0, 20.5], steel, "clevis-side-arm");
      const cap = mesh(group, new THREE.CylinderGeometry(1.65, 1.65, 0.55, 20), chrome, "hinge-rivet"); cap.position.set(0, side * 2.05, 18.5);
      const slot = box(group, [1.8, 0.06, 0.3], [0, side * 2.35, 18.5], inset, "hinge-rivet-slot"); slot.rotation.y = Math.PI / 5;
    }
    // A bevelled metal plate with two genuine openings, not painted holes.
    const jawShape = new THREE.Shape();
    jawShape.moveTo(-1.8, 0.7); jawShape.lineTo(1.8, 0.7); jawShape.lineTo(2.7, -12.5);
    jawShape.quadraticCurveTo(2.7, -18.5, 0, -18.5); jawShape.quadraticCurveTo(-2.7, -18.5, -2.7, -12.5); jawShape.closePath();
    const opening = (top: number, bottom: number) => {
      const hole = new THREE.Path(); const width = 1.25, radius = 0.65;
      hole.moveTo(-width, top - radius); hole.lineTo(-width, bottom + radius);
      hole.quadraticCurveTo(-width, bottom, -width + radius, bottom); hole.lineTo(width - radius, bottom);
      hole.quadraticCurveTo(width, bottom, width, bottom + radius); hole.lineTo(width, top - radius);
      hole.quadraticCurveTo(width, top, width - radius, top); hole.lineTo(-width + radius, top);
      hole.quadraticCurveTo(-width, top, -width, top - radius); jawShape.holes.push(hole);
    };
    opening(-2.5, -8.5); opening(-10.1, -15.6);
    const jawGeometry = new THREE.ExtrudeGeometry(jawShape, { depth: 1.12, bevelEnabled: true, bevelSegments: 2, steps: 1, bevelSize: 0.16, bevelThickness: 0.16, curveSegments: 10 });
    // Extrusion (u,v,w) maps to (x=w,y=u,z=v): the gripping face is YZ.
    jawGeometry.applyMatrix4(new THREE.Matrix4().set(0, 0, 1, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1));
    for (const side of [-1, 1]) {
      const pivot = new THREE.Group(); pivot.name = side > 0 ? "right-articulated-jaw" : "left-articulated-jaw"; pivot.position.set(side * 0.55, 0, 18.5); group.add(pivot);
      const plate = mesh(pivot, jawGeometry, steel, "fenestrated-atraumatic-jaw"); plate.scale.x = side;
      // Shallow transverse ridges suggest an atraumatic grip rather than spikes.
      for (let i = 0; i < 8; i++) for (const edge of [-1, 1]) {
        const ridge = box(pivot, [0.22, 0.62, 0.32], [-side * 0.08, edge * 2.0, -3.7 - i * 1.5], satin, "fine-grip-serration"); ridge.rotation.x = edge * 0.08;
      }
      jawPivots.push({ object: pivot, side });
    }

    // A blue-charcoal ergonomic pistol grip with a moving finger loop.
    const body = mesh(shaftAssembly, new THREE.CapsuleGeometry(6.0, 17, 6, 18), grip, "handle-housing"); body.rotation.x = Math.PI / 2; body.position.z = 268;
    segment(shaftAssembly, new THREE.Vector3(0, -3, 270), new THREE.Vector3(0, -24, 281), 4.3, grip, "fixed-palm-grip");
    const palm = mesh(shaftAssembly, new THREE.TorusGeometry(11.5, 2.8, 12, 36), grip, "fixed-finger-loop"); palm.rotation.y = Math.PI / 2; palm.position.set(0, -31, 286); palm.scale.set(0.88, 1.18, 1);
    const palmInset = mesh(shaftAssembly, new THREE.TorusGeometry(11.5, 0.6, 8, 36), inset, "palm-loop-soft-inset"); palmInset.rotation.copy(palm.rotation); palmInset.position.copy(palm.position); palmInset.scale.copy(palm.scale); palmInset.position.x = 2.8;
    movingHandle = new THREE.Group(); movingHandle.name = "articulated-trigger-handle"; movingHandle.position.set(0, 0, 259); shaftAssembly.add(movingHandle);
    segment(movingHandle, new THREE.Vector3(0, -1, 0), new THREE.Vector3(0, -25, -8), 3.0, grip, "moving-trigger-arm");
    const loop = mesh(movingHandle, new THREE.TorusGeometry(10.6, 2.5, 12, 36), grip, "moving-finger-loop"); loop.rotation.y = Math.PI / 2; loop.position.set(0, -32, -10); loop.scale.set(0.92, 1.2, 1);
    const hinge = mesh(shaftAssembly, new THREE.CylinderGeometry(3.0, 3.0, 13, 24), steel, "handle-hinge-pin"); hinge.rotation.z = Math.PI / 2; hinge.position.z = 260;
    for (const side of [-1, 1]) {
      const button = mesh(shaftAssembly, new THREE.CylinderGeometry(2.2, 2.2, 0.7, 20), accent, "hinge-cap"); button.rotation.z = Math.PI / 2; button.position.set(side * 7, 0, 260);
    }
    box(shaftAssembly, [3.5, 1.4, 14], [0, -17, 271], satin, "ratchet-bridge");
    for (let i = 0; i < 6; i++) box(shaftAssembly, [3.5, 0.6, 0.7], [0, -18, 265 + i * 1.8], inset, "ratchet-detent");
  } else {
    probeHead = mesh(group, new THREE.SphereGeometry(1, 36, 24), chrome, "rounded-palpation-head");
    probeNeck = mesh(group, new THREE.CylinderGeometry(2.5, 2.2, 1, 24), satin, "probe-distal-neck"); probeNeck.rotation.x = Math.PI / 2;
    cylinder(shaftAssembly, 5.7, 5.7, 35, 273, grip, "palpator-pencil-grip");
    for (let i = 0; i < 8; i++) ring(shaftAssembly, 5.72, 0.38, 260 + i * 3.5, inset, "palpator-grip-groove");
    cylinder(shaftAssembly, 5.7, 4.8, 6, 293.5, satin, "palpator-end-cap");
    const end = mesh(shaftAssembly, new THREE.SphereGeometry(4.8, 20, 12), grip, "palpator-rounded-handle-end"); end.position.z = 296; end.scale.z = 0.55;
    ring(shaftAssembly, 5.8, 0.4, 256.8, accent, "palpator-identification-band");
  }

  const setJawClosure = (closure: number) => {
    if (!Number.isFinite(closure)) throw new Error("Jaw closure must be finite");
    const value = THREE.MathUtils.clamp(closure, 0, 1); group.userData.jawClosure = value;
    for (const jaw of jawPivots) jaw.object.rotation.y = -jaw.side * (1 - value) * 0.43;
    if (movingHandle) movingHandle.rotation.x = -0.16 + value * 0.29;
  };
  const setContactRadius = (radiusMm: number) => {
    if (!Number.isFinite(radiusMm) || radiusMm < 1 || radiusMm > 60) throw new Error("Instrument contact radius must be 1–60 mm");
    if (!probeHead || !probeNeck) return;
    group.userData.contactRadiusMm = radiusMm; probeHead.scale.setScalar(radiusMm); probeHead.position.z = radiusMm;
    // Tip stays at local Z=0 for every radius. The shaft retains a 5 mm diameter.
    const neckStart = radiusMm * 1.78; const shaftStart = Math.max(30, radiusMm * 2 + 9);
    probeNeck.scale.y = shaftStart - neckStart; probeNeck.position.z = (shaftStart + neckStart) / 2;
    shaftAssembly.position.z = shaftStart - 30;
  };
  setJawClosure(0); if (kind === "probe") setContactRadius(6);
  let disposed = false;
  return { kind, group, setJawClosure, setContactRadius, dispose: () => {
    if (disposed) return; disposed = true; group.removeFromParent();
    for (const geometry of geometries) geometry.dispose(); for (const finish of materials) finish.dispose(); group.clear();
  } };
}
