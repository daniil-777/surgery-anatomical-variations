import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import type { AtlasGeneration } from "../../apps/studio/src/atlas";

// This test never mocks or imports weights. Hash independent local artifacts,
// then prove that the running Studio uses those exact already-imported bytes.
let expected: { bundle: string; model: string };
test.beforeAll(async () => {
  const weights = process.env.VISCERA_JOINT_WEIGHTS;
  const model = process.env.VISCERA_JOINT_MODEL;
  if (!weights || !model) throw new Error("Set VISCERA_JOINT_WEIGHTS to the ZIP and VISCERA_JOINT_MODEL to its independently verified model.npz");
  const sha = async (file: string) => createHash("sha256").update(await readFile(file)).digest("hex");
  expected = { bundle: await sha(weights), model: await sha(model) };
});
async function responseTo(page: Page, suffix: string, action: () => Promise<unknown>): Promise<AtlasGeneration> {
  const waiting = page.waitForResponse(response => response.url().endsWith(suffix) && response.request().method() === "POST");
  await action(); const response = await waiting;
  expect(response.status(), await response.text()).toBe(200);
  const result = await response.json() as AtlasGeneration;
  await expect(page.getByRole("button", { name: "Export GLB", exact: true })).toBeEnabled();
  await expect(page.getByRole("alert")).toHaveCount(0);
  return result;
}
const geometry = (value: AtlasGeneration) => value.scene.metadata?.geometry_sha256;
function assertJoint(value: AtlasGeneration, seed: number) {
  expect(value.summary.joint_model).toMatchObject({ bundle_sha256: expected.bundle, model_sha256: expected.model, request_seed: seed, temperature: 1 });
  expect(value.spec.seed).toBe(seed); expect(value.spec.appearance).toBe("tissue");
  expect(value.spec.material).toBeTruthy();
}
async function screenshot(page: Page, info: TestInfo, name: string) {
  const canvas = page.getByTestId("atlas-viewport").locator("canvas");
  const frame = await canvas.evaluate(async (element: HTMLCanvasElement) => {
    for (let i = 0; i < 4; i++) await new Promise(requestAnimationFrame);
    const source = new Image(); source.src = element.toDataURL("image/png"); await source.decode();
    const copy = document.createElement("canvas"); copy.width = source.width; copy.height = source.height;
    const context = copy.getContext("2d")!; context.drawImage(source, 0, 0);
    const values = context.getImageData(0, 0, copy.width, copy.height).data;
    let opaque = 0; for (let i = 3; i < values.length; i += 4) if (values[i]! > 200) opaque++;
    return { opaque, png: source.src.split(",")[1]! };
  });
  expect(frame.opaque).toBeGreaterThan(10000);
  await writeFile(info.outputPath(`${name}-organ.png`), Buffer.from(frame.png, "base64"));
  await page.screenshot({ path: info.outputPath(`${name}-studio.png`) });
  return { opaquePixels: frame.opaque, imageSha256: createHash("sha256").update(frame.png).digest("hex") };
}

test("actual full joint VAE weights drive baseline and disease shape/color together, sliders and textured GLB", async ({ page }, info) => {
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  const initial = await responseTo(page, "/api/atlas/generate", () => page.goto("/?template=hra-liver-female"));
  const status = await (await page.request.get("/api/atlas/models")).json();
  expect(status.joint_bundle_sha256).toBe(expected.bundle);
  expect(status.lanes.joint).toMatchObject({ status: "active", method: "joint_conditional_vae" });
  const specimens: AtlasGeneration[] = [];
  for (const seed of [2101, 2101, 2102]) {
    await page.getByRole("textbox", { name: "Joint variation seed", exact: true }).fill(String(seed));
    const value = await responseTo(page, "/api/atlas/sample-joint", () => page.getByRole("button", { name: "Joint VAE variation", exact: true }).click());
    assertJoint(value, seed); specimens.push(value);
    expect(value.spec.template_id).toBe(initial.spec.template_id); expect(value.spec.disease).toBeFalsy();
  }
  expect(specimens[0]!.spec).toEqual(specimens[1]!.spec);
  expect(geometry(specimens[0]!)).toBe(geometry(specimens[1]!));
  expect(geometry(specimens[2]!)).not.toBe(geometry(specimens[1]!));
  expect(specimens[2]!.spec.controls).not.toEqual(specimens[1]!.spec.controls);
  expect(specimens[2]!.spec.material).not.toEqual(specimens[1]!.spec.material);
  const baselineFrame = await screenshot(page, info, "01-joint-baseline");
  await page.getByRole("tab", { name: "Disease", exact: true }).click();
  await responseTo(page, "/api/atlas/generate", () => page.getByRole("combobox", { name: "Disease profile", exact: true }).selectOption("liver-hcc"));
  const diseased: AtlasGeneration[] = [];
  for (const seed of [3201, 3201, 3202]) {
    await page.getByRole("textbox", { name: "Joint variation seed", exact: true }).fill(String(seed));
    const value = await responseTo(page, "/api/atlas/sample-joint", () => page.getByRole("button", { name: "Joint VAE variation", exact: true }).click());
    assertJoint(value, seed); diseased.push(value);
    expect(value.spec.disease?.profile_id).toBe("liver-hcc");
  }
  expect(diseased[0]!.spec).toEqual(diseased[1]!.spec);
  expect(geometry(diseased[2]!)).not.toBe(geometry(diseased[1]!));
  expect(diseased[2]!.spec.controls).not.toEqual(diseased[1]!.spec.controls);
  expect(diseased[2]!.spec.material).not.toEqual(diseased[1]!.spec.material);
  expect(diseased[2]!.spec.disease).not.toEqual(diseased[1]!.spec.disease);
  const diseaseFrame = await screenshot(page, info, "02-joint-disease");
  const edited = await responseTo(page, "/api/atlas/generate", () => page.getByRole("slider", { name: "Morphology intensity", exact: true }).fill("0.72"));
  expect(edited.spec.disease?.severity).toBe(0.72);
  expect(edited.spec.controls).toEqual(diseased[2]!.spec.controls); expect(edited.spec.material).toEqual(diseased[2]!.spec.material);
  const response = await page.request.post("/api/atlas/export", { data: { spec: edited.spec, format: "glb", texture_resolution: 512 }, timeout: 120000 });
  expect(response.status(), await response.text()).toBe(200);
  const glb = await response.body(); expect(glb.toString("ascii", 0, 4)).toBe("glTF");
  expect(glb.readUInt32LE(4)).toBe(2); expect(glb.readUInt32LE(8)).toBe(glb.length);
  const gltf = JSON.parse(glb.toString("utf8", 20, 20 + glb.readUInt32LE(12)).trim());
  expect(gltf.scenes[0].extras.spec).toEqual(edited.spec);
  expect(gltf.scenes[0].extras.geometry_sha256).toBe(geometry(edited));
  expect(gltf.meshes.length).toBeGreaterThan(0); expect(gltf.images.length).toBe(3);
  const binaryOffset = 20 + glb.readUInt32LE(12) + 8;
  for (const image of gltf.images) {
    expect(image.mimeType).toBe("image/png"); const offset = binaryOffset + (gltf.bufferViews[image.bufferView].byteOffset ?? 0);
    expect(glb.readUInt32BE(offset + 16)).toBe(512); expect(glb.readUInt32BE(offset + 20)).toBe(512);
  }
  await writeFile(info.outputPath("joint-vae-liver-512.glb"), glb);
  expect(errors).toEqual([]);
  await writeFile(info.outputPath("joint-integration-evidence.json"), JSON.stringify({ expected, status, initialRecipe: initial.spec,
    baselineRecipes: specimens.map(item => item.spec), diseaseRecipes: diseased.map(item => item.spec), baselineFrame, diseaseFrame,
    seedReplayPassed: true, bothShapeAndColorVary: true, diseaseConditionPreserved: true, continuedEditingPassed: true,
    glb: { bytes: glb.length, sha256: createHash("sha256").update(glb).digest("hex"), textureResolution: 512 }, errors }, null, 2));
});
