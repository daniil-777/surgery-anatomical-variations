import { expect, test } from "@playwright/test";
import crypto from "node:crypto";

const hash = (bytes: Uint8Array) => crypto.createHash("sha256").update(bytes).digest("hex");
const positions = [0, 70, 0, -60, -45, 45, 60, -45, 45, 0, -45, -70];
const indices = [0, 1, 2, 0, 2, 3, 0, 3, 1, 1, 3, 2];
const normals = [0, 1, 0, -0.7, -0.2, 0.6, 0.7, -0.2, 0.6, 0, -0.2, -0.9];
const colors = Array.from({ length: 4 }, () => [0.45, 0.2, 0.16]).flat();
const packed = new ArrayBuffer((positions.length + indices.length) * 8);
const data = new DataView(packed);
positions.forEach((value, index) => data.setFloat64(index * 8, value, true));
indices.forEach((value, index) => data.setUint32((positions.length + index) * 8, value, true));
const geometryHash = hash(new Uint8Array(packed));
const normalHash = hash(new Uint8Array(new Float32Array(normals).buffer));
const spec = { template_id: "fixture-reference", seed: 42, controls: {}, appearance: "tissue" };
function generation() {
  return {
    spec, summary: {},
    scene: {
      organs: [{ id: "fixture", name: "Contract fixture", kind: "organ", color: "#794033", positions: [...positions], indices, normals, colors }],
      metadata: { geometry_sha256: geometryHash, realized_id: "fixture", display_normals: { policy: "fixture", sha256: normalHash, geometry_modified: false } },
    },
  };
}

test("visual witness records exact payload identity and three framed views", async ({ page }) => {
  await page.route("**/api/atlas/generate", (route) => route.fulfill({ json: generation() }));
  await page.goto("/atlas-witness.html");
  await page.waitForFunction(() => Boolean(window.atlasWitness));
  const result = await page.evaluate(({ spec, geometryHash }) => window.atlasWitness!.render(spec as never, geometryHash), { spec, geometryHash });
  expect(result.scene_payload_geometry_sha256).toBe(geometryHash);
  expect(result.scene_payload_normal_sha256).toBe(normalHash);
  expect(result.png).toMatch(/^data:image\/png;base64,/);
  expect(result.views.map((view) => view.pose)).toEqual(["oblique", "back", "top"]);
  for (const view of result.views) expect(view.opaque_pixels).toBeGreaterThan(40);
});

test("visual witness refuses tampered arrays despite a matching claimed hash", async ({ page }) => {
  const corrupted = generation();
  corrupted.scene.organs[0]!.positions[0] = 17;
  await page.route("**/api/atlas/generate", (route) => route.fulfill({ json: corrupted }));
  await page.goto("/atlas-witness.html");
  await page.waitForFunction(() => Boolean(window.atlasWitness));
  const error = await page.evaluate(async ({ spec, geometryHash }) => {
    try { await window.atlasWitness!.render(spec as never, geometryHash); return "accepted"; }
    catch (cause) { return (cause as Error).message; }
  }, { spec, geometryHash });
  expect(error).toContain("Scene payload identity mismatch");
});

test("visual witness refuses a mismatched display-normal artifact", async ({ page }) => {
  const corrupted = generation();
  corrupted.scene.metadata.display_normals.sha256 = "0".repeat(64);
  await page.route("**/api/atlas/generate", (route) => route.fulfill({ json: corrupted }));
  await page.goto("/atlas-witness.html");
  await page.waitForFunction(() => Boolean(window.atlasWitness));
  const error = await page.evaluate(async ({ spec, geometryHash }) => {
    try { await window.atlasWitness!.render(spec as never, geometryHash); return "accepted"; }
    catch (cause) { return (cause as Error).message; }
  }, { spec, geometryHash });
  expect(error).toContain("Display-normal metadata does not match");
});
