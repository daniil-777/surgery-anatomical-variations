import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import * as THREE from "three";
import { MeshoptEncoder } from "meshoptimizer";
import { IMPORT_LIMITS, exportImportedModelGLB, inspectImportedRoot, loadImportedModel } from "./importModel";
import { ImportResources, imageHeader } from "./importResources";
import { readGltfContainer } from "./importGltf";

const directory = new URL("../../../../tests/fixtures/imported-models/", import.meta.url);
const bytes = (name: string) => new Uint8Array(readFileSync(new URL(name, directory)));
const file = (name: string) => new File([bytes(name)], name);
const gltfFiles = () => [file("colour-pbr-multipart.gltf"), file("colour-pbr-multipart.bin"), file("quadrants.png")];
const objFiles = () => [file("colour-cube.obj"), file("colour-cube.mtl"), file("quadrants.png")];
const bitmaps: { width: number; height: number; close: ReturnType<typeof vi.fn> }[] = [];
const fetchSpy = vi.fn(() => { throw new Error("Network forbidden in local import test"); });
function changedGltf(change: (json: any) => void): File[] {
  const files = gltfFiles(), json = JSON.parse(new TextDecoder().decode(bytes("colour-pbr-multipart.gltf")));
  change(json); files[0] = new File([JSON.stringify(json)], "changed.gltf"); return files;
}
beforeEach(() => {
  bitmaps.length = 0; fetchSpy.mockClear();
  vi.stubGlobal("fetch", fetchSpy);
  // Parser unit test seam only: browser tests use the real decoder and rendered
  // quadrant pixels. This verifies dimensions/ownership, not image decoding.
  vi.stubGlobal("createImageBitmap", vi.fn(async (blob: Blob) => {
    const { width, height } = imageHeader(await blob.arrayBuffer());
    const bitmap = { width, height, close: vi.fn() }; bitmaps.push(bitmap); return bitmap;
  }));
  vi.stubGlobal("FileReader", class {
    result: ArrayBuffer | string | null = null;
    onloadend: (() => void) | null = null;
    readAsArrayBuffer(blob: Blob) { void blob.arrayBuffer().then(value => { this.result = value; this.onloadend?.(); }); }
  });
});
afterEach(() => { expect(fetchSpy).not.toHaveBeenCalled(); vi.unstubAllGlobals(); });

describe("actual static interchange fixtures", () => {
  it.each(["colour-pbr-multipart.glb", "colour-pbr-multipart.gltf"])("preserves PBR/UV/RGBA/hierarchy in %s without network", async name => {
    const model = await loadImportedModel(name.endsWith(".glb") ? [file(name)] : gltfFiles());
    expect(model.stats).toMatchObject({ meshes: 2, vertices: 48, triangles: 24, materials: 1, textures: 1 });
    const left = model.root.getObjectByName("left-cube") as THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>;
    expect(left.position.toArray()).toEqual([-1.4, 0, 0]);
    expect(left.scale.toArray()).toEqual([.6, .85, .6]);
    expect(left.parent!.position.toArray()).toEqual([.2, .1, -.15]);
    expect(left.geometry.getAttribute("color").itemSize).toBe(4);
    expect(left.geometry.getAttribute("uv").count).toBe(24);
    expect(left.material.color.toArray()).toEqual([.8, .9, 1]);
    expect(left.material.roughness).toBe(.55); expect(left.material.metalness).toBe(.15);
    expect(left.material.vertexColors).toBe(true);
    expect(left.material.map!.colorSpace).toBe(THREE.SRGBColorSpace);
    expect(left.material.map!.flipY).toBe(false);
    expect(left.material.map!.magFilter).toBe(THREE.NearestFilter);
    expect(model.source.sha256).toMatch(/^[a-f\d]{64}$/);
    expect(model.stats.bounds.size[0]).toBeGreaterThan(3);
    const disposed = vi.fn(); left.material.addEventListener("dispose", disposed);
    model.dispose(); model.dispose();
    expect(disposed).toHaveBeenCalledOnce(); expect(bitmaps[0]!.close).toHaveBeenCalledOnce();
  });
  it("resolves OBJ material/texture sidecars and retains UVs and legacy material", async () => {
    const model = await loadImportedModel(objFiles());
    expect(model.stats).toMatchObject({ meshes: 1, triangles: 12, materials: 1, textures: 1 });
    const mesh = model.root.children[0] as THREE.Mesh<THREE.BufferGeometry, THREE.MeshPhongMaterial>;
    expect(mesh.geometry.getAttribute("uv").count).toBe(36);
    expect(mesh.material.name).toBe("PaintedPBRFallback");
    expect(mesh.material.map!.colorSpace).toBe(THREE.SRGBColorSpace);
    expect(model.warnings.join(" ")).toMatch(/legacy material/); model.dispose();
  });
  it.each(["cube-ascii.stl", "cube-binary.stl"])("loads %s as explicitly shape-only", async name => {
    const model = await loadImportedModel([file(name)]);
    expect(model.stats).toMatchObject({ meshes: 1, triangles: 12, materials: 1, textures: 0 });
    expect(model.stats.bounds.size).toEqual([2,2,2]);
    expect(model.warnings.join()).toMatch(/does not contain standard materials/); model.dispose();
  });
  it("makes the source digest independent of selection order and sensitive to bytes", async () => {
    const a = await loadImportedModel(gltfFiles()), b = await loadImportedModel(gltfFiles().reverse());
    expect(a.source).toEqual(b.source);
    const c = await loadImportedModel(changedGltf(json => { json.nodes[0].name = "changed-name"; }));
    expect(c.source.sha256).not.toBe(a.source.sha256);
    [a,b,c].forEach(model => model.dispose());
  });
  it("supports selected directory paths and unique selected-file basename resolution", async () => {
    const files = gltfFiles();
    Object.defineProperty(files[0], "webkitRelativePath", { value: "bundle/colour-pbr-multipart.gltf" });
    Object.defineProperty(files[1], "webkitRelativePath", { value: "bundle/colour-pbr-multipart.bin" });
    Object.defineProperty(files[2], "webkitRelativePath", { value: "bundle/quadrants.png" });
    const model = await loadImportedModel(files); expect(model.source.files.every(f => f.path.startsWith("bundle/"))).toBe(true); model.dispose();
  });
  it("decodes actual meshopt data with the bundled decoder and no network", async () => {
    await MeshoptEncoder.ready;
    const compressed = MeshoptEncoder.encodeGltfBuffer(bytes("colour-pbr-multipart.bin").slice(0,288),24,12,"ATTRIBUTES");
    const files = changedGltf(json => {
      json.extensionsUsed = json.extensionsRequired = ["EXT_meshopt_compression"];
      json.buffers.push({ uri:"compressed.bin",byteLength:compressed.length });
      json.bufferViews[0].extensions = { EXT_meshopt_compression:{ buffer:1,byteOffset:0,byteLength:compressed.length,count:24,byteStride:12,mode:"ATTRIBUTES" } };
    });
    files.push(new File([new Uint8Array(compressed)],"compressed.bin"));
    const model = await loadImportedModel(files);
    const mesh = model.root.getObjectByName("left-cube") as THREE.Mesh;
    expect(Array.from(mesh.geometry.getAttribute("position").array)).toEqual(Array.from(new Float32Array(bytes("colour-pbr-multipart.bin").buffer.slice(0,288))));
    model.dispose();
  });
  it.each([
    ["KHR_materials_clearcoat",{clearcoatFactor:.65,clearcoatRoughnessFactor:.2},"clearcoat",.65],
    ["KHR_materials_transmission",{transmissionFactor:.45},"transmission",.45],
    ["KHR_materials_ior",{ior:1.33},"ior",1.33],
    ["KHR_materials_volume",{thicknessFactor:.2},"thickness",.2],
  ])("preserves physical material extension %s including infinite default attenuation", async (name,settings,key,value) => {
    const files = changedGltf(json => {
      json.extensionsUsed = [name]; json.materials[0].extensions = { [name as string]:settings };
    });
    const model = await loadImportedModel(files);
    const mesh = model.root.getObjectByName("left-cube") as THREE.Mesh<THREE.BufferGeometry,THREE.MeshPhysicalMaterial>;
    expect((mesh.material as any)[key as string]).toBe(value);
    expect(mesh.material.attenuationDistance).toBe(Infinity);
    model.dispose();
  });
  it.each([0,24])("accepts in-range sparse indices and rejects out-of-range value %s", async sparseIndex => {
    const binary = new Uint8Array(1240); binary.set(bytes("colour-pbr-multipart.bin"));
    const view = new DataView(binary.buffer); view.setUint16(1224,sparseIndex,true); view.setFloat32(1228,-2,true); view.setFloat32(1232,-1,true); view.setFloat32(1236,1,true);
    const files = changedGltf(json => {
      json.buffers[0].byteLength = 1240;
      json.bufferViews.push({ buffer:0,byteOffset:1224,byteLength:2 },{ buffer:0,byteOffset:1228,byteLength:12 });
      json.accessors[0].sparse = { count:1,indices:{ bufferView:5,componentType:5123 },values:{ bufferView:6 } };
    });
    files[1] = new File([binary],"colour-pbr-multipart.bin");
    if (sparseIndex) { await expect(loadImportedModel(files)).rejects.toThrow(/Sparse accessor indices/); expect(bitmaps).toHaveLength(0); }
    else {
      const model = await loadImportedModel(files), mesh = model.root.getObjectByName("left-cube") as THREE.Mesh;
      expect(mesh.geometry.getAttribute("position").getX(0)).toBe(-2); model.dispose();
    }
  });
});
describe("bounded local-only input", () => {
  it.each(["https://example.com/a.bin", "//example.com/a.bin", "file:///tmp/a.bin", "blob:https://site/id", "C:\\secret.bin", "../outside.bin"])("rejects remote/escaping dependency %s", async uri => {
    await expect(loadImportedModel(changedGltf(json => { json.buffers[0].uri = uri; }))).rejects.toThrow(/local|escapes|not allowed/);
    expect(bitmaps).toHaveLength(0);
  });
  it("rejects missing texture rather than silently dropping it", async () => {
    await expect(loadImportedModel(gltfFiles().slice(0,2))).rejects.toThrow(/Missing local dependency/);
  });
  it("rejects a missing OBJ material and its remote image", async () => {
    await expect(loadImportedModel([file("colour-cube.obj")])).rejects.toThrow(/Missing local dependency/);
    const files = objFiles(); files[1] = new File(["newmtl PaintedPBRFallback\nmap_Kd https://example.com/texture.png\n"], "colour-cube.mtl");
    await expect(loadImportedModel(files)).rejects.toThrow(/not allowed/);
  });
  it("rejects an ambiguous selection and case-duplicate sidecars", async () => {
    await expect(loadImportedModel([file("cube-ascii.stl"), file("cube-binary.stl")])).rejects.toThrow(/exactly one/);
    await expect(loadImportedModel([...gltfFiles(), new File(["x"], "QUADRANTS.PNG")])).rejects.toThrow(/Duplicate/);
  });
  it("checks selected bytes before reading oversized data", async () => {
    const huge = file("cube-binary.stl"); Object.defineProperty(huge, "size", { value: IMPORT_LIMITS.sourceBytes + 1 });
    const read = vi.spyOn(huge, "arrayBuffer");
    await expect(loadImportedModel([huge])).rejects.toThrow(/128 MiB/); expect(read).not.toHaveBeenCalled();
  });
  it.each([
    ["huge accessor", (j: any) => { j.accessors[0].count = 20_000_000; }],
    ["out-of-bounds accessor", (j: any) => { j.accessors[0].byteOffset = 200; }],
    ["node cycle", (j: any) => { j.nodes[1].children = [0]; }],
    ["multiple parents", (j: any) => { j.nodes[1].children = [2]; }],
    ["skin", (j: any) => { j.nodes[1].skin = 0; }],
    ["animation", (j: any) => { j.animations = [{}]; }],
    ["morph", (j: any) => { j.meshes[0].primitives[0].targets = [{ POSITION: 0 }]; }],
    ["instancing", (j: any) => { j.nodes[0].extensions = { EXT_mesh_gpu_instancing: {} }; }],
    ["unknown required extension", (j: any) => { j.extensionsRequired = ["CUSTOM_network"]; }],
    ["Draco", (j: any) => { j.extensionsUsed = ["KHR_draco_mesh_compression"]; }],
    ["float index accessor", (j: any) => { j.accessors[4].componentType = 5126; j.bufferViews[4].byteLength = 144; j.bufferViews[4].byteOffset = 1080; }],
    ["normalized index accessor", (j: any) => { j.accessors[4].normalized = true; }],
    ["vector index accessor", (j: any) => { j.accessors[4].type = "VEC2"; j.bufferViews[4].byteLength = 144; j.bufferViews[4].byteOffset = 1080; }],
    ["malformed normal dimension", (j: any) => { j.accessors[1].type = "VEC2"; }],
    ["malformed tangent dimension", (j: any) => { j.meshes[0].primitives[0].attributes.TANGENT = 1; }],
    ["malformed UV dimension", (j: any) => { j.meshes[0].primitives[0].attributes.TEXCOORD_0 = 1; }],
    ["malformed vertex color dimension", (j: any) => { j.meshes[0].primitives[0].attributes.COLOR_0 = 2; }],
  ] as const)("rejects %s before allocating images", async (_, mutate) => {
    await expect(loadImportedModel(changedGltf(mutate))).rejects.toThrow(); expect(bitmaps).toHaveLength(0);
  });
  it("rejects oversized decoded image dimensions before the browser decoder", async () => {
    const files = gltfFiles(), png = bytes("quadrants.png");
    new DataView(png.buffer).setUint32(16, 100000);
    files[2] = new File([png], "quadrants.png");
    await expect(loadImportedModel(files)).rejects.toThrow(/image width/);
    expect(createImageBitmap).not.toHaveBeenCalled();
  });
  it("rejects malformed/truncated GLB containers", async () => {
    const original = bytes("colour-pbr-multipart.glb");
    await expect(loadImportedModel([new File([original.slice(0,100)], "bad.glb")])).rejects.toThrow(/header or length/);
  });
  it("rejects invalid vertex data after parsing and releases decoded images", async () => {
    const files = gltfFiles(), binary = bytes("colour-pbr-multipart.bin"); new DataView(binary.buffer).setFloat32(0, NaN, true);
    files[1] = new File([binary], "colour-pbr-multipart.bin");
    await expect(loadImportedModel(files)).rejects.toThrow(/nonfinite/);
    expect(bitmaps[0]!.close).toHaveBeenCalledOnce();
  });
  it("rejects malicious metadata before Three Object.assign sees it", async () => {
    const files = gltfFiles(), text = new TextDecoder().decode(bytes("colour-pbr-multipart.gltf")).replace('"asset":', '"extras":{"__proto__":{"polluted":true}},"asset":');
    files[0] = new File([text], "evil.gltf"); await expect(loadImportedModel(files)).rejects.toThrow(/Unsafe metadata/);
    expect(({} as any).polluted).toBeUndefined();
  });
});
describe("cancellation and ownership", () => {
  it("rejects an already aborted load without reading", async () => {
    const controller = new AbortController(); controller.abort();
    await expect(loadImportedModel([file("colour-pbr-multipart.glb")], controller.signal)).rejects.toMatchObject({ name: "AbortError" });
  });
  it("closes a texture that finishes decoding after cancellation", async () => {
    let resolve!: (value: unknown) => void;
    vi.stubGlobal("createImageBitmap", vi.fn(() => new Promise(r => { resolve = r; })));
    const controller = new AbortController(), promise = loadImportedModel([file("colour-pbr-multipart.glb")], controller.signal);
    await vi.waitFor(() => expect(createImageBitmap).toHaveBeenCalledOnce());
    controller.abort();
    const bitmap = { width:2, height:2, close:vi.fn() }; resolve(bitmap);
    await expect(promise).rejects.toMatchObject({ name: "AbortError" });
    expect(bitmap.close).toHaveBeenCalledOnce();
  });
  it("deduplicates shared GPU resources and immediately disposes late resources", () => {
    const pool = new ImportResources(), geometry = new THREE.BoxGeometry(), texture = new THREE.Texture(), material = new THREE.MeshStandardMaterial({ map:texture });
    const root = new THREE.Group(); root.add(new THREE.Mesh(geometry,material),new THREE.Mesh(geometry,material));
    const a = vi.spyOn(geometry,"dispose"), b = vi.spyOn(texture,"dispose"), c = vi.spyOn(material,"dispose");
    pool.own(root); pool.dispose(); pool.dispose(); pool.own(root);
    expect(a).toHaveBeenCalledOnce(); expect(b).toHaveBeenCalledOnce(); expect(c).toHaveBeenCalledOnce();
    const late = new THREE.BufferGeometry(), d = vi.spyOn(late,"dispose"); pool.own(late); expect(d).toHaveBeenCalledOnce();
  });
  it("rejects a singular node transform instead of distorting later deformations", () => {
    const root = new THREE.Group(); const mesh = new THREE.Mesh(new THREE.BoxGeometry(),new THREE.MeshStandardMaterial()); mesh.scale.x = 0; root.add(mesh);
    expect(() => inspectImportedRoot(root)).toThrow(/singular/); mesh.geometry.dispose(); mesh.material.dispose();
  });
});
describe("current-state export", () => {
  it("round-trips clearcoat/transmission/volume/IOR without exporting nonfinite JSON", async () => {
    const extensions = {
      KHR_materials_clearcoat:{clearcoatFactor:.6,clearcoatRoughnessFactor:.2},
      KHR_materials_transmission:{transmissionFactor:.4},
      KHR_materials_volume:{thicknessFactor:.25},
      KHR_materials_ior:{ior:1.33},
    };
    const model = await loadImportedModel(changedGltf(json => {
      json.extensionsUsed = Object.keys(extensions); json.materials[0].extensions = extensions;
      delete json.materials[0].pbrMetallicRoughness.baseColorTexture; json.textures = []; json.images = [];
    }));
    const output = new File([await exportImportedModelGLB(model)],"physical.glb");
    const { json } = readGltfContainer({ file:output,path:output.name,bytes:await output.arrayBuffer() });
    expect(json.materials[0].extensions.KHR_materials_clearcoat).toMatchObject(extensions.KHR_materials_clearcoat);
    expect(json.materials[0].extensions.KHR_materials_volume.thicknessFactor).toBe(.25);
    expect(json.materials[0].extensions.KHR_materials_volume.attenuationDistance).toBeUndefined();
    const restored = await loadImportedModel([output]);
    const material = (restored.root.getObjectByName("left-cube") as THREE.Mesh).material as THREE.MeshPhysicalMaterial;
    expect(material.attenuationDistance).toBe(Infinity); expect(material.clearcoat).toBe(.6);
    expect(material.transmission).toBe(.4); expect(material.thickness).toBe(.25); expect(material.ior).toBe(1.33);
    restored.dispose(); model.dispose();
  });
  it("exports actual edited geometry/transforms, strips all extras, and retains source ownership", async () => {
    const model = await loadImportedModel([file("cube-binary.stl")]);
    const mesh = model.root.children[0] as THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>;
    mesh.geometry.scale(2,1,1); mesh.position.y = 4;
    mesh.userData = { localPrivateName:"node" }; mesh.geometry.userData = { localPrivateName:"geometry" }; mesh.material.userData = { localPrivateName:"material" };
    mesh.material.color.setRGB(.2,.4,.6);
    const geometryDispose = vi.spyOn(mesh.geometry,"dispose"), materialDispose = vi.spyOn(mesh.material,"dispose");
    const exported = await exportImportedModelGLB(model);
    expect(exported.type).toBe("model/gltf-binary");
    expect(geometryDispose).not.toHaveBeenCalled(); expect(materialDispose).not.toHaveBeenCalled();
    expect(mesh.geometry.userData.localPrivateName).toBe("geometry"); expect(mesh.material.userData.localPrivateName).toBe("material");
    const exportedFile = new File([exported],"edited.glb"), data = await exportedFile.arrayBuffer();
    const { json } = readGltfContainer({ file:exportedFile,path:exportedFile.name,bytes:data });
    expect(JSON.stringify(json)).not.toContain("localPrivateName");
    const roundtrip = await loadImportedModel([exportedFile]);
    expect(roundtrip.stats.bounds.min).toEqual([-2,3,-1]);
    expect(roundtrip.stats.bounds.max).toEqual([2,5,1]);
    const next = roundtrip.root.getObjectsByProperty("isMesh",true)[0] as THREE.Mesh<THREE.BufferGeometry,THREE.MeshStandardMaterial>;
    expect(next.material.color.toArray()).toEqual([.2,.4,.6]);
    roundtrip.dispose(); model.dispose(); expect(geometryDispose).toHaveBeenCalledOnce();
  });
  it("rejects invalid colour values and material group indices", () => {
    const geometry = new THREE.BoxGeometry(), material = new THREE.MeshStandardMaterial(), root = new THREE.Mesh(geometry,[material]);
    geometry.groups[0]!.materialIndex = 8;
    expect(() => inspectImportedRoot(root)).toThrow(/material group/);
    geometry.clearGroups(); material.color.r = 1.2;
    expect(() => inspectImportedRoot(root)).toThrow(/Base color/);
    material.color.r = 1;
    geometry.setAttribute("color",new THREE.Float32BufferAttribute(new Float32Array(geometry.getAttribute("position").count*4).fill(2),4));
    expect(() => inspectImportedRoot(root)).toThrow(/Vertex color/);
    geometry.dispose(); material.dispose();
  });
});
