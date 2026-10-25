import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/examples/jsm/libs/meshopt_decoder.module.js";
import { mergeVertices } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { publicUrl } from "../api";
import { inspectImportedRoot, type ImportedModel } from "./importModel";
import { ImportResources, checkAbort } from "./importResources";
import { tubularStructure } from "./tissueDetail";

export type LaparoscopicScenePresetId = "full-laparoscopy" | "hepatobiliary" | "virtamed";

export interface LaparoscopicScenePreset {
  id: LaparoscopicScenePresetId;
  label: string;
  shortLabel: string;
  filename: string;
  description: string;
  organIds: readonly string[];
}

export const LAPAROSCOPIC_SCENE_PRESETS: readonly LaparoscopicScenePreset[] = [
  {id:"virtamed",label:"VirtaMed scene · white video reconstruction",shortLabel:"VirtaMed scene",filename:"virtamed-scene.glb",description:"Reconstructed intact hepatocystic field from Full.mp4, 00:08–00:15. Visible silhouettes; hidden geometry and scale inferred.",organIds:["liver","gallbladder","cystic-duct","hepatic-duct","cystic-artery","colon","small-intestine","duodenum","hepatocystic-fat","hepatoduodenal-ligament","falciform-ligament","abdominal-wall"]},
  {
    id: "full-laparoscopy",
    label: "Full laparoscopic abdomen (24 co-registered structures)",
    shortLabel: "Laparoscopic abdomen (24 structures)",
    filename: "laparoscopic-abdominal-scene.glb",
    description: "Co-registered human liver, gallbladder, biliary tree, portal vein, hepatic artery, stomach, duodenum, pancreas, spleen, colon, small intestine, bilateral kidneys, mesentery, and separate abdominal arterial and venous trees in shared anatomical apposition.",
    organIds: [
      "liver",
      "gallbladder",
      "hepatic-duct",
      "portal-vein",
      "hepatic-artery",
      "stomach",
      "duodenum",
      "pancreas",
      "spleen",
      "colon",
      "small-intestine",
      "right-kidney",
      "left-kidney",
      "mesentery",
      "aorta",
      "vena-cava",
      "celiac-trunk",
      "splenic-artery",
      "superior-mesenteric-artery",
      "inferior-mesenteric-artery",
      "right-renal-artery",
      "left-renal-artery",
      "right-renal-vein",
      "left-renal-vein",
    ],
  },
  {
    id: "hepatobiliary",
    label: "Hepatobiliary & foregut laparoscopy (11 co-registered structures)",
    shortLabel: "Hepatobiliary & foregut (11 structures)",
    filename: "laparoscopic-hepatobiliary-scene.glb",
    description: "Upper-abdominal surgical field (Calot’s triangle, subhepatic space & lesser sac): liver, gallbladder, extrahepatic biliary tree, portal vein, hepatic artery, stomach, duodenum, pancreas, and spleen.",
    organIds: [
      "liver",
      "gallbladder",
      "hepatic-duct",
      "portal-vein",
      "hepatic-artery",
      "stomach",
      "duodenum",
      "pancreas",
      "spleen",
      "celiac-trunk",
      "splenic-artery",
    ],
  },
] as const;

const ORGAN_SUBDIVISION_PASSES: Record<string, number> = {
  "liver": 1,
  "gallbladder": 2,
  "duodenum": 2,
  "spleen": 2,
  "right-kidney": 2,
  "left-kidney": 2,
  "stomach": 1,
  "pancreas": 2,
  "small-intestine": 2,
  "colon": 1,
  "hepatic-duct": 1,
  "portal-vein": 1,
  "hepatic-artery": 1,
};

interface OrganOpticsSpec {
  color: number;
  sheenColor: number;
  roughness: number;
  clearcoat: number;
  clearcoatRoughness: number;
  sheen: number;
}

const BASELINE_SEROSAL_OPTICS: Record<string, OrganOpticsSpec> = {
  "mesentery": { color: 0xbca183, sheenColor: 0xe7c6a2, roughness: 0.42, clearcoat: 0.28, clearcoatRoughness: 0.24, sheen: 0.30 },
  "liver": { color: 0x71322e, sheenColor: 0x9c423c, roughness: 0.33, clearcoat: 0.34, clearcoatRoughness: 0.21, sheen: 0.22 },
  "gallbladder": { color: 0x5c7546, sheenColor: 0x7e9c5a, roughness: 0.31, clearcoat: 0.42, clearcoatRoughness: 0.18, sheen: 0.26 },
  "hepatic-duct": { color: 0x728452, sheenColor: 0x94a86e, roughness: 0.34, clearcoat: 0.36, clearcoatRoughness: 0.20, sheen: 0.24 },
  "hepatic-artery": { color: 0x91483c, sheenColor: 0xbf7565, roughness: 0.38, clearcoat: 0.30, clearcoatRoughness: 0.23, sheen: 0.22 },
  "portal-vein": { color: 0x5c445c, sheenColor: 0x82587a, roughness: 0.36, clearcoat: 0.32, clearcoatRoughness: 0.22, sheen: 0.24 },
  "stomach": { color: 0xc27f75, sheenColor: 0xe39c90, roughness: 0.36, clearcoat: 0.34, clearcoatRoughness: 0.21, sheen: 0.28 },
  "duodenum": { color: 0xc6897d, sheenColor: 0xe6a496, roughness: 0.37, clearcoat: 0.33, clearcoatRoughness: 0.21, sheen: 0.28 },
  "pancreas": { color: 0xcca07c, sheenColor: 0xe8bc96, roughness: 0.44, clearcoat: 0.24, clearcoatRoughness: 0.25, sheen: 0.20 },
  "spleen": { color: 0x643146, sheenColor: 0x8f4664, roughness: 0.35, clearcoat: 0.34, clearcoatRoughness: 0.21, sheen: 0.24 },
  "colon": { color: 0xb88278, sheenColor: 0xdba094, roughness: 0.39, clearcoat: 0.30, clearcoatRoughness: 0.22, sheen: 0.26 },
  "small-intestine": { color: 0xc68d7f, sheenColor: 0xe6aa9b, roughness: 0.37, clearcoat: 0.34, clearcoatRoughness: 0.21, sheen: 0.28 },
  "right-kidney": { color: 0x944b44, sheenColor: 0xbe665c, roughness: 0.35, clearcoat: 0.36, clearcoatRoughness: 0.20, sheen: 0.24 },
  "left-kidney": { color: 0x944b44, sheenColor: 0xbe665c, roughness: 0.35, clearcoat: 0.36, clearcoatRoughness: 0.20, sheen: 0.24 },
};

/** Compute corner-angle-weighted smooth vertex normals so unequal triangle aspect ratios
 * never create flat shading artifacts on curved visceral walls. */
export function computeAngleWeightedNormals(geometry: THREE.BufferGeometry): void {
  const positions = geometry.getAttribute("position");
  if (!positions) return;
  const index = geometry.getIndex();
  const vCount = positions.count;
  const sums = new Float64Array(vCount * 3);
  const count = index ? index.count : vCount;
  for (let f = 0; f + 2 < count; f += 3) {
    const i0 = index ? index.getX(f) : f;
    const i1 = index ? index.getX(f + 1) : f + 1;
    const i2 = index ? index.getX(f + 2) : f + 2;
    const ax = positions.getX(i0), ay = positions.getY(i0), az = positions.getZ(i0);
    const bx = positions.getX(i1), by = positions.getY(i1), bz = positions.getZ(i1);
    const cx = positions.getX(i2), cy = positions.getY(i2), cz = positions.getZ(i2);
    const abx = bx - ax, aby = by - ay, abz = bz - az;
    const acx = cx - ax, acy = cy - ay, acz = cz - az;
    const nx = aby * acz - abz * acy;
    const ny = abz * acx - abx * acz;
    const nz = abx * acy - aby * acx;
    const area2 = Math.hypot(nx, ny, nz);
    if (area2 < 1e-12) continue;
    const ux = nx / area2, uy = ny / area2, uz = nz / area2;
    const bax = ax - bx, bay = ay - by, baz = az - bz;
    const bcx = cx - bx, bcy = cy - by, bcz = cz - bz;
    const ang0 = Math.atan2(area2, abx * acx + aby * acy + abz * acz);
    const ang1 = Math.atan2(area2, bax * bcx + bay * bcy + baz * bcz);
    const ang2 = Math.max(0, Math.PI - ang0 - ang1);
    sums[3 * i0] = sums[3 * i0]! + ux * ang0;
    sums[3 * i0 + 1] = sums[3 * i0 + 1]! + uy * ang0;
    sums[3 * i0 + 2] = sums[3 * i0 + 2]! + uz * ang0;
    sums[3 * i1] = sums[3 * i1]! + ux * ang1;
    sums[3 * i1 + 1] = sums[3 * i1 + 1]! + uy * ang1;
    sums[3 * i1 + 2] = sums[3 * i1 + 2]! + uz * ang1;
    sums[3 * i2] = sums[3 * i2]! + ux * ang2;
    sums[3 * i2 + 1] = sums[3 * i2 + 1]! + uy * ang2;
    sums[3 * i2 + 2] = sums[3 * i2 + 2]! + uz * ang2;
  }
  const normalArray = new Float32Array(vCount * 3);
  for (let i = 0; i < vCount; i++) {
    const lx = sums[3 * i]!, ly = sums[3 * i + 1]!, lz = sums[3 * i + 2]!;
    const len = Math.hypot(lx, ly, lz);
    if (len > 1e-12) {
      normalArray[3 * i] = lx / len;
      normalArray[3 * i + 1] = ly / len;
      normalArray[3 * i + 2] = lz / len;
    } else {
      normalArray[3 * i + 2] = 1;
    }
  }
  geometry.setAttribute("normal", new THREE.BufferAttribute(normalArray, 3));
}

/** Volume-preserving Taubin lambda/mu surface fairing (Taubin 1995) over welded 3D vertex
 * neighborhoods. Eliminates CT slice rings and flat boolean facets on the hepatic dome while
 * preserving macroscopic organ volume and co-registered visceral boundaries. */
export function fairSurfaceConcavityOutliers(geometry: THREE.BufferGeometry, passes = 6): void {
  const posAttr = geometry.getAttribute("position");
  if (!posAttr || posAttr.itemSize !== 3 || passes <= 0) return;
  const vCount = posAttr.count;
  const indexAttr = geometry.getIndex();
  const triCount = indexAttr ? indexAttr.count : vCount;

  const canonOf = new Int32Array(vCount);
  const canonMap = new Map<string, number>();
  const canonMembers: number[][] = [];
  for (let i = 0; i < vCount; i++) {
    const key = `${Math.round(posAttr.getX(i) * 50)}:${Math.round(posAttr.getY(i) * 50)}:${Math.round(posAttr.getZ(i) * 50)}`;
    let c = canonMap.get(key);
    if (c === undefined) {
      c = canonMembers.length;
      canonMap.set(key, c);
      canonMembers.push([i]);
    } else {
      canonMembers[c]!.push(i);
    }
    canonOf[i] = c;
  }

  const cCount = canonMembers.length;
  const adj: Set<number>[] = Array.from({ length: cCount }, () => new Set<number>());
  for (let f = 0; f + 2 < triCount; f += 3) {
    const c0 = canonOf[indexAttr ? indexAttr.getX(f) : f]!;
    const c1 = canonOf[indexAttr ? indexAttr.getX(f + 1) : f + 1]!;
    const c2 = canonOf[indexAttr ? indexAttr.getX(f + 2) : f + 2]!;
    if (c0 !== c1) { adj[c0]!.add(c1); adj[c1]!.add(c0); }
    if (c1 !== c2) { adj[c1]!.add(c2); adj[c2]!.add(c1); }
    if (c2 !== c0) { adj[c2]!.add(c0); adj[c0]!.add(c2); }
  }
  const neighbors = adj.map(s => Int32Array.from(s));
  const cPos = new Float64Array(cCount * 3);
  const nextCPos = new Float64Array(cCount * 3);
  for (let c = 0; c < cCount; c++) {
    const v0 = canonMembers[c]![0]!;
    cPos[3 * c] = posAttr.getX(v0);
    cPos[3 * c + 1] = posAttr.getY(v0);
    cPos[3 * c + 2] = posAttr.getZ(v0);
  }

  const applyLaplacianStep = (weight: number) => {
    for (let c = 0; c < cCount; c++) {
      const nb = neighbors[c]!;
      const px = cPos[3 * c]!, py = cPos[3 * c + 1]!, pz = cPos[3 * c + 2]!;
      if (nb.length < 3) {
        nextCPos[3 * c] = px; nextCPos[3 * c + 1] = py; nextCPos[3 * c + 2] = pz;
        continue;
      }
      let sx = 0, sy = 0, sz = 0;
      for (let k = 0; k < nb.length; k++) {
        const u = nb[k]!;
        sx += cPos[3 * u]!;
        sy += cPos[3 * u + 1]!;
        sz += cPos[3 * u + 2]!;
      }
      const inv = 1 / nb.length;
      nextCPos[3 * c] = px + weight * (sx * inv - px);
      nextCPos[3 * c + 1] = py + weight * (sy * inv - py);
      nextCPos[3 * c + 2] = pz + weight * (sz * inv - pz);
    }
    cPos.set(nextCPos);
  };

  for (let pass = 0; pass < passes; pass++) {
    applyLaplacianStep(0.50);
    applyLaplacianStep(-0.515);
  }
  for (let c = 0; c < cCount; c++) {
    const x = cPos[3 * c]!, y = cPos[3 * c + 1]!, z = cPos[3 * c + 2]!;
    for (const vi of canonMembers[c]!) {
      posAttr.setXYZ(vi, x, y, z);
    }
  }
  posAttr.needsUpdate = true;
}

/** Curved PN-Triangle 1->4 smooth surface subdivision (Vlachos et al.).
 * Retains every original co-registered vertex position exactly while projecting edge midpoints
 * onto cubic Bezier patches with bounded curvature so low-poly atlas organs become silky-smooth
 * with bounded edge offsets. This is not an anatomical contact guarantee. */
export function pnSubdivideGeometry(source: THREE.BufferGeometry, alpha = 0.52): THREE.BufferGeometry {
  const posAttr = source.getAttribute("position");
  if (!posAttr || posAttr.itemSize !== 3) return source.clone();
  const working = source.clone();
  computeAngleWeightedNormals(working);
  const normAttr = working.getAttribute("normal")!;
  const indexAttr = working.getIndex();
  const vCount = posAttr.count;
  const pos = new Float32Array(vCount * 3);
  const norm = new Float32Array(vCount * 3);
  for (let i = 0; i < vCount; i++) {
    pos[3 * i] = posAttr.getX(i);
    pos[3 * i + 1] = posAttr.getY(i);
    pos[3 * i + 2] = posAttr.getZ(i);
    norm[3 * i] = normAttr.getX(i);
    norm[3 * i + 1] = normAttr.getY(i);
    norm[3 * i + 2] = normAttr.getZ(i);
  }
  const triIndicesCount = indexAttr ? indexAttr.count : vCount;
  const newPos: number[] = Array.from(pos);
  const newIndices: number[] = [];
  const edgeMidpoints = new Map<string, number>();

  const getMidpoint = (a: number, b: number): number => {
    const lo = Math.min(a, b), hi = Math.max(a, b);
    const key = `${lo}:${hi}`;
    const existing = edgeMidpoints.get(key);
    if (existing !== undefined) return existing;
    const px = pos[3 * lo]!, py = pos[3 * lo + 1]!, pz = pos[3 * lo + 2]!;
    const qx = pos[3 * hi]!, qy = pos[3 * hi + 1]!, qz = pos[3 * hi + 2]!;
    const nx = norm[3 * lo]!, ny = norm[3 * lo + 1]!, nz = norm[3 * lo + 2]!;
    const mx = norm[3 * hi]!, my = norm[3 * hi + 1]!, mz = norm[3 * hi + 2]!;
    const dx = qx - px, dy = qy - py, dz = qz - pz;
    const wij = dx * nx + dy * ny + dz * nz;
    const wji = -dx * mx - dy * my - dz * mz;
    let ox = -alpha * (wij * nx + wji * mx) * 0.125;
    let oy = -alpha * (wij * ny + wji * my) * 0.125;
    let oz = -alpha * (wij * nz + wji * mz) * 0.125;
    const edgeLen = Math.hypot(dx, dy, dz);
    const offsetLen = Math.hypot(ox, oy, oz);
    const maxOffset = edgeLen * 0.065;
    if (offsetLen > maxOffset && offsetLen > 1e-12) {
      const scale = maxOffset / offsetLen;
      ox *= scale; oy *= scale; oz *= scale;
    }
    const midIdx = newPos.length / 3;
    newPos.push(0.5 * (px + qx) + ox, 0.5 * (py + qy) + oy, 0.5 * (pz + qz) + oz);
    edgeMidpoints.set(key, midIdx);
    return midIdx;
  };

  for (let f = 0; f + 2 < triIndicesCount; f += 3) {
    const i0 = indexAttr ? indexAttr.getX(f) : f;
    const i1 = indexAttr ? indexAttr.getX(f + 1) : f + 1;
    const i2 = indexAttr ? indexAttr.getX(f + 2) : f + 2;
    const m01 = getMidpoint(i0, i1);
    const m12 = getMidpoint(i1, i2);
    const m20 = getMidpoint(i2, i0);
    newIndices.push(
      i0, m01, m20,
      m01, i1, m12,
      m20, m12, i2,
      m01, m12, m20,
    );
  }
  working.dispose();
  const out = new THREE.BufferGeometry();
  out.setAttribute("position", new THREE.BufferAttribute(new Float32Array(newPos), 3));
  out.setIndex(new THREE.BufferAttribute(new Uint32Array(newIndices), 1));
  computeAngleWeightedNormals(out);
  out.computeBoundingBox();
  out.computeBoundingSphere();
  return out;
}

function mergeTwoGeometries(a: THREE.BufferGeometry, b: THREE.BufferGeometry): THREE.BufferGeometry {
  const posA = a.getAttribute("position"), posB = b.getAttribute("position");
  const idxA = a.getIndex(), idxB = b.getIndex();
  const countA = posA.count, countB = posB.count;
  const mergedPos = new Float32Array((countA + countB) * 3);
  for (let i = 0; i < countA; i++) {
    mergedPos[3 * i] = posA.getX(i);
    mergedPos[3 * i + 1] = posA.getY(i);
    mergedPos[3 * i + 2] = posA.getZ(i);
  }
  for (let i = 0; i < countB; i++) {
    const at = (countA + i) * 3;
    mergedPos[at] = posB.getX(i);
    mergedPos[at + 1] = posB.getY(i);
    mergedPos[at + 2] = posB.getZ(i);
  }
  const indicesA = idxA ? idxA.count : countA;
  const indicesB = idxB ? idxB.count : countB;
  const mergedIdx = new Uint32Array(indicesA + indicesB);
  for (let i = 0; i < indicesA; i++) mergedIdx[i] = idxA ? idxA.getX(i) : i;
  for (let i = 0; i < indicesB; i++) mergedIdx[indicesA + i] = countA + (idxB ? idxB.getX(i) : i);
  const out = new THREE.BufferGeometry();
  out.setAttribute("position", new THREE.BufferAttribute(mergedPos, 3));
  out.setIndex(new THREE.BufferAttribute(mergedIdx, 1));
  computeAngleWeightedNormals(out);
  out.computeBoundingBox();
  out.computeBoundingSphere();
  return out;
}

function widenGeometryAttributes(geometry: THREE.BufferGeometry): THREE.BufferGeometry {
  const clone = geometry.clone();
  for (const name of Object.keys(clone.attributes)) {
    if (name.startsWith("_")) {
      clone.deleteAttribute(name);
      continue;
    }
    const attribute = clone.getAttribute(name);
    if (!attribute || attribute.array instanceof Float32Array) continue;
    const wide = new Float32Array(attribute.count * attribute.itemSize);
    for (let i = 0; i < attribute.count; i++) {
      for (let k = 0; k < attribute.itemSize; k++) {
        wide[i * attribute.itemSize + k] = attribute.getComponent(i, k);
      }
    }
    clone.setAttribute(name, new THREE.BufferAttribute(wide, attribute.itemSize));
  }
  return clone;
}

/** Restrict long torso vessels to the abdominal field. Intersect crossing
 * triangles with the bounds instead of exposing the thoracic aortic arch. */
export function clipVesselToAbdomen(source: THREE.BufferGeometry, minY: number, maxY: number): THREE.BufferGeometry {
  const position = source.getAttribute("position"), index = source.getIndex();
  const output: number[] = [];
  const clip = (polygon: THREE.Vector3[], plane: number, above: boolean) => {
    const result: THREE.Vector3[] = [];
    for (let i = 0; i < polygon.length; i++) {
      const a = polygon[i]!, b = polygon[(i + 1) % polygon.length]!;
      const insideA = above ? a.y >= plane : a.y <= plane;
      const insideB = above ? b.y >= plane : b.y <= plane;
      if (insideA) result.push(a);
      if (insideA !== insideB) result.push(a.clone().lerp(b, (plane - a.y) / (b.y - a.y)));
    }
    return result;
  };
  for (let face = 0; face < (index?.count ?? position.count); face += 3) {
    let polygon = [0, 1, 2].map(corner => new THREE.Vector3().fromBufferAttribute(position, index ? index.getX(face + corner) : face + corner));
    polygon = clip(clip(polygon, minY, true), maxY, false);
    for (let i = 1; i + 1 < polygon.length; i++) {
      output.push(...polygon[0]!.toArray(), ...polygon[i]!.toArray(), ...polygon[i + 1]!.toArray());
    }
  }
  const raw = new THREE.BufferGeometry();
  raw.setAttribute("position", new THREE.Float32BufferAttribute(output, 3));
  const result = mergeVertices(raw, 1e-5); raw.dispose();
  computeAngleWeightedNormals(result);
  result.computeBoundingBox(); result.computeBoundingSphere();
  return result;
}

/** Load a co-registered multi-organ laparoscopic 3D scene directly from the bundled BodyParts3D
 * human torso atlas, applying curved PN-triangle refinement to low-poly visceral organs so all
 * structures lay in natural sub-millimeter anatomical apposition with smooth surgical contours. */
export async function loadLaparoscopicSceneModel(
  presetId: LaparoscopicScenePresetId = "full-laparoscopy",
  signal?: AbortSignal,
): Promise<ImportedModel> {
  const preset = LAPAROSCOPIC_SCENE_PRESETS.find(item => item.id === presetId) ?? LAPAROSCOPIC_SCENE_PRESETS[0]!;
  const resources = new ImportResources();
  const abort = () => resources.dispose();
  signal?.addEventListener("abort", abort, { once: true });
  try {
    checkAbort(signal);
    if (presetId === "virtamed") {
      const {loadVirtaMedAsset} = await import("../virtaMedAsset");
      checkAbort(signal);
      const {root,sha256,bytes} = await loadVirtaMedAsset(signal);resources.own(root);
      checkAbort(signal);
      return {root,filename:preset.filename,format:"glb",stats:inspectImportedRoot(root),warnings:["Video-derived reconstruction of the visible hepatocystic field; hidden surfaces and scale are inferred.","Open the scene texture & physics lab for verified learned appearance and coupled tissue interaction."],source:{sha256,files:[{path:"virtamed-scene.glb",sha256,bytes}]},dispose(){resources.dispose();root.removeFromParent();}};
    }
    const response = await fetch(publicUrl("anatomy-scene/bodyparts3d-torso.glb"), signal ? { signal } : undefined);
    if (!response.ok) throw new Error("The bundled co-registered anatomical atlas could not be loaded.");
    const buffer = await response.arrayBuffer();
    checkAbort(signal);
    const gltf = await new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).parseAsync(buffer, "");
    checkAbort(signal);
    gltf.scene.updateMatrixWorld(true);

    const extracted = new Map<string, THREE.BufferGeometry>();
    gltf.scene.traverse(node => {
      if (!(node instanceof THREE.Mesh)) return;
      const rawId = String(node.userData?.id ?? node.name);
      const widened = widenGeometryAttributes(node.geometry).applyMatrix4(node.matrixWorld);
      extracted.set(rawId, widened);
    });

    // Combine the biliary ducts, retaining the artery and vein as separate structures.
    const cystic = extracted.get("cystic-duct");
    const hepaticDuct = extracted.get("hepatic-duct");
    if (cystic && hepaticDuct) {
      const mergedBiliary = mergeTwoGeometries(hepaticDuct, cystic);
      hepaticDuct.dispose();
      cystic.dispose();
      extracted.set("hepatic-duct", mergedBiliary);
      extracted.delete("cystic-duct");
    }
    const abdominalBounds = new THREE.Box3();
    for (const id of preset.organIds) {
      if (tubularStructure(id) || id === "mesentery") continue;
      const geometry = extracted.get(id);
      if (geometry) { geometry.computeBoundingBox(); abdominalBounds.union(geometry.boundingBox!); }
    }
    if (!abdominalBounds.isEmpty()) for (const id of ["aorta", "vena-cava"]) {
      const geometry = extracted.get(id);
      if (!geometry || !preset.organIds.includes(id)) continue;
      extracted.set(id, clipVesselToAbdomen(geometry, abdominalBounds.min.y, abdominalBounds.max.y));
      geometry.dispose();
    }
    const root = new THREE.Group();
    root.name = preset.filename;
    const wantedSet = new Set(preset.organIds);

    for (const organId of preset.organIds) {
      const geom = extracted.get(organId);
      if (!geom) continue;
      let finalGeom: THREE.BufferGeometry = geom;
      if (organId === "liver" || organId === "stomach" || organId === "colon") {
        fairSurfaceConcavityOutliers(finalGeom, organId === "liver" ? 7 : 3);
      }
      const passes = ORGAN_SUBDIVISION_PASSES[organId] ?? 0;
      if (passes > 0) {
        for (let pass = 0; pass < passes; pass++) {
          const nextGeom = pnSubdivideGeometry(finalGeom, pass === 0 ? 0.52 : 0.44);
          finalGeom.dispose();
          finalGeom = nextGeom;
        }
      } else {
        computeAngleWeightedNormals(finalGeom);
        finalGeom.computeBoundingBox();
        finalGeom.computeBoundingSphere();
      }
      // Smooth curvature left by the atlas triangles before applying pathology.
      if (["liver", "stomach", "small-intestine", "colon", "gallbladder", "pancreas"].includes(organId)) {
        fairSurfaceConcavityOutliers(finalGeom, organId === "liver" ? 10 : 5);
        computeAngleWeightedNormals(finalGeom);
        finalGeom.computeBoundingBox(); finalGeom.computeBoundingSphere();
      }
      resources.own(finalGeom);
      const structure = tubularStructure(organId);
      const optics = BASELINE_SEROSAL_OPTICS[organId] ??
        (structure === "artery" ? BASELINE_SEROSAL_OPTICS["hepatic-artery"] : structure === "vein" ? BASELINE_SEROSAL_OPTICS["portal-vein"] : undefined) ?? {
        color: 0xb58a80,
        sheenColor: 0xd9a89e,
        roughness: 0.32,
        clearcoat: 0.72,
        clearcoatRoughness: 0.14,
        sheen: 0.32,
      };
      const material = new THREE.MeshPhysicalMaterial({
        name: organId,
        color: optics.color,
        roughness: optics.roughness,
        metalness: 0,
        ior: 1.38,
        reflectivity: 0.58,
        clearcoat: optics.clearcoat,
        clearcoatRoughness: optics.clearcoatRoughness,
        sheen: 0,
        sheenRoughness: 0.42,
        sheenColor: new THREE.Color(optics.sheenColor),
        side: THREE.DoubleSide,
      });
      resources.own(material);
      const mesh = new THREE.Mesh(finalGeom, material);
      mesh.name = organId;
      root.add(mesh);
    }

    // Dispose any unused extracted geometries
    for (const [id, geom] of extracted.entries()) {
      if (!wantedSet.has(id)) geom.dispose();
    }

    resources.own(root);
    const stats = inspectImportedRoot(root);
    const warnings = [
      `Co-registered BodyParts3D human abdominal laparoscopy scene (${root.children.length} structures in shared native millimeter frame, CC BY 4.0).`,
      "Native atlas placement is retained; sampled contact damping does not certify anatomical contacts after variation.",
    ];
    let disposed = false;
    return {
      root,
      filename: preset.filename,
      format: "glb",
      stats,
      warnings,
      source: {
        sha256: "b604569cf1a976adb037c0f63d60fcdb0e39e83f69029d9bc5427bf4e5644ca6",
        files: [{
          path: preset.filename,
          sha256: "b604569cf1a976adb037c0f63d60fcdb0e39e83f69029d9bc5427bf4e5644ca6",
          bytes: buffer.byteLength,
        }],
      },
      dispose() {
        if (disposed) return;
        disposed = true;
        resources.dispose();
        root.removeFromParent();
      },
    };
  } catch (error) {
    resources.dispose();
    throw error;
  } finally {
    signal?.removeEventListener("abort", abort);
  }
}

