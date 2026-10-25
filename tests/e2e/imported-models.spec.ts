import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { createHash } from "node:crypto";
import { open, readFile, unlink, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Matrix4, Quaternion, Vector3 } from "three";

const entry = process.env.IMPORTS_PATH ?? "/";
const fixtures = fileURLToPath(new URL("../fixtures/imported-models/", import.meta.url));
const fixture = (name: string) => path.join(fixtures, name);
const exec = promisify(execFile);
const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
type GLB = { json: any; binary: Buffer };
type Export = GLB & { bytes: Buffer; semantic: ReturnType<typeof semantic> };

function parseGLB(bytes: Buffer): GLB {
  expect(bytes.readUInt32LE(0)).toBe(0x46546c67);
  expect(bytes.readUInt32LE(4)).toBe(2);
  expect(bytes.readUInt32LE(8)).toBe(bytes.length);
  let json: any, binary = Buffer.alloc(0);
  for (let at = 12; at < bytes.length;) {
    const length = bytes.readUInt32LE(at), kind = bytes.readUInt32LE(at + 4);
    const content = bytes.subarray(at + 8, at + 8 + length);
    expect(content.length).toBe(length);
    if (kind === 0x4e4f534a) json = JSON.parse(content.toString("utf8").trim());
    if (kind === 0x004e4942) binary = content;
    at += 8 + length;
  }
  expect(json.asset.version).toBe("2.0");
  return { json, binary };
}

/** Independent decoded-data comparison; exporter JSON ordering/packing is immaterial. */
function accessor(glb: GLB, index: number): number[] {
  const a = glb.json.accessors[index], view = glb.json.bufferViews[a.bufferView];
  const components = ({ SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 } as Record<string, number>)[a.type]!;
  const sizes: Record<number, number> = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };
  const size = sizes[a.componentType]!, values: number[] = [];
  const bytes = new DataView(glb.binary.buffer, glb.binary.byteOffset, glb.binary.byteLength);
  for (let row = 0; row < a.count; row++) for (let channel = 0; channel < components; channel++) {
    const at = (view.byteOffset ?? 0) + (a.byteOffset ?? 0) + row * (view.byteStride ?? components * size) + channel * size;
    let value = a.componentType === 5126 ? bytes.getFloat32(at, true)
      : a.componentType === 5125 ? bytes.getUint32(at, true)
        : a.componentType === 5123 ? bytes.getUint16(at, true)
          : a.componentType === 5122 ? bytes.getInt16(at, true)
            : a.componentType === 5121 ? bytes.getUint8(at) : bytes.getInt8(at);
    if (a.normalized) value = a.componentType === 5121 ? value / 255
      : a.componentType === 5123 ? value / 65535 : Math.max(-1, value / (a.componentType === 5120 ? 127 : 32767));
    if (!Number.isFinite(value)) throw new Error(`Non-finite exported accessor ${index} row ${row} channel ${channel}`);
    values.push(value);
  }
  return values;
}

function semantic(glb: GLB) {
  const meshes: any[] = [];
  const names: string[] = [];
  const visit = (index: number, parent: Matrix4) => {
    const node = glb.json.nodes[index];
    // Loaders/exporters may add a scene-wrapper Group. Verify the meaningful
    // authored parent and mesh identities, not implementation wrapper names.
    if (node.name && (node.name === "fixture-root" || node.mesh !== undefined)) names.push(node.name);
    const local = node.matrix ? new Matrix4().fromArray(node.matrix) : new Matrix4().compose(
      new Vector3().fromArray(node.translation ?? [0, 0, 0]),
      new Quaternion().fromArray(node.rotation ?? [0, 0, 0, 1]),
      new Vector3().fromArray(node.scale ?? [1, 1, 1]),
    );
    const world = parent.clone().multiply(local);
    if (node.mesh !== undefined) for (const primitive of glb.json.meshes[node.mesh].primitives) {
      const material = glb.json.materials[primitive.material], pbr = material.pbrMetallicRoughness ?? {};
      const positions = accessor(glb, primitive.attributes.POSITION), worldPositions: number[] = [];
      for (let at = 0; at < positions.length; at += 3) {
        const point = new Vector3().fromArray(positions, at).applyMatrix4(world);
        worldPositions.push(...point.toArray().map(value => Number(value.toFixed(7))));
      }
      meshes.push({
        name: node.name ?? "", positions, worldPositions,
        colors: primitive.attributes.COLOR_0 === undefined ? null : accessor(glb, primitive.attributes.COLOR_0),
        uv: primitive.attributes.TEXCOORD_0 === undefined ? null : accessor(glb, primitive.attributes.TEXCOORD_0),
        indices: primitive.indices === undefined ? null : accessor(glb, primitive.indices),
        material: { color: pbr.baseColorFactor ?? [1, 1, 1, 1], metalness: pbr.metallicFactor ?? 1,
          roughness: pbr.roughnessFactor ?? 1, alphaMode: material.alphaMode ?? "OPAQUE",
          textured: pbr.baseColorTexture !== undefined },
      });
    }
    for (const child of node.children ?? []) visit(child, world);
  };
  for (const index of glb.json.scenes[glb.json.scene ?? 0].nodes) visit(index, new Matrix4());
  return { names: names.sort(), meshes: meshes.sort((a, b) => a.name.localeCompare(b.name)) };
}

async function pixels(page: Page, glb: GLB) {
  const image = glb.json.images[0], view = glb.json.bufferViews[image.bufferView];
  const data = glb.binary.subarray(view.byteOffset ?? 0, (view.byteOffset ?? 0) + view.byteLength);
  return page.evaluate(async bytes => {
    const bitmap = await createImageBitmap(new Blob([new Uint8Array(bytes)], { type: "image/png" }));
    const canvas = document.createElement("canvas"); canvas.width = bitmap.width; canvas.height = bitmap.height;
    const context = canvas.getContext("2d")!; context.drawImage(bitmap, 0, 0);
    const result = { width: bitmap.width, height: bitmap.height, rgba: Array.from(context.getImageData(0, 0, bitmap.width, bitmap.height).data) };
    bitmap.close(); return result;
  }, Array.from(data));
}

async function openWorkspace(page: Page) {
  await page.goto(`${entry}?mode=imports`);
  await expect(page.getByRole("heading", { name: /^Start with a model/ })).toBeVisible();
}
async function upload(page: Page, names = ["colour-pbr-multipart.glb"]) {
  await page.getByLabel("3D model files", { exact: true }).setInputFiles(names.map(fixture));
  await expect(page.locator("[data-import-ready=true]")).toHaveCount(1);
  await expect(page.locator(".import-status")).toContainText("Opened ");
  await expect(page.getByRole("button", { name: "Export GLB", exact: true })).toBeEnabled();
}
async function exported(page: Page, info: TestInfo, label: string): Promise<Export> {
  const pending = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export GLB", exact: true }).click();
  const download = await pending, destination = info.outputPath(`${label}.glb`);
  await download.saveAs(destination);
  const bytes = await readFile(destination), glb = parseGLB(bytes);
  return { ...glb, bytes, semantic: semantic(glb) };
}
async function recipe(page: Page, info: TestInfo, label: string) {
  const pending = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download recipe", exact: true }).click();
  const download = await pending, destination = info.outputPath(`${label}.recipe.json`);
  await download.saveAs(destination);
  return JSON.parse(await readFile(destination, "utf8"));
}
async function chooseReference(page: Page) {
  const select = page.getByRole("combobox", { name: /^Reference (style|for )/ }).first();
  await expect(select).toBeEnabled();
  await expect.poll(() => select.locator("option").count()).toBeGreaterThan(1);
  const value = await select.locator("option").evaluateAll(options => {
    const list = options as HTMLOptionElement[];
    return (list.find(option => option.value.includes("liver")) ?? list.find(option => option.value))!.value;
  });
  await select.selectOption(value);
  return value;
}
async function generate(page: Page, seed: number, next = false) {
  await page.getByRole("spinbutton", { name: "Variation seed", exact: true }).fill(String(seed));
  await page.getByRole("button", { name: next ? "Next variation" : /^Generate (scene )?variation$/, exact: true }).click();
  await expect(page.locator(".import-status")).toContainText(new RegExp(`[Vv]ariation ${next ? (seed + 1) >>> 0 : seed} applied`));
}
function shape(value: Export) { return value.semantic.meshes.map(mesh => mesh.worldPositions); }
function colors(value: Export) { return value.semantic.meshes.map(mesh => mesh.colors); }

test.beforeEach(async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  (page as any).__importErrors = errors;
});
test.afterEach(async ({ page }) => { expect((page as any).__importErrors, "uncaught browser errors").toEqual([]); });

test("GLB preserves actual PBR image, linear vertex colours, multipart transforms and round-trip data", async ({ page }, info) => {
  await openWorkspace(page);
  const appOrigin = new URL(page.url()).origin;
  const remote: string[] = [];
  page.on("request", request => {
    if (/^https?:/.test(request.url()) && new URL(request.url()).origin !== appOrigin) remote.push(request.url());
  });
  await upload(page);
  const original = parseGLB(await readFile(fixture("colour-pbr-multipart.glb")));
  const output = await exported(page, info, "original-export");
  expect(output.semantic).toEqual(semantic(original));
  expect(await pixels(page, output)).toEqual(await pixels(page, original));
  expect(output.json.materials).toHaveLength(1);
  await page.getByLabel("3D model files", { exact: true }).setInputFiles(info.outputPath("original-export.glb"));
  await expect(page.locator(".import-status")).toContainText("Opened original-export.glb");
  const reimport = await exported(page, info, "reimport-export");
  expect(reimport.semantic).toEqual(output.semantic);
  expect(await pixels(page, reimport)).toEqual(await pixels(page, original));
  expect(remote).toEqual([]);
  await page.screenshot({ path: info.outputPath("pbr-model-loaded.png") });
});

test("external glTF resolves only selected binary and PNG sidecars", async ({ page }, info) => {
  await openWorkspace(page);
  await upload(page, ["colour-pbr-multipart.gltf", "colour-pbr-multipart.bin", "quadrants.png"]);
  const output = await exported(page, info, "external-export");
  expect(output.semantic).toEqual(semantic(parseGLB(await readFile(fixture("colour-pbr-multipart.glb")))));
});

test("OBJ plus MTL plus PNG keeps painted material on GLB export", async ({ page }, info) => {
  await openWorkspace(page); await upload(page, ["colour-cube.obj", "colour-cube.mtl", "quadrants.png"]);
  const output = await exported(page, info, "obj-export");
  expect(output.semantic.meshes).toHaveLength(1);
  expect(output.semantic.meshes[0].material.textured).toBe(true);
  expect(output.semantic.meshes[0].uv.length).toBeGreaterThan(0);
  const source = await pixels(page, parseGLB(await readFile(fixture("colour-pbr-multipart.glb"))));
  // OBJ uses bottom-left UV image coordinates; glTF uses top-left. The
  // conversion retains UV values and flips image rows exactly once.
  const stride = source.width * 4, rows: number[] = [];
  for (let row = source.height - 1; row >= 0; row--) rows.push(...source.rgba.slice(row * stride, (row + 1) * stride));
  expect(await pixels(page, output)).toEqual({ ...source, rgba: rows });
  await page.getByLabel("3D model files", { exact: true }).setInputFiles(info.outputPath("obj-export.glb"));
  await expect(page.locator(".import-status")).toContainText("Opened obj-export.glb");
  const roundtrip = await exported(page, info, "obj-reimport");
  expect(roundtrip.semantic).toEqual(output.semantic);
  expect(await pixels(page, roundtrip)).toEqual(await pixels(page, output));
});

for (const name of ["cube-ascii.stl", "cube-binary.stl"]) test(`${name} imports actual triangle geometry`, async ({ page }, info) => {
  await openWorkspace(page); await upload(page, [name]);
  const output = await exported(page, info, name);
  expect(output.semantic.meshes).toHaveLength(1);
  const mesh = output.semantic.meshes[0];
  expect((mesh.indices?.length ?? mesh.positions.length / 3) / 3).toBe(12);
  expect(mesh.material.textured).toBe(false);
});

for (const defect of ["remote URI", "missing sidecar", "corrupt GLB", "unsupported native project"]) {
  test(`rejects ${defect} without replacing the displayed original`, async ({ page }, info) => {
    await openWorkspace(page); await upload(page);
    const before = await exported(page, info, "before");
    const requested: string[] = [];
    await page.route("https://import-blocked.invalid/**", route => { requested.push(route.request().url()); return route.abort(); });
    let name = "broken.gltf", buffer: Buffer;
    if (defect === "remote URI" || defect === "missing sidecar") {
      const document = JSON.parse(await readFile(fixture("colour-pbr-multipart.gltf"), "utf8"));
      if (defect === "remote URI") document.buffers[0].uri = "https://import-blocked.invalid/private.bin";
      buffer = Buffer.from(JSON.stringify(document));
    } else if (defect === "corrupt GLB") { name = "broken.glb"; buffer = Buffer.from("glTF truncated"); }
    else { name = "project.blend"; buffer = Buffer.from("BLENDER-v300"); }
    await page.getByLabel("3D model files", { exact: true }).setInputFiles({ name, mimeType: "application/octet-stream", buffer });
    await expect(page.locator(".import-status [role=alert]")).toBeVisible();
    expect(requested).toEqual([]);
    expect((await exported(page, info, "after-rejection")).semantic).toEqual(before.semantic);
  });
}

test("rejects an actual oversized local file before reading its payload", async ({ page }, info) => {
  await openWorkspace(page);
  const oversized = info.outputPath("oversized.glb"), file = await open(oversized, "wx");
  try {
    await file.truncate(128 * 1024 * 1024 + 1); await file.close();
    await page.getByLabel("3D model files", { exact: true }).setInputFiles(oversized);
    await expect(page.locator(".import-status [role=alert]")).toContainText("128 MiB");
    await expect(page.locator("[data-import-ready=true]")).toHaveCount(0);
  } finally { await file.close().catch(() => {}); await unlink(oversized); }
});

test("actual bundled learned weights produce seed42→43→42 replay with source provenance and exact reset", async ({ page }, info) => {
  const loaded: string[] = [];
  page.on("response", response => { if (/\/models\/joint-v2\/(?:model\.json|weights\.bin)$/.test(new URL(response.url()).pathname) && response.ok()) loaded.push(response.url()); });
  await openWorkspace(page); await upload(page); const reference = await chooseReference(page);
  const original = await exported(page, info, "rest");
  await generate(page, 42); const first = await exported(page, info, "seed42");
  const provenance = await recipe(page, info, "seed42");
  expect(provenance.schema).toBe("viscera.import-variation/v1");
  expect(provenance.recipe.provenance).toMatchObject({ method: "joint-flow-recipe-transfer", seed: provenance.multiOrganCount ? 42 + 997 : 42,
    referenceId: reference, meshEncoding: false, diseaseInference: false });
  expect(provenance.recipe.provenance.modelSha256).toMatch(/^[a-f0-9]{64}$/);
  const actual = await page.request.get(new URL(`${entry.replace(/\/?$/, "/")}models/joint-v2/model.json`, page.url()).href);
  expect(actual.ok()).toBe(true);
  expect(provenance.recipe.provenance.modelSha256).toBe((await actual.json()).model_sha256);
  expect(JSON.stringify(provenance.source)).toContain(sha(await readFile(fixture("colour-pbr-multipart.glb"))));
  expect(loaded.some(url => url.endsWith("/weights.bin"))).toBe(true);
  expect(shape(first)).not.toEqual(shape(original)); expect(colors(first)).not.toEqual(colors(original));
  await generate(page, 42, true); const second = await exported(page, info, "seed43");
  expect(shape(second)).not.toEqual(shape(first));
  await generate(page, 42); const replay = await exported(page, info, "seed42-replay");
  expect(replay.semantic).toEqual(first.semantic);
  expect(await pixels(page, replay)).toEqual(await pixels(page, original));
  await page.getByRole("button", { name: "Restore original", exact: true }).click();
  await expect(page.locator(".import-status")).toContainText("Original geometry, colours and materials restored.");
  expect((await exported(page, info, "restored")).semantic).toEqual(original.semantic);
});

for (const scope of ["shape", "texture"] as const) test(`${scope}-only variation preserves the other source channel`, async ({ page }, info) => {
  await openWorkspace(page); await upload(page); await chooseReference(page);
  const original = await exported(page, info, "rest");
  await page.getByLabel("Variation scope", { exact: true }).selectOption(scope);
  await generate(page, 77);
  const changed = await exported(page, info, scope);
  if (scope === "shape") { expect(shape(changed)).not.toEqual(shape(original)); expect(colors(changed)).toEqual(colors(original)); }
  else { expect(shape(changed)).toEqual(shape(original)); expect(colors(changed)).not.toEqual(colors(original)); }
  expect(changed.semantic.meshes.map(mesh => mesh.uv)).toEqual(original.semantic.meshes.map(mesh => mesh.uv));
  expect(await pixels(page, changed)).toEqual(await pixels(page, original));
});

test("zero strengths and strict text failure are atomic; supported commands edit the recipe", async ({ page }, info) => {
  await openWorkspace(page); await upload(page); await chooseReference(page);
  const original = await exported(page, info, "rest");
  await page.getByRole("slider", { name: "Shape strength", exact: true }).fill("0");
  await page.getByRole("slider", { name: "Texture blend", exact: true }).fill("0");
  await generate(page, 314); expect((await exported(page, info, "zero")).semantic).toEqual(original.semantic);
  await page.getByRole("slider", { name: "Shape strength", exact: true }).fill("65");
  await page.getByRole("slider", { name: "Texture blend", exact: true }).fill("50");
  await page.getByLabel("Describe a variation", { exact: true }).fill("wider; flatter; twist 0.2; wetter");
  await page.getByRole("button", { name: "Apply text", exact: true }).click();
  await expect(page.locator(".import-status")).toContainText("Shape and appearance applied to");
  const edited = await exported(page, info, "text-edited"), textRecipe = await recipe(page, info, "text");
  expect(textRecipe.recipe.provenance.method).toBe("deterministic-text-controls");
  expect(textRecipe.recipe.controls.twist).toBe(.2);
  expect(shape(edited)).not.toEqual(shape(original));
  await page.getByLabel("Describe a variation", { exact: true }).fill("wider; add a new surgical robot");
  await page.getByRole("button", { name: "Apply text", exact: true }).click();
  await expect(page.locator(".import-status [role=alert]")).toContainText(/No partial edit was applied/i);
  expect((await exported(page, info, "after-text-error")).semantic).toEqual(edited.semantic);
  expect((await recipe(page, info, "after-text-error")).recipe).toEqual(textRecipe.recipe);
});

test("a replaced slow file cannot publish over the later import", async ({ page }, info) => {
  await page.addInitScript(() => {
    const original = Blob.prototype.arrayBuffer;
    const state = { pending: false, settled: false, release: null as null | (() => void) };
    (window as any).__slowImport = state;
    Blob.prototype.arrayBuffer = async function () {
      if (this instanceof File && this.name === "slow.glb") {
        state.pending = true; await new Promise<void>(resolve => { state.release = resolve; });
        try { return await original.call(this); } finally { state.settled = true; }
      }
      return original.call(this);
    };
  });
  await openWorkspace(page);
  const bytes = await readFile(fixture("colour-pbr-multipart.glb"));
  await page.getByLabel("3D model files", { exact: true }).setInputFiles({ name: "slow.glb", mimeType: "model/gltf-binary", buffer: bytes });
  await expect.poll(() => page.evaluate(() => (window as any).__slowImport.pending)).toBe(true);
  await page.getByLabel("3D model files", { exact: true }).setInputFiles({ name: "replacement.glb", mimeType: "model/gltf-binary", buffer: bytes });
  await expect(page.locator(".import-status")).toContainText("Opened replacement.glb");
  await page.evaluate(() => (window as any).__slowImport.release());
  await expect.poll(() => page.evaluate(() => (window as any).__slowImport.settled)).toBe(true);
  await expect(page.locator(".import-scene-title")).toContainText("replacement.glb");
  expect((await exported(page, info, "race-winner")).semantic).toEqual(semantic(parseGLB(bytes)));
});

test("failed real model-weight fetch leaves original import/export usable and retry recovers", async ({ page }, info) => {
  await page.route("**/models/joint-v2/weights.bin", route => route.abort("failed"));
  await openWorkspace(page); await upload(page);
  await expect(page.getByRole("button", { name: "Retry model loading", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /^Generate (scene )?variation$/, exact: true })).toBeDisabled();
  expect((await exported(page, info, "without-generative-model")).semantic.meshes).toHaveLength(2);
  await page.unroute("**/models/joint-v2/weights.bin");
  await page.getByRole("button", { name: "Retry model loading", exact: true }).click();
  await chooseReference(page); await generate(page, 42);
});

test("375px at200% text exposes usable upload, variation, recorder and export controls", async ({ page }, info) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.addInitScript(() => localStorage.setItem("viscera.display.v1", JSON.stringify({ textPercent: 200 })));
  await openWorkspace(page); await upload(page); await chooseReference(page);
  const controls = [
    page.getByRole("button", { name: "Display settings", exact: true }),
    page.getByRole("button", { name: "Video recorder", exact: true }),
    page.getByRole("button", { name: "Replace / upload files", exact: true }),
    page.getByRole("combobox", { name: /^Reference (style|for )/ }).first(),
    page.getByRole("button", { name: /^Generate (scene )?variation$/, exact: true }),
    page.getByRole("button", { name: "Export GLB", exact: true }),
  ];
  for (const control of controls) {
    await control.scrollIntoViewIfNeeded();
    const bounds = await control.boundingBox(); expect(bounds).not.toBeNull();
    expect(bounds!.x).toBeGreaterThanOrEqual(-1); expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(376);
    expect(await control.evaluate(element => {
      const box = element.getBoundingClientRect(); return element.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2));
    }), await control.getAttribute("aria-label") ?? await control.innerText()).toBe(true);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await generate(page, 42); await exported(page, info, "mobile-export");
  await page.locator(".import-scene").evaluate(element => element.scrollIntoView({ block: "start", behavior: "instant" }));
  const visibility = await page.locator(".import-viewport").evaluate(element => {
    const box = element.getBoundingClientRect();
    let left = Math.max(0, box.left), right = Math.min(innerWidth, box.right);
    let top = Math.max(0, box.top), bottom = Math.min(innerHeight, box.bottom);
    for (let ancestor = element.parentElement; ancestor; ancestor = ancestor.parentElement) {
      const style = getComputedStyle(ancestor), bounds = ancestor.getBoundingClientRect();
      if (style.overflowY !== "visible") { top = Math.max(top, bounds.top); bottom = Math.min(bottom, bounds.bottom); }
      if (style.overflowX !== "visible") { left = Math.max(left, bounds.left); right = Math.min(right, bounds.right); }
    }
    const header = document.querySelector(".import-header")!.getBoundingClientRect();
    const footer = document.querySelector(".import-status")!.getBoundingClientRect();
    if (footer.top >= 0 && footer.top < bottom && footer.bottom > top) bottom = footer.top;
    return { canvasWidth: box.width, canvasHeight: box.height, visibleWidth: Math.max(0, right - left),
      visibleHeight: Math.max(0, bottom - top), headerHeight: header.height, headerBottom: header.bottom };
  });
  expect(visibility.visibleWidth).toBeGreaterThanOrEqual(320);
  expect(visibility.visibleHeight, JSON.stringify(visibility)).toBeGreaterThanOrEqual(400);
  expect(visibility.headerBottom, "Tall mobile header scrolls clear of the model").toBeLessThanOrEqual(1);
  await writeFile(info.outputPath("mobile-scene-visibility.json"), JSON.stringify(visibility, null, 2));
  await page.screenshot({ path: info.outputPath("mobile-375-text200-scene.png") });
  await page.locator(".import-header").scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath("mobile-375-text200.png"), fullPage: true });
});

test("loaded PBR scene remains usable across desktop and tablet layouts", async ({ page }, info) => {
  await openWorkspace(page); await upload(page);
  for (const width of [1440, 768]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.locator(".import-scene").scrollIntoViewIfNeeded();
    await expect(page.getByRole("button", { name: "Fit", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Fit", exact: true }).click();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    const canvas = page.locator(".import-viewport canvas");
    expect((await canvas.boundingBox())!.height).toBeGreaterThanOrEqual(400);
    await page.screenshot({ path: info.outputPath(`loaded-pbr-${width}.png`) });
  }
});

test("scene sizing, controls width, keyboard pan and fullscreen work without changing source data", async ({ page }, info) => {
  await openWorkspace(page); await upload(page);
  const canvas = page.locator(".import-viewport canvas");
  await page.getByRole("button", { name: "Display settings", exact: true }).click();
  await page.getByRole("checkbox", { name: "Fit scene height to window", exact: true }).uncheck();
  await page.getByRole("slider", { name: "Scene height", exact: true }).fill("900");
  await page.getByRole("slider", { name: "Controls panel width", exact: true }).fill("460");
  await page.getByRole("button", { name: "Done", exact: true }).click();
  await expect.poll(async () => (await page.locator(".import-scene").boundingBox())!.height).toBe(900);
  await expect.poll(async () => Math.round((await page.locator(".import-inspector").boundingBox())!.width)).toBe(460);
  await canvas.focus();
  const before = await canvas.screenshot();
  for (let index = 0; index < 8; index++) await canvas.press("ArrowRight");
  await expect.poll(async () => sha(await canvas.screenshot())).not.toBe(sha(before));
  await page.screenshot({ path: info.outputPath("keyboard-pan-custom-layout.png") });
  for (const viewport of [{ width: 1440, height: 1000 }, { width: 375, height: 812 }]) {
    await page.setViewportSize(viewport);
    await page.getByRole("button", { name: "Scene full screen", exact: true }).click();
    await expect.poll(() => page.evaluate(() => document.fullscreenElement?.classList.contains("import-scene"))).toBe(true);
    await expect.poll(async () => Math.round((await canvas.boundingBox())!.height)).toBe(viewport.height);
    await expect.poll(async () => Math.round((await canvas.boundingBox())!.width)).toBe(viewport.width);
    await page.getByRole("button", { name: "Exit scene full screen", exact: true }).click();
    await expect.poll(() => page.evaluate(() => document.fullscreenElement === null)).toBe(true);
    await expect.poll(async () => (await page.locator(".import-scene").boundingBox())!.height).toBe(900);
  }
  expect((await exported(page, info, "after-layout")).semantic).toEqual(semantic(parseGLB(await readFile(fixture("colour-pbr-multipart.glb")))));
});

test("actual 39-part anatomical torso imports, varies, exports and restores at realistic mesh scale", async ({ page }, info) => {
  test.setTimeout(180_000);
  const sourcePath = fileURLToPath(new URL("../../apps/studio/public/anatomy-scene/bodyparts3d-torso.glb", import.meta.url));
  const sourceBytes = await readFile(sourcePath), source = parseGLB(sourceBytes);
  const compact = (glb: GLB) => glb.json.meshes.flatMap((mesh: any) => mesh.primitives.map((primitive: any) => ({
    vertices: glb.json.accessors[primitive.attributes.POSITION].count,
    indices: glb.json.accessors[primitive.indices].count,
    position: sha(Buffer.from(new Float32Array(accessor(glb, primitive.attributes.POSITION)).buffer)),
    topology: sha(Buffer.from(new Uint32Array(accessor(glb, primitive.indices)).buffer)),
    colors: primitive.attributes.COLOR_0 === undefined ? null : sha(Buffer.from(new Float32Array(accessor(glb, primitive.attributes.COLOR_0)).buffer)),
  })));
  const downloadCompact = async (label: string) => {
    const pending = page.waitForEvent("download");
    await page.getByRole("button", { name: "Export GLB", exact: true }).click();
    const destination = info.outputPath(`${label}.glb`); await (await pending).saveAs(destination);
    const bytes = await readFile(destination), glb = parseGLB(bytes);
    return { bytes: bytes.length, sha256: sha(bytes), mesh: compact(glb) };
  };
  await openWorkspace(page);
  const began = Date.now();
  await page.getByLabel("3D model files", { exact: true }).setInputFiles(sourcePath);
  await expect(page.locator("[data-import-ready=true]")).toHaveCount(1);
  await expect(page.locator(".import-status")).toContainText("Opened ");
  const loadedAt = Date.now(); await chooseReference(page);
  await page.evaluate(() => {
    (window as any).__importHeartbeat = { ticks: 0, maxGapMs: 0, previous: performance.now() };
    (window as any).__importHeartbeatTimer = setInterval(() => {
      const h = (window as any).__importHeartbeat, now = performance.now();
      h.ticks++; h.maxGapMs = Math.max(h.maxGapMs, now - h.previous); h.previous = now;
    }, 50);
  });
  const generationAt = Date.now(); await generate(page, 42); const generatedAt = Date.now();
  const heartbeat = await page.evaluate(() => {
    clearInterval((window as any).__importHeartbeatTimer); return (window as any).__importHeartbeat;
  });
  const varied = await downloadCompact("torso-varied"), original = compact(source);
  expect(original).toHaveLength(39); expect(varied.mesh).toHaveLength(39);
  expect(original.reduce((sum: number, mesh: any) => sum + mesh.vertices, 0)).toBe(392295);
  expect(original.reduce((sum: number, mesh: any) => sum + mesh.indices / 3, 0)).toBe(784624);
  expect(varied.mesh.map((mesh: any) => [mesh.vertices, mesh.indices, mesh.topology]))
    .toEqual(original.map((mesh: any) => [mesh.vertices, mesh.indices, mesh.topology]));
  expect(varied.mesh.map((mesh: any) => mesh.position)).not.toEqual(original.map((mesh: any) => mesh.position));
  expect(varied.mesh.every((mesh: any) => mesh.colors !== null)).toBe(true);
  const provenance = await recipe(page, info, "torso-varied");
  expect(provenance.recipe.provenance.method).toBe("joint-flow-recipe-transfer");
  await page.getByRole("button", { name: "Fit", exact: true }).click();
  await page.screenshot({ path: info.outputPath("torso-varied.png") });
  await page.getByRole("button", { name: "Restore original", exact: true }).click();
  await expect(page.locator(".import-status")).toContainText("Original geometry, colours and materials restored.");
  const restored = await downloadCompact("torso-restored");
  expect(restored.mesh).toEqual(original);
  await writeFile(info.outputPath("torso-review.json"), JSON.stringify({
    source: { path: sourcePath, bytes: sourceBytes.length, sha256: sha(sourceBytes) },
    uploadReadyMs: loadedAt - began, generationMs: generatedAt - generationAt,
    heartbeat, varied, restored,
    qualification: "Existing BodyParts3D geometry; upload/variation/export smoke, not anatomical or biomechanical validation. Timing is an observation, not a performance budget.",
  }, null, 2));
});

test("HD recorder encodes the imported textured scene and restores its exact viewport", async ({ page }, info) => {
  await openWorkspace(page); await upload(page);
  await page.getByRole("checkbox", { name: "Turntable", exact: true }).check();
  const canvas = page.locator('canvas[data-scene-recording-label="Imported 3D model"]');
  const before = await canvas.evaluate((element: HTMLCanvasElement) => [element.width, element.height]);
  await page.getByRole("button", { name: "Video recorder", exact: true }).click();
  const panel = page.getByRole("dialog", { name: "Video recorder", exact: true });
  await panel.getByRole("radio", { name: "HD · 1280 × 720", exact: true }).check();
  await panel.getByRole("button", { name: "Start recording", exact: true }).click();
  await expect(page.getByRole("button", { name: "Stop video recording", exact: true })).toBeVisible();
  expect(await canvas.evaluate((element: HTMLCanvasElement) => [element.width, element.height])).toEqual([1280, 720]);
  await page.waitForTimeout(2300); // Deliberate elapsed capture, not a UI synchronization wait.
  await page.getByRole("button", { name: "Stop video recording", exact: true }).click();
  await expect(page.getByRole("region", { name: "Finished recording", exact: true })).toBeVisible();
  const pending = page.waitForEvent("download"); await page.getByRole("link", { name: /^Download (MP4|WebM)$/i }).click();
  const download = await pending, destination = info.outputPath(`imported-hd.${download.suggestedFilename().split(".").pop()}`);
  await download.saveAs(destination);
  const probe = JSON.parse((await exec(process.env.FFPROBE ?? "/opt/homebrew/bin/ffprobe",
    ["-v", "error", "-count_frames", "-show_streams", "-show_format", "-of", "json", destination])).stdout);
  const video = probe.streams.find((stream: any) => stream.codec_type === "video");
  expect([video.width, video.height]).toEqual([1280, 720]);
  expect(probe.streams.filter((stream: any) => stream.codec_type === "audio")).toHaveLength(0);
  const data = (await exec(process.env.FFMPEG ?? "/opt/homebrew/bin/ffmpeg", ["-v", "error", "-i", destination,
    "-vf", "scale=160:90", "-pix_fmt", "rgb24", "-fps_mode", "passthrough", "-f", "rawvideo", "pipe:1"],
  { encoding: "buffer", maxBuffer: 32 * 1024 * 1024 })).stdout as unknown as Buffer;
  const frames = data.length / 43200, unique = new Set<string>();
  for (let at = 0; at < data.length; at += 43200) unique.add(sha(data.subarray(at, at + 43200)));
  expect(frames).toBeGreaterThan(5); expect(unique.size).toBeGreaterThan(5);
  const details = page.waitForEvent("download"); await page.getByRole("button", { name: "Capture details", exact: true }).click();
  await (await details).saveAs(info.outputPath("imported-hd.capture.json"));
  const capture = JSON.parse(await readFile(info.outputPath("imported-hd.capture.json"), "utf8"));
  expect(capture.upscaled).toBe(false); expect(capture.sourceKind).toBe("scene");
  await writeFile(info.outputPath("imported-hd.decode.json"), JSON.stringify({ probe, frames, uniqueFrames: unique.size }, null, 2));
  expect(await canvas.evaluate((element: HTMLCanvasElement) => [element.width, element.height])).toEqual(before);
});

test("generated tissue maps survive GLB export and reimport", async ({ page }, info) => {
  await openWorkspace(page);
  await upload(page, ["cube-binary.stl"]);
  await chooseReference(page);
  await generate(page, 42);
  const output = await exported(page, info, "generated-tissue");
  expect(output.json.images).toHaveLength(3);
  expect(output.json.materials[0].normalTexture).toBeDefined();
  expect(output.json.materials[0].pbrMetallicRoughness.metallicRoughnessTexture).toBeDefined();
  expect(await pixels(page, output)).toMatchObject({ width: 512, height: 512 });
  await page.getByLabel("3D model files", { exact: true }).setInputFiles(info.outputPath("generated-tissue.glb"));
  await expect(page.locator(".import-status")).toContainText("Opened generated-tissue.glb");
  const roundtrip = await exported(page, info, "generated-tissue-roundtrip");
  expect(await pixels(page, roundtrip)).toEqual(await pixels(page, output));
  // An unnamed STL primitive receives the loader's default mesh_0 name.
  const content = (value: Export) => value.semantic.meshes.map(({ name: _name, ...mesh }) => mesh);
  expect(content(roundtrip)).toEqual(content(output));
  for (const role of ["normal", "roughness"] as const) {
    const channel = (value: Export): GLB => {
      const material = value.json.materials[0];
      const texture = role === "normal" ? material.normalTexture.index : material.pbrMetallicRoughness.metallicRoughnessTexture.index;
      const image = value.json.images[value.json.textures[texture].source];
      return { ...value, json: { ...value.json, images: [image] } };
    };
    expect(await pixels(page, channel(roundtrip))).toEqual(await pixels(page, channel(output)));
  }
});
