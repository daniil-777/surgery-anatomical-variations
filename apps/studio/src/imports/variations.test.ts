import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  BoxGeometry, BufferAttribute, BufferGeometry, Group, Matrix3, Mesh, MeshStandardMaterial,
  Texture, Vector3,
} from "three";
import { parseJointModel, sampleJointControls, type JointModelMeta } from "../atlasJointLocal";
import type { TextCompilerTables } from "../atlasTextCompiler";
import { deformVertices } from "../atlasLocal";
import {
  applyVariation, compileImportedText, createVariationState, disposeVariationState,
  importedVariationSystem, resetVariation, sampleNeuralVariation,
} from "./variations";

const read = (path: string) => readFileSync(new URL(path, import.meta.url));
const metadata = JSON.parse(read("../../public/models/joint-v2/model.json").toString()) as JointModelMeta;
const weights = read("../../public/models/joint-v2/weights.bin");
const model = parseJointModel(metadata, weights.buffer.slice(weights.byteOffset, weights.byteOffset + weights.byteLength));
const tables = JSON.parse(read("../../public/models/text-compiler/tables.json").toString()) as TextCompilerTables;
const system = importedVariationSystem(model, tables);
const referenceId = system.references[0]!.id;
const recipe = (seed = 42) => sampleNeuralVariation(system, { referenceId, seed, temperature: 0.7 });
function fixture() {
  const root = new Group();
  const geometry = new BoxGeometry(2, 3, 4, 3, 3, 3);
  geometry.computeTangents();
  const colors = new Float32Array(geometry.getAttribute("position").count * 4);
  for (let index = 0; index < colors.length; index += 4) colors.set([0.3, 0.5, 0.7, 0.4], index);
  geometry.setAttribute("color", new BufferAttribute(colors, 4));
  const map = new Texture(), roughnessMap = new Texture(), normalMap = new Texture();
  const material = new MeshStandardMaterial({ color: 0xaabbcc, vertexColors: true, map, roughnessMap,
    normalMap, roughness: 0.6, opacity: 0.7, transparent: true, alphaTest: 0.2 });
  const mesh = new Mesh(geometry, material);
  mesh.position.set(3, -2, 4); mesh.rotation.set(0.3, -0.2, 0.1); mesh.scale.set(1.5, 0.8, 1.2);
  root.add(mesh);
  return { root, mesh, geometry, material, state: createVariationState(root) };
}
const positions = (mesh: Mesh) => Array.from(mesh.geometry.getAttribute("position").array);
const colors = (mesh: Mesh) => Array.from(mesh.geometry.getAttribute("color").array);
const strength = { shapeStrength: 0.65, textureStrength: 0.5 };

describe("imported recipe sampling and text scope", () => {
  it("runs the actual bundled spline flow, with exact baseline controls and honest scope", () => {
    expect(system.references).toHaveLength(24);
    const sampled = recipe();
    const expected = sampleJointControls(model, referenceId, null, 42, 0.7, "baseline");
    expect(sampled.controls).toEqual(expected.controls);
    expect(sampled.material).toEqual(expected.material);
    expect(sampled.provenance).toMatchObject({
      method: "joint-flow-recipe-transfer", modelSha256: metadata.model_sha256,
      contextGain: 0, trainingSamples: 57888, meshEncoding: false, diseaseInference: false,
    });
    expect(recipe()).toEqual(sampled);
    expect(recipe(43).controls).not.toEqual(sampled.controls);
    expect(sampleNeuralVariation(system, { referenceId, seed: 42, temperature: 1.4 }).controls).not.toEqual(sampled.controls);
  });
  it("rejects unsupported conditions, seeds, temperature and altered limit metadata", () => {
    expect(() => sampleNeuralVariation(system, { referenceId: "upload", seed: 1, temperature: 1 })).toThrow("reference");
    expect(() => recipe(-1)).toThrow("seed");
    expect(() => sampleNeuralVariation(system, { referenceId, seed: 1, temperature: 8 })).toThrow("temperature");
    const broken = structuredClone(tables);
    broken.templates.find(entry => entry.template_id === referenceId)!.control_limits[0] = NaN;
    expect(() => importedVariationSystem(model, broken)).toThrow("limits");
  });
  it("supports documented bounded text edits without claiming an LLM or measured dimensions", () => {
    const result = compileImportedText(system, referenceId, "wider; flatter; twist 0.2; wetter");
    expect(result.controls.scale_x).toBe(0.2);
    expect(result.controls.scale_z).toBe(-0.2);
    expect(result.controls.twist).toBe(0.2);
    expect(result.provenance.method).toBe("deterministic-text-controls");
    expect(result.provenance.modelSha256).toBeNull();
    expect(result.controls.bend).toBe(0);
    expect(compileImportedText(system, referenceId, "please make it taller and wetness 0.9", result).controls.scale_y).toBe(0.2);
  });
  it.each(["wider; make a new liver", "wider; remove tumour", "20% wider", "height 200 mm",
    "twist 1.2", "wetness -1", "wider and", "make it realistic"])("rejects the entire unsupported request: %s", text => {
    const original = recipe(), before = JSON.stringify(original);
    expect(() => compileImportedText(system, referenceId, text, original)).toThrow();
    expect(JSON.stringify(original)).toBe(before);
  });
});

describe("imported immutable-source deformation and appearance", () => {
  it("replays seed42→43→42 exactly and preserves topology, UV, textures, alpha and source bytes", async () => {
    const f = fixture(), originalPositions = positions(f.mesh), originalColors = colors(f.mesh);
    const index = Array.from(f.geometry.index!.array), uv = Array.from(f.geometry.getAttribute("uv").array);
    const report = await applyVariation(f.state, recipe(), strength);
    const firstPositions = positions(f.mesh), firstColors = colors(f.mesh);
    expect(firstPositions).not.toEqual(originalPositions);
    expect(firstColors).not.toEqual(originalColors);
    expect(Array.from(f.mesh.geometry.index!.array)).toEqual(index);
    expect(Array.from(f.mesh.geometry.getAttribute("uv").array)).toEqual(uv);
    expect(f.mesh.geometry.groups).toEqual(f.geometry.groups);
    expect(report.minJacobian).toBeGreaterThan(0);
    const material = f.mesh.material as MeshStandardMaterial;
    expect(material).not.toBe(f.material);
    expect(material.map).toBe(f.material.map); expect(material.normalMap).toBe(f.material.normalMap);
    expect(material.roughnessMap).toBe(f.material.roughnessMap);
    expect(material.opacity).toBe(0.7); expect(material.alphaTest).toBe(0.2); expect(material.transparent).toBe(true);
    expect(material.color.toArray()).toEqual(f.material.color.toArray());
    expect(firstColors.filter((_, index) => index % 4 === 3)).toEqual(originalColors.filter((_, index) => index % 4 === 3));
    expect(firstColors.every(value => value >= 0 && value <= 1)).toBe(true);
    await applyVariation(f.state, recipe(43), strength);
    expect(positions(f.mesh)).not.toEqual(firstPositions);
    await applyVariation(f.state, recipe(), strength);
    expect(positions(f.mesh)).toEqual(firstPositions); expect(colors(f.mesh)).toEqual(firstColors);
    expect(Array.from(f.geometry.getAttribute("position").array)).toEqual(originalPositions);
    expect(Array.from(f.geometry.getAttribute("color").array)).toEqual(originalColors);
    resetVariation(f.state);
    expect(f.mesh.geometry).toBe(f.geometry); expect(f.mesh.material).toBe(f.material);
    expect(positions(f.mesh)).toEqual(originalPositions); expect(colors(f.mesh)).toEqual(originalColors);
  });
  it("supports shape-only, appearance-only and exact zero-strength source attributes", async () => {
    const f = fixture(), initial = positions(f.mesh), initialColors = colors(f.mesh);
    await applyVariation(f.state, recipe(), { shapeStrength: 0, textureStrength: 0.7 });
    expect(positions(f.mesh)).toEqual(initial); expect(colors(f.mesh)).not.toEqual(initialColors);
    await applyVariation(f.state, recipe(), { shapeStrength: 0.6, textureStrength: 0 });
    expect(positions(f.mesh)).not.toEqual(initial); expect(colors(f.mesh)).toEqual(initialColors);
    expect((f.mesh.material as MeshStandardMaterial).roughness).toBe(f.material.roughness);
    await applyVariation(f.state, recipe(), { shapeStrength: 0, textureStrength: 0 });
    expect(positions(f.mesh)).toEqual(initial); expect(colors(f.mesh)).toEqual(initialColors);
  });
  it.each([0, 0.6, 1])("wetness changes roughness monotonically for source roughness %s", async original => {
    const f = fixture(); f.material.roughness = original;
    const dry = recipe(); dry.material.wetness = 0;
    const wet = recipe(); wet.material.wetness = 1;
    await applyVariation(f.state, dry, { shapeStrength: 0, textureStrength: 1 });
    const dryValue = (f.mesh.material as MeshStandardMaterial).roughness;
    await applyVariation(f.state, wet, { shapeStrength: 0, textureStrength: 1 });
    const wetValue = (f.mesh.material as MeshStandardMaterial).roughness;
    expect(dryValue).toBeGreaterThan(wetValue);
    expect(wetValue).toBeGreaterThanOrEqual(0); expect(dryValue).toBeLessThanOrEqual(1);
    expect(f.material.roughness).toBe(original);
  });
  it("first shape text edits have no hidden random shape or appearance changes", async () => {
    const f = fixture(), originalColors = colors(f.mesh);
    const r = compileImportedText(system, referenceId, "wider");
    expect(r.controls.bend).toBe(0); expect(r.controls.twist).toBe(0);
    await applyVariation(f.state, r, strength);
    expect(colors(f.mesh)).toEqual(originalColors);
    expect((f.mesh.material as MeshStandardMaterial).roughness).toBeCloseTo(f.material.roughness, 12);
  });
  it("maps a shared world-space seam identically through different node transforms", async () => {
    const root = new Group();
    const g = new BufferGeometry();
    g.setAttribute("position", new BufferAttribute(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), 3));
    const a = new Mesh(g, new MeshStandardMaterial());
    const b = new Mesh(g.clone(), new MeshStandardMaterial()); b.position.set(1, 0, 0);
    root.add(a, b); root.rotation.z = 0.3; root.scale.set(2, 1, 0.7);
    const state = createVariationState(root);
    await applyVariation(state, recipe(), strength);
    const pa = new Vector3().fromBufferAttribute(a.geometry.getAttribute("position"), 1).applyMatrix4(a.matrixWorld);
    const pb = new Vector3().fromBufferAttribute(b.geometry.getAttribute("position"), 0).applyMatrix4(b.matrixWorld);
    expect(pa.distanceTo(pb)).toBeLessThan(2e-7);
  });
  it("transports authored normals and tangents by the deformation derivative", async () => {
    const f = fixture(), r = recipe();
    await applyVariation(f.state, r, strength);
    const p = f.geometry.getAttribute("position"), normals = f.mesh.geometry.getAttribute("normal");
    const tangents = f.mesh.geometry.getAttribute("tangent");
    const sourceNormals = f.geometry.getAttribute("normal");
    const controls = Object.fromEntries(Object.entries(r.controls).map(([name, value]) => [name, value * strength.shapeStrength]));
    const normalMatrix = new Matrix3().getNormalMatrix(f.mesh.matrixWorld);
    for (const index of [0, 17, 41, 70]) {
      const n = new Vector3().fromBufferAttribute(normals, index);
      const t = new Vector3().fromBufferAttribute(tangents, index);
      expect(n.length()).toBeCloseTo(1, 6); expect(t.length()).toBeCloseTo(1, 6); expect(n.dot(t)).toBeCloseTo(0, 5);
      const source = new Vector3().fromBufferAttribute(p, index).applyMatrix4(f.mesh.matrixWorld).sub(f.state.center);
      const oldN = new Vector3().fromBufferAttribute(sourceNormals, index).applyMatrix3(normalMatrix).normalize();
      const oldT = new Vector3(1, 0.4, -0.3).cross(oldN).normalize();
      const eps = f.state.normalization * 1e-5;
      const left = source.clone().addScaledVector(oldT, -eps), right = source.clone().addScaledVector(oldT, eps);
      const result = deformVertices([...left.toArray(), ...right.toArray()], controls, r.reference.limits, f.state.normalization);
      const tangentWorld = new Vector3().fromArray(result, 3).sub(new Vector3().fromArray(result)).normalize();
      const newN = n.applyMatrix3(normalMatrix).normalize();
      expect(Math.abs(newN.dot(tangentWorld))).toBeLessThan(1e-5);
    }
  });
  it("cancels atomically on reset or abort and releases only owned geometry/materials", async () => {
    const f = fixture();
    const originalGeometryDisposed = vi.fn(), originalTextureDisposed = vi.fn();
    f.geometry.addEventListener("dispose", originalGeometryDisposed);
    f.material.map!.addEventListener("dispose", originalTextureDisposed);
    const pending = applyVariation(f.state, recipe(), strength);
    resetVariation(f.state);
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(f.mesh.geometry).toBe(f.geometry);
    const controller = new AbortController(); controller.abort();
    await expect(applyVariation(f.state, recipe(), { ...strength, signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
    await applyVariation(f.state, recipe(), strength);
    const ownedDisposed = vi.fn(); f.mesh.geometry.addEventListener("dispose", ownedDisposed);
    disposeVariationState(f.state);
    expect(ownedDisposed).toHaveBeenCalledOnce();
    expect(originalGeometryDisposed).not.toHaveBeenCalled(); expect(originalTextureDisposed).not.toHaveBeenCalled();
    expect(f.mesh.geometry).toBe(f.geometry);
    await expect(applyVariation(f.state, recipe(), strength)).rejects.toThrow("disposed");
  });
  it("refuses invalid recipes and changed source transforms without partial publication", async () => {
    const f = fixture(), invalid = recipe(); invalid.controls.twist = NaN;
    await expect(applyVariation(f.state, invalid, strength)).rejects.toThrow("recipe");
    expect(f.mesh.geometry).toBe(f.geometry);
    f.mesh.position.x++;
    await expect(applyVariation(f.state, recipe(), strength)).rejects.toThrow("transforms changed");
    expect(f.mesh.geometry).toBe(f.geometry);
  });
  it("does not activate hidden source colors when original materials disabled vertex colors", async () => {
    const f = fixture(); f.material.vertexColors = false;
    await applyVariation(f.state, recipe(), { shapeStrength: 0, textureStrength: 0.01 });
    const color = f.mesh.geometry.getAttribute("color");
    expect(color.getX(0)).toBeGreaterThan(0.99); expect(color.getW(0)).toBe(1);
  });
  it("synthesizes seamless 3D PBR textures and realistic organ colors on untextured 3D meshes", async () => {
    const root = new Group();
    const geometry = new BoxGeometry(3, 2, 2.5, 4, 4, 4);
    geometry.deleteAttribute("uv");
    const material = new MeshStandardMaterial({ color: 0xffffff, roughness: 0.7 });
    const mesh = new Mesh(geometry, material);
    root.add(mesh);
    const state = createVariationState(root);
    const liverRecipe = sampleNeuralVariation(system, { referenceId: "hra-liver-female", seed: 42, temperature: 0.7 });
    const report = await applyVariation(state, liverRecipe, { shapeStrength: 0.35, textureStrength: 0.35 });
    expect(report.appearanceEncoding).toBe("seamless-3d-pbr-synthesis");
    expect(report.synthesizedTextures).toBe(3);
    const variedMat = mesh.material as MeshStandardMaterial;
    expect(variedMat.map).not.toBeNull();
    expect(variedMat.normalMap).not.toBeNull();
    expect(variedMat.roughnessMap).not.toBeNull();
    expect(variedMat.vertexColors).toBe(true);
    const uvAttr = mesh.geometry.getAttribute("uv");
    expect(uvAttr).toBeDefined();
    expect(uvAttr.count).toBe(geometry.getAttribute("position").count);
    const colorAttr = mesh.geometry.getAttribute("color");
    expect(colorAttr).toBeDefined();
    // Ensure the untextured mesh does not stay white (hepatic green/blue are well below 0.85)
    expect(colorAttr.getY(0)).toBeLessThan(0.75);
    expect(colorAttr.getZ(0)).toBeLessThan(0.75);
    resetVariation(state);
    expect(mesh.geometry).toBe(geometry);
    expect(mesh.material).toBe(material);
  });
  it("samples and applies the 22-DOF Joint Variational Model with pathology profiles (shape + texture + disease)", async () => {
    const root = new Group();
    const geometry = new BoxGeometry(4, 3, 3, 6, 6, 6);
    const material = new MeshStandardMaterial({ color: 0xffffff });
    const mesh = new Mesh(geometry, material);
    root.add(mesh);
    const state = createVariationState(root);
    const baselineRecipe = sampleNeuralVariation(system, { referenceId: "hra-liver-female", seed: 42, temperature: 0.7 });
    const cirrhoticRecipe = sampleNeuralVariation(system, {
      referenceId: "hra-liver-female",
      profileId: "liver-cirrhosis",
      severity: "severe",
      seed: 42,
      temperature: 0.7,
    });
    expect(cirrhoticRecipe.disease).toBeDefined();
    expect(cirrhoticRecipe.disease?.profile_id).toBe("liver-cirrhosis");
    expect(cirrhoticRecipe.provenance.profileId).toBe("liver-cirrhosis");
    expect(cirrhoticRecipe.provenance.severity).toBe("severe");
    await applyVariation(state, baselineRecipe, { shapeStrength: 0.5, textureStrength: 0.8 });
    const baselinePos = positions(mesh), baselineCol = colors(mesh);
    await applyVariation(state, cirrhoticRecipe, { shapeStrength: 0.5, textureStrength: 0.8 });
    const cirrhoticPos = positions(mesh), cirrhoticCol = colors(mesh);
    expect(cirrhoticPos).not.toEqual(baselinePos);
    expect(cirrhoticCol).not.toEqual(baselineCol);
  });
});
