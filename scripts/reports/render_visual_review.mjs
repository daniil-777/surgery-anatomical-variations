/** Render the actual stored/generated meshes in declared, reproducible review views. */
import { chromium } from "@playwright/test";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const output = path.resolve(root, "../reports/viscera-organ-review-2026-10-06");
await mkdir(path.join(output, "images"), { recursive: true });
const sources = JSON.parse(
  await readFile(path.join(output, "sources.json"), "utf8"),
);
const browser = await chromium.launch({
  headless: true,
  args:
    process.platform === "darwin"
      ? ["--use-gl=angle", "--use-angle=metal"]
      : [],
});
const page = await browser.newPage({ viewport: { width: 1400, height: 1050 } });
await page.goto("http://127.0.0.1:5174");
const modules = await page.evaluate(() =>
  performance.getEntriesByType("resource").map((e) => e.name),
);
const threeUrl = modules.find((s) => s.includes("/three.js?"));
const roomUrl = modules.find((s) => s.includes("RoomEnvironment__js.js?"));
if (!threeUrl || !roomUrl)
  throw new Error("Studio renderer modules not loaded");
await page.evaluate(
  async ({ threeUrl, roomUrl }) => {
    const THREE = await import(threeUrl);
    const { RoomEnvironment } = await import(roomUrl);
    const host = document.createElement("div");
    host.style.cssText =
      "position:fixed;inset:0;z-index:99999;background:#e7e9eb";
    document.body.appendChild(host);
    const renderer = new THREE.WebGLRenderer({
      antialias: true,
      preserveDrawingBuffer: true,
    });
    renderer.setSize(1400, 1050);
    renderer.setPixelRatio(1);
    renderer.setClearColor("#e7e9eb");
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 0.95;
    renderer.localClippingEnabled = true;
    host.appendChild(renderer.domElement);
    const pmrem = new THREE.PMREMGenerator(renderer),
      room = new RoomEnvironment();
    const environment = pmrem.fromScene(room, 0.05);
    room.dispose();
    pmrem.dispose();
    window.reviewRender = ({
      sceneData,
      view,
      span,
      mode = "pigment",
      section = false,
      scaffold = false,
    }) => {
      const scene = new THREE.Scene();
      scene.environment = environment.texture;
      scene.add(new THREE.HemisphereLight(0xf4f7ff, 0x665955, 1.0));
      const light = new THREE.DirectionalLight(0xfff3e9, 2.0);
      light.position.set(-200, 250, 400);
      scene.add(light);
      const fill = new THREE.DirectionalLight(0xd3e5ff, 0.65);
      fill.position.set(300, -200, 150);
      scene.add(fill);
      const meshes = [],
        group = new THREE.Group();
      scene.add(group);
      const base = [...sceneData.organs, ...(sceneData.vessels ?? [])];
      for (const organ of base) {
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute(
          "position",
          new THREE.Float32BufferAttribute(organ.positions, 3),
        );
        geometry.setIndex(organ.indices);
        geometry.computeVertexNormals();
        const isOrgan = sceneData.organs.includes(organ);
        const usePigment = mode !== "clay" && organ.colors;
        if (usePigment) {
          const color = new THREE.Color(),
            colors = Float32Array.from(organ.colors);
          for (let i = 0; i < colors.length; i += 3) {
            color
              .setRGB(colors[i], colors[i + 1], colors[i + 2])
              .convertSRGBToLinear();
            colors.set(color.toArray(), i);
          }
          geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
        }
        const material = new THREE.MeshPhysicalMaterial({
          color:
            mode === "clay" ? "#8a939a" : usePigment ? "#ffffff" : organ.color,
          vertexColors: Boolean(usePigment),
          metalness: 0,
          roughness: mode === "clay" ? 0.9 : 0.4,
          clearcoat: mode === "clay" ? 0 : 0.35,
          clearcoatRoughness: 0.28,
          side: THREE.DoubleSide,
          wireframe: mode === "wire",
          transparent: scaffold && isOrgan,
          opacity: scaffold && isOrgan ? 0.13 : 1,
          depthWrite: !(scaffold && isOrgan),
        });
        const mesh = new THREE.Mesh(geometry, material);
        group.add(mesh);
        meshes.push(mesh);
        if (section && organ.lumen) {
          const lumenGeo = new THREE.BufferGeometry();
          lumenGeo.setAttribute(
            "position",
            new THREE.Float32BufferAttribute(organ.lumen.positions, 3),
          );
          lumenGeo.setIndex(organ.lumen.indices);
          lumenGeo.computeVertexNormals();
          const inner = new THREE.Mesh(
            lumenGeo,
            new THREE.MeshPhysicalMaterial({
              color: "#786f47",
              roughness: 0.65,
              side: THREE.DoubleSide,
            }),
          );
          group.add(inner);
          meshes.push(inner);
        }
      }
      const bounds = new THREE.Box3().setFromObject(group),
        center = bounds.getCenter(new THREE.Vector3());
      if (section) {
        const plane = new THREE.Plane(new THREE.Vector3(-1, 0, 0), center.x);
        for (const mesh of meshes) mesh.material.clippingPlanes = [plane];
      }
      const aspect = 1400 / 1050;
      const camera = new THREE.OrthographicCamera(
        -span / 2,
        span / 2,
        span / 2 / aspect,
        -span / 2 / aspect,
        0.1,
        3000,
      );
      camera.position
        .copy(center)
        .add(new THREE.Vector3(...view).normalize().multiplyScalar(700));
      camera.up.set(0, 0, 1);
      if (
        Math.abs(view[2]) > 0.99 &&
        Math.abs(view[0]) + Math.abs(view[1]) < 0.1
      )
        camera.up.set(0, 1, 0);
      camera.lookAt(center);
      camera.updateMatrixWorld();
      renderer.render(scene, camera);
      const canvas = document.createElement("canvas");
      canvas.width = 1400;
      canvas.height = 1050;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(renderer.domElement, 0, 0);
      ctx.fillStyle = "#24323e";
      ctx.strokeStyle = "#24323e";
      ctx.lineWidth = 3;
      ctx.font = "40px Arial";
      const scale = span < 160 ? 20 : 50,
        length = (scale / span) * 1400;
      ctx.beginPath();
      ctx.moveTo(58, 970);
      ctx.lineTo(58 + length, 970);
      ctx.stroke();
      ctx.fillText(`${scale} mm`, 58, 1007);
      const colors = ["#a54747", "#46734c", "#416a95"],
        labels = ["R", "A", "S"];
      for (let i = 0; i < 3; i++) {
        const dir = new THREE.Vector3(
          i === 0 ? 1 : 0,
          i === 1 ? 1 : 0,
          i === 2 ? 1 : 0,
        ).transformDirection(camera.matrixWorldInverse);
        const dx = dir.x * 62,
          dy = -dir.y * 62;
        ctx.strokeStyle = colors[i];
        ctx.fillStyle = colors[i];
        ctx.beginPath();
        ctx.moveTo(1260, 950);
        ctx.lineTo(1260 + dx, 950 + dy);
        ctx.stroke();
        if (Math.abs(dx) + Math.abs(dy) > 8)
          ctx.fillText(labels[i], 1260 + dx + 7, 950 + dy + 7);
      }
      const data = canvas.toDataURL("image/png");
      for (const mesh of meshes) {
        mesh.geometry.dispose();
        mesh.material.dispose();
      }
      return data;
    };
  },
  { threeUrl, roomUrl },
);

const jobs = [];
const add = (name, source, view, span, extra = {}) =>
  jobs.push({ name, source, view, span, ...extra });
add("hero", "default", [0.65, 1, 0.28], 340);
for (const [name, view] of Object.entries({
  anterior: [0, 1, 0],
  posterior: [0, -1, 0],
  right: [1, 0, 0],
  left: [-1, 0, 0],
  superior: [0, 0, 1],
  inferior: [0, 0, -1],
}))
  add(`assembly-${name}`, "default", view, 340, { mode: "clay" });
add("liver-anterior", "liver", [0, 1, 0.05], 290);
add("liver-inferior", "liver", [0, 0, -1], 290);
add("liver-inferior-clay", "liver", [0, 0, -1], 290, { mode: "clay" });
add("liver-wire", "liver", [0, 0, -1], 290, { mode: "wire" });
add("gb-right", "gallbladder", [1, 0, 0], 120);
add("gb-oblique", "gallbladder", [1, 0.3, 0.2], 120);
add("gb-section", "gallbladder", [1, 0, 0], 120, { section: true });
add("scaffold", "default", [0, -1, -0.1], 340, { scaffold: true });
for (let i = 0; i < 6; i++)
  add(`cohort-${i}`, `cohort-${i}`, [0.35, 1, -0.15], 350);
for (const key of ["left_lobe_ratio", "inferior_concavity", "fissure_depth_mm"])
  for (let i = 0; i < 3; i++)
    add(`control-${key}-${i}`, `control-${key}-${i}`, [0, 0, -1], 300, {
      mode: "clay",
    });
for (let i = 0; i < 4; i++)
  add(`gb-control-${i}`, `gb-control-${i}`, [1, 0, 0], 140);
const rendered = [];
try {
  for (const job of jobs) {
    const sceneData = JSON.parse(
      await readFile(path.join(output, sources[job.source].file), "utf8"),
    );
    const data = await page.evaluate((input) => window.reviewRender(input), {
      ...job,
      sceneData,
    });
    const file = `images/${job.name}.png`;
    await writeFile(
      path.join(output, file),
      Buffer.from(data.split(",")[1], "base64"),
    );
    rendered.push({
      ...job,
      file,
      source_sha256: sources[job.source].sha256,
      projection: "orthographic",
      width: 1400,
      height: 1050,
    });
  }
  await writeFile(
    path.join(output, "renders.json"),
    JSON.stringify(
      {
        browser: browser.version(),
        views: rendered,
        lighting:
          "Neutral review rig with authored PBR; not calibrated tissue optics",
        date: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
  console.log(`Rendered ${rendered.length} views at ${output}`);
} finally {
  await browser.close();
}
