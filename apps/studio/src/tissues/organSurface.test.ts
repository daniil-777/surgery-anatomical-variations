import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { MeshoptEncoder } from "meshoptimizer/encoder";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import * as THREE from "three";
import { ORGAN_SURFACE_IDS, extractOrganGeometry, supportedOrganSurface, organOrbitPose, loadOrganSurface } from "./organSurface";
import { projectedTriplanarNormal, triplanarBasis, applyTriplanar } from "./triplanar";
import { createScopeLighting } from "./lighting";

describe("explicit exterior anatomy selection", () => {
  it("only maps supported exterior families and never maps mucosa or absent anatomy", () => {
    expect(ORGAN_SURFACE_IDS).toHaveLength(12);
    for (const invalid of ["uterus", "muscle", "fascia", "peritoneum", "gastric_mucosa", "intestinal_mucosa", "colonic_mucosa", "liver_peritoneum", "constructor", "__proto__"]) expect(supportedOrganSurface(invalid)).toBe(false);
    expect(() => extractOrganGeometry(new THREE.Scene(), "uterus")).toThrow();
    expect(() => extractOrganGeometry(new THREE.Scene(), "liver")).toThrow("missing");
  });
  it("copies only named mesh positions in the original shared atlas frame", () => {
    const scene = new THREE.Scene(), geometry = new THREE.BoxGeometry(20, 30, 40), material = new THREE.MeshBasicMaterial(), liver = new THREE.Mesh(geometry, material), unrelated = new THREE.Mesh(new THREE.SphereGeometry(80), material);
    liver.name = "liver"; liver.position.set(12, -6, 4); unrelated.name = "stomach"; scene.add(liver, unrelated);
    const original = Array.from(geometry.getAttribute("position").array), result = extractOrganGeometry(scene, "liver");
    expect(result.nodes).toEqual(["liver"]); expect(result.center.toArray()).toEqual([12, -6, 4]);
    expect(Array.from(geometry.getAttribute("position").array)).toEqual(original);
    expect(result.geometry.getAttribute("position").count).toBe(geometry.getAttribute("position").count);
    expect(result.geometry.getAttribute("uv").array.every(value => value === 0)).toBe(true);
    result.geometry.dispose(); geometry.dispose(); unrelated.geometry.dispose(); material.dispose();
  });
  it("keeps every orbit direction outside the bounding sphere and closes exactly", () => {
    const surface = { center: new THREE.Vector3(20, 3, -11), radius: 87 };
    for (const yaw of [-180, -90, 0, 90, 180]) for (const pitch of [-90, 0, 90]) {
      const first = organOrbitPose(surface, 0, yaw, pitch), last = organOrbitPose(surface, 24, yaw, pitch);
      expect(first.position.distanceTo(surface.center)).toBeCloseTo(87 * 2.6, 10);
      expect(first.position.distanceTo(last.position)).toBeLessThan(1e-10);
      expect(first.target.equals(surface.center)).toBe(true);
      const forward = first.target.clone().sub(first.position).normalize(); expect(Math.abs(forward.dot(first.up))).toBeLessThan(1e-12);
    }
    expect(() => organOrbitPose(surface, NaN)).toThrow(); expect(() => organOrbitPose(surface, 0, 181)).toThrow();
  });
  it("keeps atlas illumination camera-mounted even when coupon grazing lighting was selected earlier", () => {
    const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera(), rig = createScopeLighting(scene);
    camera.position.set(250, -180, 95); camera.lookAt(40, -15, 60); camera.updateMatrixWorld();
    rig.update(camera, { view: "organ", lighting: "grazing", study: "lit", vessels: .7, fascia: .02, adipose: 0, wetness: .8, playing: false, time: 0, seed: 42 }, new THREE.Vector3(40, -15, 60));
    for (const light of scene.children) if (light instanceof THREE.RectAreaLight || light instanceof THREE.SpotLight) expect(light.position.distanceTo(camera.position)).toBeLessThan(5);
    rig.dispose(); expect(scene.children).toHaveLength(0);
  });
});

describe("triplanar surface gradients", () => {
  it("preserves every smooth surface normal for flat relief, without axis blending artifacts", () => {
    const flat = [new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 0, 1)];
    for (let i = 1; i <= 100; i++) {
      const normal = new THREE.Vector3(Math.sin(i), Math.cos(i * 1.7), Math.sin(i * 2.3)).normalize();
      expect(projectedTriplanarNormal(normal, flat, .85).distanceTo(normal)).toBeLessThan(1e-12);
    }
  });
  it("uses right-handed projections on all six faces and correctly orients a known u ramp", () => {
    for (let axis = 0; axis < 3; axis++) for (const sign of [-1, 1]) {
      const normal = new THREE.Vector3().setComponent(axis, sign), basis = triplanarBasis(normal);
      expect(basis.u[axis]!.clone().cross(basis.v[axis]!).distanceTo(normal)).toBeLessThan(1e-12);
      const mapNormal = new THREE.Vector3(-.25, 0, 1).normalize();
      const result = projectedTriplanarNormal(normal, [mapNormal, mapNormal, mapNormal]);
      const analytical = normal.clone().addScaledVector(basis.u[axis]!, -.25).normalize();
      expect(result.distanceTo(analytical)).toBeLessThan(1e-12);
    }
  });
  it("replaces atlas UV normals and map reads while retaining distinct shader roles", () => {
    const shader = { uniforms: {}, vertexShader: THREE.ShaderLib.physical.vertexShader, fragmentShader: THREE.ShaderLib.physical.fragmentShader } as THREE.WebGLProgramParametersWithUniforms;
    applyTriplanar(shader, "lit", false);
    expect(shader.fragmentShader).not.toContain("#include <normal_fragment_maps>");
    expect(shader.fragmentShader).not.toContain("#include <clearcoat_normal_fragment_maps>");
    expect(shader.fragmentShader).toContain("tissueSample(map, vMapUv)");
    expect(shader.fragmentShader).toContain("tissueNormalMatrix * normalize(tissueRestN + tissueGradient");
    expect(shader.vertexShader).toContain("vTissueRestPosition = position");
    expect(shader.fragmentShader).toContain("g-n*dot(n,g)");
  });
});


describe("packaged atlas loader integration", () => {
  it("extracts every supported exterior from the actual GLB without invented UVs or nonfinite coordinates", async () => {
    const bytes = await readFile("apps/studio/public/anatomy-scene/bodyparts3d-torso.glb");
    const source = await new GLTFLoader().parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), "");
    try {
      for (const organ of ORGAN_SURFACE_IDS) {
        const selected = extractOrganGeometry(source.scene, organ);
        expect(selected.radius).toBeGreaterThan(10); expect(selected.radius).toBeLessThan(350);
        expect(selected.geometry.getAttribute("position").array.every(Number.isFinite)).toBe(true);
        expect(selected.geometry.getAttribute("normal").array.every(Number.isFinite)).toBe(true);
        selected.geometry.dispose();
      }
    } finally {
      source.scene.traverse(node => { if (node instanceof THREE.Mesh) { node.geometry.dispose(); (Array.isArray(node.material) ? node.material : [node.material]).forEach(material => material.dispose()); } });
    }
  });
});

/** A software triangle tests actual decoding/ownership, not anatomical realism.
 * The required extension has no uncompressed fallback. The separate fallback
 * buffer declaration is the EXT_meshopt_compression placeholder, not BIN data.
 */
async function compressedTriangleGlb() {
  await MeshoptEncoder.ready;
  const positions = new Float32Array([0, 0, 0, 20, 0, 0, 0, 30, 0]);
  const encoded = MeshoptEncoder.encodeGltfBuffer(new Uint8Array(positions.buffer), 3, 12, "ATTRIBUTES", 0);
  const gltf = {
    asset: { version: "2.0", generator: "VISCERA software regression fixture; no anatomical claim" },
    extensionsUsed: ["EXT_meshopt_compression"], extensionsRequired: ["EXT_meshopt_compression"],
    scene: 0, scenes: [{ nodes: [0] }], nodes: [{ name: "liver", mesh: 0, translation: [12, -6, 4] }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, mode: 4 }] }],
    accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: "VEC3", min: [0, 0, 0], max: [20, 30, 0] }],
    buffers: [{ byteLength: encoded.byteLength }, { byteLength: positions.byteLength, extensions: { EXT_meshopt_compression: { fallback: true } } }],
    bufferViews: [{ buffer: 1, byteLength: positions.byteLength, byteStride: 12, target: 34962,
      extensions: { EXT_meshopt_compression: { buffer: 0, byteOffset: 0, byteLength: encoded.byteLength, byteStride: 12, count: 3, mode: "ATTRIBUTES", filter: "NONE" } } }],
  };
  const json = new TextEncoder().encode(JSON.stringify(gltf));
  const jsonLength = Math.ceil(json.length / 4) * 4, binLength = Math.ceil(encoded.length / 4) * 4;
  const bytes = new Uint8Array(12 + 8 + jsonLength + 8 + binLength), view = new DataView(bytes.buffer);
  view.setUint32(0, 0x46546c67, true); view.setUint32(4, 2, true); view.setUint32(8, bytes.length, true);
  view.setUint32(12, jsonLength, true); view.setUint32(16, 0x4e4f534a, true);
  bytes.fill(32, 20, 20 + jsonLength); bytes.set(json, 20);
  view.setUint32(20 + jsonLength, binLength, true); view.setUint32(24 + jsonLength, 0x004e4942, true);
  bytes.set(encoded, 28 + jsonLength);
  return bytes.buffer;
}

describe("compressed atlas fetch and integrity contract", () => {
  let bytes: ArrayBuffer, digest: string;
  const baseURI = "https://studio.example.test/portfolio/anatomy/tissues.html";
  beforeAll(async () => { bytes = await compressedTriangleGlb(); digest = createHash("sha256").update(new Uint8Array(bytes)).digest("hex"); });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
  function serve(signal: AbortSignal, expectedDigest = digest, onAssetRead?: () => void) {
    vi.stubGlobal("document", { baseURI });
    const manifest = { schemaVersion: "1.0", sha256: expectedDigest, units: "software-fixture-mm", license: "CC0-1.0", attribution: "Synthetic triangle test fixture", limitations: ["Not anatomical geometry"], sourceUrl: "https://studio.example.test/software-fixture" };
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.signal).toBe(signal);
      const url = String(input);
      if (url === "https://studio.example.test/portfolio/anatomy/anatomy-scene/manifest.json") return new Response(JSON.stringify(manifest), { headers: { "content-type": "application/json" } });
      if (url === "https://studio.example.test/portfolio/anatomy/anatomy-scene/bodyparts3d-torso.glb") {
        const response = new Response(bytes.slice(0), { headers: { "content-type": "model/gltf-binary" } });
        if (onAssetRead) { const read = response.arrayBuffer.bind(response); response.arrayBuffer = async () => { const value = await read(); onAssetRead(); return value; }; }
        return response;
      }
      throw new Error("Unexpected fixture request: " + url);
    });
    vi.stubGlobal("fetch", fetcher); return fetcher;
  }

  it("verifies and decodes required meshopt data through the production loader at a nested base URL", async () => {
    expect(bytes.byteLength).toBeLessThan(2048);
    // A loader without the decoder must fail, proving this is not plain fallback geometry.
    await expect(new GLTFLoader().parseAsync(bytes.slice(0), "")).rejects.toThrow(/setMeshoptDecoder/);
    const controller = new AbortController(), fetcher = serve(controller.signal);
    const surface = await loadOrganSurface("liver", controller.signal);
    try {
      expect(fetcher).toHaveBeenCalledTimes(2);
      expect(surface.nodes).toEqual(["liver"]);
      expect(Array.from(surface.geometry.getAttribute("position").array)).toEqual([12, -6, 4, 32, -6, 4, 12, 24, 4]);
      expect(Array.from(surface.geometry.getAttribute("normal").array)).toEqual([0, 0, 1, 0, 0, 1, 0, 0, 1]);
      expect(Array.from(surface.geometry.getAttribute("uv").array)).toEqual([0, 0, 0, 0, 0, 0]);
      expect(surface.center.toArray()).toEqual([22, 9, 4]); expect(surface.radius).toBeCloseTo(Math.hypot(10, 15), 10);
      expect(surface.provenance).toEqual({ assetSha256: digest, license: "CC0-1.0", attribution: "Synthetic triangle test fixture", units: "software-fixture-mm", limitations: ["Not anatomical geometry"], source: "https://studio.example.test/software-fixture" });
    } finally { surface.geometry.dispose(); }
  });

  it("rejects the pre-compression manifest digest before attempting to decode the compressed asset", async () => {
    const controller = new AbortController(), staleDigest = createHash("sha256").update("different uncompressed atlas bytes").digest("hex");
    serve(controller.signal, staleDigest);
    const parse = vi.spyOn(GLTFLoader.prototype, "parseAsync");
    await expect(loadOrganSurface("liver", controller.signal)).rejects.toThrow("Atlas asset digest mismatch");
    expect(parse).not.toHaveBeenCalled();
  });

  it("does not decode or publish geometry when cancellation arrives after the asset response", async () => {
    const controller = new AbortController(); serve(controller.signal, digest, () => controller.abort());
    const parse = vi.spyOn(GLTFLoader.prototype, "parseAsync");
    await expect(loadOrganSurface("liver", controller.signal)).rejects.toThrow("Atlas loading cancelled");
    expect(parse).not.toHaveBeenCalled();
  });
});
