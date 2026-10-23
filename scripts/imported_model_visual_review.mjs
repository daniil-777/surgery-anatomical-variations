/** Real native-UHD imported-scene recording; no renderer mocks or desktop capture. */
import { chromium, expect } from "@playwright/test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

const exec = promisify(execFile);
const base = process.env.IMPORT_REVIEW_URL ?? "http://127.0.0.1:5174/";
const output = path.resolve(process.env.IMPORT_REVIEW_OUTPUT ?? "artifacts/imported-models-2026-10-20/uhd");
const fixture = path.resolve("tests/fixtures/imported-models/colour-pbr-multipart.glb");
const ffmpeg = process.env.FFMPEG ?? "/opt/homebrew/bin/ffmpeg", ffprobe = process.env.FFPROBE ?? "/opt/homebrew/bin/ffprobe";
const sha = value => createHash("sha256").update(value).digest("hex");
if ((await readdir(output).catch(error => { if (error.code === "ENOENT") return []; throw error; })).length) throw new Error("Choose an empty evidence directory; previous captures must remain intact.");
await mkdir(output, { recursive: true });
async function sources() {
  const files = [
    ...(await readdir("apps/studio/src/imports")).filter(name => /\.(ts|tsx|css)$/.test(name)).map(name => `apps/studio/src/imports/${name}`),
    "apps/studio/src/recording/VideoRecorder.ts", "packages/render/src/sceneRecording.ts", "apps/studio/src/VideoRecorderPanel.tsx",
    "scripts/imported_model_visual_review.mjs",
  ];
  return Object.fromEntries(await Promise.all(files.map(async name => [name, sha(await readFile(name))])));
}
const report = {
  schema: "viscera.imported-native-review/v1", startedAt: new Date().toISOString(), url: base,
  fixture: { path: fixture, sha256: sha(await readFile(fixture)), textureResolution: [2,2], meshes:2, triangles:24 },
  sourceBefore: await sources(), cases: [], pageErrors: [], requestFailures: [], verdict:"NOT RUN",
  limitations: [
    "This is a geometric/material interoperability fixture, not anatomical or photorealism validation.",
    "The actual rendered output is 3840×2160; its source texture is an authored 2×2 diagnostic image.",
    "Unique frames are measured after scaling to 160×90; they are not a motion-compensated temporal quality score.",
    "Encoded FPS is counted frames divided by encoded duration; target FPS and rendering cadence are different quantities.",
    "Extracted UHD stills are decoded video frames, not lossless framebuffer exports.",
  ],
};
let browser;
async function download(page, locator, destination) {
  const pending = page.waitForEvent("download"); await locator.click();
  const result = await pending; await result.saveAs(destination); return result;
}
async function analyze(filename, label) {
  const probe = JSON.parse((await exec(ffprobe, ["-v","error","-count_frames","-show_streams","-show_format","-of","json",filename])).stdout);
  const video = probe.streams.find(stream => stream.codec_type === "video");
  assert.deepEqual([video.width,video.height],[3840,2160]);
  assert.equal(probe.streams.filter(stream => stream.codec_type === "audio").length,0);
  const duration = Number(video.duration ?? probe.format.duration), count = Number(video.nb_read_frames);
  assert(Number.isFinite(duration) && duration > 4); assert(count > 10);
  const raw = (await exec(ffmpeg,["-v","error","-i",filename,"-vf","scale=160:90","-pix_fmt","rgb24","-fps_mode","passthrough","-f","rawvideo","pipe:1"],{ encoding:"buffer", maxBuffer:64*1024*1024 })).stdout;
  const frameBytes = 160*90*3, unique = new Set();
  assert.equal(raw.length % frameBytes,0);
  let sum = 0, max = 0;
  for (let at = 0; at < raw.length; at += frameBytes) unique.add(sha(raw.subarray(at,at+frameBytes)));
  for (const value of raw) { sum += value; max = Math.max(max,value); }
  assert(unique.size > 10); assert(sum/raw.length > 3 && max > 32);
  const contact = `${label}-motion-contact.jpg`, still = `${label}-native-frame.png`;
  await exec(ffmpeg,["-v","error","-i",filename,"-vf",`select='not(mod(n,${Math.max(1,Math.floor(count/12))}))',scale=640:360,tile=4x3`,"-frames:v","1",path.join(output,contact)]);
  await exec(ffmpeg,["-v","error","-ss",String(duration*.5),"-i",filename,"-frames:v","1",path.join(output,still)]);
  const metrics = { width:video.width,height:video.height,codec:video.codec_name,frames:count,rawDecodedFrames:raw.length/frameBytes,uniqueAt160x90:unique.size,duration,encodedFps:count/duration,meanByte:sum/raw.length,maximumByte:max,contact,still,sha256:sha(await readFile(filename)) };
  await writeFile(path.join(output,`${label}-decode.json`),JSON.stringify({metrics,probe},null,2));
  return metrics;
}
try {
  browser = await chromium.launch({ headless:true,
    ...(process.platform === "darwin" ? { executablePath:"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",args:["--use-gl=angle","--use-angle=metal"] } : {}),
  });
  report.browser = browser.version();
  const context = await browser.newContext({viewport:{width:1440,height:1000},deviceScaleFactor:2});
  const page = await context.newPage(); page.setDefaultTimeout(30000);
  page.on("pageerror",error => report.pageErrors.push(error.message));
  page.on("requestfailed",request => report.requestFailures.push({url:request.url(),error:request.failure()?.errorText}));
  const url = new URL(base); url.searchParams.set("mode","imports"); await page.goto(url.href);
  await page.getByLabel("3D model files",{exact:true}).setInputFiles(fixture);
  await expect(page.locator("[data-import-ready=true]")).toHaveCount(1);
  await expect(page.locator(".import-status")).toContainText("Original geometry and materials are ready.");
  const canvas = page.locator('canvas[data-scene-recording-label="Imported 3D model"]');
  for (const label of ["original","variation-42"]) {
    if (label !== "original") {
      const reference = page.getByLabel("Reference style",{exact:true}); await expect(reference).toBeEnabled();
      await expect.poll(() => reference.locator("option").count()).toBeGreaterThan(1);
      const value = await reference.locator("option").evaluateAll(options => (options.find(option => option.value.includes("liver")) ?? options.find(option => option.value)).value);
      await reference.selectOption(value);
      await page.getByRole("spinbutton",{name:"Variation seed",exact:true}).fill("42");
      await page.getByRole("button",{name:"Generate variation",exact:true}).click();
      await expect(page.locator(".import-status")).toContainText("Variation 42 applied.");
      await download(page,page.getByRole("button",{name:"Download recipe",exact:true}),path.join(output,`${label}-recipe.json`));
    }
    await download(page,page.getByRole("button",{name:"Export GLB",exact:true}),path.join(output,`${label}-current.glb`));
    await page.getByRole("checkbox",{name:"Turntable",exact:true}).check();
    const before = await canvas.evaluate(element => ({width:element.width,height:element.height,hostWidth:element.parentElement.clientWidth,hostHeight:element.parentElement.clientHeight}));
    await page.getByRole("button",{name:"Video recorder",exact:true}).click();
    const dialog = page.getByRole("dialog",{name:"Video recorder",exact:true});
    if (label !== "original") await dialog.getByRole("button",{name:"Record another",exact:true}).click();
    await dialog.getByRole("radio",{name:"4K · 3840 × 2160",exact:true}).check();
    await dialog.getByRole("button",{name:"Start recording",exact:true}).click();
    await expect(page.getByRole("button",{name:"Stop video recording",exact:true})).toBeVisible();
    assert.deepEqual(await canvas.evaluate(element => [element.width,element.height]),[3840,2160]);
    const rect = await canvas.boundingBox(); assert(Math.abs(rect.width/rect.height-16/9)<.002);
    await page.screenshot({path:path.join(output,`${label}-active-ui.png`)});
    await page.waitForTimeout(5000); // Actual elapsed capture, not a readiness heuristic.
    await page.getByRole("button",{name:"Stop video recording",exact:true}).click();
    await expect(page.getByRole("region",{name:"Finished recording",exact:true})).toBeVisible();
    const pending = page.waitForEvent("download");
    await page.getByRole("link",{name:/^Download (MP4|WebM)$/i}).click();
    const media = await pending, filename = path.join(output,`${label}.${media.suggestedFilename().split(".").at(-1)}`);
    await media.saveAs(filename);
    const details = path.join(output,`${label}-capture.json`);
    await download(page,page.getByRole("button",{name:"Capture details",exact:true}),details);
    const capture = JSON.parse(await readFile(details,"utf8"));
    assert.equal(capture.capturePath,"native-canvas"); assert.equal(capture.upscaled,false);
    assert.deepEqual([capture.sourceWidth,capture.sourceHeight],[3840,2160]);
    const after = await canvas.evaluate(element => ({width:element.width,height:element.height,hostWidth:element.parentElement.clientWidth,hostHeight:element.parentElement.clientHeight}));
    // Headers may reflow when recording controls appear. Restoration must use
    // the current host size, not a stale pre-recording viewport.
    assert(Math.abs(after.width-after.hostWidth*before.width/before.hostWidth)<=1);
    assert(Math.abs(after.height-after.hostHeight*before.height/before.hostHeight)<=1);
    await dialog.getByRole("button",{name:"Close video recorder",exact:true}).click();
    await page.getByRole("checkbox",{name:"Turntable",exact:true}).uncheck();
    const decoded = await analyze(filename,label);
    report.cases.push({label,video:path.basename(filename),capture,decoded,viewport:{before,after}});
    await writeFile(path.join(output,"progress.json"),JSON.stringify(report,null,2));
  }
  await context.close();
  assert.deepEqual(report.pageErrors,[]);
  report.sourceAfter = await sources(); assert.deepEqual(report.sourceAfter,report.sourceBefore);
  report.verdict = "PASS: native UHD encoded output, moving decoded frames, exact viewport restoration. Visual assessment recorded separately.";
} catch (error) {
  report.verdict = "FAIL"; report.error = error.stack ?? String(error); process.exitCode = 1;
} finally {
  await browser?.close(); report.finishedAt = new Date().toISOString();
  await writeFile(path.join(output,"receipt.json"),JSON.stringify(report,null,2));
  console.log(JSON.stringify({verdict:report.verdict,cases:report.cases.length,error:report.error,output},null,2));
}
