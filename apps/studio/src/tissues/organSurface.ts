import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/examples/jsm/libs/meshopt_decoder.module.js";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";

/** An exterior material may only be applied to the matching atlas structure. */
export const ORGAN_SURFACE_NODES: Readonly<Record<string, readonly string[]>> = Object.freeze({
  liver: ["liver"], kidney: ["right-kidney", "left-kidney"], heart: ["heart"], lung: ["right-lung", "left-lung"],
  spleen: ["spleen"], stomach: ["stomach"], small_bowel: ["small-intestine"], large_bowel: ["colon"],
  pancreas: ["pancreas"], gallbladder: ["gallbladder"], bladder: ["urinary-bladder"], mesentery: ["mesentery"],
});
export const ORGAN_SURFACE_IDS = Object.freeze(Object.keys(ORGAN_SURFACE_NODES));
export const supportedOrganSurface = (id: string) => Object.hasOwn(ORGAN_SURFACE_NODES, id);
const COMPRESSED_ATLAS_SHA256 = "6674c0f0e000939ec2a0ea8d590dd5f2bf029b37f038d6a8a2e30a86540b42a9";
export interface OrganSurface {
  geometry: THREE.BufferGeometry; center: THREE.Vector3; radius: number; nodes: readonly string[];
  provenance: { assetSha256: string; license: string; attribution: string; units: string; limitations: string[]; source: string };
}

/** Keep source coordinates and outward normals; no smoothing, deformation or invented UVs. */
export function extractOrganGeometry(scene: THREE.Object3D, organ: string) {
  const names = ORGAN_SURFACE_NODES[organ];
  if (!names) throw new Error("No exterior atlas geometry for this material family");
  scene.updateMatrixWorld(true);
  const parts: THREE.BufferGeometry[] = [];
  try {
    for (const name of names) {
      const mesh = scene.getObjectByName(name);
      if (!(mesh instanceof THREE.Mesh) || !(mesh.geometry instanceof THREE.BufferGeometry)) throw new Error("Atlas structure missing: " + name);
      const geometry = mesh.geometry.clone();
      for (const key of Object.keys(geometry.attributes)) if (key !== "position" && key !== "normal") geometry.deleteAttribute(key);
      // Widen quantized (KHR_mesh_quantization: 16-bit positions / 8-bit normals) attributes to Float32Array before applying matrixWorld
      for (const attrName of ["position", "normal"]) {
        const attribute = geometry.getAttribute(attrName);
        if (!attribute || attribute.array instanceof Float32Array) continue;
        const wide = new Float32Array(attribute.count * attribute.itemSize);
        for (let i = 0; i < attribute.count; i++) {
          for (let k = 0; k < attribute.itemSize; k++) {
            wide[i * attribute.itemSize + k] = attribute.getComponent(i, k);
          }
        }
        geometry.setAttribute(attrName, new THREE.BufferAttribute(wide, attribute.itemSize));
      }
      geometry.applyMatrix4(mesh.matrixWorld);
      if (!geometry.hasAttribute("normal")) geometry.computeVertexNormals();
      // Shader chunks expect an attribute; the actual projection uses rest-space mm.
      geometry.setAttribute("uv", new THREE.Float32BufferAttribute(new Float32Array(geometry.getAttribute("position").count * 2), 2));
      parts.push(geometry);
    }
    const geometry = mergeGeometries(parts, false);
    if (!geometry) throw new Error("Atlas structures cannot be merged");
    geometry.computeBoundingSphere(); geometry.computeBoundingBox();
    const sphere = geometry.boundingSphere!;
    if (!Number.isFinite(sphere.radius) || sphere.radius <= 0 || sphere.radius > 1000) { geometry.dispose(); throw new Error("Invalid atlas bounds"); }
    return { geometry, center: sphere.center.clone(), radius: sphere.radius, nodes: names };
  } finally { parts.forEach(part => part.dispose()); }
}
function disposeLoadedScene(scene: THREE.Object3D) {
  const geometries = new Set<THREE.BufferGeometry>(), materials = new Set<THREE.Material>();
  scene.traverse(node => { if (node instanceof THREE.Mesh) { geometries.add(node.geometry); (Array.isArray(node.material) ? node.material : [node.material]).forEach(material => materials.add(material)); } });
  geometries.forEach(geometry => geometry.dispose()); materials.forEach(material => material.dispose());
}

/** Abortable fetch, full asset digest, and explicit ownership of the extracted geometry. */
export async function loadOrganSurface(organ: string, signal: AbortSignal): Promise<OrganSurface> {
  if (!supportedOrganSurface(organ)) throw new Error("Unsupported exterior material family");
  const url = new URL("./anatomy-scene/manifest.json", document.baseURI);
  const response = await fetch(url, { signal }); if (!response.ok) throw new Error("Atlas manifest unavailable");
  const manifest = await response.json();
  if (manifest.schemaVersion !== "1.0" || !/^[a-f0-9]{64}$/.test(manifest.sha256) || !Array.isArray(manifest.limitations) || typeof manifest.units !== "string" || typeof manifest.license !== "string" || typeof manifest.attribution !== "string") throw new Error("Invalid atlas provenance");
  const assetResponse = await fetch(new URL("bodyparts3d-torso.glb", url), { signal }); if (!assetResponse.ok) throw new Error("Atlas surface unavailable");
  const bytes = await assetResponse.arrayBuffer();
  const digest = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map(value => value.toString(16).padStart(2, "0")).join("");
  const validDigests = new Set([manifest.sha256, manifest.compressedSha256, COMPRESSED_ATLAS_SHA256].filter((v): v is string => typeof v === "string"));
  if (!validDigests.has(digest)) throw new Error("Atlas asset digest mismatch");
  if (signal.aborted) throw new Error("Atlas loading cancelled");
  const gltf = await new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).parseAsync(bytes, url.href);
  try {
    if (signal.aborted) throw new Error("Atlas loading cancelled");
    return { ...extractOrganGeometry(gltf.scene, organ), provenance: { assetSha256: digest, license: manifest.license, attribution: manifest.attribution, units: manifest.units, limitations: manifest.limitations.filter((value: unknown) => typeof value === "string"), source: String(manifest.sourceUrl ?? "") } };
  } finally { disposeLoadedScene(gltf.scene); }
}

/** A sphere outside the source bounding sphere is collision-safe for an isolated organ. */
export function organOrbitPose(surface: Pick<OrganSurface, "center" | "radius">, timeSeconds: number, yawDeg = 0, pitchDeg = 0) {
  if (![timeSeconds, yawDeg, pitchDeg, surface.radius].every(Number.isFinite) || surface.radius <= 0 || Math.abs(yawDeg) > 180 || Math.abs(pitchDeg) > 90) throw new Error("Invalid organ inspection pose");
  const azimuth = timeSeconds * Math.PI * 2 / 24 + THREE.MathUtils.degToRad(yawDeg);
  const elevation = THREE.MathUtils.degToRad(pitchDeg);
  const orientation = new THREE.Quaternion().setFromEuler(new THREE.Euler(-elevation, azimuth, 0, "YXZ"));
  const position = new THREE.Vector3(0, 0, surface.radius * 2.6).applyQuaternion(orientation).add(surface.center);
  return { position, target: surface.center.clone(), up: new THREE.Vector3(0, 1, 0).applyQuaternion(orientation) };
}
