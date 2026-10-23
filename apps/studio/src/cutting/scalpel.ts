import * as THREE from "three";
import { DEFAULT_SCALPEL, type ScalpelGeometry, type ScalpelPose } from "./types";

/** The visible cutting surface is the same finite wedge as mechanical contact.
 * Local Y runs from the cutting edge toward the handle; local Z is edge length.
 * This is a generic research instrument, not manufacturer CAD or a No. 11 blade.
 */
export function createCuttingScalpel(dimensions: Readonly<ScalpelGeometry> = DEFAULT_SCALPEL) {
  const { halfThicknessMm: half, halfLengthMm: length, heightMm: height, halfAngleRadians: angle } = dimensions;
  const endBevel = dimensions.endBevelMm ?? 0;
  if (![half, length, height, angle, endBevel].every(Number.isFinite) || half <= 0 || length <= 0 || height <= 0 || angle <= 0 || angle >= Math.PI / 2 || half / Math.tan(angle) >= height || endBevel < 0 || endBevel >= length) throw new Error("Invalid finite scalpel wedge dimensions");
  const group = new THREE.Group(); group.name = "finite-contact-scalpel";
  group.userData = { units: "mm", contactDimensions: { ...dimensions, endBevelMm: endBevel }, tipLocal: [0, 0, 0], cosmeticHandleCollision: false };
  const geometries = new Set<THREE.BufferGeometry>(), materials = new Set<THREE.Material>();
  const finish = (parameters: THREE.MeshPhysicalMaterialParameters) => { const material = new THREE.MeshPhysicalMaterial(parameters); materials.add(material); return material; };
  const steel = finish({ name: "scalpel-satin-steel", color: "#d5dfe4", metalness: .96, roughness: .24, clearcoat: .2, envMapIntensity: 1.1 });
  const bevel = finish({ name: "scalpel-polished-bevel", color: "#eef3f5", metalness: .98, roughness: .12, envMapIntensity: 1.3 });
  const handle = finish({ name: "scalpel-brushed-handle", color: "#b8babc", metalness: .96, roughness: .3, envMapIntensity: 1 });
  const groove = finish({ color: "#45484b", metalness: .85, roughness: .38 });
  const add = (geometry: THREE.BufferGeometry, material: THREE.Material | THREE.Material[], name: string) => { geometries.add(geometry); const object = new THREE.Mesh(geometry, material); object.name = name; object.castShadow = true; object.receiveShadow = true; group.add(object); return object; };
  const bevelHeight = half / Math.tan(angle);
  // One closed surface, including the four sharpened end facets. Exactly the
  // same polytope as contact: |x| <= min(h, tan(a)y, h/b (L-|z|)).
  // Per-face material groups avoid duplicated coplanar meshes and shadow bias.
  const innerLength = length - endBevel, body = new THREE.BufferGeometry(), positions: number[] = [];
  const vertices = [
    [0, 0, -length], [0, height, -length], [0, 0, length], [0, height, length],
    [-half, bevelHeight, -innerLength], [-half, height, -innerLength], [-half, bevelHeight, innerLength], [-half, height, innerLength],
    [half, bevelHeight, -innerLength], [half, height, -innerLength], [half, bevelHeight, innerLength], [half, height, innerLength],
  ].map(point => new THREE.Vector3(...point as [number, number, number]));
  const face = (indices: number[], outward: [number, number, number], polished: boolean) => {
    const points = indices.map(index => vertices[index]!);
    const normal = points[1]!.clone().sub(points[0]!).cross(points[2]!.clone().sub(points[0]!));
    if (normal.dot(new THREE.Vector3(...outward)) < 0) points.reverse();
    const start = positions.length / 3;
    for (let i = 1; i < points.length - 1; i++) for (const point of [points[0]!, points[i]!, points[i + 1]!]) positions.push(point.x, point.y, point.z);
    body.addGroup(start, positions.length / 3 - start, polished ? 1 : 0);
  };
  face([4, 6, 7, 5], [-1, 0, 0], false); face([8, 9, 11, 10], [1, 0, 0], false);
  face([0, 2, 6, 4], [-1, -Math.tan(angle), 0], true); face([0, 8, 10, 2], [1, -Math.tan(angle), 0], true);
  // Unnormalised end normals remain valid at b=0 (the old blunt end caps).
  face([0, 4, 5, 1], [-endBevel, 0, -half], endBevel > 0); face([0, 1, 9, 8], [endBevel, 0, -half], endBevel > 0);
  face([2, 3, 7, 6], [-endBevel, 0, half], endBevel > 0); face([2, 10, 11, 3], [endBevel, 0, half], endBevel > 0);
  face([1, 5, 7, 3, 11, 9], [0, 1, 0], false);
  body.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3)); body.computeVertexNormals();
  add(body, [steel, bevel], "mechanical-wedge");
  const tang = add(new THREE.BoxGeometry(1.6, 10, 8), steel, "blade-tang"); tang.position.y = height + 5;
  const handleShape = new THREE.Shape(); handleShape.moveTo(-3, height + 8); handleShape.lineTo(3, height + 8); handleShape.lineTo(5, height + 30); handleShape.lineTo(4, height + 102); handleShape.quadraticCurveTo(0, height + 110, -4, height + 102); handleShape.lineTo(-5, height + 30); handleShape.closePath();
  const grip = new THREE.ExtrudeGeometry(handleShape, { depth: 2.6, bevelEnabled: true, bevelSize: .55, bevelThickness: .45, bevelSegments: 2, steps: 1 }); grip.translate(0, 0, -1.3);
  add(grip, handle, "balanced-satin-handle");
  for (let i = 0; i < 12; i++) for (const sign of [-1, 1]) { const ridge = add(new THREE.BoxGeometry(7, .35, .12), groove, "handle-grip-engraving"); ridge.position.set(0, height + 26 + i * 2.4, sign * 1.82); }
  const accent = add(new THREE.BoxGeometry(6, .9, .12), bevel, "instrument-index-mark"); accent.position.set(0, height + 64, 1.82);
  let disposed = false;
  return {
    group,
    // Cosmetic inspection only: the mechanically active blade always remains
    // visible. Never hide contact geometry to make an incision look clearer.
    setHandleVisible(visible: boolean) { for (const child of group.children) if (child.name !== "mechanical-wedge") child.visible = visible; },
    setPose(pose: ScalpelPose, planeXMm: number) { if (![pose.tipYMm, pose.centerZMm, planeXMm].every(Number.isFinite)) throw new Error("Scalpel pose must be finite"); group.position.set(planeXMm, pose.tipYMm, pose.centerZMm); },
    dispose() { if (disposed) return; disposed = true; group.removeFromParent(); for (const geometry of geometries) geometry.dispose(); for (const material of materials) material.dispose(); group.clear(); },
  };
}
