import * as THREE from "three";
import { ATLAS_VESSEL_VERSION, type AtlasVesselNetwork } from "./atlasVessels";

const TEXTURE_WIDTH = 512;
export interface AtlasVesselShaderHandle { dispose: () => void; setVisibility: (visibility: number) => void }

export interface AtlasVesselGrid {
  origin: THREE.Vector3;
  cellSize: number;
  dimensions: THREE.Vector3;
  headers: Float32Array;
  candidates: Float32Array;
  segments: Float32Array;
  maxCellSegments: number;
}
/** Conservative segment AABBs retain every field with non-negligible support.
 * Lists have variable length, so dense junctions never silently lose branches. */
export function createAtlasVesselGrid(network: AtlasVesselNetwork): AtlasVesselGrid {
  const bounds = new THREE.Box3();
  for (const s of network.segments) {
    const support = 2 * (Math.max(s.radius_a_mm, s.radius_b_mm) * 2.3 + 0.7 * s.depth_mm);
    for (const p of [s.a_mm, s.b_mm]) {
      bounds.expandByPoint(new THREE.Vector3(...p).addScalar(support));
      bounds.expandByPoint(new THREE.Vector3(...p).addScalar(-support));
    }
  }
  if (bounds.isEmpty()) bounds.set(new THREE.Vector3(-1, -1, -1), new THREE.Vector3(1, 1, 1));
  const size = bounds.getSize(new THREE.Vector3());
  const cellSize = Math.max(size.x, size.y, size.z, 1) / 40;
  const dimensions = size.clone().divideScalar(cellSize).ceil().max(new THREE.Vector3(1, 1, 1));
  const count = dimensions.x * dimensions.y * dimensions.z;
  const cells = Array.from({ length: count }, () => [] as number[]);
  const segments = new Float32Array(Math.max(12, network.segments.length * 12));
  for (let i = 0; i < network.segments.length; i++) {
    const s = network.segments[i]!;
    segments.set([...s.a_mm, s.radius_a_mm, ...s.b_mm, s.radius_b_mm, ...s.normal, s.depth_mm * (s.kind === 0 ? -1 : 1)], i * 12);
    const support = 2 * (Math.max(s.radius_a_mm, s.radius_b_mm) * 2.3 + 0.7 * s.depth_mm);
    const lo = new THREE.Vector3(...s.a_mm).min(new THREE.Vector3(...s.b_mm)).addScalar(-support).sub(bounds.min).divideScalar(cellSize).floor().max(new THREE.Vector3());
    const hi = new THREE.Vector3(...s.a_mm).max(new THREE.Vector3(...s.b_mm)).addScalar(support).sub(bounds.min).divideScalar(cellSize).floor().min(dimensions.clone().addScalar(-1));
    for (let z = lo.z; z <= hi.z; z++) for (let y = lo.y; y <= hi.y; y++) for (let x = lo.x; x <= hi.x; x++)
      cells[x + dimensions.x * (y + dimensions.y * z)]!.push(i);
  }
  const headers = new Float32Array(count * 4), indices: number[] = [];
  let maxCellSegments = 0;
  for (let i = 0; i < cells.length; i++) {
    const cell = cells[i]!;
    headers[i * 4] = indices.length; headers[i * 4 + 1] = cell.length;
    indices.push(...cell); maxCellSegments = Math.max(maxCellSegments, cell.length);
  }
  return { origin: bounds.min, cellSize, dimensions, headers, candidates: new Float32Array(indices.length ? indices : [0]), segments, maxCellSegments };
}

function dataTexture(values: Float32Array): THREE.DataTexture {
  const height = Math.max(1, Math.ceil(values.length / (TEXTURE_WIDTH * 4)));
  const buffer = new Float32Array(TEXTURE_WIDTH * height * 4); buffer.set(values);
  const texture = new THREE.DataTexture(buffer, TEXTURE_WIDTH, height, THREE.RGBAFormat, THREE.FloatType);
  texture.minFilter = THREE.NearestFilter; texture.magFilter = THREE.NearestFilter;
  texture.generateMipmaps = false; texture.needsUpdate = true;
  return texture;
}

export const ATLAS_VESSEL_GLSL = `
uniform sampler2D uVesselHeaders;
uniform sampler2D uVesselCandidates;
uniform sampler2D uVesselSegments;
uniform vec3 uVesselOrigin;
uniform vec3 uVesselDimensions;
uniform float uVesselCellSize;
uniform float uVesselVisibility;
struct AtlasVesselSample { float artery; float vein; float core; float heightMm; vec3 gradient; };
vec4 atlasVesselTexel(sampler2D source, int index) {
  return texelFetch(source, ivec2(index % 512, index / 512), 0);
}
AtlasVesselSample atlasSampleVessels(vec3 p, vec3 restNormal, float footprint) {
  AtlasVesselSample result;
  result.artery = 0.0; result.vein = 0.0; result.core = 0.0; result.heightMm = 0.0; result.gradient = vec3(0.0);
  if (uVesselVisibility <= 0.0) return result;
  ivec3 cell = ivec3(floor((p - uVesselOrigin) / uVesselCellSize));
  if (any(lessThan(cell, ivec3(0))) || any(greaterThanEqual(cell, ivec3(uVesselDimensions)))) return result;
  int flatCell = cell.x + int(uVesselDimensions.x) * (cell.y + int(uVesselDimensions.y) * cell.z);
  vec2 header = atlasVesselTexel(uVesselHeaders, flatCell).xy;
  for (int i = 0; i < int(header.y); i++) {
    int candidate = int(header.x) + i;
    vec4 candidatePack = atlasVesselTexel(uVesselCandidates, candidate / 4);
    int index = int(candidatePack[candidate % 4]);
    vec4 a = atlasVesselTexel(uVesselSegments, index * 3);
    vec4 b = atlasVesselTexel(uVesselSegments, index * 3 + 1);
    vec4 nd = atlasVesselTexel(uVesselSegments, index * 3 + 2);
    vec3 axis = b.xyz - a.xyz;
    float t = clamp(dot(p - a.xyz, axis) / max(dot(axis, axis), 1e-12), 0.0, 1.0);
    vec3 delta = p - mix(a.xyz, b.xyz, t);
    float d2 = dot(delta, delta), radius = mix(a.w, b.w, t), depth = abs(nd.w);
    float haloWidth = radius * 2.3 + 0.7 * depth;
    if (d2 > 4.0 * haloWidth * haloWidth) continue;
    float alignment = smoothstep(0.15, 0.55, dot(restNormal, nd.xyz));
    float w = radius + 0.2 * depth, w2 = w * w + 0.2 * footprint * footprint;
    float core = exp(-2.0 * d2 / w2 - 0.8 * depth) * alignment * w / sqrt(w2);
    float halo = exp(-2.0 * d2 / (haloWidth * haloWidth) - 0.8 * depth) * alignment;
    float opacity = uVesselVisibility * (0.62 * core + 0.12 * halo);
    if (nd.w < 0.0) result.artery = max(result.artery, opacity); else result.vein = max(result.vein, opacity);
    result.core = max(result.core, core * uVesselVisibility);
    float height = 0.1 * radius * core * uVesselVisibility;
    if (height > result.heightMm) {
      result.heightMm = height;
      result.gradient = -4.0 * delta * height / w2;
    }
  }
  return result;
}
vec3 atlasVesselColor(vec3 base, AtlasVesselSample field) {
  base = mix(base, vec3(0.1626471937, 0.0134117489, 0.0196066485), field.artery);
  return mix(base, vec3(0.0732389559, 0.0196066485, 0.0396819095), field.vein);
}
vec3 atlasVesselPerturbNormal(vec3 surfacePosition, vec3 surfaceNormal, vec3 restGradient, float faceOrientation) {
  vec3 dx = dFdx(surfacePosition), dy = dFdy(surfacePosition);
  vec3 r1 = cross(dy, surfaceNormal), r2 = cross(surfaceNormal, dx);
  float determinant = dot(dx, r1) * faceOrientation;
  if (abs(determinant) <= length(cross(dx, dy)) * 1e-7) return surfaceNormal;
  vec2 derivative = vec2(dot(restGradient, dFdx(vAtlasRestPosition)), dot(restGradient, dFdy(vAtlasRestPosition)));
  vec3 gradient = sign(determinant) * (derivative.x * r1 + derivative.y * r2);
  return normalize(abs(determinant) * surfaceNormal - gradient);
}
`;

/** Install after the authored tissue material. Rest-space sampling advects with
 * arbitrary vertex edits, with no floating overlay meshes or frame-time rebuilds. */
export function installAtlasVessels(geometry: THREE.BufferGeometry, material: THREE.MeshPhysicalMaterial, network: AtlasVesselNetwork): AtlasVesselShaderHandle {
  if (!geometry.hasAttribute("atlasRestPosition")) geometry.setAttribute("atlasRestPosition", geometry.getAttribute("position").clone());
  const grid = createAtlasVesselGrid(network);
  const headers = dataTexture(grid.headers), candidates = dataTexture(grid.candidates), segments = dataTexture(grid.segments);
  const visibility = { value: network.settings.visibility };
  const uniforms = {
    uVesselHeaders: { value: headers }, uVesselCandidates: { value: candidates }, uVesselSegments: { value: segments },
    uVesselOrigin: { value: grid.origin }, uVesselDimensions: { value: grid.dimensions }, uVesselCellSize: { value: grid.cellSize }, uVesselVisibility: visibility,
  };
  const previousCompile = material.onBeforeCompile, previousKey = material.customProgramCacheKey.bind(material);
  const key = previousKey();
  material.customProgramCacheKey = () => `${key}:${ATLAS_VESSEL_VERSION}`;
  material.onBeforeCompile = (shader, renderer) => {
    previousCompile.call(material, shader, renderer);
    Object.assign(shader.uniforms, uniforms);
    if (!shader.vertexShader.includes("attribute vec3 atlasRestPosition;")) {
      shader.vertexShader = shader.vertexShader.replace("#include <common>", "#include <common>\nattribute vec3 atlasRestPosition;\nvarying vec3 vAtlasRestPosition;")
        .replace("#include <begin_vertex>", "#include <begin_vertex>\nvAtlasRestPosition = atlasRestPosition;");
      shader.fragmentShader = shader.fragmentShader.replace("#include <common>", "#include <common>\nvarying vec3 vAtlasRestPosition;");
    }
    // Append after the varying declaration, including the tissue shader's declaration.
    shader.fragmentShader = shader.fragmentShader.replace("varying vec3 vAtlasRestPosition;", `varying vec3 vAtlasRestPosition;\n${ATLAS_VESSEL_GLSL}`)
      .replace("#include <roughnessmap_fragment>", `
        vec3 vesselRestNormal = normalize(cross(dFdx(vAtlasRestPosition), dFdy(vAtlasRestPosition))) * (gl_FrontFacing ? 1.0 : -1.0);
        AtlasVesselSample atlasVesselField = atlasSampleVessels(vAtlasRestPosition, vesselRestNormal, max(length(dFdx(vAtlasRestPosition)), length(dFdy(vAtlasRestPosition))));
        diffuseColor.rgb = atlasVesselColor(diffuseColor.rgb, atlasVesselField);
        #include <roughnessmap_fragment>`)
      .replace("#include <normal_fragment_begin>", "roughnessFactor = clamp(roughnessFactor - 0.035 * atlasVesselField.core, 0.16, 0.9);\n#include <normal_fragment_begin>")
      .replace("#include <normal_fragment_maps>", "#include <normal_fragment_maps>\nnormal = atlasVesselPerturbNormal(-vViewPosition, normal, atlasVesselField.gradient, faceDirection);")
      .replace("#include <clearcoat_normal_fragment_maps>", "#include <clearcoat_normal_fragment_maps>\n#ifdef USE_CLEARCOAT\nclearcoatNormal = atlasVesselPerturbNormal(-vViewPosition, clearcoatNormal, atlasVesselField.gradient, faceDirection);\n#endif");
  };
  material.needsUpdate = true;
  let disposed = false;
  const dispose = () => { if (disposed) return; disposed = true; headers.dispose(); candidates.dispose(); segments.dispose(); material.removeEventListener("dispose", dispose); };
  material.addEventListener("dispose", dispose);
  return { dispose, setVisibility: value => { visibility.value = Math.max(0, Math.min(1, value)); } };
}
