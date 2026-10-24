import * as THREE from "three";
import { SceneNavigationGuard, type NavigationSurface } from "./wholeSceneNavigation";
import { buildVascularTable, periodicTissueNoise } from "./imports/tissueDetail";

export const OPERATIVE_REGIONS = [
  { id: "subhepatic", label: "Under the liver", organs: ["gallbladder", "hepatic-duct"], direction: [.12, -.65, 1], description: "Look upward along the liver edge toward the gallbladder. The liver can obscure deeper ducts and vessels." },
  { id: "gastric", label: "Stomach & spleen", organs: ["stomach"], direction: [.35, -.15, 1], description: "Follow the smooth stomach surface. Fat and adjacent organs partly cover the deeper vessels and pancreas." },
  { id: "bowel", label: "Bowel & mesentery", organs: ["small-intestine", "mesentery"], direction: [.68, -.12, 1], description: "Explore the bowel loops and the fatty mesenteric folds between them. Retreat before turning into a narrow space." },
] as const;
export type OperativeRegion = typeof OPERATIVE_REGIONS[number]["id"];

/** Start outside the abdominal surfaces and stop short of the first visible
 * surface. Regional jumps are separate entry views, never a claimed safe route. */
export function operativeEntry(surfaces: NavigationSurface[], region: OperativeRegion, guard: SceneNavigationGuard) {
  const definition = OPERATIVE_REGIONS.find(item => item.id === region)!;
  const focus = new THREE.Box3(), all = new THREE.Box3();
  for (const part of surfaces) {
    if (!part.visible || part.id.startsWith("operative-") || part.id.startsWith("fat-")) continue;
    part.geometry.computeBoundingBox();
    if (part.geometry.boundingBox) {
      all.union(part.geometry.boundingBox);
      if ((definition.organs as readonly string[]).includes(part.id)) focus.union(part.geometry.boundingBox);
    }
  }
  if (focus.isEmpty() || all.isEmpty()) return null;
  const target = focus.getCenter(new THREE.Vector3());
  if (region === "bowel") { const size = focus.getSize(new THREE.Vector3()); target.x += size.x * .30; target.y -= size.y * .08; }
  const outward = new THREE.Vector3(...definition.direction).normalize();
  const maximum = all.getSize(new THREE.Vector3()).length() * 2;
  const origin = target.clone().addScaledVector(outward, maximum);
  const forward = outward.negate();
  // The inferred wall is deliberately excluded from entry; it encloses the
  // camera after entry and participates in subsequent motion sweeps.
  const distance = guard.rayDistance(origin, forward, maximum * 2);
  const workingDistance = region === "bowel" ? 100 : Math.max(35, Math.min(75, focus.getSize(new THREE.Vector3()).length() * .38));
  return { position: origin.addScaledVector(forward, Math.max(0, distance - workingDistance)), forward, workingDistance };
}

/** Illustrative insufflated peritoneal enclosure, inferred from the abdominal
 * atlas bounds. A viewer context layer, not a segmented patient body wall. */
export function createOperativeEnvelope(surfaces: NavigationSurface[]) {
  const bounds = new THREE.Box3();
  const abdominal = /^(liver|stomach|spleen|colon|small-intestine|.*kidney|gallbladder|mesentery)$/;
  for (const part of surfaces) if (abdominal.test(part.id)) {
    part.geometry.computeBoundingBox(); if (part.geometry.boundingBox) bounds.union(part.geometry.boundingBox);
  }
  if (bounds.isEmpty()) return null;
  const center = bounds.getCenter(new THREE.Vector3()), extent = bounds.getSize(new THREE.Vector3());
  // Superellipsoid shoulders leave space around lateral organs. The anterior
  // wall is lifted to suggest a working cavity, without moving organ surfaces.
  const radii = extent.clone().multiply(new THREE.Vector3(.69, .72, 1.25)).addScalar(25);
  center.z += extent.z * .16;
  const geometry = new THREE.SphereGeometry(1, 112, 72);
  const position = geometry.getAttribute("position"), colors = new Float32Array(position.count * 3);
  const tint = new THREE.Color();
  for (let i = 0; i < position.count; i++) {
    const x = position.getX(i), y = position.getY(i), z = position.getZ(i);
    const relief = .7 * Math.sin(x * 23 + y * 9) * Math.sin(z * 17 - y * 13);
    position.setXYZ(i, center.x + x * radii.x, center.y + y * radii.y, center.z + z * (radii.z + relief));
    const fat = Math.max(0, Math.sin(x * 12 + y * 7) * Math.cos(y * 11 - z * 8)) * .35;
    tint.setRGB(.56 + fat * .16, .31 + fat * .24, .29 + fat * .08, THREE.SRGBColorSpace);
    colors.set(tint.toArray(), i * 3);
  }
  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  geometry.computeVertexNormals(); geometry.computeBoundingBox(); geometry.computeBoundingSphere();
  const side = 512, color = new Uint8Array(side * side * 4), roughness = color.slice(), height = color.slice();
  const vessels = buildVascularTable(1847, side);
  for (let y = 0; y < side; y++) for (let x = 0; x < side; x++) {
    const i = y * side + x, j = 4 * i, u = x / side, v = y / side;
    const n = periodicTissueNoise(u, v, 17, 212), fine = periodicTissueNoise(u, v, 113, 51);
    const vessel = Math.min(.30, vessels.arteryMask[i]! * .22 + vessels.veinMask[i]! * .16);
    color.set([245 - 25 * vessel + n * 5, 239 - 160 * vessel + n * 6, 237 - 130 * vessel + n * 5, 255], j);
    roughness.set([150 + n * 18, 150 + n * 18, 150 + n * 18, 255], j);
    const h = 128 + n * 9 + fine * 3;
    height.set([h, h, h, 255], j);
  }
  const texture = (bytes: Uint8Array, srgb = false) => {
    const t = new THREE.DataTexture(bytes, side, side); t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.magFilter = THREE.LinearFilter; t.minFilter = THREE.LinearMipmapLinearFilter; t.generateMipmaps = true;
    if (srgb) t.colorSpace = THREE.SRGBColorSpace; t.needsUpdate = true; return t;
  };
  const map = texture(color, true), roughnessMap = texture(roughness), bumpMap = texture(height);
  const material = new THREE.MeshPhysicalMaterial({ color: 0xffffff, vertexColors: true, side: THREE.BackSide,
    map, roughnessMap, bumpMap, bumpScale: .3, roughness: .75, clearcoat: .18, clearcoatRoughness: .3, metalness: 0 });
  const mesh = new THREE.Mesh(geometry, material); mesh.name = "operative-peritoneal-wall";
  mesh.receiveShadow = true; mesh.castShadow = false;
  return { mesh, dispose() { mesh.removeFromParent(); geometry.dispose(); material.dispose(); map.dispose(); roughnessMap.dispose(); bumpMap.dispose(); } };
}
