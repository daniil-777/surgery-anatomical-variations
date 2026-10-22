// The preview GLB is made with three's GLTFExporter, which reads its output through FileReader (absent in node, so a
// minimal one is stubbed here). Texture re-encoding needs a canvas and is covered by the browser end-to-end tests.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { vi } from "vitest";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { NodeFileReader } from "./__fixtures__/builders";
import type { LoadedModel } from "./loaders";
import { exportDisplayGlb, prepareDisplay, toStandardMaterial } from "./normalize";
import { ImportResources } from "./resources";
import { measureScene } from "./stats";

beforeAll(() => {
  vi.stubGlobal("FileReader", NodeFileReader);
});

afterAll(() => {
  vi.unstubAllGlobals();
});

function model(root: THREE.Object3D, changes: Partial<LoadedModel> = {}): LoadedModel {
  return { format: "fbx", root, animations: [], notes: [], units: "cm", upAxis: "Y", uprightX: 0, toMetres: 0.01, signals: {}, title: null, ...changes };
}

async function parseGlb(blob: Blob): Promise<THREE.Group> {
  const gltf = await new GLTFLoader().parseAsync(await blob.arrayBuffer(), "");
  return gltf.scene;
}

describe("materials", () => {
  it("turns Phong into PBR, keeping colour, maps, transparency and sidedness", () => {
    const map = new THREE.Texture();
    const phong = new THREE.MeshPhongMaterial({ name: "Skin", color: 0xff8800, map, shininess: 30, opacity: 0.5, transparent: true, side: THREE.DoubleSide, vertexColors: true });
    const standard = toStandardMaterial(phong);
    expect(standard).toBeInstanceOf(THREE.MeshStandardMaterial);
    expect(standard).toMatchObject({ name: "Skin", map, opacity: 0.5, transparent: true, side: THREE.DoubleSide, vertexColors: true, metalness: 0 });
    expect(standard!.color.getHex()).toBe(phong.color.getHex());
    expect(standard!.roughness).toBeCloseTo(Math.sqrt(2 / 32));
    expect(toStandardMaterial(new THREE.MeshLambertMaterial())!.roughness).toBe(0.9);
    expect(toStandardMaterial(new THREE.MeshStandardMaterial())).toBeNull();
    expect(toStandardMaterial(new THREE.MeshBasicMaterial())).toBeNull();
  });
});

describe("prepareDisplay", () => {
  it("removes lights and cameras, converts materials, clears userData, stands the model up and scales it to metres", () => {
    const root = new THREE.Group();
    root.userData = { localPath: "C:\\Users\\ada\\heart.max" };
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(100, 200, 300), new THREE.MeshPhongMaterial());
    root.add(mesh, new THREE.PointLight(), new THREE.PerspectiveCamera());
    const resources = new ImportResources();
    const display = prepareDisplay(model(root, { uprightX: -Math.PI / 2 }), resources);
    expect(display.notes).toEqual(["Lights and cameras from the file are not part of the preview."]);
    expect(root.children).toEqual([mesh]);
    expect(mesh.material).toBeInstanceOf(THREE.MeshStandardMaterial);
    expect(root.userData).toEqual({});
    const size = measureScene(display.scene).bbox!;
    expect(size.x).toBeCloseTo(1);
    expect(size.y).toBeCloseTo(3);
    expect(size.z).toBeCloseTo(2);
    resources.dispose();
  });
});

describe("exportDisplayGlb", () => {
  it("writes a binary glTF the viewer can load back, in metres", async () => {
    const root = new THREE.Group();
    root.add(new THREE.Mesh(new THREE.BoxGeometry(100, 50, 20), new THREE.MeshPhongMaterial({ color: 0x3366cc })));
    const resources = new ImportResources();
    const display = prepareDisplay(model(root), resources);
    const { glb, notes } = await exportDisplayGlb(display.scene, [], 16 * 1024 * 1024);
    expect(notes).toEqual([]);
    expect(glb?.type).toBe("model/gltf-binary");
    const bytes = new Uint8Array(await glb!.arrayBuffer());
    expect(new TextDecoder().decode(bytes.subarray(0, 4))).toBe("glTF");
    const loaded = await parseGlb(glb!);
    const measure = measureScene(loaded);
    expect(measure).toMatchObject({ meshes: 1, triangles: 12 });
    expect(measure.bbox!.x).toBeCloseTo(1);
    expect(measure.bbox!.y).toBeCloseTo(0.5);
    const material = (loaded.getObjectByProperty("isMesh", true) as THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>).material;
    expect(material.metalness).toBe(0);
    expect(material.color.getHex()).toBe(new THREE.Color(0x3366cc).getHex());
    resources.dispose();
  });

  it("drops the animation to fit the size limit, then gives up with a note", async () => {
    const root = new THREE.Group();
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial());
    mesh.name = "Box";
    root.add(mesh);
    const times = Array.from({ length: 2000 }, (_, i) => i / 30);
    const values = times.flatMap((t) => [Math.sin(t), 0, 0]);
    const clip = new THREE.AnimationClip("wobble", -1, [new THREE.VectorKeyframeTrack("Box.position", times, values)]);
    const full = await exportDisplayGlb(root, [clip], 64 * 1024 * 1024);
    const still = await exportDisplayGlb(root, [], 64 * 1024 * 1024);
    const fullSize = full.glb!.size;
    const stillSize = still.glb!.size;
    expect(fullSize).toBeGreaterThan(stillSize + 20_000);
    const fitted = await exportDisplayGlb(root, [clip], stillSize + 100);
    expect(fitted.glb?.size).toBe(stillSize);
    expect(fitted.notes[0]).toMatch(/textures of at most 2048 px and no animation/);
    const tooSmall = await exportDisplayGlb(root, [clip], 100);
    expect(tooSmall.glb).toBeNull();
    expect(tooSmall.notes[0]).toMatch(/would be larger than 100 bytes/);
  });
});
