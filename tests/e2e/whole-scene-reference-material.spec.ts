import { expect, test, type Page } from "@playwright/test";
import { resolve } from "node:path";
import { writeFile } from "node:fs/promises";

const source = resolve("artifacts/ground-truth/drends-pilot/review/frame-00000-left.png");
async function snapshot(page: Page): Promise<any> {
  return JSON.parse(await page.locator("[data-scene-snapshot]").getAttribute("data-scene-snapshot") ?? "{}");
}

async function prepareColonReference(page: Page) {
  await page.emulateMedia({reducedMotion: "reduce"});
  await page.goto("/?mode=scene");
  await expect(page.locator("[data-scene-ready='true'] canvas")).toBeVisible({timeout: 60000});
  await page.getByText("Explore the structures", {exact:false}).click();
  await page.getByRole("button", {name:"Large intestine", exact:true}).click();
  await page.getByRole("button", {name:"Apply learned physics to all organs", exact:true}).click();
  await page.getByRole("button", {name:"Pause physics", exact:true}).click();
  await page.getByLabel("Reference image", {exact:true}).setInputFiles(source);
  await page.getByRole("button", {name:"Select entire image", exact:true}).click();
  const selection = page.getByTestId("reference-image-selection");
  await selection.scrollIntoViewIfNeeded();
  const rect = (await selection.boundingBox())!;
  // Same spatially prompted visible colon region as the independently recorded SAM smoke.
  await page.mouse.move(rect.x + .11*rect.width, rect.y + .04*rect.height);
  await page.mouse.down(); await page.mouse.move(rect.x + .50*rect.width, rect.y + .87*rect.height,{steps:8}); await page.mouse.up();
  await page.getByRole("button", {name:"+ Tissue", exact:true}).click();
  for (const [x,y] of [[.29,.43],[.26,.58],[.30,.23],[.20,.38]]) {
    await selection.click({position:{x:x!*rect.width,y:y!*rect.height}});
  }
  await page.getByRole("button", {name:"− Background", exact:true}).click();
  for (const [x,y] of [[.53,.49],[.08,.20],[.37,.75]]) {
    await selection.click({position:{x:x!*rect.width,y:y!*rect.height}});
  }
  const response = page.waitForResponse(r => r.url().endsWith("/reference-material/analyze"));
  await page.getByRole("button", {name:"Analyse reference region",exact:true}).click();
  const result = await response; expect(result.status()).toBe(200);
  const analysis = await result.json(); expect(analysis.organ).toBe("large-intestine");
  return analysis;
}

test("actual surgical reference changes only the selected colon material and preserves paused physics", async ({page}, info) => {
  const errors: string[] = [];
  page.on("pageerror", e => errors.push(e.message));
  const analysis = await prepareColonReference(page);
  await page.getByRole("slider", {name:"Reference transfer strength",exact:true}).fill("1");
  await page.getByRole("combobox", {name:"Reference transfer mode",exact:true}).selectOption("color");
  await page.getByRole("checkbox", {name:"I confirm the highlighted tissue is Large intestine.",exact:true}).check();
  const before = await snapshot(page);
  await page.locator(".whole-scene-canvas canvas").screenshot({path:info.outputPath("colon-before.png")});
  await page.getByRole("button", {name:"Apply reference colour",exact:true}).click();
  await expect.poll(async () => (await snapshot(page)).referenceColors?.colon?.source_sha256).toBe(analysis.source_sha256);
  const after = await snapshot(page);
  for (const old of before.organs) {
    const next = after.organs.find((o:any) => o.id === old.id);
    expect(next.geometrySignature).toBe(old.geometrySignature);
    if (old.id === "colon") expect(next.materialSignature).not.toBe(old.materialSignature);
    else expect(next.materialSignature).toBe(old.materialSignature);
  }
  expect(after.physics).toEqual(before.physics);
  expect(after.camera).toEqual(before.camera);
  await page.locator(".whole-scene-canvas canvas").screenshot({path:info.outputPath("colon-after.png")});
  await page.screenshot({path:info.outputPath("colon-transfer-ui.png"),fullPage:true});
  await writeFile(info.outputPath("colon-reference-evidence.json"), JSON.stringify({source,analysis,before,after},null,2));
  await page.getByRole("button", {name:"Clear reference colour",exact:true}).click();
  await expect.poll(async () => (await snapshot(page)).organs.find((o:any)=>o.id==="colon").materialSignature).toBe(before.organs.find((o:any)=>o.id==="colon").materialSignature);
  expect(errors).toEqual([]);
});

test("close-up surgical reference comparison keeps colour-only and full transfer optics and anatomy consistent", async ({page}, info) => {
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  const analysis = await prepareColonReference(page);
  expect(analysis.segmentation.method).toBe("sam2");
  await expect(page.getByRole("slider", {name:"Reference transfer strength", exact:true})).toHaveValue("0.7");
  await expect(page.getByRole("combobox", {name:"Reference transfer mode", exact:true})).toHaveValue("chroma");
  await page.getByRole("checkbox", {name:"I confirm the highlighted tissue is Large intestine.",exact:true}).check();
  const records: any[] = [];
  const settled = async () => {
    await expect.poll(async () => {
      const state = await snapshot(page);
      return !state.rendering.cameraTransition && state.rendering.renderedRevision === state.rendering.sceneRevision;
    }).toBe(true);
  };
  for (const [view, label] of [["front", "Front"], ["oblique", "¾ view"]] as const) {
    if ((await snapshot(page)).referenceColors?.colon) await page.getByRole("button", {name:"Clear reference colour",exact:true}).click();
    await page.getByRole("button", {name:label,exact:true}).click();
    await page.getByRole("button", {name:"Focus organ",exact:true}).click();
    await settled();
    const before = await snapshot(page);
    expect(before.camera.focusedOrgan).toBe("colon");
    await page.locator(".whole-scene-canvas canvas").screenshot({path:info.outputPath(`colon-${view}-baseline.png`)});
    const candidates: any[] = [];
    for (const [name, strength, mode] of [["chroma70", 0.7, "chroma"], ["full100", 1, "color"]] as const) {
      await page.getByRole("slider", {name:"Reference transfer strength",exact:true}).fill(String(strength));
      await page.getByRole("combobox", {name:"Reference transfer mode",exact:true}).selectOption(mode);
      await page.getByRole("button", {name:"Apply reference colour",exact:true}).click();
      await expect.poll(async () => {
        const reference = (await snapshot(page)).referenceColors?.colon;
        return reference?.strength === strength && reference?.mode === mode;
      }).toBe(true);
      await settled();
      const after = await snapshot(page);
      expect(after.camera).toEqual(before.camera);
      expect(after.physics).toEqual(before.physics);
      expect(after.rendering.lights).toEqual(before.rendering.lights);
      expect(after.rendering.exposure).toBe(before.rendering.exposure);
      expect(after.rendering.environmentIntensity).toBe(before.rendering.environmentIntensity);
      for (const old of before.organs) {
        const next = after.organs.find((organ:any) => organ.id === old.id);
        expect(next.geometrySignature).toBe(old.geometrySignature);
        if (old.id !== "colon") expect(next.materialSignature).toBe(old.materialSignature);
        else {
          const oldMaterial = JSON.parse(old.materialSignature), newMaterial = JSON.parse(next.materialSignature);
          expect(newMaterial.color).not.toBe(oldMaterial.color);
          expect(newMaterial.opticalRoughness).toBe(oldMaterial.opticalRoughness);
          expect(newMaterial.opticalSpecular).toBe(oldMaterial.opticalSpecular);
          expect(newMaterial.profileParameters).toEqual(oldMaterial.profileParameters);
          // Only the display base colour and its provenance are allowed to differ.
          delete oldMaterial.color; delete newMaterial.color; delete newMaterial.reference_color;
          expect(newMaterial).toEqual(oldMaterial);
        }
      }
      await page.locator(".whole-scene-canvas canvas").screenshot({path:info.outputPath(`colon-${view}-${name}.png`)});
      candidates.push({name,strength,mode,after});
    }
    records.push({view,before,candidates});
  }
  await writeFile(info.outputPath("colon-closeup-comparison.json"), JSON.stringify({source,analysis,records},null,2));
  await page.getByRole("button", {name:"Clear reference colour",exact:true}).click();
  await expect.poll(async () => (await snapshot(page)).organs.find((organ:any) => organ.id === "colon").materialSignature).toBe(records[0].before.organs.find((organ:any) => organ.id === "colon").materialSignature);
  expect(errors).toEqual([]);
});
